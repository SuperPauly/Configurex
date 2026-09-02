import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { TomlEngine } from "../taplo/service";
import type { SchemaManifest } from "../types/schema";
import { GenericWorkbench } from "./GenericWorkbench";

vi.mock("@uiw/react-codemirror", async () => {
  const React = await import("react");
  return { default: ({ value, onChange, onBlur, "data-editor-label": label }: Record<string, unknown>) => React.createElement("textarea", { "aria-label": label, value, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => (onChange as (value: string) => void)(event.target.value), onBlur }) };
});

const engine: TomlEngine = {
  validate: vi.fn(async () => ({ diagnostics: [] })),
  format: vi.fn((source: string) => `${source.trim()}\n`),
  decode: vi.fn((source: string) => source.includes("bad") ? (() => { throw new Error("bad TOML"); })() : source.includes("max_threads") ? ({ agents: { max_threads: 8 } }) : source.includes("max_concurrent_threads_per_session") ? ({ agents: { max_concurrent_threads_per_session: 8 } }) : source.includes("type = ") ? ({ type: "object" }) : ({ port: 443 })),
  encode: vi.fn(() => "port = 443\n"),
};

const manifest: SchemaManifest = {
  generatedAt: "2026-08-04T12:00:00Z",
  programs: { codex: { name: "Codex CLI", defaultFormat: "toml", outputBaseName: "config", versions: [
    { id: "stable-current", label: "Current stable", channel: "stable", version: "Current stable", sha256: "a".repeat(64), sourceUrl: "https://learn.chatgpt.com/docs/config-schema.json", assetPath: "schemas/codex/stable-current/config-schema.json", syncedAt: "2026-08-04T12:00:00Z" },
    { id: "rust-v0.147.0-alpha.7", label: "v0.147.0-alpha.7", channel: "alpha", version: "v0.147.0-alpha.7", sha256: "b".repeat(64), sourceUrl: "https://example.test/alpha", assetPath: "schemas/codex/releases/rust-v0.147.0-alpha.7/config-schema.json", syncedAt: "2026-08-04T11:50:00Z" },
    { id: "rust-v0.147.0-alpha.6", label: "v0.147.0-alpha.6", channel: "archive", version: "v0.147.0-alpha.6", sha256: "c".repeat(64), sourceUrl: "https://example.test/older", assetPath: "schemas/codex/releases/rust-v0.147.0-alpha.6/config-schema.json", syncedAt: "2026-08-03T11:50:00Z" },
  ] } },
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "object" }), { status: 200 })));
});

afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("GenericWorkbench", () => {
  it("selects JSON, YAML, TOML, or automatic detection and offers all themes", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    expect(screen.getByLabelText(/configuration format/i)).toHaveValue("toml");
    expect(screen.getByLabelText(/website theme/i).querySelectorAll("option")).toHaveLength(32);
    await userEvent.selectOptions(screen.getByLabelText(/configuration format/i), "yaml");
    expect(screen.getByRole("textbox", { name: /yaml configuration editor/i })).toBeVisible();
  });

  it("validates a JSON value against an uploaded JSON Schema with precise detail", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/configuration format/i), "json");
    const editor = screen.getByRole("textbox", { name: /json configuration editor/i });
    fireEvent.change(editor, { target: { value: '{"port":"443"}' } });
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { port: { type: "integer" } } })], "config.schema.json", { type: "application/json" }));
    await userEvent.click(screen.getByRole("button", { name: /^validate$/i }));
    const problem = await screen.findByText(/wrong value type.*expected integer/i);
    expect(problem).toBeVisible();
    await userEvent.click(problem);
    expect(screen.getByText(/replace the value with a valid integer/i)).toBeVisible();
  });

  it("loads a YAML schema file and validates against it", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File(["type: object\nproperties:\n  port:\n    type: integer\n"], "ports.schema.yaml"));
    expect(await screen.findByText("ports.schema.yaml")).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText(/configuration format/i), "json");
    fireEvent.change(screen.getByRole("textbox", { name: /json configuration editor/i }), { target: { value: '{"port":"443"}' } });
    await userEvent.click(screen.getByRole("button", { name: /^validate$/i }));
    expect(await screen.findByText(/wrong value type.*expected integer/i)).toBeVisible();
  });

  it("loads a TOML schema file with the TOML engine", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File(['type = "object"\n'], "mini.schema.toml"));
    expect(await screen.findByText("mini.schema.toml")).toBeVisible();
    expect(engine.decode).toHaveBeenCalled();
  });

  it("accepts a pasted YAML schema", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.click(screen.getByRole("button", { name: /paste schema/i }));
    await userEvent.type(screen.getByLabelText(/json schema or openapi/i), "type: object");
    await userEvent.click(screen.getByRole("button", { name: /load schema/i }));
    expect(await screen.findByText("pasted.schema.yaml")).toBeVisible();
  });

  it("loads a configuration file, detects YAML, and formats it", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/upload configuration/i), new File(["port: 443\nname: test\n"], "config.yaml"));
    expect(await screen.findByRole("textbox", { name: /yaml configuration editor/i })).toHaveValue("port: 443\nname: test\n");
    await userEvent.click(screen.getByRole("button", { name: /format/i }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: /yaml configuration editor/i }) as HTMLTextAreaElement).value).toContain("port: 443"));
  });

  it("supports uploaded local reference bundles and blocks them in internal mode", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $ref: "port.schema.json" })], "root.schema.json", { type: "application/json" }));
    expect(await screen.findByText(/blocked in internal only mode/i)).toBeVisible();
    await userEvent.click(screen.getByText(/^advanced$/i));
    await userEvent.upload(screen.getByLabelText(/upload schema dependencies/i), new File([JSON.stringify({ type: "object" })], "port.schema.json", { type: "application/json" }));
    fireEvent.click(screen.getByRole("radio", { name: /uploaded bundle/i }));
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $ref: "port.schema.json" })], "root.schema.json", { type: "application/json" }));
    await userEvent.click(screen.getByRole("button", { name: /^validate$/i }));
    await waitFor(() => expect(screen.queryByText(/blocked in internal only mode/i)).not.toBeInTheDocument());
  });

  it("selects a program and version inline", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/schema source/i), "codex");
    await screen.findByText(/current stable loaded/i);
    await userEvent.click(screen.getByRole("button", { name: /change/i }));
    await userEvent.selectOptions(screen.getByLabelText(/schema version/i), "rust-v0.147.0-alpha.6");
    expect(await screen.findByText(/v0\.147\.0-alpha\.6 loaded/i)).toBeVisible();
  });

  it("preserves the active schema when a replacement is invalid", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ type: "object" })], "mine.schema.json", { type: "application/json" }));
    expect(await screen.findByText("mine.schema.json")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /change/i }));
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ type: 42 })], "bad.schema.json", { type: "application/json" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid|type/i);
    await userEvent.click(screen.getByRole("button", { name: /close schema loader/i }));
    expect(screen.getByText("mine.schema.json")).toBeVisible();
  });

  it("offers downloads once a configuration parses, and blocks broken documents", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.click(screen.getByRole("button", { name: /^download$/i }));
    expect(screen.getByRole("menuitem", { name: /^json \.json$/i })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: /toml configuration editor/i }), { target: { value: "" } });
    expect(screen.getByRole("menuitem", { name: /^json \.json$/i })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /toml configuration editor/i }), { target: { value: "model = \"changed\"\n" } });
    expect(screen.getByRole("menuitem", { name: /^json \.json$/i })).toBeEnabled();
  });

  it("saves the active schema as YAML, TOML, or JSON Schema and OpenAPI JSON", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" })], "config.schema.json", { type: "application/json" }));
    await screen.findByText("config.schema.json");
    await userEvent.click(screen.getByRole("button", { name: /^download$/i }));
    expect(screen.getByRole("menuitem", { name: /json schema yaml/i })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /json schema toml/i })).toBeEnabled();
  });

  it("marks removed agents.max_threads as an unknown key and updates it in one click", async () => {
    const codexSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { agents: { $ref: "#/definitions/AgentsToml" } },
      definitions: {
        AgentRoleToml: { type: "object", properties: { description: { type: "string" } }, additionalProperties: false },
        AgentsToml: { type: "object", properties: { max_concurrent_threads_per_session: { type: "integer", minimum: 1 } }, additionalProperties: { $ref: "#/definitions/AgentRoleToml" } },
      },
      additionalProperties: false,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(codexSchema), { status: 200 })));
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/schema source/i), "codex");
    await screen.findByText(/current stable loaded/i);
    const editor = screen.getByRole("textbox", { name: /toml configuration editor/i });
    fireEvent.change(editor, { target: { value: "[agents]\nmax_threads = 8\n" } });
    await userEvent.click(screen.getByRole("button", { name: /^validate$/i }));
    expect(await screen.findByText(/not declared by the selected schema/i)).toBeVisible();
    expect(screen.getByText(/not declared by the selected schema/i).closest("li")).toHaveClass("problem-kind-unknown-key");
    await userEvent.click(screen.getByRole("button", { name: /update key/i }));
    expect(editor).toHaveValue("[agents]\nmax_concurrent_threads_per_session = 8\n");
    await waitFor(() => expect(screen.queryByText(/not declared by the selected schema/i)).not.toBeInTheDocument());
  });

  it("reveals only the selected custom schema input and rejects unsupported URLs", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    expect(screen.queryByLabelText(/json schema or openapi/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /paste schema/i }));
    expect(screen.getByLabelText(/json schema or openapi/i)).toBeVisible();
    expect(screen.queryByLabelText(/https schema url/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /fetch url/i }));
    await userEvent.type(screen.getByLabelText(/https schema url/i), "https://example.test/schema.txt");
    await userEvent.click(screen.getByRole("button", { name: /fetch schema/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ends in \.json/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a YAML schema over HTTPS", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("type: object\n", { status: 200 })));
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.click(screen.getByRole("button", { name: /fetch url/i }));
    await userEvent.type(screen.getByLabelText(/https schema url/i), "https://example.test/api.yaml");
    await userEvent.click(screen.getByRole("button", { name: /fetch schema/i }));
    expect(await screen.findByText("api.yaml")).toBeVisible();
  });

  it("accepts a dropped schema file and a clipboard-pasted schema file", async () => {
    const { container, unmount } = render(<GenericWorkbench engine={engine} manifest={manifest} />);
    const dropZone = container.querySelector(".schema-loader");
    const dropped = new File([JSON.stringify({ type: "object" })], "dropped.schema.json", { type: "application/json" });
    fireEvent.drop(dropZone!, { dataTransfer: { files: [dropped], types: ["Files"] } });
    expect(await screen.findByText("dropped.schema.json")).toBeVisible();
    unmount();

    const second = render(<GenericWorkbench engine={engine} manifest={manifest} />);
    const pasted = new File([JSON.stringify({ type: "object" })], "pasted.schema.json", { type: "application/json" });
    fireEvent.paste(second.container.querySelector(".schema-loader")!, { clipboardData: { files: [pasted] } });
    expect(await screen.findByText("pasted.schema.json")).toBeVisible();
  });

  it("opens and closes the full-screen editor without replacing its value", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    const editor = screen.getByRole("textbox", { name: /toml configuration editor/i });
    fireEvent.change(editor, { target: { value: "port = 8443\n" } });
    await userEvent.click(screen.getByRole("button", { name: /expand editor/i }));
    expect(editor.closest(".editor-shell")).toHaveClass("is-expanded");
    expect(editor).toHaveValue("port = 8443\n");
    await userEvent.keyboard("{Escape}");
    expect(editor.closest(".editor-shell")).not.toHaveClass("is-expanded");
  });
});

