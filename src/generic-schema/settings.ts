/**
 * Typed schema-loading and AJV validation settings for the Generic Workbench.
 *
 * Every setting has a documented purpose and a safe default. Imported or
 * persisted values are runtime-validated with `parseSchemaValidationSettings`;
 * anything missing, malformed, stale, or unknown falls back to the Strict
 * defaults. The shape is plain JSON so it survives the Worker message boundary
 * and `localStorage` unchanged.
 */

/**
 * Dialect preference. `auto` honors the schema's declared `$schema` URI and
 * falls back to Draft 2020-12 (with an informational notice) when undeclared.
 * A concrete value overrides the declaration without mutating the schema.
 */
export type SchemaDialect =
  | "auto"
  | "draft-04"
  | "draft-06"
  | "draft-07"
  | "draft-2019-09"
  | "draft-2020-12";

/** A concrete dialect (no `auto`). */
export type ResolvedSchemaDialect = Exclude<SchemaDialect, "auto">;

export type SchemaDocumentType = "auto" | "json-schema" | "openapi";

export type SchemaValidationPreset = "strict" | "compatible" | "permissive" | "custom";

export interface SchemaValidationSettings {
  /** Dialect selection; `auto` detects from `$schema`, defaulting to 2020-12. */
  readonly dialect: SchemaDialect;
  /** Selected preset; becomes `custom` when an individual control is changed. */
  readonly preset: SchemaValidationPreset;
  /** Document-type interpretation; `auto` detects OpenAPI markers. */
  readonly documentType: SchemaDocumentType;

  /** Reject unknown or misplaced schema keywords/structures (AJV `strictSchema`). */
  readonly strictSchema: boolean;
  /** Require `items: [...]` tuples to declare their intended length (AJV `strictTuples`). */
  readonly strictTuples: boolean;
  /** Require properties named by `required` to be declared (AJV `strictRequired`). */
  readonly strictRequired: boolean;

  /** Report every validation failure instead of stopping at the first (AJV `allErrors`). */
  readonly allErrors: boolean;
  /** Assert the semantics of known `format` keywords (AJV `validateFormats`). */
  readonly validateFormats: boolean;
  /** Treat unrecognized custom formats as annotations instead of compile errors. */
  readonly allowUnknownFormatsAsAnnotations: boolean;

  /** Which `$ref` targets are allowed; remote URLs are never fetched. */
  readonly referenceMode: "internal" | "bundle";
  /** Kept for compatibility; bundled dependencies are only used in `bundle` mode. */
  readonly allowLocalSchemaDependencies: boolean;

  /** Attach data/verbose detail to validation errors (AJV `verbose`). */
  readonly verboseErrors: boolean;
}

/** Serializable fields that influence AJV construction; used as the compile-cache key. */
export interface SchemaCompilerOptions {
  readonly dialect: ResolvedSchemaDialect;
  readonly strict: boolean;
  readonly strictTuples: boolean;
  readonly strictRequired: boolean;
  readonly allErrors: boolean;
  readonly validateFormats: boolean;
  readonly formatsMode: "fast" | "full";
  readonly verbose: boolean;
  readonly allowUnknownFormats: boolean;
}

const STRICT_BASE = {
  strictSchema: true,
  strictTuples: true,
  strictRequired: false,
  allErrors: true,
  validateFormats: true,
  allowUnknownFormatsAsAnnotations: true,
  verboseErrors: true,
} as const;

const COMPATIBLE_BASE = { ...STRICT_BASE, strictTuples: false } as const;

const PERMISSIVE_BASE = { ...COMPATIBLE_BASE, strictSchema: false } as const;

/**
 * Strict is the default and recommended preset: full schema-authoring quality
 * checks plus reliable validation.
 */
export const STRICT_SCHEMA_VALIDATION_SETTINGS: SchemaValidationSettings = {
  dialect: "auto",
  preset: "strict",
  documentType: "auto",
  ...STRICT_BASE,
  referenceMode: "internal",
  allowLocalSchemaDependencies: false,
};

