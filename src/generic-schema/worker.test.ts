import { beforeEach, describe, expect, it } from "vitest";

import {
  schemaValidationSettingsForPreset,
  STRICT_SCHEMA_VALIDATION_SETTINGS,
  withSchemaValidationPatch,
  type SchemaValidationSettings,
} from "./settings";
import { lastFreshCompilation, preflightSchemaRequest, resetSchemaCompileCacheForTests, validateSchemaRequest } from "./worker";

const strict = STRICT_SCHEMA_VALIDATION_SETTINGS;
const compatible = schemaValidationSettingsForPreset("compatible");
const permissive = schemaValidationSettingsForPreset("permissive");

function settingsWith(patch: Partial<SchemaValidationSettings>): SchemaValidationSettings {
  return withSchemaValidationPatch(STRICT_SCHEMA_VALIDATION_SETTINGS, patch);
}

const LEGACY_TUPLE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "array",
  items: [{ type: "string" }, { type: "number" }],
};

const CONSTRAINED_TUPLE_SCHEMA = {
  ...LEGACY_TUPLE_SCHEMA,
  minItems: 2,
  maxItems: 2,
  additionalItems: false,
};

beforeEach(() => resetSchemaCompileCacheForTests());

describe("preflightSchemaRequest", () => {
  it("accepts a genuine JSON Schema without validating it against config data", () => {
    const result = preflightSchemaRequest({
      kind: "preflight",
      requestId: 100,
      primary: { fileName: "schema.json", schema: { type: "object", required: ["name"] } },
      dependencies: [],
      settings: strict,
    });

    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("rejects JSON that is not a valid JSON Schema", () => {
    const result = preflightSchemaRequest({
      kind: "preflight",
      requestId: 101,
      primary: { fileName: "schema.json", schema: { type: 42 } },
      dependencies: [],
      settings: strict,
    });

    expect(result.valid).toBe(false);
    expect(result.problems[0]?.message).toMatch(/schema.*invalid|type/i);
  });
});

describe("validateSchemaRequest", () => {
  it.each([
    "http://json-schema.org/draft-04/schema#",
    "http://json-schema.org/draft-06/schema#",
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("validates supported schema draft %s", ($schema) => {
    const result = validateSchemaRequest({
      requestId: 1,
      value: { port: "wrong" },
      primary: { fileName: "config.schema.json", schema: { $schema, type: "object", properties: { port: { type: "integer" } } } },
      dependencies: [],
      settings: strict,
    });
    expect(result.problems.some((problem) => problem.keyword === "type")).toBe(true);
    expect(result.interpretation).toMatchObject({ effectiveDialect: expect.any(String), dialectSource: "declared" });
  });

  it("defaults a missing draft to 2020-12 with an information notice", () => {
    const result = validateSchemaRequest({ requestId: 2, value: "ok", primary: { fileName: "schema.json", schema: { type: "string" } }, dependencies: [], settings: strict });
    expect(result.notices[0]).toMatchObject({ ruleId: "schema/draft-default", severity: "info" });
    expect(result.interpretation).toMatchObject({ effectiveDialect: "draft-2020-12", dialectSource: "auto-fallback" });
    expect(result.valid).toBe(true);
  });

  it("rejects unsupported drafts and invalid schemas without vague exceptions", () => {
    const unsupported = validateSchemaRequest({ requestId: 3, value: {}, primary: { fileName: "schema.json", schema: { $schema: "https://example.test/draft", type: "object" } }, dependencies: [], settings: strict });
    const invalid = validateSchemaRequest({ requestId: 4, value: {}, primary: { fileName: "schema.json", schema: { type: 42 } }, dependencies: [], settings: strict });
    expect(unsupported.problems[0]).toMatchObject({ keyword: "schema-draft", instancePath: "" });
    expect(invalid.problems[0]?.message).toMatch(/schema.*invalid|type/i);
  });

  it("validates through uploaded local dependencies and never fetches them", () => {
    const result = validateSchemaRequest({
      requestId: 5,
      value: { server: { port: "wrong" } },
      primary: { fileName: "config.schema.json", schema: { type: "object", properties: { server: { $ref: "server.schema.json" } } } },
      dependencies: [{ fileName: "server.schema.json", schema: { type: "object", properties: { port: { type: "integer" } } } }],
      settings: settingsWith({ referenceMode: "bundle" }),
    });
    expect(result.problems.some((problem) => problem.instancePath === "/server/port" && problem.keyword === "type")).toBe(true);
  });

  it("blocks external references in internal mode without network access", () => {
    const result = validateSchemaRequest({
      requestId: 55,
      value: {},
      primary: { fileName: "config.schema.json", schema: { type: "object", properties: { server: { $ref: "server.schema.json" } } } },
      dependencies: [],
      settings: strict,
    });
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatchObject({ keyword: "ref-external-blocked", params: { reference: "server.schema.json" } });
  });

  it("compiles the Codex uint format instead of returning a schema compiler error", () => {
    const result = validateSchemaRequest({
      requestId: 6,
      value: { max_concurrent_threads_per_session: 8 },
      primary: {
        fileName: "config.schema.json",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            max_concurrent_threads_per_session: { type: "integer", format: "uint" },
          },
        },
      },
      dependencies: [],
      settings: strict,
    });

    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("compiles Codex exclusion guards without treating strictRequired lint as a schema error", () => {
    const result = validateSchemaRequest({
      requestId: 10,
      value: {},
      primary: {
        fileName: "config-schema.json",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          allOf: [{ not: { required: ["exclude"] } }],
        },
      },
      dependencies: [],
      settings: strict,
    });

    expect(result.problems.some((problem) => problem.keyword === "schema-compile")).toBe(false);
    expect(result.valid).toBe(true);
  });

  it.each([
    ["uint", 0, -1],
    ["uint16", 65_535, 65_536],
    ["uint32", 4_294_967_295, 4_294_967_296],
    ["uint64", Number.MAX_SAFE_INTEGER, -1],
    ["int32", 2_147_483_647, 2_147_483_648],
    ["int64", Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER - 1],
    ["double", 1.25, Number.POSITIVE_INFINITY],
  ])("enforces the Codex numeric format %s", (format, accepted, rejected) => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: format === "double" ? "number" : "integer",
      format,
    };
    const valid = validateSchemaRequest({ requestId: 7, value: accepted, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict });
    const invalid = validateSchemaRequest({ requestId: 8, value: rejected, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict });

    expect(valid.valid).toBe(true);
    expect(valid.problems).toEqual([]);
    expect(invalid.valid).toBe(false);
    expect(invalid.problems[0]).toMatchObject(format === "double"
      ? { keyword: "type", params: { type: "number" } }
      : { keyword: "format", params: { format } });
  });

  it("treats an unknown custom format as an annotation and still validates structure", () => {
    const result = validateSchemaRequest({
      requestId: 9,
      value: "ab",
      primary: {
        fileName: "schema.json",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "string",
          format: "project-slug",
          minLength: 3,
        },
      },
      dependencies: [],
      settings: strict,
    });

    expect(result.problems.some((problem) => problem.keyword === "schema-compile")).toBe(false);
    expect(result.problems.some((problem) => problem.keyword === "minLength")).toBe(true);
    expect(result.notices).toContainEqual(expect.objectContaining({
      ruleId: "schema/format-annotation",
      severity: "info",
      message: expect.stringContaining("1 custom schema format"),
      explanation: expect.stringContaining("project-slug"),
    }));
  });

  it("fails compilation for unknown formats when annotations are disabled, but keeps known formats working", () => {
    const custom = validateSchemaRequest({
      requestId: 90,
      value: "abc",
      primary: { fileName: "schema.json", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "string", format: "project-slug" } },
      dependencies: [],
      settings: settingsWith({ allowUnknownFormatsAsAnnotations: false }),
    });
    expect(custom.valid).toBe(false);
    expect(custom.problems[0]?.message).toMatch(/unknown format|project-slug/i);
    expect(custom.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/format-strict", severity: "warning" }));

    const known = validateSchemaRequest({
      requestId: 91,
      value: { email: "not-an-email" },
      primary: { fileName: "schema.json", schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { email: { type: "string", format: "email" } } } },
      dependencies: [],
      settings: settingsWith({ allowUnknownFormatsAsAnnotations: false }),
    });
    expect(known.valid).toBe(false);
    expect(known.problems[0]).toMatchObject({ keyword: "format", params: { format: "email" } });
  });
});

