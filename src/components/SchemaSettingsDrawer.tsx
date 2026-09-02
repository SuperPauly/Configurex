import { RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";

import {
  reducedValidationNotice,
  schemaDialectLabel,
  schemaValidationSettingsForPreset,
  STRICT_SCHEMA_VALIDATION_SETTINGS,
  withSchemaValidationPatch,
  type SchemaDialect,
  type SchemaDocumentType,
  type SchemaValidationPreset,
  type SchemaValidationSettings,
} from "../generic-schema/settings";
import type { SchemaInterpretation } from "../generic-schema/types";

const DIALECT_OPTIONS: readonly { value: SchemaDialect; label: string }[] = [
  { value: "auto", label: "Auto-detect (recommended)" },
  { value: "draft-04", label: "Draft 4" },
  { value: "draft-06", label: "Draft 6" },
  { value: "draft-07", label: "Draft 7" },
  { value: "draft-2019-09", label: "Draft 2019-09" },
  { value: "draft-2020-12", label: "Draft 2020-12" },
];

const DOCUMENT_TYPE_OPTIONS: readonly { value: SchemaDocumentType; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "json-schema", label: "JSON Schema" },
  { value: "openapi", label: "OpenAPI document" },
];

const PRESET_OPTIONS: readonly { value: Exclude<SchemaValidationPreset, "custom">; label: string; description: string }[] = [
  { value: "strict", label: "Strict (recommended)", description: "Full schema-authoring quality checks and reliable validation." },
  { value: "compatible", label: "Compatible", description: "Accepts legacy tuple schemas from older tools while preserving other strict checks." },
  { value: "permissive", label: "Permissive", description: "Best-effort troubleshooting mode for legacy schemas; disables schema-quality checks." },
];

const ADVANCED_TOGGLES: readonly {
  key: "strictSchema" | "strictTuples" | "strictRequired" | "validateFormats" | "allowUnknownFormatsAsAnnotations" | "allErrors" | "verboseErrors";
  label: string;
  help: string;
}[] = [
  { key: "strictSchema", label: "Require strict schema keywords and structures", help: "Reject unknown or misplaced schema keywords instead of ignoring them." },
  { key: "strictTuples", label: "Require tuple length constraints", help: "A legacy `items: [...]` tuple must declare its intended length with `minItems`/`maxItems` and/or `additionalItems: false`. Disable to accept the legacy tuple style." },
  { key: "strictRequired", label: "Require properties referenced by `required` to be declared", help: "Every property named by `required` must also appear in `properties`." },
  { key: "validateFormats", label: "Validate known format semantics", help: "Assert values match known `format` keywords such as `email`, `uri`, and the Codex numeric formats." },
  { key: "allowUnknownFormatsAsAnnotations", label: "Treat unknown custom formats as annotations", help: "Unrecognized custom formats do not block structural validation; disable to fail compilation on them." },
  { key: "allErrors", label: "Collect all validation failures", help: "Report every failure instead of stopping at the first one." },
  { key: "verboseErrors", label: "Include verbose validation details", help: "Attach the failing value and schema path to each reported problem." },
];

export interface SchemaSettingsDrawerProps {
  readonly settings: SchemaValidationSettings;
  readonly interpretation: SchemaInterpretation | undefined;
  readonly onChange: (settings: SchemaValidationSettings) => void;
}

