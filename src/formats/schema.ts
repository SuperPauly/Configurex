import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { TomlEngine } from "../taplo/service";
import type { SchemaFormat } from "./types";

const FINAL_NEWLINE = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

/** True when the string is valid YAML (JSON is a subset, so this is always true for JSON too). */
export function isYamlDocument(raw: string): boolean {
  try { parseYaml(raw.startsWith("﻿") ? raw.slice(1) : raw); return true; } catch { return false; }
}

/**
 * Parses schema text written as JSON, YAML, or TOML. The `hint` parameter is
 * a file name or explicit format used to pick the parser; JSON is always
 * tried first because it is a subset of YAML and cheap to reject.
 */
export function parseSchemaText(raw: string, hint?: string, engine?: TomlEngine): unknown {
  const cleaned = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const extension = hint?.toLowerCase().match(/\.([^.]+)$/)?.[1];

  if (extension === "toml") {
    if (!engine) throw new Error("TOML schemas need the TOML engine to be ready.");
    return engine.decode(cleaned);
  }
  if (extension === "yaml" || extension === "yml") return parseYaml(cleaned);
  if (extension === "json") return JSON.parse(cleaned) as unknown;

  try {
    return JSON.parse(cleaned) as unknown;
  } catch (jsonError) {
    try {
      return parseYaml(cleaned) as unknown;
    } catch {
      const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
      throw new Error(`not valid JSON or YAML: ${message}`, { cause: jsonError });
    }
  }
}

function assertSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("The schema must be an object at the document root.");
  return value as Record<string, unknown>;
}

/** Rewrites the top-level dialect/openapi marker so the saved file reads as the requested kind. */
function retarget(value: Record<string, unknown>, target: "jsonschema" | "openapi"): Record<string, unknown> {
  if (target === "openapi") {
    const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema"));
    return { openapi: typeof value.openapi === "string" ? value.openapi : "3.1.0", ...rest };
  }
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "openapi"));
  return { $schema: typeof value.$schema === "string" ? value.$schema : "https://json-schema.org/draft/2020-12/schema", ...rest };
}

export interface SerializeSchemaOptions {
  readonly format: SchemaFormat;
  readonly target?: "jsonschema" | "openapi";
  readonly engine?: TomlEngine;
}

/**
 * Serializes a schema as JSON, YAML, or TOML, optionally re-marking it as a
 * JSON Schema or OpenAPI document.
 */
export function serializeSchema(value: unknown, options: SerializeSchemaOptions): string {
  const object = assertSchemaObject(value);
  const target = options.target ?? (typeof object.openapi === "string" ? "openapi" : "jsonschema");
  const prepared = retarget(object, target);
  if (options.format === "json") return `${JSON.stringify(prepared, null, 2)}\n`;
  if (options.format === "yaml") return FINAL_NEWLINE(stringifyYaml(prepared, { lineWidth: 100 }));
  if (!options.engine) throw new TypeError("TOML output needs the TOML engine to be ready.");
  return FINAL_NEWLINE(options.engine.format(options.engine.encode(prepared)));
}

export function schemaFileExtension(format: SchemaFormat): string {
  return format;
}
