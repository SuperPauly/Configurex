import Ajv, { type AnySchema } from "ajv";
import type AjvCore from "ajv/dist/core";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import draft6MetaSchema from "ajv/dist/refs/json-schema-draft-06.json";

import { prepareSchemas, scanReferences } from "./references";
import {
  compilerCacheKey,
  compilerOptionsFor,
  declaredSchemaUri,
  dialectForSchemaUri,
  openapiVersionOf,
  parseSchemaValidationSettings,
  schemaDialectLabel,
  type ResolvedSchemaDialect,
  type SchemaCompilerOptions,
  type SchemaValidationSettings,
} from "./settings";
import type { DialectSource, SchemaInterpretation, SchemaNotice, SchemaPreflightRequest, SchemaProblem, SchemaValidationRequest, SchemaValidationResponse } from "./types";

type JsonObject = Record<string, unknown>;

const STANDARD_FORMATS = new Set([
  "date", "time", "date-time", "duration", "uri", "uri-reference", "uri-template", "url",
  "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "relative-json-pointer",
  "byte", "float", "password", "binary",
]);

const CODEX_NUMERIC_FORMATS = new Set(["uint", "uint16", "uint32", "uint64", "int32", "int64", "double"]);

/** Dialects Configurex can safely validate with the installed AJV ecosystem. */
const SUPPORTED_DIALECTS: readonly ResolvedSchemaDialect[] = ["draft-04", "draft-06", "draft-07", "draft-2019-09", "draft-2020-12"];

/** Dialect used when no `$schema` is declared and the user selection is `auto`. */
export const AUTO_FALLBACK_DIALECT: ResolvedSchemaDialect = "draft-2020-12";

function schemaObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function schemaFormats(value: unknown, formats = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return formats;
  if (Array.isArray(value)) {
    for (const item of value) schemaFormats(item, formats);
    return formats;
  }
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (key === "format" && typeof child === "string") formats.add(child);
    else schemaFormats(child, formats);
  }
  return formats;
}