describe("tuple strictness presets", () => {
  it("rejects a legacy Draft 7 tuple schema in Strict mode with a targeted hint", () => {
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 20, primary: { fileName: "tuple.schema.json", schema: LEGACY_TUPLE_SCHEMA }, dependencies: [], settings: strict });
    expect(result.valid).toBe(false);
    expect(result.problems[0]?.keyword).toBe("schema-compile");
    expect(result.problems[0]?.message).toContain(`"items" is 2-tuple`);
    expect(result.problems[0]?.params.hint).toContain("prefixItems");
    expect(result.problems[0]?.params.hint).toContain("Compatible validation");
  });

  it("compiles the same legacy tuple schema in Compatible mode", () => {
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 21, primary: { fileName: "tuple.schema.json", schema: LEGACY_TUPLE_SCHEMA }, dependencies: [], settings: compatible });
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("compiles the same legacy tuple schema in Permissive mode", () => {
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 22, primary: { fileName: "tuple.schema.json", schema: LEGACY_TUPLE_SCHEMA }, dependencies: [], settings: permissive });
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("compiles a correctly constrained Draft 7 tuple schema in Strict mode", () => {
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 23, primary: { fileName: "tuple.schema.json", schema: CONSTRAINED_TUPLE_SCHEMA }, dependencies: [], settings: strict });
    expect(result.valid).toBe(true);
    const invalid = validateSchemaRequest({ requestId: 24, value: ["a", 1, "extra"], primary: { fileName: "tuple.schema.json", schema: CONSTRAINED_TUPLE_SCHEMA }, dependencies: [], settings: strict });
    expect(invalid.valid).toBe(false);
    expect(invalid.problems.some((problem) => problem.keyword === "additionalItems" || problem.keyword === "maxItems")).toBe(true);
  });

  it("compiles and validates Draft 2020-12 prefixItems tuples", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      minItems: 2,
      maxItems: 2,
    };
    const preflight = preflightSchemaRequest({ kind: "preflight", requestId: 25, primary: { fileName: "tuple.schema.json", schema }, dependencies: [], settings: strict });
    expect(preflight.valid).toBe(true);
    expect(preflight.interpretation).toMatchObject({ effectiveDialect: "draft-2020-12", dialectSource: "declared" });
    const valid = validateSchemaRequest({ requestId: 26, value: ["a", 1], primary: { fileName: "tuple.schema.json", schema }, dependencies: [], settings: strict });
    const invalid = validateSchemaRequest({ requestId: 27, value: ["a", "b"], primary: { fileName: "tuple.schema.json", schema }, dependencies: [], settings: strict });
    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.problems.some((problem) => problem.instancePath === "/1" && problem.keyword === "type")).toBe(true);
  });
});

