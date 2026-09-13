import Ajv, { type AnySchema } from "ajv";
import type AjvCore from "ajv/dist/core";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import AjvDraft04 from "ajv-draft-04";
import addErrors from "ajv-errors";
import addFormats from "ajv-formats";
import addKeywords from "ajv-keywords";
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

/**
 * Consumer-mode AJV relaxations applied when Strict authoring checks reject a
 * document that is spec-valid for validation purposes (unknown vendor
 * keywords, legacy tuples, overlapping patternProperties). Strict findings are
 * then surfaced as warnings instead of blocking the load.
 */
interface ConsumerRelaxations {
  readonly strict: boolean;
  readonly strictTuples: boolean;
  readonly strictRequired: boolean;
  readonly allowMatchingProperties: boolean;
}

const RELAXED_CONSUMER_MODE: ConsumerRelaxations = { strict: false, strictTuples: false, strictRequired: false, allowMatchingProperties: true };

function ajvForDialect(
  dialect: ResolvedSchemaDialect,
  options: SchemaCompilerOptions,
  relaxations: ConsumerRelaxations = { strict: options.strict, strictTuples: options.strictTuples, strictRequired: options.strictRequired, allowMatchingProperties: false },
  skipMetaValidation = false,
): AjvCore {
  const ajvOptions = {
    allErrors: options.allErrors,
    strict: relaxations.strict,
    strictTuples: relaxations.strictTuples,
    strictRequired: relaxations.strictRequired,
    verbose: options.verbose,
    validateFormats: options.validateFormats,
    allowUnionTypes: true,
    allowMatchingProperties: relaxations.allowMatchingProperties,
    ...(skipMetaValidation ? { validateSchema: false as const } : {}),
  };
  let ajv: AjvCore;
  switch (dialect) {
    case "draft-04": ajv = new AjvDraft04(ajvOptions) as AjvCore; break;
    case "draft-06": {
      // AJV 8 validates draft-06 with the draft-07 class plus the draft-06 meta-schema.
      ajv = new Ajv(ajvOptions);
      ajv.addMetaSchema(draft6MetaSchema);
      break;
    }
    case "draft-07": ajv = new Ajv(ajvOptions); break;
    case "draft-2019-09": ajv = new Ajv2019(ajvOptions); break;
    case "draft-2020-12": ajv = new Ajv2020(ajvOptions); break;
  }
  addKeywords(ajv, ["regexp", "range", "exclusiveRange", "uniqueItemProperties"]);
  if (options.allErrors) addErrors(ajv);
  return ajv;
}

/**
 * Removes a `$schema` URI that does not name the effective dialect so AJV does
 * not try to resolve a foreign meta-schema. For Draft 4 the marker is removed
 * even when it matches: ajv-draft-04 only registers the http form of the meta
 * URI, so schemas declaring the equivalent https form (common in SchemaStore)
 * fail to resolve unless the declaration is dropped from the compilation copy.
 * Applied only to that copy (already cloned by `prepareSchemas`), never to the
 * user's uploaded schema source.
 */
function stripForeignSchemaMarker(schema: unknown, dialect: ResolvedSchemaDialect): unknown {
  const object = schemaObject(schema);
  if (!object) return schema;
  const uri = declaredSchemaUri(object);
  if (uri === undefined) return schema;
  const declared = dialectForSchemaUri(uri);
  // Draft 4 always drops the marker: ajv-draft-04 only registers the http form
  // of the meta URI, so the equivalent https form (common in SchemaStore)
  // fails to resolve unless the declaration is dropped from the compile copy.
  if (declared === dialect && dialect !== "draft-04") return schema;
  return stripSchemaKey(object);
}

function stripSchemaKey(object: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([key]) => key !== "$schema"));
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

/** Root-level keywords proving a document intends to be a JSON Schema. */
const SCHEMA_VOCABULARY_KEYS = new Set([
  "type", "properties", "items", "required", "enum", "const", "allOf", "anyOf", "oneOf", "not",
  "$ref", "$defs", "definitions", "patternProperties", "additionalProperties", "propertyNames",
  "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
  "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "multipleOf",
  "dependencies", "dependentRequired", "dependentSchemas", "if", "then", "else", "contains",
  "minContains", "maxContains", "prefixItems", "unevaluatedProperties", "unevaluatedItems",
  "$anchor", "$comment", "examples",
]);

function isStrictModeError(error: unknown): boolean {
  return error instanceof Error && /^strict mode:/.test(error.message);
}

function tupleHint(message: string): string {
  return /"(?:items|prefixItems)" is \d+-tuple/.test(message)
    ? " This schema uses positional tuple items without declaring an intended array length; consider `minItems`/`maxItems` or Draft 2020-12 `prefixItems`."
    : "";
}