describe("schema validation settings UI", () => {
  const LEGACY_TUPLE = JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
  });

  it("shows initial loading options with Strict selected by default", () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    expect(screen.getByText(/schema loading options/i)).toBeVisible();
    expect(screen.getByLabelText(/schema document type/i)).toHaveValue("auto");
    expect(screen.getByLabelText(/schema dialect/i)).toHaveValue("auto");
    expect(screen.getByLabelText(/validation preset/i)).toHaveValue("strict");
    expect(screen.getByRole("radio", { name: /internal references only/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /allow local bundled dependency schemas/i })).not.toBeChecked();
    expect(screen.getByText(/advanced options/i).closest("details")).not.toHaveAttribute("open");
  });

  it("rejects the legacy tuple schema under the default Strict preset with the tuple hint", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([LEGACY_TUPLE], "tuple.schema.json", { type: "application/json" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/is 2-tuple/i);
  });

  it("uses the selected settings for the first preflight: Compatible accepts a legacy tuple schema", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/validation preset/i), "compatible");
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([LEGACY_TUPLE], "tuple.schema.json", { type: "application/json" }));
    expect(await screen.findByText("tuple.schema.json")).toBeVisible();
    expect(screen.queryByText(/is 2-tuple/i)).not.toBeInTheDocument();
    // Let the upload-triggered re-preflight settle so it cannot persist into later tests.
    await waitFor(() => expect(screen.getByText(/compatible validation is active/i)).toBeVisible());
  });

  it("displays automatic dialect detection after loading", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ type: "object" })], "plain.schema.json", { type: "application/json" }));
    expect(await screen.findByText("plain.schema.json")).toBeVisible();
    const summary = await screen.findByLabelText(/active schema settings/i);
    expect(summary).toHaveTextContent(/automatic fallback/i);
    expect(summary).toHaveTextContent(/draft 2020-12/i);
  });





  it("falls back to Strict when stored settings are malformed", () => {
    localStorage.setItem("codex-config-checker.schema-validation-settings", "{{{broken");
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    expect(screen.getByLabelText(/validation preset/i)).toHaveValue("strict");
  });





  it("switches to Custom when an advanced toggle changes, and presets overwrite toggles", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.click(screen.getByText(/advanced options/i));
    await userEvent.click(screen.getByRole("checkbox", { name: /require tuple length constraints/i }));
    expect(screen.getByLabelText(/validation preset/i)).toHaveValue("custom");
    await userEvent.selectOptions(screen.getByLabelText(/validation preset/i), "permissive");
    expect(screen.getByRole("checkbox", { name: /require tuple length constraints/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /require strict schema keywords/i })).not.toBeChecked();
    // Allow the change's effects to settle before the next test reads storage.
    await waitFor(() => expect(screen.getByLabelText(/validation preset/i)).toHaveValue("permissive"));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });

  it("persists settings and restores them after a remount", async () => {
    const first = render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/validation preset/i), "compatible");
    first.unmount();
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    expect(screen.getByLabelText(/validation preset/i)).toHaveValue("compatible");
  });

  it("sends a dialect override to the worker and reports a mismatch warning", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/schema dialect/i), "draft-2020-12");
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" })], "config.schema.json", { type: "application/json" }));
    expect(await screen.findByText("config.schema.json")).toBeVisible();
    const summary = await screen.findByLabelText(/active schema settings/i);
    expect(summary).toHaveTextContent(/manual override/i);
    expect(summary).toHaveTextContent(/draft 2020-12/i);
    expect(summary).toHaveTextContent(/draft-07\/schema/i);
    // Let the upload-triggered re-preflight settle so it cannot persist into later tests.
    await waitFor(() => expect(screen.getByLabelText(/active schema settings/i)).toHaveTextContent(/manual override/i));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  });

  it("shows the reduced-validation warning and re-preflights when settings change", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/validation preset/i), "compatible");
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([LEGACY_TUPLE], "tuple.schema.json", { type: "application/json" }));
    expect(await screen.findByText("tuple.schema.json")).toBeVisible();
    expect(await screen.findByText(/compatible validation is active/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /schema settings/i }));
    const drawer = screen.getByRole("complementary", { name: /schema validation settings/i });
    await userEvent.selectOptions(within(drawer).getByLabelText(/validation preset/i), "strict");
    expect(await screen.findByRole("alert")).toHaveTextContent(/is 2-tuple/i);
  });

  it("resets to Strict defaults and re-preflights from the settings drawer", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.selectOptions(screen.getByLabelText(/validation preset/i), "compatible");
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([LEGACY_TUPLE], "tuple.schema.json", { type: "application/json" }));
    expect(await screen.findByText("tuple.schema.json")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /schema settings/i }));
    const drawer = screen.getByRole("complementary", { name: /schema validation settings/i });
    expect(within(drawer).getByLabelText(/validation preset/i)).toHaveValue("compatible");
    expect(within(drawer).getByText(/compatible validation is active/i)).toBeVisible();
    await userEvent.click(within(drawer).getByRole("button", { name: /reset to strict defaults/i }));
    expect(within(drawer).getByLabelText(/validation preset/i)).toHaveValue("strict");
    expect(within(drawer).queryByText(/compatible validation is active/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/is 2-tuple/i);
    expect(localStorage.getItem("codex-config-checker.schema-validation-settings")).toContain('"preset":"strict"');
  });

  it("shows the declared $schema and interpretation in the settings drawer", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" })], "config.schema.json", { type: "application/json" }));
    expect(await screen.findByText("config.schema.json")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /schema settings/i }));
    const drawer = screen.getByRole("complementary", { name: /schema validation settings/i });
    expect(within(drawer).getByText(/draft-07\/schema/i)).toBeVisible();
    expect(within(drawer).getByText(/declared by the schema/i)).toBeVisible();
    expect(within(drawer).getByText("Draft 7", { selector: "dd" })).toBeVisible();
  });

  it("reports OpenAPI documents as unsupported instead of validating them as JSON Schema", async () => {
    render(<GenericWorkbench engine={engine} manifest={manifest} />);
    await userEvent.upload(screen.getByLabelText(/choose schema file/i), new File([JSON.stringify({ openapi: "3.1.0", info: { title: "API", version: "1" }, paths: {} })], "openapi.json", { type: "application/json" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/openapi 3\.1 documents are not validated as standalone json schema/i);
  });
});
