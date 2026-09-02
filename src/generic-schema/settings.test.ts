import { describe, expect, it } from "vitest";

import {
  compilerOptionsFor,
  dialectForSchemaUri,
  isReducedValidation,
  loadSchemaValidationSettings,
  openapiVersionOf,
  parseSchemaValidationSettings,
  presetForSettings,
  reducedValidationNotice,
  saveSchemaValidationSettings,
  schemaValidationSettingsForPreset,
  SCHEMA_VALIDATION_SETTINGS_KEY,
  STRICT_SCHEMA_VALIDATION_SETTINGS,
  withSchemaValidationPatch,
} from "./settings";

describe("schema validation settings model", () => {
  it("uses Strict defaults for all new sessions", () => {
    expect(STRICT_SCHEMA_VALIDATION_SETTINGS).toEqual({
      dialect: "auto",
      preset: "strict",
      documentType: "auto",
      strictSchema: true,
      strictTuples: true,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
      allowUnknownFormatsAsAnnotations: true,
      referenceMode: "internal",
      allowLocalSchemaDependencies: false,
      verboseErrors: true,
    });
  });

  it.each([
    ["strict", { strictSchema: true, strictTuples: true, strictRequired: false }],
    ["compatible", { strictSchema: true, strictTuples: false, strictRequired: false }],
    ["permissive", { strictSchema: false, strictTuples: false, strictRequired: false }],
  ] as const)("populates the %s preset", (preset, expected) => {
    const settings = schemaValidationSettingsForPreset(preset);
    expect(settings).toMatchObject({
      ...expected,
      allErrors: true,
      validateFormats: true,
      allowUnknownFormatsAsAnnotations: true,
      verboseErrors: true,
      preset,
    });
  });

  it("keeps the Compatible preset focused on tuple strictness only", () => {
    const compatible = schemaValidationSettingsForPreset("compatible");
    const strict = schemaValidationSettingsForPreset("strict");
    const changed = Object.keys(strict).filter((key) => compatible[key as keyof typeof strict] !== strict[key as keyof typeof strict]);
    expect(changed.sort()).toEqual(["preset", "strictTuples"]);
  });

  it("switches to custom when an individual control changes", () => {
    const next = withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { strictTuples: false });
    expect(next.preset).toBe("custom");
    expect(next.strictTuples).toBe(false);
    expect(next.strictSchema).toBe(true);
  });

  it("recognizes preset values as the preset, not custom", () => {
    expect(presetForSettings(schemaValidationSettingsForPreset("permissive"))).toBe("permissive");
    expect(presetForSettings(withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { strictTuples: false }))).toBe("compatible");
  });

  it("keeps custom presets without toggle changes intact", () => {
    const customDialect = withSchemaValidationPatch(schemaValidationSettingsForPreset("compatible"), { dialect: "draft-07" });
    expect(customDialect.preset).toBe("compatible");
    expect(customDialect.dialect).toBe("draft-07");
  });

  it("selecting a preset overwrites individual controls", () => {
    const customized = withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { strictRequired: true, allErrors: false });
    expect(customized.preset).toBe("custom");
    const reset = schemaValidationSettingsForPreset("permissive", customized);
    expect(reset.strictRequired).toBe(false);
    expect(reset.allErrors).toBe(true);
    expect(reset.strictSchema).toBe(false);
  });

  it("rejects invalid persisted values by falling back to Strict defaults", () => {
    expect(parseSchemaValidationSettings(JSON.stringify({
      dialect: "draft-09",
      preset: "loose",
      documentType: "raml",
      strictSchema: "yes",
      referenceMode: "remote",
    }))).toEqual(STRICT_SCHEMA_VALIDATION_SETTINGS);
  });

  it("fills missing persisted values with defaults", () => {
    expect(parseSchemaValidationSettings(JSON.stringify({ dialect: "draft-07", strictTuples: false }))).toEqual({
      ...STRICT_SCHEMA_VALIDATION_SETTINGS,
      dialect: "draft-07",
      strictTuples: false,
      preset: "compatible",
    });
  });

  it("rejects non-object input", () => {
    expect(() => parseSchemaValidationSettings("not json")).toThrow(/not valid JSON/i);
    expect(() => parseSchemaValidationSettings("[1]")).toThrow(/must be a JSON object/i);
    expect(() => parseSchemaValidationSettings(42)).toThrow(/must be a JSON object/i);
  });

  it("keeps bundle reference mode and dependency allowance coherent", () => {
    const bundle = parseSchemaValidationSettings(JSON.stringify({ referenceMode: "bundle" }));
    expect(bundle.allowLocalSchemaDependencies).toBe(true);
    const internal = parseSchemaValidationSettings(JSON.stringify({ referenceMode: "internal", allowLocalSchemaDependencies: true }));
    expect(internal.allowLocalSchemaDependencies).toBe(false);
  });

  it("round-trips through serialization unchanged", () => {
    const settings = withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { dialect: "draft-06", referenceMode: "bundle" });
    expect(parseSchemaValidationSettings(JSON.stringify(settings))).toEqual(settings);
  });

  it("persists and restores settings from storage", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    const settings = schemaValidationSettingsForPreset("compatible");
    saveSchemaValidationSettings(settings, shim);
    expect(storage.has(SCHEMA_VALIDATION_SETTINGS_KEY)).toBe(true);
    expect(loadSchemaValidationSettings(shim)).toEqual(settings);
  });

  it("falls back to Strict defaults when stored settings are malformed", () => {
    const shim = { getItem: () => "{{{not json", setItem: () => undefined };
    expect(loadSchemaValidationSettings(shim)).toEqual(STRICT_SCHEMA_VALIDATION_SETTINGS);
    const stale = { getItem: () => JSON.stringify({ dialect: "draft-99", preset: "strict" }), setItem: () => undefined };
    expect(loadSchemaValidationSettings(stale)).toEqual(STRICT_SCHEMA_VALIDATION_SETTINGS);
  });

  it("does not persist schema or configuration content", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    saveSchemaValidationSettings(STRICT_SCHEMA_VALIDATION_SETTINGS, shim);
    expect(storage.get(SCHEMA_VALIDATION_SETTINGS_KEY)).not.toContain("$schema");
  });
});