function integerFormat(minimum: number, maximum: number) {
  return {
    type: "number" as const,
    validate: (value: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
  };
}

function addSupportedFormats(ajv: AjvCore, options: SchemaCompilerOptions, schemas: readonly unknown[]): SchemaNotice[] {
  addFormats(ajv, { mode: options.formatsMode });
  ajv.addFormat("uint", integerFormat(0, Number.MAX_SAFE_INTEGER));
  ajv.addFormat("uint16", integerFormat(0, 65_535));
  ajv.addFormat("uint32", integerFormat(0, 4_294_967_295));
  ajv.addFormat("uint64", integerFormat(0, Number.MAX_SAFE_INTEGER));
  ajv.addFormat("int32", integerFormat(-2_147_483_648, 2_147_483_647));
  ajv.addFormat("int64", integerFormat(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
  ajv.addFormat("double", { type: "number", validate: Number.isFinite });

  const custom = [...schemas.reduce<Set<string>>((formats, schema) => schemaFormats(schema, formats), new Set<string>())]
    .filter((format) => !STANDARD_FORMATS.has(format) && !CODEX_NUMERIC_FORMATS.has(format))
    .sort();
  if (!custom.length) return [];
  if (options.allowUnknownFormats) {
    for (const format of custom) ajv.addFormat(format, true);
    return [{
      ruleId: "schema/format-annotation",
      severity: "info",
      message: `${custom.length} custom schema ${custom.length === 1 ? "format is" : "formats are"} treated as annotations.`,
      explanation: `Structural validation still ran, but application-specific format semantics were not asserted: ${custom.join(", ")}.`,
    }];
  }
  return [{
    ruleId: "schema/format-strict",
    severity: "warning",
    message: `${custom.length} custom schema ${custom.length === 1 ? "format is" : "formats are"} not recognized: ${custom.join(", ")}.`,
    explanation: "\"Treat unknown custom formats as annotations\" is disabled, so compilation fails when the schema uses these formats.",
  }];
}

interface DialectDecision {
  readonly dialect?: ResolvedSchemaDialect;
  readonly source: DialectSource;
  readonly notices: SchemaNotice[];
  readonly unsupported?: SchemaProblem;
}

/**
 * Resolves the effective dialect from the user's selection and the schema's
 * declared `$schema` URI. A manual override never mutates the schema source;
 * it only selects the AJV implementation and raises a mismatch warning.
 */
function decideDialect(schema: unknown, settings: SchemaValidationSettings): DialectDecision {
  const declaredUri = declaredSchemaUri(schema);
  const declared = declaredUri === undefined ? undefined : dialectForSchemaUri(declaredUri);
  if (settings.dialect !== "auto") {
    const override = settings.dialect;
    if (declaredUri !== undefined && declared !== override) {
      return {
        dialect: override,
        source: "manual-override",
        notices: [{
          ruleId: "schema/dialect-mismatch",
          severity: "warning",
          message: declared
            ? `Schema declares ${schemaDialectLabel(declared)}, but the manual override compiles it as ${schemaDialectLabel(override)}.`
            : `The schema declares an unrecognized \`$schema\` (${declaredUri}); it is compiled as ${schemaDialectLabel(override)} per the manual override.`,
          explanation: "Overriding the declared JSON Schema dialect can produce validation results that differ from tools honoring the declared dialect.",
        }],
      };
    }
    return { dialect: override, source: "manual-override", notices: [] };
  }
  if (declared) return { dialect: declared, source: "declared", notices: [] };
  if (declaredUri === undefined) {
    return {
      dialect: AUTO_FALLBACK_DIALECT,
      source: "auto-fallback",
      notices: [{ ruleId: "schema/draft-default", severity: "info", message: `JSON Schema draft was not declared; ${schemaDialectLabel(AUTO_FALLBACK_DIALECT)} was used.`, explanation: "Add a `$schema` URI when a different draft is required." }],
    };
  }
  return {
    source: "declared",
    notices: [],
    unsupported: {
      keyword: "schema-draft",
      instancePath: "",
      schemaPath: "$schema",
      message: `Unsupported JSON Schema draft \`${declaredUri}\`. Supported drafts are ${SUPPORTED_DIALECTS.map(schemaDialectLabel).join(", ")}.`,
      params: { draft: declaredUri },
    },
  };
}

function ajvForDialect(dialect: ResolvedSchemaDialect, options: SchemaCompilerOptions): AjvCore {
  const ajvOptions = {
    allErrors: options.allErrors,
    strict: options.strict,
    strictTuples: options.strictTuples,
    strictRequired: options.strictRequired,
    verbose: options.verbose,
    validateFormats: options.validateFormats,
  };
  switch (dialect) {
    case "draft-04": return new AjvDraft04(ajvOptions) as AjvCore;
    case "draft-06": {
      // AJV 8 validates draft-06 with the draft-07 class plus the draft-06 meta-schema.
      const ajv = new Ajv(ajvOptions);
      ajv.addMetaSchema(draft6MetaSchema);
      return ajv;
    }
    case "draft-07": return new Ajv(ajvOptions);
    case "draft-2019-09": return new Ajv2019(ajvOptions);
    case "draft-2020-12": return new Ajv2020(ajvOptions);
  }
}

/**
 * Removes a `$schema` URI that does not name the effective dialect so AJV does
 * not try to resolve a foreign meta-schema. Applied only to the compilation
 * copy (references are already rewritten onto new objects by `prepareSchemas`),
 * never to the user's uploaded schema source.
 */
function stripForeignSchemaMarker(schema: unknown, dialect: ResolvedSchemaDialect): unknown {
  const object = schemaObject(schema);
  if (!object) return schema;
  const uri = declaredSchemaUri(object);
  if (uri === undefined || dialectForSchemaUri(uri) === dialect) return schema;
  const rest = Object.fromEntries(Object.entries(object).filter(([key]) => key !== "$schema"));
  return rest;
}

function serializeErrors(errors: AjvCore["errors"]): SchemaProblem[] {
  return (errors ?? []).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    message: error.message ?? "The schema constraint was not satisfied",
    params: error.params,
    ...("data" in error ? { data: error.data } : {}),
  }));
}

function normalizeDraft04Identifier(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const value = schema as JsonObject;
  if (typeof value.$id !== "string") return schema;
  const { $id, ...rest } = value;
  return { ...rest, id: $id };
}