export function SchemaSettingsDrawer({ settings, interpretation, onChange }: SchemaSettingsDrawerProps) {
  const [open, setOpen] = useState(false);
  const warning = reducedValidationNotice(settings);
  const update = (patch: Partial<SchemaValidationSettings>) => onChange(withSchemaValidationPatch(settings, patch));
  const selectPreset = (preset: SchemaValidationPreset) => {
    if (preset === "custom") return;
    onChange(schemaValidationSettingsForPreset(preset, settings));
  };
  const reset = () => onChange(STRICT_SCHEMA_VALIDATION_SETTINGS);
  return <>
    <button className="button button-secondary" onClick={() => setOpen(true)} type="button"><SlidersHorizontal aria-hidden="true" size={17} /> Schema settings</button>
    {open ? <div className="drawer-backdrop" role="presentation">
      <aside aria-label="Schema validation settings" className="lint-drawer schema-settings-drawer">
        <header><div><p className="eyebrow">Schema compatibility</p><h2>Schema validation settings</h2><p>Change how Configurex reads and compiles the loaded schema. These settings do not change your configuration document.</p></div><button aria-label="Close schema validation settings" className="icon-button" onClick={() => setOpen(false)} type="button"><X aria-hidden="true" /></button></header>
        <fieldset className="settings-section">
          <legend>Schema interpretation</legend>
          <label>Schema document type
            <select aria-label="Schema document type" onChange={(event) => update({ documentType: event.target.value as SchemaDocumentType })} value={settings.documentType}>
              {DOCUMENT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Schema dialect
            <select aria-label="Schema dialect" onChange={(event) => update({ dialect: event.target.value as SchemaDialect })} value={settings.dialect}>
              {DIALECT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <dl className="interpretation-facts">
            <div><dt>Declared $schema</dt><dd>{interpretation?.declaredDialectUri ?? "none declared"}</dd></div>
            <div><dt>Active dialect</dt><dd>{interpretation?.effectiveDialect ? schemaDialectLabel(interpretation.effectiveDialect as Exclude<SchemaDialect, "auto">) : "not compiled"}</dd></div>
            <div><dt>Dialect source</dt><dd>{interpretation ? { declared: "Declared by the schema", "auto-fallback": "Automatic fallback (no `$schema` declared)", "manual-override": "Manual override" }[interpretation.dialectSource] : "not compiled"}</dd></div>
          </dl>
          <p className="settings-hint">A manual dialect override never rewrites the uploaded schema, but validation may differ from tools that honor the declared dialect.</p>
        </fieldset>
        <fieldset className="settings-section">
          <legend>Validation profile</legend>
          <label>Validation preset
            <select aria-label="Validation preset" onChange={(event) => selectPreset(event.target.value as SchemaValidationPreset)} value={settings.preset}>
              {PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              <option disabled={settings.preset !== "custom"} value="custom">Custom</option>
            </select>
          </label>
          <ul className="preset-descriptions">
            {PRESET_OPTIONS.map((option) => <li key={option.value}><strong>{option.label}:</strong> {option.description}</li>)}
            <li><strong>Custom:</strong> shown automatically when individual advanced options differ from a preset.</li>
          </ul>
        </fieldset>
        <fieldset className="settings-section">
          <legend>Advanced compatibility options</legend>
          <p className="settings-hint">These settings affect how Configurex reads and compiles the schema, not the configuration document itself. Changing one switches the preset to Custom.</p>
          {ADVANCED_TOGGLES.map((toggle) => <label className="settings-toggle" key={toggle.key}>
            <input checked={settings[toggle.key]} onChange={(event) => update({ [toggle.key]: event.target.checked })} type="checkbox" />
            <span><strong>{toggle.label}</strong><small>{toggle.help}</small></span>
          </label>)}
        </fieldset>
        <fieldset className="settings-section reference-mode">
          <legend>Reference policy</legend>
          <label><input checked={settings.referenceMode === "internal"} name="settings-reference-mode" onChange={() => update({ referenceMode: "internal" })} type="radio" /> Internal references only</label>
          <label><input checked={settings.referenceMode === "bundle"} name="settings-reference-mode" onChange={() => update({ referenceMode: "bundle" })} type="radio" /> Allow local bundled dependency schemas</label>
          <p className="settings-hint">Remote URL references are never fetched in this browser.</p>
        </fieldset>
        {warning ? <p className="schema-warning" role="status">{warning}</p> : null}
        <div className="drawer-toolbar">
          <button className="button button-danger" onClick={reset} type="button"><RotateCcw aria-hidden="true" size={15} /> Reset to Strict defaults</button>
        </div>
      </aside>
    </div> : null}
  </>;
}
