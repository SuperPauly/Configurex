import { describe, expect, it, vi } from "vitest";

import type { TomlEngine } from "../taplo/service";
import { detectSchemaFormat } from "./detect";
import { isYamlDocument, parseSchemaText, serializeSchema } from "./schema";

const engine: TomlEngine = {
  validate: vi.fn(async () => ({ diagnostics: [] })),
  format: vi.fn((source: string) => source),
  decode: vi.fn((source: string) => ({ title: source.match(/"(.*)"/)?.[1] ?? "Demo" })),
  encode: vi.fn(() => 'title = "Demo"\n'),
};

describe("parseSchemaText", () => {
  it("parses JSON regardless of hint", () => {
    expect(parseSchemaText('{"type":"object"}')).toEqual({ type: "object" });
    expect(parseSchemaText('{"type":"object"}', "schema.json")).toEqual({ type: "object" });
  });

  it("parses YAML by extension and by fallback", () => {
    expect(parseSchemaText("type: object\n", "schema.yaml")).toEqual({ type: "object" });
    expect(parseSchemaText("type: object\n")).toEqual({ type: "object" });
  });

  it("parses TOML with the engine when hinted", () => {
    expect(parseSchemaText('title = "Typed"\n', "schema.toml", engine)).toEqual({ title: "Typed" });
  });

  it("strips a byte order mark before parsing", () => {
    expect(parseSchemaText("﻿{\"type\":\"string\"}")).toEqual({ type: "string" });
  });

  it("rejects text that is neither JSON nor YAML", () => {
    expect(() => parseSchemaText("{a: ")).toThrow(/not valid JSON or YAML/);
  });
});

describe("serializeSchema", () => {
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };

  it("serializes JSON Schema as JSON and YAML", () => {
    expect(serializeSchema(schema, { format: "json" })).toContain('"$schema"');
    expect(serializeSchema(schema, { format: "yaml" })).toContain("$schema:");
  });

  it("converts a JSON Schema to an OpenAPI document", () => {
    const text = serializeSchema(schema, { format: "yaml", target: "openapi" });
    expect(text).toContain("openapi: 3.1.0");
    expect(text).not.toContain("$schema:");
  });

  it("converts an OpenAPI document back to a JSON Schema", () => {
    const text = serializeSchema({ openapi: "3.0.3", info: { title: "Demo" } }, { format: "json", target: "jsonschema" });
    expect(text).toContain('"$schema"');
    expect(text).not.toContain('"openapi"');
  });

  it("serializes TOML through the engine", () => {
    expect(serializeSchema(schema, { format: "toml", engine })).toBe('title = "Demo"\n');
    expect(engine.encode).toHaveBeenCalled();
  });

  it("rejects non-object roots", () => {
    expect(() => serializeSchema([1, 2], { format: "json" })).toThrow(/object at the document root/);
  });
});

describe("isYamlDocument", () => {
  it("accepts YAML and JSON, rejects broken text", () => {
    expect(isYamlDocument("type: object\n")).toBe(true);
    expect(isYamlDocument('{"type":"object"}')).toBe(true);
    expect(isYamlDocument("{a: ")).toBe(false);
  });
});

describe("detectSchemaFormat", () => {
  it("detects JSON Schema and OpenAPI documents", () => {
    expect(detectSchemaFormat("schema.json", { $schema: "https://json-schema.org/draft/2020-12/schema" })).toEqual({ format: "json", schemaKind: "jsonschema" });
    expect(detectSchemaFormat("api.yaml", { openapi: "3.1.0" })).toEqual({ format: "yaml", schemaKind: "openapi" });
    expect(detectSchemaFormat("api.yml", { swagger: "2.0" }).schemaKind).toBe("openapi");
  });

  it("defaults unknown objects to JSON Schema when an extension is present", () => {
    expect(detectSchemaFormat("schema.toml", { title: "x" })).toEqual({ format: "toml", schemaKind: "jsonschema" });
    expect(detectSchemaFormat(undefined, { title: "x" })).toEqual({ format: undefined, schemaKind: "unknown" });
  });
});
