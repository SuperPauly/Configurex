import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Check, ChevronDown, Clipboard, Download, FileJson, FileUp, Link2, LoaderCircle, Maximize2, Minimize2, Paintbrush, Play, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

import { LintSettingsDrawer } from "../components/LintSettingsDrawer";
import { ProblemsPanel } from "../components/ProblemsPanel";
import { documentLevelDiagnostic, rangeFromOffsets } from "../diagnostics/location";
import { diagnosticCountSummary } from "../diagnostics/summary";
import type { Diagnostic } from "../diagnostics/types";
import { ConfigEditor } from "../editor/ConfigEditor";
import { loadEditorTheme, RAINGLOW_THEMES, saveEditorTheme, type RainglowThemeId } from "../editor/rainglow";
import { detectFormat, detectSchemaFormat } from "../formats/detect";
import { JsonAdapter } from "../formats/json";
import { isYamlDocument, parseSchemaText, serializeSchema } from "../formats/schema";
import { serializeConfig } from "../formats/serialize";
import { TomlAdapter } from "../formats/toml";
import type { ConfigFormat, FormatAdapter, FormatOptions, SchemaFormat } from "../formats/types";
import { YamlAdapter } from "../formats/yaml";
import { SchemaWorkerClient } from "../generic-schema/client";
import { schemaPropertyNames, translateSchemaProblem } from "../generic-schema/diagnostics";
import type { LocalSchemaFile, ReferenceMode, SchemaPreflightRequest, SchemaValidationRequest, SchemaValidationResponse } from "../generic-schema/types";
import { preflightSchemaRequest, validateSchemaRequest } from "../generic-schema/worker";
import { applyLintSeverities, lintDocument } from "../lint/engine";
import { loadLintSettings, saveLintSettings, type LintSettings } from "../lint/settings";
import { schemaAssetUrl } from "../schema/manifest";
import { codexMigrationDiagnostics } from "../schema/codex-migrations";
import type { TomlEngine } from "../taplo/service";
import type { SchemaManifest } from "../types/schema";

const MAX_CONFIG_BYTES = 6 * 1024 * 1024;
const MAX_SCHEMA_FILES = 50;
const MAX_SCHEMA_BUNDLE_BYTES = 10 * 1024 * 1024;
const STARTER_TOML = '# Paste or upload your configuration\nmodel = "gpt-5"\n';
const FORMAT_OPTIONS: FormatOptions = { tabWidth: 2, useTabs: false, printWidth: 100, singleQuote: false };

type SelectedFormat = ConfigFormat | "auto";
type Status = { type: "idle" | "working" | "valid" | "invalid" | "error"; message: string };
interface SchemaClient {
  validate(request: Omit<SchemaValidationRequest, "requestId">): Promise<SchemaValidationResponse>;
  preflight(request: Omit<SchemaPreflightRequest, "requestId" | "kind">): Promise<SchemaValidationResponse>;
  cancel(): void;
  dispose(): void;
}

function readFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result ?? "")); reader.onerror = () => reject(reader.error); reader.readAsText(file); });
}

function inProcessClient(): SchemaClient {
  let requestId = 0;
  return {
    validate: async (request) => validateSchemaRequest({ ...request, requestId: ++requestId }),
    preflight: async (request) => preflightSchemaRequest({ ...request, kind: "preflight", requestId: ++requestId }),
    cancel: () => { requestId += 1; },
    dispose: () => undefined,
  };
}

function validSchemaUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a complete HTTPS URL ending in .json, .yaml, .yml, or .toml."); }
  if (url.protocol !== "https:" || !/\.(json|ya?ml|toml)$/i.test(url.pathname)) throw new Error("Use an HTTPS URL whose path ends in .json, .yaml, .yml, or .toml.");
  return url;
}