export const DEFAULT_SCHEMA_VALIDATION_SETTINGS = STRICT_SCHEMA_VALIDATION_SETTINGS;

const SCHEMA_VALIDATION_PRESETS = {
  strict: STRICT_BASE,
  compatible: COMPATIBLE_BASE,
  permissive: PERMISSIVE_BASE,
} as const;

/** Full settings for a non-custom preset, preserving dialect/document/reference choices. */
export function schemaValidationSettingsForPreset(
  preset: Exclude<SchemaValidationPreset, "custom">,
  base: SchemaValidationSettings = STRICT_SCHEMA_VALIDATION_SETTINGS,
): SchemaValidationSettings {
  return { ...base, preset, ...SCHEMA_VALIDATION_PRESETS[preset] };
}

/** Preset whose toggle values match `settings`, or `custom` when none do. */
export function presetForSettings(settings: SchemaValidationSettings): SchemaValidationPreset {
  for (const [name, base] of Object.entries(SCHEMA_VALIDATION_PRESETS)) {
    if (
      settings.strictSchema === base.strictSchema
      && settings.strictTuples === base.strictTuples
      && settings.strictRequired === base.strictRequired
      && settings.allErrors === base.allErrors
      && settings.validateFormats === base.validateFormats
      && settings.allowUnknownFormatsAsAnnotations === base.allowUnknownFormatsAsAnnotations
      && settings.verboseErrors === base.verboseErrors
    ) return name as SchemaValidationPreset;
  }
  return "custom";
}

/**
 * Applies an individual control change. Toggles always flip the preset to
 * `custom`; `referenceMode: "bundle"` also enables local dependencies.
 */
export function withSchemaValidationPatch(
  settings: SchemaValidationSettings,
  patch: Partial<SchemaValidationSettings>,
): SchemaValidationSettings {
  const merged = { ...settings, ...patch };
  const toggled = (
    merged.strictSchema !== settings.strictSchema
    || merged.strictTuples !== settings.strictTuples
    || merged.strictRequired !== settings.strictRequired
    || merged.allErrors !== settings.allErrors
    || merged.validateFormats !== settings.validateFormats
    || merged.allowUnknownFormatsAsAnnotations !== settings.allowUnknownFormatsAsAnnotations
    || merged.verboseErrors !== settings.verboseErrors
  );
  return {
    ...merged,
    preset: toggled ? "custom" : presetForSettings(merged),
    allowLocalSchemaDependencies: merged.referenceMode === "bundle",
  };
}

const DIALECT_LABELS: Record<ResolvedSchemaDialect, string> = {
  "draft-04": "Draft 4",
  "draft-06": "Draft 6",
  "draft-07": "Draft 7",
  "draft-2019-09": "Draft 2019-09",
  "draft-2020-12": "Draft 2020-12",
};

export function schemaDialectLabel(dialect: ResolvedSchemaDialect): string {
  return DIALECT_LABELS[dialect];
}

const DIALECT_URIS: Readonly<Record<ResolvedSchemaDialect, readonly string[]>> = {
  "draft-04": ["http://json-schema.org/draft-04/schema#"],
  "draft-06": ["http://json-schema.org/draft-06/schema#"],
  "draft-07": ["http://json-schema.org/draft-07/schema#"],
  "draft-2019-09": ["https://json-schema.org/draft/2019-09/schema"],
  "draft-2020-12": ["https://json-schema.org/draft/2020-12/schema"],
};