describe("dialect and document helpers", () => {
  it("maps known $schema URIs to dialects, ignoring a trailing fragment", () => {
    expect(dialectForSchemaUri("http://json-schema.org/draft-04/schema#")).toBe("draft-04");
    expect(dialectForSchemaUri("http://json-schema.org/draft-04/schema")).toBe("draft-04");
    expect(dialectForSchemaUri("http://json-schema.org/draft-06/schema#")).toBe("draft-06");
    expect(dialectForSchemaUri("http://json-schema.org/draft-07/schema#")).toBe("draft-07");
    expect(dialectForSchemaUri("https://json-schema.org/draft/2019-09/schema")).toBe("draft-2019-09");
    expect(dialectForSchemaUri("https://json-schema.org/draft/2020-12/schema")).toBe("draft-2020-12");
    expect(dialectForSchemaUri("https://example.test/other")).toBeUndefined();
  });

  it("detects OpenAPI 3.0 and 3.1 documents separately", () => {
    expect(openapiVersionOf({ openapi: "3.0.3" })).toBe("3.0");
    expect(openapiVersionOf({ openapi: "3.1.1" })).toBe("3.1");
    expect(openapiVersionOf({ openapi: "2.0" })).toBeUndefined();
    expect(openapiVersionOf({ $schema: "https://json-schema.org/draft/2020-12/schema" })).toBeUndefined();
  });

  it("reduces settings to compiler options that AJV can represent", () => {
    expect(compilerOptionsFor(STRICT_SCHEMA_VALIDATION_SETTINGS, "draft-2020-12")).toEqual({
      dialect: "draft-2020-12",
      strict: true,
      strictTuples: true,
      strictRequired: false,
      allErrors: true,
      validateFormats: true,
      formatsMode: "fast",
      verbose: true,
      allowUnknownFormats: true,
    });
    const custom = withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { allowUnknownFormatsAsAnnotations: false });
    expect(compilerOptionsFor(custom, "draft-07")).toMatchObject({ formatsMode: "full", allowUnknownFormats: false });
  });
});

describe("reduced-validation warning", () => {
  it("is silent for Strict settings", () => {
    expect(isReducedValidation(STRICT_SCHEMA_VALIDATION_SETTINGS)).toBe(false);
    expect(reducedValidationNotice(STRICT_SCHEMA_VALIDATION_SETTINGS)).toBe("");
  });

  it("explains Compatible mode", () => {
    const notice = reducedValidationNotice(schemaValidationSettingsForPreset("compatible"));
    expect(notice).toContain("Compatible validation is active");
    expect(notice).toContain("Tuple-length strictness is disabled");
    expect(notice).toContain("legacy tuple schemas can compile");
  });

  it("explains Permissive mode", () => {
    const notice = reducedValidationNotice(schemaValidationSettingsForPreset("permissive"));
    expect(notice).toContain("Permissive validation is active");
    expect(notice).toContain("best-effort compatibility");
    expect(notice).toContain("well-formed");
  });

  it("labels custom relaxations", () => {
    const notice = reducedValidationNotice(withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, { allErrors: false }));
    expect(notice).toContain("Custom validation is active");
    expect(notice).toContain("first validation failure");
  });
});