function createSchemaClient(): SchemaClient { return typeof Worker === "undefined" ? inProcessClient() : new SchemaWorkerClient(); }
function extension(format: ConfigFormat): string { return format === "yaml" ? "yaml" : format; }
function mimeType(format: ConfigFormat): string { return format === "json" ? "application/json" : format === "yaml" ? "application/yaml" : "application/toml"; }
function schemaOutputName(target: SchemaFormat, kind: "jsonschema" | "openapi"): string { return `${kind === "openapi" ? "openapi" : "schema"}.${extension(target)}`; }

export interface GenericWorkbenchProps {
  readonly engine: TomlEngine;
  readonly manifest: SchemaManifest;
  readonly onThemeChange?: (themeId: RainglowThemeId) => void;
  readonly themeId?: RainglowThemeId;
}

export function GenericWorkbench({ engine, manifest, onThemeChange, themeId: controlledThemeId }: GenericWorkbenchProps) {
  const programIds = Object.keys(manifest.programs);
  const firstProgram = manifest.programs[programIds[0] ?? ""];
  if (!firstProgram) throw new Error("The schema registry does not contain a selectable program.");
  const [programId, setProgramId] = useState("none");
  const program = programId === "none" ? undefined : manifest.programs[programId];
  const initialVersion = firstProgram.versions.find((version) => version.channel === "stable") ?? firstProgram.versions[0];

  const [source, setSource] = useState(STARTER_TOML);
  const [fileName, setFileName] = useState<string | undefined>();
  const [selectedFormat, setSelectedFormat] = useState<SelectedFormat>("toml");
  const [selectedVersionId, setSelectedVersionId] = useState(initialVersion?.id ?? "");
  const selectedVersion = program?.versions.find((version) => version.id === selectedVersionId) ?? program?.versions[0];
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [loaderOpen, setLoaderOpen] = useState(true);
  const [loaderAction, setLoaderAction] = useState<"none" | "paste" | "url">("none");
  const [schemaDraft, setSchemaDraft] = useState("");
  const [schemaUrl, setSchemaUrl] = useState("");
  const [schemaFeedback, setSchemaFeedback] = useState("");
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [localThemeId, setLocalThemeId] = useState<RainglowThemeId>(() => loadEditorTheme());
  const themeId = controlledThemeId ?? localThemeId;
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [trackedPrimary, setTrackedPrimary] = useState<LocalSchemaFile | undefined>();
  const [customPrimary, setCustomPrimary] = useState<LocalSchemaFile | undefined>();
  const [dependencies, setDependencies] = useState<readonly LocalSchemaFile[]>([]);
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>("internal");
  const [lintSettings, setLintSettings] = useState<LintSettings>(() => loadLintSettings());
  const [status, setStatus] = useState<Status>({ type: "idle", message: "Choose or add a JSON Schema to begin." });
  const [revision, setRevision] = useState(0);
  const sourceRef = useRef(source);
  const revisionRef = useRef(0);
  const editorRef = useRef<EditorView | null>(null);
  const sequence = useRef(0);
  const schemaLoadSequence = useRef(0);
  const compiledSchema = useRef<{ primary: LocalSchemaFile; dependencies: readonly LocalSchemaFile[]; referenceMode: ReferenceMode } | undefined>(undefined);
  const [schemaClient] = useState<SchemaClient>(() => createSchemaClient());

  const detected = useMemo(() => detectFormat(fileName, source), [fileName, source]);
  const format: ConfigFormat = selectedFormat === "auto" ? detected.format ?? program?.defaultFormat ?? "toml" : selectedFormat;
  const primary = customPrimary ?? trackedPrimary;
  const schemaKind: "jsonschema" | "openapi" = useMemo(() => {
    const kind = detectSchemaFormat(customPrimary?.fileName, primary?.schema).schemaKind;
    return kind === "openapi" ? "openapi" : "jsonschema";
  }, [customPrimary?.fileName, primary?.schema]);
  const adapters = useMemo<Record<ConfigFormat, FormatAdapter>>(() => ({ json: new JsonAdapter(), yaml: new YamlAdapter(), toml: new TomlAdapter(engine) }), [engine]);

  useEffect(() => () => schemaClient.dispose(), [schemaClient]);
  useEffect(() => {
    if (!selectedVersion) return;
    const run = ++schemaLoadSequence.current;
    const url = new URL(schemaAssetUrl(selectedVersion), window.location.href);
    url.searchParams.set("sha", selectedVersion.sha256);
    fetch(url, { cache: "no-cache" }).then(async (response) => {
      if (!response.ok) throw new Error(`Schema returned HTTP ${response.status}.`);
      return await response.json() as unknown;
    }).then(async (schema) => {
      if (run !== schemaLoadSequence.current) return;
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new Error("The selected schema is not a JSON object.");
      const candidate = { fileName: `${selectedVersion.version}.schema.json`, schema };
      const checked = await schemaClient.preflight({ primary: candidate, dependencies: [], referenceMode: "internal" });
      if (!checked.valid) throw new Error(checked.problems[0]?.message ?? "The selected schema is invalid.");
      if (run !== schemaLoadSequence.current) return;
      compiledSchema.current = { primary: candidate, dependencies: [], referenceMode: "internal" };
      setTrackedPrimary(candidate);
      setLoaderOpen(false);
      setStatus({ type: "idle", message: `${selectedVersion.label} loaded. Press Validate to check this configuration.` });
    }).catch((error: unknown) => {
      if (run !== schemaLoadSequence.current) return;
      setStatus({ type: "error", message: `Could not load ${selectedVersion.label}: ${error instanceof Error ? error.message : String(error)}` });
    });
  }, [programId, schemaClient, selectedVersion]);

  const setEditorTheme = (next: RainglowThemeId) => { saveEditorTheme(next); if (onThemeChange) onThemeChange(next); else setLocalThemeId(next); };
  const updateLintSettings = (next: LintSettings) => { setLintSettings(next); saveLintSettings(next); };
  const updateSource = (next: string) => { sourceRef.current = next; revisionRef.current += 1; setRevision(revisionRef.current); setSource(next); setStatus({ type: "idle", message: "Edited. Checking when you pause." }); };

  const validate = useCallback(async () => {
    const run = ++sequence.current;
    schemaClient.cancel();
    setStatus({ type: "working", message: `Checking ${format.toUpperCase()} syntax and lint rules...` });
    const parsed = adapters[format].parse(sourceRef.current);
    const migrations = programId === "codex" && !customPrimary && parsed.value !== undefined ? codexMigrationDiagnostics(sourceRef.current, format, parsed.value) : [];
    const base = [...applyLintSeverities(parsed.diagnostics, lintSettings), ...lintDocument(sourceRef.current, parsed, format, lintSettings), ...migrations];
    if (!primary) {
      if (run !== sequence.current) return;
      setDiagnostics(base);
      setStatus({ type: "error", message: "The selected JSON Schema is still loading or could not be loaded." });
      return;
    }
    if (parsed.value === undefined || base.some((item) => item.source === "syntax" && item.severity === "error")) {
      if (run !== sequence.current) return;
      setDiagnostics(base);
      setStatus({ type: "invalid", message: `${base.filter((item) => item.severity === "error").length} blocking errors found.` });
      return;
    }
    setStatus({ type: "working", message: `Validating configuration against ${primary.fileName}...` });
    const cached = compiledSchema.current;
    const reuseCompiled = cached && cached.primary === primary && cached.referenceMode === referenceMode
      && cached.dependencies.length === dependencies.length && cached.dependencies.every((file, index) => file === dependencies[index]);
    const response = await schemaClient.validate({ value: parsed.value, primary, dependencies, referenceMode, ...(reuseCompiled ? { skipPreflight: true } : {}) });
    if (!reuseCompiled) compiledSchema.current = { primary, dependencies, referenceMode };
    if (run !== sequence.current) return;
    const migrationPaths = new Set(migrations.flatMap((diagnostic) => diagnostic.dataPath === undefined ? [] : [diagnostic.dataPath]));
    const knownPropertyNames = schemaPropertyNames(primary.schema);
    const schemaDiagnostics = response.problems
      .map((problem) => translateSchemaProblem(problem, { source: sourceRef.current, value: parsed.value, locations: parsed.locations, knownPropertyNames }))
      .filter((diagnostic) => !migrationPaths.has(diagnostic.dataPath ?? ""));
    const notices: Diagnostic[] = response.notices.map((notice) => ({ ...rangeFromOffsets(sourceRef.current, 0, Math.min(1, sourceRef.current.length)), hasSourceLocation: false, severity: notice.severity, source: "schema", ruleId: notice.ruleId, message: notice.message, explanation: notice.explanation, suggestion: notice.ruleId === "schema/format-annotation" ? "Add validator support for the custom format if its application-specific semantics must be asserted." : "Declare the intended JSON Schema draft explicitly if the default is not correct." }));
    const next = [...base, ...schemaDiagnostics, ...notices].sort((left, right) => left.from - right.from || left.severity.localeCompare(right.severity));
    setDiagnostics(next);
    const errors = next.filter((item) => item.severity === "error").length;
    setStatus({ type: errors ? "invalid" : "valid", message: errors ? `${diagnosticCountSummary(next)} found.` : `Valid against ${customPrimary?.fileName ?? selectedVersion?.label ?? primary.fileName}${next.length ? ` with ${diagnosticCountSummary(next)}` : ""}.` });
  }, [adapters, customPrimary, dependencies, format, lintSettings, primary, programId, referenceMode, schemaClient, selectedVersion?.label]);

  useEffect(() => {
    if (!revision) return;
    const timer = window.setTimeout(() => void validate(), 450);
    return () => window.clearTimeout(timer);
  }, [revision, validate]);

  useEffect(() => {
    if (!editorExpanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setEditorExpanded(false); };
    document.body.classList.add("editor-is-expanded");
    window.addEventListener("keydown", close);
    return () => { document.body.classList.remove("editor-is-expanded"); window.removeEventListener("keydown", close); };
  }, [editorExpanded]);

  const uploadConfig = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CONFIG_BYTES) { setStatus({ type: "error", message: "Configuration files must be 2 MiB or smaller." }); return; }
    const detection = detectFormat(file.name, "");
    if (!detection.format) { setStatus({ type: "error", message: "Choose a .json, .yaml, .yml, or .toml configuration file." }); return; }
    try { const contents = await readFile(file); setFileName(file.name); setSelectedFormat(detection.format); updateSource(contents); setStatus({ type: "idle", message: `${file.name} loaded as ${detection.format.toUpperCase()}.` }); } catch { setStatus({ type: "error", message: "The selected configuration file could not be read." }); }
  };

  const parseSchemaFile = async (file: File): Promise<LocalSchemaFile> => {
    if (!/\.(json|ya?ml|toml)$/i.test(file.name)) throw new Error("Schema files must use the .json, .yaml, .yml, or .toml extension.");
    const raw = await readFile(file);
    try { return { fileName: file.name, schema: parseSchemaText(raw, file.name, engine) }; } catch (cause) { throw new Error(`${file.name} is not valid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  };
  const activateCustomSchema = async (candidate: LocalSchemaFile) => {
    setSchemaBusy(true);
    setSchemaFeedback("Checking schema...");
    try {
      const checked = await schemaClient.preflight({ primary: candidate, dependencies, referenceMode });
      if (!checked.valid) throw new Error(checked.problems[0]?.message ?? "This is not a valid JSON Schema.");
      schemaLoadSequence.current += 1;
      compiledSchema.current = { primary: candidate, dependencies, referenceMode };
      setProgramId("none");
      setTrackedPrimary(undefined);
      setCustomPrimary(candidate);
     
      setLoaderOpen(false);
      setSchemaFeedback("");
      setStatus({ type: "idle", message: `${candidate.fileName} is ready.` });
    } catch (cause) {
      setSchemaFeedback(cause instanceof Error ? cause.message : "This is not a valid JSON Schema.");
    } finally { setSchemaBusy(false); }
  };
  const uploadPrimary = async (file: File | undefined) => {
    if (!file) return;
    try { if (file.size > MAX_CONFIG_BYTES) throw new Error("Schema files must be 2 MiB or smaller."); await activateCustomSchema(await parseSchemaFile(file)); }
    catch (cause) { setSchemaFeedback(cause instanceof Error ? cause.message : String(cause)); }
  };
  const loadPastedSchema = async () => {
    const trimmed = schemaDraft.trim();
    const yamlSource = isYamlDocument(trimmed) && !trimmed.startsWith("{") && !trimmed.startsWith("[");
    try { await activateCustomSchema({ fileName: yamlSource ? "pasted.schema.yaml" : "pasted.schema.json", schema: parseSchemaText(trimmed, undefined, engine) }); }
    catch (cause) { setSchemaFeedback(`Invalid schema text: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const fetchSchema = async () => {
    setSchemaBusy(true);
    setSchemaFeedback("Fetching schema...");
    try {
      const url = validSchemaUrl(schemaUrl.trim());
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Schema returned HTTP ${response.status}.`);
      const finalUrl = validSchemaUrl(response.url || url.href);
      const text = await response.text();
      await activateCustomSchema({ fileName: finalUrl.pathname.split("/").at(-1) ?? "schema.json", schema: parseSchemaText(text, finalUrl.pathname, engine) });
    } catch (cause) { setSchemaFeedback(cause instanceof Error ? cause.message : String(cause)); setSchemaBusy(false); }
  };
  const receiveSchemaFile = (event: DragEvent<HTMLElement> | ClipboardEvent<HTMLElement>) => {
    const file = "dataTransfer" in event ? event.dataTransfer.files[0] : event.clipboardData.files[0];
    if (!file) return;
    event.preventDefault();
    void uploadPrimary(file);
  };
  const uploadDependencies = async (files: FileList | null) => {
    if (!files?.length) return;
    try { const incoming = [...files]; if (incoming.length > MAX_SCHEMA_FILES || incoming.reduce((sum, file) => sum + file.size, 0) > MAX_SCHEMA_BUNDLE_BYTES) throw new Error("A local schema bundle can contain up to 50 files and 10 MiB total."); const parsed = await Promise.all(incoming.map(parseSchemaFile)); setDependencies(parsed); compiledSchema.current = undefined; setStatus({ type: "idle", message: `${parsed.length} local schema ${parsed.length === 1 ? "dependency" : "dependencies"} loaded.` }); }
    catch (cause) { setStatus({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
  };

  const formatSource = async () => { try { const formatted = await adapters[format].formatSource(sourceRef.current, FORMAT_OPTIONS); updateSource(formatted); await validate(); } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setDiagnostics([documentLevelDiagnostic(sourceRef.current, "error", "format", "format/failed", message, `The ${format.toUpperCase()} formatter could not format this document because its current structure is invalid.`, `Correct the ${format.toUpperCase()} syntax error, then run Format again.`)]); setStatus({ type: "error", message }); } };
  const visit = (diagnostic: Diagnostic) => { const editor = editorRef.current; if (!editor) return; const from = Math.min(diagnostic.from, editor.state.doc.length); const to = Math.min(Math.max(from, diagnostic.to), editor.state.doc.length); editor.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) }); editor.focus(); };
  const copy = async () => { try { await navigator.clipboard.writeText(sourceRef.current); setStatus({ type: "idle", message: "Configuration copied to the clipboard." }); } catch { setStatus({ type: "error", message: "Clipboard access was not available." }); } };
  const saveBlob = (text: string, mime: string, name: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
    setDownloadMenuOpen(false);
  };
  const download = (target: ConfigFormat) => {
    try {
      const parsed = adapters[format].parse(sourceRef.current);
      if (parsed.value === undefined || parsed.diagnostics.some((item) => item.severity === "error")) throw new Error("Fix the syntax errors in the current configuration before downloading it.");
      saveBlob(serializeConfig(parsed.value, target, engine), mimeType(target), `${program?.outputBaseName ?? "config"}.${extension(target)}`);
    } catch (cause) { setStatus({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const downloadSchema = (target: SchemaFormat) => {
    try {
      if (!primary) throw new Error("Load a schema before saving it.");
      saveBlob(serializeSchema(primary.schema, { format: target, engine }), mimeType(target), schemaOutputName(target, schemaKind));
    } catch (cause) { setStatus({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const applyFix = (diagnostic: Diagnostic) => {
    if (!diagnostic.fix) return;
    const next = `${sourceRef.current.slice(0, diagnostic.fix.from)}${diagnostic.fix.replacement}${sourceRef.current.slice(diagnostic.fix.to)}`;
    updateSource(next);
    void validate();
  };
  const canDownload = source.trim().length > 0;
  const canDownloadSchema = primary !== undefined;

  return <section aria-labelledby="generic-title" className="workbench generic-workbench">
    <div className="workbench-intro"><div><p className="eyebrow">Private, in your browser</p><h1 id="generic-title">Check your config</h1><p>Paste or open a configuration, then get clear fixes before you use it.</p></div>
      <div className="select-stack unified-selects">
        <label>Configuration format<select aria-label="Configuration format" value={selectedFormat} onChange={(event) => { setSelectedFormat(event.target.value as SelectedFormat); }}><option value="auto">Auto detect ({format.toUpperCase()})</option><option value="json">JSON</option><option value="yaml">YAML</option><option value="toml">TOML</option></select></label>
        <label>Theme<select aria-label="Website theme" value={themeId} onChange={(event) => setEditorTheme(event.target.value as RainglowThemeId)}><optgroup label="Dark themes">{RAINGLOW_THEMES.filter((theme) => theme.variant === "dark").map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</optgroup><optgroup label="Light themes">{RAINGLOW_THEMES.filter((theme) => theme.variant === "light").map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</optgroup></select></label>
      </div>
    </div>

    <section aria-label="Load schema" className={`schema-loader${loaderOpen ? " is-open" : ""}`} onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); }} onDrop={receiveSchemaFile} onPaste={receiveSchemaFile}>
      {!loaderOpen && primary ? <div className="schema-summary"><span><Check aria-hidden="true" size={17} /><small>Schema</small><strong>{program?.name ?? customPrimary?.fileName}</strong>{selectedVersion ? <em>{selectedVersion.label}</em> : null}</span><button className="button button-quiet" onClick={() => setLoaderOpen(true)} type="button">Change</button></div> : <>
        <div className="schema-loader-heading"><div><h2>Load schema</h2><p>Choose a ready-made schema or add your own.</p></div>{primary ? <button aria-label="Close schema loader" className="icon-button" onClick={() => setLoaderOpen(false)} type="button"><X aria-hidden="true" size={18} /></button> : null}</div>
        <div className="schema-source-row">
          <label>Source<select aria-label="Schema source" value={programId} onChange={(event) => {
            const id = event.target.value;
            setProgramId(id); setCustomPrimary(undefined); setDependencies([]); setTrackedPrimary(undefined); setSchemaFeedback("");
            if (id === "none") { schemaLoadSequence.current += 1; compiledSchema.current = undefined; setStatus({ type: "idle", message: "Add your JSON Schema below." }); return; }
            const next = manifest.programs[id]; if (!next) return;
            const version = next.versions.find((item) => item.channel === "stable") ?? next.versions[0];
            setSelectedVersionId(version?.id ?? ""); setSelectedFormat(next.defaultFormat); setStatus({ type: "working", message: `Loading ${next.name} schema...` });
          }}><option value="none">None — use my own (JSON, YAML, TOML, OpenAPI)</option>{programIds.map((id) => <option key={id} value={id}>{manifest.programs[id]?.name}</option>)}</select></label>
          {program ? <label>Version<select aria-label="Schema version" value={selectedVersionId} onChange={(event) => { setTrackedPrimary(undefined); setSelectedVersionId(event.target.value); setStatus({ type: "working", message: "Loading schema..." }); }}>
            {program.versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}
          </select></label> : null}
        </div>
        {programId === "none" ? <div className="custom-schema-controls">
          <div className="schema-choice-buttons">
            <button aria-pressed={loaderAction === "paste"} className="button button-secondary" onClick={() => setLoaderAction(loaderAction === "paste" ? "none" : "paste")} type="button"><FileJson aria-hidden="true" size={17} /> Paste schema</button>
            <button aria-pressed={loaderAction === "url"} className="button button-secondary" onClick={() => setLoaderAction(loaderAction === "url" ? "none" : "url")} type="button"><Link2 aria-hidden="true" size={17} /> Fetch URL</button>
            <label className="button button-secondary"><FileUp aria-hidden="true" size={17} /> Choose file<input accept=".json,.yaml,.yml,.toml,application/json,application/yaml" aria-label="Choose schema file (JSON, YAML, or TOML)" className="visually-hidden" onChange={(event) => { void uploadPrimary(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} type="file" /></label>
          </div>
          {loaderAction === "paste" ? <div className="schema-input-reveal"><label htmlFor="schema-json">JSON Schema or OpenAPI (JSON or YAML)</label><textarea id="schema-json" onChange={(event) => setSchemaDraft(event.target.value)} placeholder={'$schema: https://json-schema.org/draft/2020-12/schema\ntype: object\n# — or paste JSON, including an OpenAPI document'} rows={6} value={schemaDraft} /><button className="button button-primary" disabled={!schemaDraft.trim() || schemaBusy} onClick={() => void loadPastedSchema()} type="button">{schemaBusy ? "Checking..." : "Load schema"}</button></div> : null}
          {loaderAction === "url" ? <div className="schema-input-reveal schema-url-input"><label htmlFor="schema-url">HTTPS schema URL (.json, .yaml, .yml, .toml)</label><div><input id="schema-url" inputMode="url" onChange={(event) => setSchemaUrl(event.target.value)} placeholder="https://example.com/schema.yaml" type="url" value={schemaUrl} /><button className="button button-primary" disabled={!schemaUrl.trim() || schemaBusy} onClick={() => void fetchSchema()} type="button">{schemaBusy ? "Fetching..." : "Fetch schema"}</button></div></div> : null}
          <p className="drop-hint">You can also drop a .json, .yaml, .yml, or .toml schema file here, or paste a copied file.</p>
          {schemaFeedback ? <p className="schema-feedback" role="alert"><TriangleAlert aria-hidden="true" size={16} />{schemaFeedback}</p> : null}
          <details className="schema-advanced"><summary>Advanced</summary><div className="schema-upload"><span>Local references</span><label className="button button-secondary"><FileUp aria-hidden="true" size={17} /> {dependencies.length ? `${dependencies.length} loaded` : "Choose dependencies"}<input accept=".json,.yaml,.yml,.toml,application/json,application/yaml" aria-label="Upload schema dependencies" className="visually-hidden" multiple onChange={(event) => { void uploadDependencies(event.currentTarget.files); event.currentTarget.value = ""; }} type="file" /></label></div><fieldset className="reference-mode"><legend>$ref policy</legend><label><input checked={referenceMode === "internal"} name="reference-mode" onChange={() => { setReferenceMode("internal"); compiledSchema.current = undefined; }} type="radio" /> Internal only</label><label><input checked={referenceMode === "bundle"} name="reference-mode" onChange={() => { setReferenceMode("bundle"); compiledSchema.current = undefined; }} type="radio" /> Uploaded bundle</label></fieldset></details>
        </div> : null}
      </>}
    </section>

    <div aria-label="Configuration actions" className="action-bar"><label className="button button-secondary"><FileUp aria-hidden="true" size={17} /> Upload config<input accept=".json,.yaml,.yml,.toml" aria-label="Upload configuration" className="visually-hidden" onChange={(event) => { void uploadConfig(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} type="file" /></label><LintSettingsDrawer onChange={updateLintSettings} settings={lintSettings} /><span className="action-spacer" /><button className="button button-quiet" onClick={() => void copy()} type="button"><Clipboard aria-hidden="true" size={17} /> Copy</button>
      <div className="download-control"><button aria-expanded={downloadMenuOpen} className="button button-quiet" onClick={() => setDownloadMenuOpen((open) => !open)} type="button"><Download aria-hidden="true" size={17} /> Download <ChevronDown aria-hidden="true" size={15} /></button>{downloadMenuOpen ? <div aria-label="Download format" className="download-menu" role="menu">
        <div className="download-menu-label">Configuration</div>
        {(["json", "yaml", "toml"] as const).map((target) => <button disabled={!canDownload} key={target} onClick={() => download(target)} role="menuitem" type="button">{target.toUpperCase()} <small>.{extension(target)}</small></button>)}
        <div className="download-menu-label">Schema</div>
        {(["json", "yaml", "toml"] as const).map((target) => <button disabled={!canDownloadSchema} key={target} onClick={() => downloadSchema(target)} role="menuitem" type="button">{schemaKind === "openapi" ? `OpenAPI ${target.toUpperCase()}` : `JSON Schema ${target.toUpperCase()}`} <small>.{extension(target)}</small></button>)}
      </div> : null}</div>
      <button className="button button-danger" onClick={() => { sequence.current += 1; updateSource(""); setDiagnostics([]); }} type="button"><Trash2 aria-hidden="true" size={17} /> Clear</button>
    </div>
    <div className={`editor-shell${editorExpanded ? " is-expanded" : ""}`}><div className="editor-toolbar"><strong>{fileName ?? `Untitled.${extension(format)}`}</strong><span /><button className="button button-primary" onClick={() => void validate()} type="button"><Play aria-hidden="true" size={16} /> Validate</button><button className="button button-secondary" onClick={() => void formatSource()} type="button"><Paintbrush aria-hidden="true" size={16} /> Format</button><button className="button button-secondary" onClick={() => setEditorExpanded((value) => !value)} type="button">{editorExpanded ? <Minimize2 aria-hidden="true" size={16} /> : <Maximize2 aria-hidden="true" size={16} />}{editorExpanded ? "Done" : "Expand editor"}</button></div><div className="editor-frame"><ConfigEditor ariaLabel={`${format.toUpperCase()} configuration editor`} diagnostics={diagnostics} language={format} onChange={updateSource} onCreateEditor={(view) => { editorRef.current = view; }} onValidationTrigger={() => void validate()} themeId={themeId} value={source} /></div></div>
    <div className={`validation-status status-${status.type}`} role={status.type === "error" ? "alert" : "status"}>{status.type === "working" ? <LoaderCircle aria-hidden="true" className="spin" size={18} /> : status.type === "valid" ? <Check aria-hidden="true" size={18} /> : status.type === "invalid" || status.type === "error" ? <TriangleAlert aria-hidden="true" size={18} /> : null}<span>{status.message}</span></div>
    <ProblemsPanel diagnostics={diagnostics} onFix={applyFix} onVisit={visit} />
    <p className="privacy-note">Configuration and schema files stay in this browser. Optional site visit metrics only start after consent.</p>
  </section>;
}