/** Attaches targeted tuple-strictness guidance without hiding the compiler's message. */
function schemaProblem(serialized: SchemaProblem, messagePrefix?: string): SchemaProblem {
  const params = { ...serialized.params };
  if (/"(?:items|prefixItems)" is \d+-tuple/.test(serialized.message)) {
    params.hint = "This schema uses positional tuple items but does not declare its intended array length. For Draft 4–7, add `minItems` and `maxItems` and/or `additionalItems: false`. For Draft 2020-12, use `prefixItems` with appropriate item constraints. Alternatively, select Compatible validation to accept this legacy tuple style.";
  }
  if (messagePrefix) return { ...serialized, keyword: "schema-invalid", message: `${messagePrefix}: ${serialized.message}`, params };
  return { ...serialized, params };
}

type CompileRequest = SchemaValidationRequest | SchemaPreflightRequest;

interface CompilationResult {
  readonly requestId: number;
  readonly valid: boolean;
  readonly notices: SchemaNotice[];
  readonly problems: SchemaProblem[];
  readonly interpretation?: SchemaInterpretation | undefined;
  readonly validate?: ReturnType<AjvCore["compile"]> | undefined;
}

function compileSchemaRequest(request: CompileRequest): CompilationResult {
  const notices: SchemaNotice[] = [];
  try {
    const settings = parseSchemaValidationSettings(request.settings);
    const referenceMode = request.referenceMode ?? settings.referenceMode;
    const openapi = openapiVersionOf(request.primary.schema);
    const documentKind = settings.documentType === "openapi" || (settings.documentType === "auto" && openapi)
      ? `openapi-${openapi ?? "3.1"}`
      : "json-schema";
    if (settings.documentType === "openapi" && !openapi) {
      notices.push({ ruleId: "schema/openapi-assumed", severity: "warning", message: "The document does not declare an `openapi` version, but it is treated as an OpenAPI document.", explanation: "The document type was forced to OpenAPI by the Schema loading options." });
    }
    if (documentKind !== "json-schema") {
      const version = documentKind === "openapi-3.0" ? "3.0" : "3.1";
      const alignment = version === "3.1"
        ? "OpenAPI 3.1 schemas align substantially with JSON Schema Draft 2020-12, but an OpenAPI document itself is not a standalone JSON Schema."
        : "OpenAPI 3.0 uses its own Schema Object: a modified subset of JSON Schema Draft 4 with additions such as `nullable` and `discriminator`.";
      const declaredUri = declaredSchemaUri(request.primary.schema);
      return {
        requestId: request.requestId,
        valid: false,
        notices,
        problems: [{
          keyword: "schema-unsupported-document",
          instancePath: "",
          schemaPath: "",
          message: `OpenAPI ${version} documents are not validated as standalone JSON Schema. ${alignment} Extract the specific schema object (for example an entry under \`components.schemas\`) and load it as a JSON Schema document instead.`,
          params: { documentKind },
        }],
        interpretation: { effectiveDialect: "", dialectSource: "declared", documentKind, ...(declaredUri !== undefined ? { declaredDialectUri: declaredUri } : {}) },
      };
    }
    const issues = scanReferences(request.primary.schema, referenceMode, request.dependencies);
    if (issues.length) {
      return {
        requestId: request.requestId,
        valid: false,
        notices,
        problems: issues.map((issue) => ({ keyword: issue.ruleId.split("/").at(-1) ?? "reference", instancePath: "", schemaPath: "$ref", message: issue.message, params: { reference: issue.reference } })),
      };
    }
    const decision = decideDialect(request.primary.schema, settings);
    notices.push(...decision.notices);
    const declaredUri = declaredSchemaUri(request.primary.schema);
    const interpretation: SchemaInterpretation | undefined = decision.dialect
      ? { effectiveDialect: decision.dialect, dialectSource: decision.source, documentKind, ...(declaredUri !== undefined ? { declaredDialectUri: declaredUri } : {}) }
      : undefined;
    if (!decision.dialect || decision.unsupported) {
      return { requestId: request.requestId, valid: false, notices, problems: decision.unsupported ? [decision.unsupported] : [], ...(interpretation ? { interpretation } : {}) };
    }
    const compilerOptions = compilerOptionsFor(settings, decision.dialect);
    const ajv = ajvForDialect(decision.dialect, compilerOptions);
    notices.push(...addSupportedFormats(ajv, compilerOptions, [request.primary.schema, ...request.dependencies.map((dependency) => dependency.schema)]));
    const prepared = prepareSchemas(request.primary.schema, request.primary.fileName, request.dependencies);
    const draft04 = decision.dialect === "draft-04";
    for (const dependency of prepared.dependencies) ajv.addSchema(stripForeignSchemaMarker(draft04 ? normalizeDraft04Identifier(dependency.schema) : dependency.schema, decision.dialect) as AnySchema);
    const primary = stripForeignSchemaMarker(draft04 ? normalizeDraft04Identifier(prepared.primary) : prepared.primary, decision.dialect) as AnySchema;
    if (!ajv.validateSchema(primary)) return { requestId: request.requestId, valid: false, notices, problems: serializeErrors(ajv.errors).map((problem) => schemaProblem(problem, "Uploaded JSON Schema is invalid")), interpretation };
    const validate = ajv.compile(primary);
    return { requestId: request.requestId, valid: true, notices, problems: [], interpretation, validate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      requestId: request.requestId,
      valid: false,
      notices,
      problems: [schemaProblem({
        keyword: "schema-compile",
        instancePath: "",
        schemaPath: "",
        message: `JSON Schema could not be compiled: ${message}`,
        params: {},
      })],
    };
  }
}

