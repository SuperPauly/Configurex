import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRICT_SCHEMA_VALIDATION_SETTINGS } from "./settings";
import { preflightSchemaRequest } from "./worker";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schemastore-corpus");

interface CorpusEntry {
  readonly file: string;
  readonly url: string;
  readonly note: string;
  readonly expected?: "loadable" | "invalid";
}

const index = JSON.parse(readFileSync(join(FIXTURE_DIR, "index.json"), "utf8")) as CorpusEntry[];
const files = new Set(readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json") && file !== "index.json"));

for (const entry of index) {
  if (!files.has(entry.file)) throw new Error(`Corpus index references missing fixture: ${entry.file}`);
}
for (const file of files) {
  if (!index.some((entry) => entry.file === file)) throw new Error(`Corpus fixture missing from index: ${file}`);
}

const preflight = (file: string) => preflightSchemaRequest({
  kind: "preflight",
  requestId: 1,
  primary: { fileName: file, schema: JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) },
  dependencies: [],
  settings: STRICT_SCHEMA_VALIDATION_SETTINGS,
});

/**
 * Real-world schemas sampled from https://www.schemastore.org/api/json/catalog.json
 * (plus the Hermes model catalog that motivated this suite). Loadable fixtures
 * must load under Strict defaults: spec-valid documents that trip AJV Strict
 * authoring checks load in compatibility mode with warning notices, and plain
 * data documents load with an explicit plain-document notice. `invalid`
 * fixtures are genuinely broken upstream and must fail with clear problems
 * instead of silently loading.
 */
describe("SchemaStore corpus preflight", () => {
  for (const entry of index.filter((item) => item.expected !== "invalid")) {
    it(`loads ${entry.file} (${entry.note})`, () => {
      const response = preflight(entry.file);
      expect(response.problems, JSON.stringify(response.problems, null, 1)).toEqual([]);
      expect(response.valid).toBe(true);
    });
  }

  for (const entry of index.filter((item) => item.expected === "invalid")) {
    it(`rejects ${entry.file} (${entry.note})`, () => {
      const response = preflight(entry.file);
      expect(response.valid).toBe(false);
      expect(response.problems.length).toBeGreaterThan(0);
      expect(response.problems.every((problem) => problem.keyword === "schema-invalid" || problem.keyword === "schema-compile")).toBe(true);
    });
  }

  it("flags the Hermes model catalog as a plain document instead of failing", () => {
    const response = preflight("hermes-model-catalog.json");
    expect(response.valid).toBe(true);
    expect(response.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/plain-document", severity: "warning" }));
    expect(response.notices).not.toContainEqual(expect.objectContaining({ ruleId: "schema/strict-relaxed" }));
  });

  it("reports relaxed strict checks for schemas with unknown vendor keywords", () => {
    const response = preflight("Gemini_CLI_settings.json");
    expect(response.valid).toBe(true);
    expect(response.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/strict-relaxed", severity: "warning" }));
  });

  it("warns about ignored invalid regular expressions", () => {
    const response = preflight("Symfony_Services_Configuration.json");
    expect(response.valid).toBe(true);
    expect(response.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/invalid-pattern", severity: "warning" }));
  });

  it("warns about unresolvable internal references in MockServer", () => {
    const response = preflight("MockServer_Expectations.json");
    expect(response.valid).toBe(true);
    expect(response.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/unresolvable-ref", severity: "warning" }));
  });

  it("loads the pmbot schema best-effort with a meta-conformance warning", () => {
    const response = preflight(".pmbot.yml.json");
    expect(response.valid).toBe(true);
    expect(response.notices).toContainEqual(expect.objectContaining({ ruleId: "schema/meta-nonconformant", severity: "warning" }));
  });

  it("recognizes the draft-2019-09 dialect URI with a trailing hash", () => {
    const response = preflight("Yarn_Config__.yarnrc.yml_.json");
    expect(response.valid).toBe(true);
    expect(response.interpretation).toMatchObject({ effectiveDialect: "draft-2019-09", dialectSource: "declared" });
  });
});