describe("dialect handling", () => {
  it("validates Draft 6 schemas when draft-06 is declared", () => {
    const schema = { $schema: "http://json-schema.org/draft-06/schema#", type: "integer", exclusiveMinimum: 3 };
    const preflight = preflightSchemaRequest({ kind: "preflight", requestId: 30, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict });
    expect(preflight.valid).toBe(true);
    expect(preflight.interpretation).toMatchObject({ effectiveDialect: "draft-06", dialectSource: "declared" });
    expect(validateSchemaRequest({ requestId: 31, value: 3, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict }).valid).toBe(false);
    expect(validateSchemaRequest({ requestId: 32, value: 4, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict }).valid).toBe(true);
  });

  it("applies a manual dialect override without mutating the original schema data", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "array", items: [{ type: "string" }] };
    const snapshot = JSON.parse(JSON.stringify(schema));
    const settings = settingsWith({ dialect: "draft-2020-12" });
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 33, primary: { fileName: "schema.json", schema }, dependencies: [], settings });
    expect(result.interpretation).toMatchObject({ effectiveDialect: "draft-2020-12", dialectSource: "manual-override", declaredDialectUri: "http://json-schema.org/draft-07/schema#" });
    expect(result.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/dialect-mismatch", severity: "warning" }));
    expect(result.notices[0]?.message).toContain("Draft 7");
    expect(result.notices[0]?.message).toContain("Draft 2020-12");
    expect(schema).toEqual(snapshot);
  });

  it("reports an unknown declared dialect as unsupported in Auto mode", () => {
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 34, primary: { fileName: "schema.json", schema: { $schema: "https://example.test/draft-3", type: "object" } }, dependencies: [], settings: strict });
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatchObject({ keyword: "schema-draft", params: { draft: "https://example.test/draft-3" } });
    expect(result.problems[0]?.message).toContain("Unsupported JSON Schema draft");
  });

  it("allows an explicit override of an unknown declared dialect with a mismatch notice", () => {
    const settings = settingsWith({ dialect: "draft-07" });
    const result = preflightSchemaRequest({ kind: "preflight", requestId: 35, primary: { fileName: "schema.json", schema: { $schema: "https://example.test/draft-3", type: "object" } }, dependencies: [], settings });
    expect(result.valid).toBe(true);
    expect(result.interpretation).toMatchObject({ effectiveDialect: "draft-07", dialectSource: "manual-override" });
    expect(result.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/dialect-mismatch", severity: "warning" }));
  });

  it("rejects OpenAPI documents instead of compiling them as JSON Schema", () => {
    for (const [version, documentKind] of [["3.0.1", "openapi-3.0"], ["3.1.0", "openapi-3.1"]] as const) {
      const result = preflightSchemaRequest({
        kind: "preflight",
        requestId: 36,
        primary: { fileName: "openapi.json", schema: { openapi: version, info: { title: "API", version: "1.0" }, paths: {} },
        },
        dependencies: [],
        settings: strict,
      });
      expect(result.valid).toBe(false);
      expect(result.problems[0]?.keyword).toBe("schema-unsupported-document");
      expect(result.problems[0]?.message).toContain(`OpenAPI ${version.split(".").slice(0, 2).join(".")}`);
      expect(result.interpretation?.documentKind).toBe(documentKind);
    }
  });

  it("warns when a non-OpenAPI document is forced to the OpenAPI document type", () => {
    const result = preflightSchemaRequest({
      kind: "preflight",
      requestId: 37,
      primary: { fileName: "schema.json", schema: { type: "object" } },
      dependencies: [],
      settings: settingsWith({ documentType: "openapi" }),
    });
    expect(result.valid).toBe(false);
    expect(result.problems[0]?.keyword).toBe("schema-unsupported-document");
    expect(result.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/openapi-assumed", severity: "warning" }));
  });
});

