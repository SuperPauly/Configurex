import Ajv, { type AnySchema } from "ajv";
import type AjvCore from "ajv/dist/core";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";

import { prepareSchemas, scanReferences } from "./references";
import type { SchemaNotice, SchemaPreflightRequest, SchemaProblem, SchemaValidationRequest, SchemaValidationResponse } from "./types";

type JsonObject = Record<string, unknown>;

const STANDARD_FORMATS = new Set([
  "date", "time", "date-time", "duration", "uri", "uri-reference", "uri-template", "url",
  "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "relative-json-pointer",
  "byte", "float", "password", "binary",
]);

const CODEX_NUMERIC_FORMATS = new Set(["uint", "uint16", "uint32", "uint64", "int32", "int64", "double"]);

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

function addSupportedFormats(ajv: AjvCore, schemas: readonly unknown[]): SchemaNotice[] {
  addFormats(ajv);
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
  for (const format of custom) ajv.addFormat(format, true);
  return custom.length ? [{
    ruleId: "schema/format-annotation",
    severity: "info",
    message: `${custom.length} custom schema ${custom.length === 1 ? "format is" : "formats are"} treated as annotations.`,
    explanation: `Structural validation still ran, but application-specific format semantics were not asserted: ${custom.join(", ")}.`,
  }] : [];
}

function ajvFor(schema: unknown, relatedSchemas: readonly unknown[]): { ajv?: AjvCore; notices: SchemaNotice[]; unsupported?: SchemaProblem } {
  const uri = schemaObject(schema)?.$schema;
  const options = {
    allErrors: true,
    strict: true,
    strictRequired: false,
    verbose: true,
    validateFormats: true,
  } as const;
  let ajv: AjvCore;
  if (uri === undefined) {
    ajv = new Ajv2020(options);
    const notices = addSupportedFormats(ajv, [schema, ...relatedSchemas]);
    return { ajv, notices: [{ ruleId: "schema/draft-default", severity: "info", message: "JSON Schema draft was not declared; Draft 2020-12 was used.", explanation: "Add a `$schema` URI when a different draft is required." }, ...notices] };
  }
  const value = String(uri);
  if (/draft-04/.test(value)) ajv = new AjvDraft04(options) as AjvCore;
  else if (/draft-07/.test(value)) ajv = new Ajv(options);
  else if (/2019-09/.test(value)) ajv = new Ajv2019(options);
  else if (/2020-12/.test(value)) ajv = new Ajv2020(options);
  else return { notices: [], unsupported: { keyword: "schema-draft", instancePath: "", schemaPath: "$schema", message: `Unsupported JSON Schema draft \`${value}\`. Supported drafts are 4, 7, 2019-09, and 2020-12.`, params: { draft: value } } };
  return { ajv, notices: addSupportedFormats(ajv, [schema, ...relatedSchemas]) };
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

type CompileRequest = SchemaValidationRequest | SchemaPreflightRequest;

function compileSchemaRequest(request: CompileRequest) {
  const notices: SchemaNotice[] = [];
  try {
    const referenceIssues = scanReferences(request.primary.schema, request.referenceMode, request.dependencies);
    if (referenceIssues.length) return {
      requestId: request.requestId,
      valid: false,
      notices,
      problems: referenceIssues.map((issue) => ({ keyword: issue.ruleId.split("/").at(-1) ?? "reference", instancePath: "", schemaPath: "$ref", message: issue.message, params: { reference: issue.reference } })),
    };
    const { ajv, notices: formatNotices, unsupported } = ajvFor(request.primary.schema, request.dependencies.map((dependency) => dependency.schema));
    notices.push(...formatNotices);
    if (!ajv || unsupported) return { requestId: request.requestId, valid: false, notices, problems: unsupported ? [unsupported] : [] };
    const prepared = prepareSchemas(request.primary.schema, request.primary.fileName, request.dependencies);
    const draft04 = /draft-04/.test(String(schemaObject(request.primary.schema)?.$schema ?? ""));
    for (const dependency of prepared.dependencies) ajv.addSchema((draft04 ? normalizeDraft04Identifier(dependency.schema) : dependency.schema) as AnySchema);
    const primary = (draft04 ? normalizeDraft04Identifier(prepared.primary) : prepared.primary) as AnySchema;
    if (!ajv.validateSchema(primary)) return { requestId: request.requestId, valid: false, notices, problems: serializeErrors(ajv.errors).map((problem) => ({ ...problem, keyword: "schema-invalid", message: `Uploaded JSON Schema is invalid: ${problem.message}` })) };
    const validate = ajv.compile(primary);
    return { requestId: request.requestId, valid: true, notices, problems: [], validate };
  } catch (error) {
    return {
      requestId: request.requestId,
      valid: false,
      notices,
      problems: [{
        keyword: "schema-compile",
        instancePath: "",
        schemaPath: "",
        message: `JSON Schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
        params: {},
      }],
    };
  }
}

function responseFromCompilation(compiled: ReturnType<typeof compileSchemaRequest>): SchemaValidationResponse {
  return {
    requestId: compiled.requestId,
    valid: compiled.valid,
    notices: compiled.notices,
    problems: compiled.problems,
  };
}

let cachedCompilation: {
  readonly primary: unknown;
  readonly dependencies: readonly unknown[];
  readonly referenceMode: string;
  readonly compiled: ReturnType<typeof compileSchemaRequest>;
} | undefined;

function sameCompilation(request: CompileRequest): boolean {
  const cached = cachedCompilation;
  return Boolean(
    cached
    && cached.referenceMode === request.referenceMode
    && cached.primary === request.primary.schema
    && cached.dependencies.length === request.dependencies.length
    && cached.dependencies.every((schema, index) => schema === request.dependencies[index]?.schema),
  );
}

function compileWithCache(request: CompileRequest): ReturnType<typeof compileSchemaRequest> {
  if (sameCompilation(request)) return cachedCompilation!.compiled;
  const compiled = compileSchemaRequest(request);
  cachedCompilation = { primary: request.primary.schema, dependencies: request.dependencies.map((dependency) => dependency.schema), referenceMode: request.referenceMode, compiled };
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
  };
}

if (typeof document === "undefined" && typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("message", (event: MessageEvent<SchemaValidationRequest | SchemaPreflightRequest>) => {
    globalThis.postMessage(event.data.kind === "preflight" ? preflightSchemaRequest(event.data) : validateSchemaRequest(event.data));
  });
}
