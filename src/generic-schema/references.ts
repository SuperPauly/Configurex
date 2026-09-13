import { dialectForSchemaUri } from "./settings";
import type { LocalSchemaFile, ReferenceIssue, ReferenceMode } from "./types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function declaredId(file: LocalSchemaFile): string | undefined {
  if (!isObject(file.schema)) return undefined;
  return typeof file.schema.$id === "string"
    ? file.schema.$id
    : typeof file.schema.id === "string"
      ? file.schema.id
      : undefined;
}

function baseReference(reference: string): string {
  return reference.split("#", 1)[0] ?? reference;
}

function aliases(file: LocalSchemaFile): readonly string[] {
  return [file.fileName, `local:///${file.fileName}`, declaredId(file)].filter((item): item is string => Boolean(item));
}

function referenceMap(dependencies: readonly LocalSchemaFile[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of dependencies) {
    const canonical = declaredId(file) ?? `local:///${file.fileName}`;
    for (const alias of aliases(file)) {
      if (result.has(alias)) throw new Error(`Duplicate local schema identifier \`${alias}\` in the uploaded bundle.`);
      result.set(alias, canonical);
    }
  }
  return result;
}

function collectReferences(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, result));
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === "string") result.push(value.$ref);
  Object.values(value).forEach((item) => collectReferences(item, result));
}

export function scanReferences(
  schema: unknown,
  mode: ReferenceMode,
  dependencies: readonly LocalSchemaFile[],
): ReferenceIssue[] {
  const references: string[] = [];
  collectReferences(schema, references);
  const lookup = referenceMap(dependencies);
  return references.flatMap((reference): ReferenceIssue[] => {
    if (reference.startsWith("#")) return [];
    if (mode === "internal") return [{
      ruleId: "schema/ref-external-blocked" as const,
      reference,
      message: `Reference \`${reference}\` is blocked in Internal only mode.`,
    }];
    const base = baseReference(reference);
    if (lookup.has(base)) return [];
    return [{
      ruleId: "schema/ref-unresolved" as const,
      reference,
      message: `Reference \`${reference}\` does not match any uploaded local schema filename or $id.`,
    }];
  });
}

/**
 * Legacy schemas (common in SchemaStore) stamp subschemas with pointer-style
 * pseudo-`$id`s such as `#/properties/foo`. These are not valid `$id` values,
 * and AJV resolves them to the same URI as the subschema's own JSON pointer
 * location, producing "reference resolves to more than one schema" failures.
 * They are dropped from the compilation copy: `$ref`s that target them still
 * resolve through ordinary pointer resolution. Name-anchor ids (`#name`),
 * which `$ref`s cannot reach via pointers, are kept untouched.
 */
function isPointerStyleFragmentId(id: string): boolean {
  return id.startsWith("#/");
}

/**
 * Some schemas embed a copy of a dialect meta-schema and stamp it with the
 * meta URI as `$id` (MockServer does this with Draft 7). AJV already
 * registers that URI, so the embedded copy collides ("reference ... resolves
 * to more than one schema"). Dropping the `$id` keeps `$ref`s to the meta URI
 * resolving to AJV's authoritative copy.
 */
function isMetaSchemaId(id: string): boolean {
  return dialectForSchemaUri(id) !== undefined;
}

function rewriteReferences(value: unknown, lookup: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteReferences(item, lookup));
  if (!isObject(value)) return value;
  const clone: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "$id" && typeof item === "string" && (isPointerStyleFragmentId(item) || isMetaSchemaId(item))) continue;
    if (key === "$ref" && typeof item === "string" && !item.startsWith("#")) {
      const [base, fragment] = item.split("#", 2);
      clone[key] = `${lookup.get(base ?? "") ?? base}${fragment === undefined ? "" : `#${fragment}`}`;
    } else {
      clone[key] = rewriteReferences(item, lookup);
    }
  }
  return clone;
}

export interface PreparedSchemas {
  readonly primary: unknown;
  readonly dependencies: readonly LocalSchemaFile[];
}

export function prepareSchemas(
  primary: unknown,
  primaryFileName: string,
  dependencies: readonly LocalSchemaFile[],
): PreparedSchemas {
  const lookup = referenceMap(dependencies);
  const rewrittenDependencies = dependencies.map((file) => {
    const schema = rewriteReferences(file.schema, lookup);
    if (!isObject(schema)) return { ...file, schema };
    const canonical = declaredId(file) ?? `local:///${file.fileName}`;
    return { ...file, schema: { ...schema, $id: canonical } };
  });
  const rewrittenPrimary = rewriteReferences(primary, lookup);
  if (!isObject(rewrittenPrimary)) return { primary: rewrittenPrimary, dependencies: rewrittenDependencies };
  return {
    primary: { ...rewrittenPrimary, $id: typeof rewrittenPrimary.$id === "string" ? rewrittenPrimary.$id : `local:///${primaryFileName}` },
    dependencies: rewrittenDependencies,
  };
}