describe("compile cache", () => {
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
  const preflight = (requestId: number, settings: SchemaValidationSettings) => preflightSchemaRequest({ kind: "preflight", requestId, primary: { fileName: "schema.json", schema }, dependencies: [], settings });

  it("reuses the cached compilation for an unchanged schema and unchanged settings", () => {
    preflight(40, strict);
    const fresh = lastFreshCompilation;
    const second = preflight(41, strict);
    expect(second.valid).toBe(true);
    expect(lastFreshCompilation).toBe(fresh);
  });

  it("recompiles when switching from Strict to Compatible", () => {
    preflight(42, strict);
    const fresh = lastFreshCompilation;
    const second = preflight(43, compatible);
    expect(second.valid).toBe(true);
    expect(lastFreshCompilation).not.toBe(fresh);
  });

  it("recompiles when the dialect override changes", () => {
    preflight(44, strict);
    const fresh = lastFreshCompilation;
    const overridden = preflight(45, settingsWith({ dialect: "draft-2020-12" }));
    expect(lastFreshCompilation).not.toBe(fresh);
    expect(overridden.interpretation).toMatchObject({ effectiveDialect: "draft-2020-12", dialectSource: "manual-override" });
  });

  it("recompiles when format validation is toggled", () => {
    preflight(46, strict);
    const fresh = lastFreshCompilation;
    const second = preflight(47, settingsWith({ validateFormats: false }));
    expect(lastFreshCompilation).not.toBe(fresh);
    expect(second.valid).toBe(true);
  });

  it("recompiles when custom-format annotation handling is toggled", () => {
    preflight(48, strict);
    const fresh = lastFreshCompilation;
    preflight(49, settingsWith({ allowUnknownFormatsAsAnnotations: false }));
    expect(lastFreshCompilation).not.toBe(fresh);
  });
});

describe("strictness toggles", () => {
  it("enforces strictRequired only when enabled", () => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { present: { type: "string" } }, required: ["absent"] };
    const relaxed = preflightSchemaRequest({ kind: "preflight", requestId: 60, primary: { fileName: "schema.json", schema }, dependencies: [], settings: strict });
    expect(relaxed.valid).toBe(true);
    const enforced = preflightSchemaRequest({ kind: "preflight", requestId: 61, primary: { fileName: "schema.json", schema }, dependencies: [], settings: settingsWith({ strictRequired: true }) });
    expect(enforced.valid).toBe(false);
    expect(enforced.problems[0]?.message).toMatch(/required|absent/i);
  });

  it("reports only the first error when allErrors is disabled", () => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } };
    const request = { requestId: 62, value: { a: "x", b: "y" }, primary: { fileName: "schema.json", schema }, dependencies: [] };
    const all = validateSchemaRequest({ ...request, settings: strict });
    const first = validateSchemaRequest({ ...request, requestId: 63, settings: settingsWith({ allErrors: false }) });
    expect(all.problems.length).toBeGreaterThan(1);
    expect(first.problems).toHaveLength(1);
  });
});