/** Dialect declared by a `$schema` URI, or `undefined` when unrecognized. */
export function dialectForSchemaUri(uri: string): ResolvedSchemaDialect | undefined {
  const value = uri.trim().toLowerCase();
  for (const [dialect, uris] of Object.entries(DIALECT_URIS) as [ResolvedSchemaDialect, readonly string[]][]) {
    if (uris.some((known) => value === known || value === known.replace(/#$/, ""))) return dialect;
  }
  return undefined;
}

/** The `$schema` URI declared by a schema document, when present and a string. */
export function declaredSchemaUri(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const value = (schema as Record<string, unknown>).$schema;
  return typeof value === "string" ? value : undefined;
}

/** Detected OpenAPI major version, or `undefined` when the value is not an OpenAPI document. */
export function openapiVersionOf(value: unknown): "3.0" | "3.1" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).openapi;
  if (typeof version !== "string") return undefined;
  if (/^3\.1(?:\.|$)/.test(version)) return "3.1";
  if (/^3\.0(?:\.|$)/.test(version)) return "3.0";
  return undefined;
}

const SCHEMA_DIALECTS: readonly SchemaDialect[] = ["auto", "draft-04", "draft-06", "draft-07", "draft-2019-09", "draft-2020-12"];
const SCHEMA_PRESETS: readonly SchemaValidationPreset[] = ["strict", "compatible", "permissive", "custom"];
const SCHEMA_DOCUMENT_TYPES: readonly SchemaDocumentType[] = ["auto", "json-schema", "openapi"];
const REFERENCE_MODES: readonly ("internal" | "bundle")[] = ["internal", "bundle"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Validates unknown input (parsed JSON or a candidate object) into complete settings. */
export function parseSchemaValidationSettings(input: unknown): SchemaValidationSettings {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input) as unknown; } catch { throw new Error("Schema validation settings are not valid JSON."); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Schema validation settings must be a JSON object.");
  const candidate = value as Record<string, unknown>;
  const defaults = STRICT_SCHEMA_VALIDATION_SETTINGS;
  const merged: SchemaValidationSettings = {
    dialect: oneOf(candidate.dialect, SCHEMA_DIALECTS, defaults.dialect),
    preset: oneOf(candidate.preset, SCHEMA_PRESETS, defaults.preset),
    documentType: oneOf(candidate.documentType, SCHEMA_DOCUMENT_TYPES, defaults.documentType),
    strictSchema: booleanOr(candidate.strictSchema, defaults.strictSchema),
    strictTuples: booleanOr(candidate.strictTuples, defaults.strictTuples),
    strictRequired: booleanOr(candidate.strictRequired, defaults.strictRequired),
    allErrors: booleanOr(candidate.allErrors, defaults.allErrors),
    validateFormats: booleanOr(candidate.validateFormats, defaults.validateFormats),
    allowUnknownFormatsAsAnnotations: booleanOr(candidate.allowUnknownFormatsAsAnnotations, defaults.allowUnknownFormatsAsAnnotations),
    referenceMode: oneOf(candidate.referenceMode, REFERENCE_MODES, defaults.referenceMode),
    allowLocalSchemaDependencies: booleanOr(candidate.allowLocalSchemaDependencies, defaults.allowLocalSchemaDependencies),
    verboseErrors: booleanOr(candidate.verboseErrors, defaults.verboseErrors),
  };
  // Keep the model coherent: `preset` mirrors the toggles, and bundled
  // dependencies only exist in bundle reference mode.
  return withSchemaValidationPatch(merged, {});
}

export const SCHEMA_VALIDATION_SETTINGS_KEY = "codex-config-checker.schema-validation-settings";

/** Loads persisted settings, falling back to Strict defaults on anything unusable. */
export function loadSchemaValidationSettings(storage: Pick<Storage, "getItem"> = localStorage): SchemaValidationSettings {
  const stored = storage.getItem(SCHEMA_VALIDATION_SETTINGS_KEY);
  if (!stored) return STRICT_SCHEMA_VALIDATION_SETTINGS;
  try { return parseSchemaValidationSettings(stored); } catch { return STRICT_SCHEMA_VALIDATION_SETTINGS; }
}

/** Validates and persists settings immediately. */
export function saveSchemaValidationSettings(
  settings: SchemaValidationSettings,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(SCHEMA_VALIDATION_SETTINGS_KEY, JSON.stringify(parseSchemaValidationSettings(settings)));
}

/**
 * Serializes the exact settings handed to the validator worker. The worker
 * derives referenceMode from the settings, so callers pass a single source of
 * truth across the message boundary.
 */
export function schemaWorkerSettings(settings: SchemaValidationSettings): SchemaValidationSettings {
  return parseSchemaValidationSettings(settings);
}

/**
 * Reduces settings to the values that influence AJV construction. Included in
 * the compile-cache key so any effective change forces recompilation.
 * `strictSchema: false` relaxes the whole `strict` family, and disabling
 * custom-format annotations requires `formatsMode: "full"` so ajv-formats
 * formats still validate while unknown ones fail compilation.
 */
export function compilerOptionsFor(
  settings: SchemaValidationSettings,
  dialect: ResolvedSchemaDialect,
): SchemaCompilerOptions {
  return {
    dialect,
    strict: settings.strictSchema,
    strictTuples: settings.strictTuples,
    strictRequired: settings.strictRequired,
    allErrors: settings.allErrors,
    validateFormats: settings.validateFormats,
    formatsMode: settings.allowUnknownFormatsAsAnnotations ? "fast" : "full",
    verbose: settings.verboseErrors,
    allowUnknownFormats: settings.allowUnknownFormatsAsAnnotations,
  };
}

/** Stable string form of the compiler options, used as the compile-cache key. */
export function compilerCacheKey(options: SchemaCompilerOptions): string {
  return JSON.stringify(options);
}

/** True when the active settings perform fewer checks than Strict. */
export function isReducedValidation(settings: SchemaValidationSettings): boolean {
  const strict = STRICT_SCHEMA_VALIDATION_SETTINGS;
  return settings.strictSchema !== strict.strictSchema
    || settings.strictTuples !== strict.strictTuples
    || settings.strictRequired !== strict.strictRequired
    || settings.allErrors !== strict.allErrors
    || settings.validateFormats !== strict.validateFormats
    || settings.allowUnknownFormatsAsAnnotations !== strict.allowUnknownFormatsAsAnnotations
    || settings.verboseErrors !== strict.verboseErrors;
}

/** User-facing explanation shown when validation runs below Strict. */
export function reducedValidationNotice(settings: SchemaValidationSettings): string {
  const strict = STRICT_SCHEMA_VALIDATION_SETTINGS;
  if (!isReducedValidation(settings)) return "";
  const relaxations: string[] = [];
  if (settings.strictSchema !== strict.strictSchema) relaxations.push("strict schema keyword checks are disabled");
  if (settings.strictTuples !== strict.strictTuples) relaxations.push("tuple-length strictness is disabled, so legacy tuple schemas can compile even when their intended array length is ambiguous");
  if (settings.strictRequired !== strict.strictRequired) relaxations.push("required-property declaration checks are relaxed");
  if (settings.allErrors !== strict.allErrors) relaxations.push("only the first validation failure is reported");
  if (settings.validateFormats !== strict.validateFormats) relaxations.push("format values are not asserted");
  if (settings.allowUnknownFormatsAsAnnotations !== strict.allowUnknownFormatsAsAnnotations) relaxations.push("unknown custom formats fail compilation instead of being treated as annotations");
  if (settings.verboseErrors !== strict.verboseErrors) relaxations.push("validation details are abbreviated");
  if (!settings.strictSchema) {
    return `Permissive validation is active. Some schema-quality checks are disabled (${relaxations.join("; ")}); treat successful validation as best-effort compatibility rather than proof that the schema is well-formed.`;
  }
  const preset = presetForSettings(settings);
  const label = preset === "custom" ? "Custom" : preset === "compatible" ? "Compatible" : "Adjusted";
  return `${label} validation is active. ${relaxations.map((part) => part[0]?.toUpperCase() + part.slice(1)).join("; ")}.`;
}
