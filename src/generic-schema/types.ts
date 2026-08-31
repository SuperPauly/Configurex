import type { DiagnosticSeverity } from "../diagnostics/types";

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
  readonly referenceMode: ReferenceMode;
  /** When true, the worker may reuse the cached compilation for an identical schema set. */
  readonly skipPreflight?: boolean;
}

export interface SchemaPreflightRequest {
  readonly kind: "preflight";
  readonly requestId: number;
  readonly primary: LocalSchemaFile;
  readonly dependencies: readonly LocalSchemaFile[];
  readonly referenceMode: ReferenceMode;
}

export interface SchemaValidationResponse {
  readonly requestId: number;
  readonly valid: boolean;
  readonly problems: readonly SchemaProblem[];
  readonly notices: readonly SchemaNotice[];
}