function usesSchemaVocabulary(schema: unknown): boolean {
  const object = schemaObject(schema);
  if (!object) return false;
  return Object.keys(object).some((key) => SCHEMA_VOCABULARY_KEYS.has(key));
}

function isCompilablePattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function replaceUnresolvableRef(schema: unknown, reference: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => replaceUnresolvableRef(item, reference));
  const object = schemaObject(schema);
  if (!object) return schema;
  // The whole subschema becomes permissive `true`, not `$ref: true` (which is
  // itself an invalid $ref value); draft-07 ignores $ref siblings anyway.
  if (object.$ref === reference) return true;
  const clone: JsonObject = {};
  for (const [key, value] of Object.entries(object)) clone[key] = replaceUnresolvableRef(value, reference);
  return clone;
}

/**
 * Published schemas sometimes carry `pattern`/`patternProperties` values with
 * escapes that are invalid in ECMAScript regexes (double-escaped classes,
 * `\_`, trailing regex-literal slashes). AJV throws on such patterns, so they
 * are dropped from the compilation copy and reported as a warning; every
 * other constraint keeps validating.
 */
function stripInvalidPatterns(schema: unknown, removed: string[]): unknown {
  if (Array.isArray(schema)) return schema.map((item) => stripInvalidPatterns(item, removed));
  const object = schemaObject(schema);
  if (!object) return schema;
  const clone: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (key === "pattern" && typeof value === "string" && !isCompilablePattern(value)) {
      removed.push(value);
      continue;
    }
    if (key === "patternProperties" && value && typeof value === "object" && !Array.isArray(value)) {
      const kept: JsonObject = {};
      for (const [pattern, subschema] of Object.entries(value as JsonObject)) {
        if (isCompilablePattern(pattern)) kept[pattern] = subschema;
        else removed.push(pattern);
      }
      clone[key] = stripInvalidPatterns(kept, removed);
      continue;
    }
    clone[key] = stripInvalidPatterns(value, removed);
  }
  return clone;
}

