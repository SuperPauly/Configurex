import type { Diagnostic, SourceRange } from "../diagnostics/types";

export type ConfigFormat = "json" | "yaml" | "toml";

/** Serialization formats a schema document can be loaded from or saved as. */
export type SchemaFormat = "json" | "yaml" | "toml";

export interface ParsedDocument {
  readonly value?: unknown;
  readonly diagnostics: readonly Diagnostic[];
  readonly locations: ReadonlyMap<string, SourceRange>;
}

export interface FormatOptions {
  readonly tabWidth: number;
  readonly useTabs: boolean;
  readonly printWidth: number;
  readonly singleQuote?: boolean;
}

export interface FormatAdapter {
  readonly format: ConfigFormat;
  parse(source: string): ParsedDocument;
  formatSource(source: string, options: FormatOptions): Promise<string>;
}
