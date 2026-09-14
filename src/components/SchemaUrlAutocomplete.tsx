import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CatalogEntry } from "../generic-schema/schemastore";

export interface SchemaUrlAutocompleteProps {
  readonly catalog: readonly CatalogEntry[];
  readonly disabled?: boolean;
  readonly id: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}

const MAX_SUGGESTIONS = 8;

function matches(entry: CatalogEntry, query: string): boolean {
  const needle = query.toLowerCase();
  return entry.name.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle);
}

/**
 * SchemaStore URL autocomplete. The native `<datalist>` renders as an
 * unstyled full-viewport overlay on mobile browsers, so suggestions are
 * rendered as a custom dropdown anchored to the input's width.
 */
export function SchemaUrlAutocomplete({ catalog, disabled, id, onChange, placeholder, value }: SchemaUrlAutocompleteProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const query = value.trim();
  const suggestions = useMemo(
    () => (query.length < 2 ? [] : catalog.filter((entry) => matches(entry, query)).slice(0, MAX_SUGGESTIONS)),
    [catalog, query],
  );
  const expanded = open && suggestions.length > 0;

  const close = () => { setOpen(false); setHighlight(-1); };

  const pick = (entry: CatalogEntry) => {
    onChange(entry.url);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { close(); return; }
    if (!expanded) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" && highlight >= 0) {
      event.preventDefault();
      pick(suggestions[highlight]!);
    }
  };

  return <div className="schema-url-autocomplete" ref={rootRef}>
    <input
      aria-activedescendant={expanded && highlight >= 0 ? `${listId}-${highlight}` : undefined}
      aria-autocomplete="list"
      aria-controls={expanded ? listId : undefined}
      aria-expanded={expanded}
      autoComplete="off"
      disabled={disabled}
      id={id}
      inputMode="url"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
      onChange={(event) => { onChange(event.target.value); setOpen(true); setHighlight(-1); }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      role="combobox"
      type="url"
      value={value}
    />
    {expanded ? <ul aria-label="Schema suggestions" className="schema-url-suggestions" id={listId} role="listbox">
      {suggestions.map((entry, index) => <li
        aria-selected={index === highlight}
        className={index === highlight ? "is-highlighted" : undefined}
        id={`${listId}-${index}`}
        key={entry.url}
        onMouseDown={(event) => { event.preventDefault(); pick(entry); }}
        onMouseEnter={() => setHighlight(index)}
        role="option"
      >
        <strong>{entry.name}</strong>
        <small>{entry.url}</small>
      </li>)}
    </ul> : null}
  </div>;
}