function compileSchemaRequest(request: CompileRequest): CompilationResult {
  const notices: SchemaNotice[] = [];
  let attemptNotices: SchemaNotice[] = [];
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
    let prepared = prepareSchemas(request.primary.schema, request.primary.fileName, request.dependencies);
    const removedPatterns: string[] = [];
    const sanitizedPrimary = stripInvalidPatterns(prepared.primary, removedPatterns);
    const sanitizedDependencies = prepared.dependencies.map((dependency) => ({ ...dependency, schema: stripInvalidPatterns(dependency.schema, removedPatterns) }));
    if (removedPatterns.length) prepared = { primary: sanitizedPrimary, dependencies: sanitizedDependencies };
    if (removedPatterns.length) {
      notices.push({
        ruleId: "schema/invalid-pattern",
        severity: "warning",
        message: `${removedPatterns.length} invalid regular expression${removedPatterns.length === 1 ? " was" : "s were"} ignored: ${removedPatterns.slice(0, 3).map((pattern) => `\`${pattern}\``).join(", ")}${removedPatterns.length > 3 ? ", …" : ""}`,
        explanation: "These pattern values are not valid ECMAScript regular expressions, so the constraints were dropped; all other validation still applies.",
      });
    }
    const draft04 = decision.dialect === "draft-04";
    const dialect = decision.dialect;

    const attempt = (relaxed: boolean, skipMetaValidation = false): { validate?: ReturnType<AjvCore["compile"]>; problems?: SchemaProblem[] } => {
      const ajv = ajvForDialect(dialect, compilerOptions, relaxed ? RELAXED_CONSUMER_MODE : undefined, skipMetaValidation);
      attemptNotices = addSupportedFormats(ajv, compilerOptions, [request.primary.schema, ...request.dependencies.map((dependency) => dependency.schema)]);
      for (const dependency of prepared.dependencies) ajv.addSchema(stripForeignSchemaMarker(draft04 ? normalizeDraft04Identifier(dependency.schema) : dependency.schema, dialect) as AnySchema);
      const primary = stripForeignSchemaMarker(draft04 ? normalizeDraft04Identifier(prepared.primary) : prepared.primary, dialect) as AnySchema;
      if (!skipMetaValidation && !ajv.validateSchema(primary)) return { problems: serializeErrors(ajv.errors).map((problem) => schemaProblem(problem, "Uploaded JSON Schema is invalid")) };
      return { validate: ajv.compile(primary) };
    };

    // A document with no `$schema` and no schema vocabulary is a plain data
    // file (for example an API model catalog); strict keyword checks cannot
    // apply, so it compiles directly in consumer mode with an explicit notice.
    if (declaredUri === undefined && !usesSchemaVocabulary(request.primary.schema)) {
      notices.push({
        ruleId: "schema/plain-document",
        severity: "warning",
        message: "This document declares no `$schema` and uses no JSON Schema keywords, so it compiles to a schema that accepts any JSON.",
        explanation: "Configurex loaded it without strict keyword checks. Add a `$schema` URI and schema keywords such as `type` or `properties` if this file is meant to constrain documents.",
      });
      const compiled = attempt(true);
      if (compiled.problems) return { requestId: request.requestId, valid: false, notices: [...notices, ...attemptNotices], problems: compiled.problems, interpretation };
      return { requestId: request.requestId, valid: true, notices: [...notices, ...attemptNotices], problems: [], interpretation, validate: compiled.validate };
    }

    // Retry ladder: spec-valid schemas routinely trip AJV Strict authoring
    // checks (unknown vendor keywords, legacy tuples) and published schemas
    // sometimes $ref definitions that do not exist. Each round either compiles,
    // flips one switch to consumer mode, or neutralizes one broken reference,
    // and the affected constructs are reported as warnings.
    let consumerMode = false;
    let strictNoticeAdded = false;
    let skipMetaValidation = false;
    let metaProblems: SchemaProblem[] | undefined;
    let lastError: string | undefined;
    const droppedReferences: string[] = [];
    for (let round = 0; round < 40; round++) {
      try {
        const compiled = attempt(consumerMode, skipMetaValidation);
        if (compiled.problems) {
          // Schemas that embed a dialect meta-schema (or describe JSON-Schema-like
          // documents with a `$ref` data property) violate the meta-schema while
          // still compiling correctly; retry once without meta validation before
          // declaring the document invalid.
          if (!skipMetaValidation) {
            skipMetaValidation = true;
            metaProblems = compiled.problems;
            continue;
          }
          return { requestId: request.requestId, valid: false, notices: [...notices, ...attemptNotices], problems: compiled.problems, interpretation };
        }
        if (droppedReferences.length) {
          notices.push({
            ruleId: "schema/unresolvable-ref",
            severity: "warning",
            message: `${droppedReferences.length} unresolvable $ref${droppedReferences.length === 1 ? "" : "s"} were treated as permissive: ${droppedReferences.slice(0, 3).map((reference) => `\`${reference}\``).join(", ")}${droppedReferences.length > 3 ? ", …" : ""}`,
            explanation: "These references point at definitions that do not exist in the schema, so the affected locations accept any value; all other validation still applies.",
          });
          droppedReferences.length = 0;
        }
        if (metaProblems) {
          notices.push({
            ruleId: "schema/meta-nonconformant",
            severity: "warning",
            message: `The schema does not fully conform to its meta-schema and was loaded best-effort: ${metaProblems[0]?.message ?? "meta-schema validation failed"}`,
            explanation: "Compilation and validation still ran; treat results for the affected constructs as best-effort. Common causes are schemas that embed a copy of a dialect meta-schema or define a data property named `$ref`.",
          });
          metaProblems = undefined;
        }
        return { requestId: request.requestId, valid: true, notices: [...notices, ...attemptNotices], problems: [], interpretation, validate: compiled.validate };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === lastError) throw error;
        lastError = message;
        if (isStrictModeError(error)) {
          if (!strictNoticeAdded) {
            strictNoticeAdded = true;
            notices.push({
              ruleId: "schema/strict-relaxed",
              severity: "warning",
              message: `Strict schema checks were relaxed to load this document: ${message}`,
              explanation: `The schema compiles and validates correctly, but it does not satisfy Strict authoring checks.${tupleHint(message)} Switch to the Compatible or Permissive preset to silence this warning.`,
            });
          }
          consumerMode = true;
          continue;
        }
        const unresolvable = /(?:can't resolve reference|can't resolve ref) (.+?) from id /.exec(message)?.[1];
        if (unresolvable && !droppedReferences.includes(unresolvable) && droppedReferences.length < 20) {
          droppedReferences.push(unresolvable);
          prepared = {
            primary: replaceUnresolvableRef(prepared.primary, unresolvable),
            dependencies: prepared.dependencies.map((dependency) => ({ ...dependency, schema: replaceUnresolvableRef(dependency.schema, unresolvable) })),
          };
          continue;
        }
        // The meta-validation skip did not rescue the schema: report the
        // original meta-schema findings instead of the raw compiler error.
        if (metaProblems) {
          const problems = metaProblems;
          metaProblems = undefined;
          return { requestId: request.requestId, valid: false, notices: [...notices, ...attemptNotices], problems, interpretation };
        }
        throw error;
      }
    }
    throw new Error("JSON Schema could not be compiled after exhausting compatibility retries.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      requestId: request.requestId,
      valid: false,
      notices: [...notices, ...attemptNotices],
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
  if (sameCompilation(request)) return { ...cachedCompilation!.compiled, requestId: request.requestId };
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
