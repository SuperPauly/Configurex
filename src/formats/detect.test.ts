import { describe, expect, it } from "vitest";

import { detectFormat } from "./detect";

describe("detectFormat", () => {
  it("prefers a supported filename extension", () => {
    expect(detectFormat("config.yaml", "name: Paul\n")).toEqual({ format: "yaml", confidence: "extension", ambiguous: false });
    expect(detectFormat("CONFIG.JSON", "name: Paul\n").format).toBe("json");
  });

  it("recognizes schema-style filenames with compound extensions", () => {
    expect(detectFormat("config.schema.json", "{}").format).toBe("json");
    expect(detectFormat("openapi.yaml", "openapi: 3.1.0\n").format).toBe("yaml");
  });

  it("recognizes pasted JSON, YAML, and TOML conservatively", () => {
    expect(detectFormat(undefined, '{"name":"Paul"}')).toEqual({ format: "json", confidence: "content", ambiguous: false });
    expect(detectFormat(undefined, "name: Paul\n").format).toBe("yaml");
    expect(detectFormat(undefined, 'name = "Paul"\n').format).toBe("toml");
  });

  it("marks empty content as ambiguous", () => {
    expect(detectFormat(undefined, "  \n")).toEqual({ format: undefined, confidence: "none", ambiguous: true });
  });
});
