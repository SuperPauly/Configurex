import type { ConfigFormat, SchemaFormat } from "./types";

export interface FormatDetection {
  readonly format: ConfigFormat | undefined;
  readonly confidence: "extension" | "content" | "none";
  readonly ambiguous: boolean;
}

const EXTENSIONS: Readonly<Record<string, ConfigFormat>> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
};

export const SCHEMA_EXTENSIONS: Readonly<Record<string, SchemaFormat>> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
};

export interface SchemaDetection {
  readonly format: SchemaFormat | undefined;
  readonly schemaKind: "jsonschema" | "openapi" | "unknown";
}

function schemaKindFor(value: unknown): "jsonschema" | "openapi" | "unknown" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const record = value as Record<string, unknown>;
  if (typeof record.openapi === "string" || typeof record.swagger === "string") return "openapi";
  if (typeof record.$schema === "string" || typeof record.$ref === "string" || typeof record.$defs === "object" || typeof record.definitions === "object") return "jsonschema";
  return "unknown";
}

export function detectSchemaFormat(fileName: string | undefined, value: unknown): SchemaDetection {
  const extension = fileName?.toLowerCase().match(/\.([^.]+)$/)?.[1];
  const format = extension ? SCHEMA_EXTENSIONS[extension] : undefined;
  const schemaKind = schemaKindFor(value);
  if (format) return { format, schemaKind: schemaKind === "unknown" ? "jsonschema" : schemaKind };
  return { format, schemaKind };
}

export function detectFormat(fileName: string | undefined, source: string): FormatDetection {
  const extension = fileName?.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (extension && EXTENSIONS[extension]) {
    return { format: EXTENSIONS[extension], confidence: "extension", ambiguous: false };
  }
  const trimmed = source.trim();
  if (!trimmed) return { format: undefined, confidence: "none", ambiguous: true };
  if (/^[{[]/.test(trimmed)) {
    return { format: "json", confidence: "content", ambiguous: false };
  }
  const firstMeaningful = trimmed.split(/\r?\n/).find((line) => !/^\s*(?:#|$)/.test(line)) ?? "";
  if (/^\s*(?:\[[^\]]+\]\s*$|[A-Za-z0-9_."'-]+\s*=)/.test(firstMeaningful)) {
    return { format: "toml", confidence: "content", ambiguous: false };
  }
  if (/^\s*(?:---\s*$|[-?]?\s*[A-Za-z0-9_."']+\s*:)/.test(firstMeaningful)) {
    return { format: "yaml", confidence: "content", ambiguous: false };
  }
  return { format: undefined, confidence: "none", ambiguous: true };
}
