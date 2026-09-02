import { displayValue, rangeFromOffsets } from "../diagnostics/location";
import type { Diagnostic, SourceRange } from "../diagnostics/types";
import type { SchemaProblem } from "./types";

export interface SchemaDiagnosticContext {
  readonly source: string;
  readonly value: unknown;
  readonly locations: ReadonlyMap<string, SourceRange>;
  readonly knownPropertyNames?: ReadonlySet<string>;
}

export function schemaPropertyNames(schema: unknown, names = new Set<string>()): ReadonlySet<string> {
  if (!schema || typeof schema !== "object") return names;
  if (Array.isArray(schema)) { for (const item of schema) schemaPropertyNames(item, names); return names; }
  for (const [key, child] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const propertyName of Object.keys(child as Record<string, unknown>)) names.add(propertyName);
    }
    schemaPropertyNames(child, names);
  }
  return names;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  return pointer.split("/").slice(1).reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return (current as Record<string, unknown>)[key];
  }, value);
}

function nearestRange(context: SchemaDiagnosticContext, path: string): SourceRange {
  let candidate = path;
  while (candidate) {
    const range = context.locations.get(candidate);
    if (range) return range;
    candidate = candidate.slice(0, candidate.lastIndexOf("/"));
  }
  return context.locations.get("") ?? rangeFromOffsets(context.source, 0, Math.min(1, context.source.length));
}

function expectation(problem: SchemaProblem): string | undefined {
  if (problem.keyword === "type") return String(problem.params.type ?? "the required type");
  if (problem.keyword === "enum") return `one of ${displayValue(problem.params.allowedValues ?? problem.params)}`;
  if (problem.keyword === "format") return `format ${String(problem.params.format ?? "required by the schema")}`;
  if (["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(problem.keyword)) return `${problem.keyword} ${String(problem.params.limit ?? "")}`.trim();
  return undefined;
}

export function translateSchemaProblem(problem: SchemaProblem, context: SchemaDiagnosticContext): Diagnostic {
  const additional = typeof problem.params.additionalProperty === "string" ? problem.params.additionalProperty : undefined;
  const missing = typeof problem.params.missingProperty === "string" ? problem.params.missingProperty : undefined;
  const dataPath = additional ? `${problem.instancePath}/${escapePointer(additional)}` : problem.instancePath;
  const range = nearestRange(context, dataPath);
  const actualValue = problem.data ?? valueAtPointer(context.value, dataPath);
  const base = {
    ...range,
    severity: "error" as const,
    source: "schema" as const,
    ruleId: `schema/${problem.keyword}`,
    dataPath,
    schemaPath: problem.schemaPath,
  };
  if (problem.keyword === "schema-compile" || problem.keyword === "schema-invalid" || problem.keyword === "schema-draft" || problem.keyword === "schema-unsupported-document") {
    const tupleHint = typeof problem.params.hint === "string" ? problem.params.hint : undefined;
    const schemaLevel = problem.keyword === "schema-invalid" || problem.keyword === "schema-compile";
    return {
      ...base,
      hasSourceLocation: false,
      message: problem.message,
      explanation: schemaLevel
        ? tupleHint ?? "The uploaded JSON Schema could not be used, so the configuration itself was not validated against it."
        : problem.keyword === "schema-draft"
          ? "The declared JSON Schema draft is not one Configurex can validate. Pick a supported Schema dialect override in the Schema validation settings to compile it anyway."
          : "This document type is not a standalone JSON Schema, so whole-document validation would be inaccurate.",
      suggestion: schemaLevel
        ? tupleHint ? "Declare the intended tuple length or switch to the Compatible preset, then run validation again." : "Correct the uploaded JSON Schema, then run validation again."
        : problem.keyword === "schema-draft"
          ? "Choose the intended draft under Schema dialect, or fix the `$schema` URI in the schema."
          : "Extract the specific schema object (for example from `components.schemas`) and load it as a JSON Schema document.",
    };
  }
  if (problem.keyword === "required" && missing) return {
    ...base,
    message: `Missing required property \`${missing}\` at \`${problem.instancePath || "/"}\`.`,
    explanation: `The JSON Schema lists \`${missing}\` as mandatory for this object.`,
    suggestion: `Add \`${missing}\` to \`${problem.instancePath || "/"}\` using the type required by the schema.`,
    expected: `property \`${missing}\``,
    actual: "property is absent",
  };
  if (problem.keyword === "additionalProperties" && additional) return {
    ...base,
    kind: context.knownPropertyNames?.has(additional) ? "wrong-table" : "unknown-key",
    message: context.knownPropertyNames?.has(additional) ? `Property \`${additional}\` is under the wrong table at \`${problem.instancePath || "/"}\`.` : `Unknown property \`${additional}\` at \`${problem.instancePath || "/"}\`.`,
    explanation: context.knownPropertyNames?.has(additional) ? "The selected schema recognizes this key, but it is not allowed inside this object or table." : "The selected schema does not declare this key for any configuration table.",
    suggestion: context.knownPropertyNames?.has(additional) ? `Move \`${additional}\` to the table where the selected schema declares it.` : `Remove \`${additional}\` or correct its spelling.`,
    expected: "only properties declared by the schema",
    actual: additional,
  };
  const expected = expectation(problem);
  if (problem.keyword === "type") return {
    ...base,
    message: `Wrong value type at \`${dataPath || "/"}\`: expected ${expected}.`,
    explanation: `The value is ${actualValue === null ? "null" : Array.isArray(actualValue) ? "an array" : `a ${typeof actualValue}`}, but the schema requires ${expected}.`,
    suggestion: `Replace the value with ${expected === "string" ? "quoted text" : `a valid ${expected} value`}.`,
    ...(expected ? { expected } : {}),
    actual: displayValue(actualValue),
    kind: "wrong-type",
  };
  return {
    ...base,
    message: `Schema rule \`${problem.keyword}\` failed at \`${dataPath || "/"}\`: ${problem.message}.`,
    explanation: `The value does not satisfy the JSON Schema keyword \`${problem.keyword}\`.`,
    suggestion: expected ? `Change the value to satisfy ${expected}.` : "Review the linked schema path and correct the highlighted value.",
    ...(expected ? { expected } : {}),
    actual: displayValue(actualValue),
  };
}