function responseFromCompilation(compiled: CompilationResult): SchemaValidationResponse {
  return {
    requestId: compiled.requestId,
    valid: compiled.valid,
    notices: compiled.notices,
    problems: compiled.problems,
    ...(compiled.interpretation ? { interpretation: compiled.interpretation } : {}),
  };
}

let cachedCompilation: {
  readonly primary: unknown;
  readonly dependencies: readonly unknown[];
  readonly settingsKey: string;
  readonly compiled: CompilationResult;
} | undefined;

/** The most recent compilation this module produced (test hook for cache assertions). */
export let lastFreshCompilation: CompilationResult | undefined;

/** Cache key covering every effective setting that can influence compilation. */
function compilationSettingsKey(request: CompileRequest): string {
  const parsed = parseSchemaValidationSettings(request.settings);
  const referenceMode = request.referenceMode ?? parsed.referenceMode;
  const decision = decideDialect(request.primary.schema, parsed);
  const compiler = decision.dialect ? compilerCacheKey(compilerOptionsFor(parsed, decision.dialect)) : `unsupported:${declaredSchemaUri(request.primary.schema) ?? "none"}`;
  return JSON.stringify({ compiler, referenceMode });
}

function sameCompilation(request: CompileRequest): boolean {
  const cached = cachedCompilation;
  return Boolean(
    cached
    && cached.settingsKey === compilationSettingsKey(request)
    && cached.primary === request.primary.schema
    && cached.dependencies.length === request.dependencies.length
    && cached.dependencies.every((schema, index) => schema === request.dependencies[index]?.schema),
  );
}

function compileWithCache(request: CompileRequest): CompilationResult {
  if (sameCompilation(request)) return cachedCompilation!.compiled;
  const compiled = compileSchemaRequest(request);
  lastFreshCompilation = compiled;
  cachedCompilation = {
    primary: request.primary.schema,
    dependencies: request.dependencies.map((dependency) => dependency.schema),
    settingsKey: compilationSettingsKey(request),
    compiled,
  };
  return compiled;
}

export function preflightSchemaRequest(request: SchemaPreflightRequest): SchemaValidationResponse {
  return responseFromCompilation(compileWithCache(request));
}

export function validateSchemaRequest(request: SchemaValidationRequest): SchemaValidationResponse {
  // Always route through the cache: repeated validations against the same schema skip recompilation.
  const compiled = compileWithCache(request);
  if (!compiled.valid || !compiled.validate) {
    return responseFromCompilation(compiled);
  }
  const valid = compiled.validate(request.value);
  return {
    requestId: request.requestId,
    valid: Boolean(valid),
    notices: compiled.notices,
    problems: serializeErrors(compiled.validate.errors),
    ...(compiled.interpretation ? { interpretation: compiled.interpretation } : {}),
  };
}

/** Test hook: clears the cached compilation. */
export function resetSchemaCompileCacheForTests(): void {
  cachedCompilation = undefined;
  lastFreshCompilation = undefined;
}

if (typeof document === "undefined" && typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("message", (event: MessageEvent<SchemaValidationRequest | SchemaPreflightRequest>) => {
    globalThis.postMessage(event.data.kind === "preflight" ? preflightSchemaRequest(event.data) : validateSchemaRequest(event.data));
  });
}
