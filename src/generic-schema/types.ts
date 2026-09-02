import type { DiagnosticSeverity } from "../diagnostics/types";
import type { SchemaValidationSettings } from "./settings";

export type ReferenceMode = "internal" | "bundle";

export interface LocalSchemaFile {
  readonly fileName: string;
  readonly schema: unknown;
}

export interface ReferenceIssue {
  readonly ruleId: "schema/ref-external-blocked" | "schema/ref-unresolved";
  readonly reference: string;
  readonly message: string;
}

export interface SchemaProblem {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly data?: unknown;
}

export interface SchemaNotice {
  readonly ruleId: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly explanation: string;
}

export interface SchemaValidationRequest {
  readonly kind?: "validate";
  readonly requestId: number;
  readonly value: unknown;
  readonly primary: LocalSchemaFile;
  readonly dependencies: readonly LocalSchemaFile[];
  /** Effective validation settings; `referenceMode` inside takes precedence. */
  readonly settings: SchemaValidationSettings;
  /** @deprecated Legacy field kept for older callers; superseded by `settings.referenceMode`. */
  readonly referenceMode?: ReferenceMode;
  /** When true, the worker may reuse the cached compilation for an identical schema set. */
  readonly skipPreflight?: boolean;
}

export interface SchemaPreflightRequest {
  readonly kind: "preflight";
  readonly requestId: number;
  readonly primary: LocalSchemaFile;
  readonly dependencies: readonly LocalSchemaFile[];
  /** Effective validation settings; `referenceMode` inside takes precedence. */
  readonly settings: SchemaValidationSettings;
  /** @deprecated Legacy field kept for older callers; superseded by `settings.referenceMode`. */
  readonly referenceMode?: ReferenceMode;
}

/** How the effective dialect was chosen for a compiled schema. */
export type DialectSource = "declared" | "auto-fallback" | "manual-override";

export interface SchemaInterpretation {
  /** The `$schema` URI declared by the schema, when present. */
  readonly declaredDialectUri?: string;
  /** The dialect the schema was actually compiled with. */
  readonly effectiveDialect: string;
  /** Where the effective dialect came from. */
  readonly dialectSource: DialectSource;
  /** The detected document interpretation (`json-schema`, `openapi-3.0`, or `openapi-3.1`). */
  readonly documentKind: string;
}

export interface SchemaValidationResponse {
  readonly requestId: number;
  readonly valid: boolean;
  readonly problems: readonly SchemaProblem[];
  readonly notices: readonly SchemaNotice[];
  /** How the schema was interpreted; present whenever interpretation was possible. */
  readonly interpretation?: SchemaInterpretation;
}
