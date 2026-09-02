import {
  schemaValidationSettingsForPreset,
  withSchemaValidationPatch,
  type SchemaDialect,
  type SchemaDocumentType,
  type SchemaValidationPreset,
  type SchemaValidationSettings,
} from "../generic-schema/settings";

export interface SchemaLoadingOptionsProps {
  readonly settings: SchemaValidationSettings;
  readonly onChange: (settings: SchemaValidationSettings) => void;
}

/**
 * Initial-load compatibility controls. Every change applies to the first
 * preflight compilation of the schema being loaded.
 */
export function SchemaLoadingOptions({ settings, onChange }: SchemaLoadingOptionsProps) {
  const update = (patch: Partial<SchemaValidationSettings>) => onChange(withSchemaValidationPatch(settings, patch));
  return <fieldset className="schema-loading-options">
    <legend>Schema loading options</legend>
    <div className="schema-loading-grid">
      <label>Schema document type
        <select aria-label="Schema document type" onChange={(event) => update({ documentType: event.target.value as SchemaDocumentType })} value={settings.documentType}>
          <option value="auto">Auto-detect</option>
          <option value="json-schema">JSON Schema</option>
          <option value="openapi">OpenAPI document</option>
        </select>
      </label>
      <label>Schema dialect
        <select aria-label="Schema dialect" onChange={(event) => update({ dialect: event.target.value as SchemaDialect })} value={settings.dialect}>
          <option value="auto">Auto-detect (recommended)</option>
          <option value="draft-04">Draft 4</option>
          <option value="draft-06">Draft 6</option>
          <option value="draft-07">Draft 7</option>
          <option value="draft-2019-09">Draft 2019-09</option>
          <option value="draft-2020-12">Draft 2020-12</option>
        </select>
      </label>
      <label>Validation preset
        <select aria-label="Validation preset" onChange={(event) => { const preset = event.target.value as SchemaValidationPreset; if (preset !== "custom") onChange(schemaValidationSettingsForPreset(preset, settings)); }} value={settings.preset}>
          <option value="strict">Strict (recommended)</option>
          <option value="compatible">Compatible</option>
          <option value="permissive">Permissive</option>
          <option disabled={settings.preset !== "custom"} value="custom">Custom</option>
        </select>
      </label>
      <fieldset className="reference-mode schema-loading-references">
        <legend>Reference policy</legend>
        <label><input checked={settings.referenceMode === "internal"} name="loading-reference-mode" onChange={() => update({ referenceMode: "internal" })} type="radio" /> Internal references only</label>
        <label><input checked={settings.referenceMode === "bundle"} name="loading-reference-mode" onChange={() => update({ referenceMode: "bundle" })} type="radio" /> Allow local bundled dependency schemas</label>
      </fieldset>
    </div>
    <p className="settings-hint">OpenAPI documents are detected and reported, but Configurex validates JSON Schema documents; extract an embedded schema object first. Reference policies never fetch remote URLs.</p>
    <details className="schema-loading-advanced">
      <summary>Advanced options</summary>
      <p className="settings-hint">These settings affect how Configurex reads and compiles the schema, not the configuration document itself. Changing one switches the preset to Custom.</p>
      <div className="schema-loading-toggles">
        <label><input checked={settings.strictSchema} onChange={(event) => update({ strictSchema: event.target.checked })} type="checkbox" /> Require strict schema keywords and structures</label>
        <label><input checked={settings.strictTuples} onChange={(event) => update({ strictTuples: event.target.checked })} type="checkbox" /> Require tuple length constraints</label>
        <label><input checked={settings.strictRequired} onChange={(event) => update({ strictRequired: event.target.checked })} type="checkbox" /> Require properties referenced by `required` to be declared</label>
        <label><input checked={settings.validateFormats} onChange={(event) => update({ validateFormats: event.target.checked })} type="checkbox" /> Validate known format semantics</label>
        <label><input checked={settings.allowUnknownFormatsAsAnnotations} onChange={(event) => update({ allowUnknownFormatsAsAnnotations: event.target.checked })} type="checkbox" /> Treat unknown custom formats as annotations</label>
        <label><input checked={settings.allErrors} onChange={(event) => update({ allErrors: event.target.checked })} type="checkbox" /> Collect all validation failures</label>
        <label><input checked={settings.verboseErrors} onChange={(event) => update({ verboseErrors: event.target.checked })} type="checkbox" /> Include verbose validation details</label>
      </div>
    </details>
  </fieldset>;
}
