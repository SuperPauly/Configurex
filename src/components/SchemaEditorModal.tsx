import { lintGutter } from "@codemirror/lint";
import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { jsonSchema } from "codemirror-json-schema";
import schemaMetaSchema from "ajv/dist/refs/json-schema-2020-12/schema.json";
import { useEffect, useMemo, useState } from "react";

import { editorThemeExtension, type RainglowThemeId } from "../editor/rainglow";

function buildZebraStripes(state: EditorState): DecorationSet {
  const stripes = [];
  for (let lineNumber = 2; lineNumber <= state.doc.lines; lineNumber += 2) {
    stripes.push(Decoration.line({ class: "cm-zebra-stripe" }).range(state.doc.line(lineNumber).from));
  }
  return Decoration.set(stripes, true);
}

const zebraStripes = StateField.define<DecorationSet>({
  create: buildZebraStripes,
  update: (stripes, transaction) => transaction.docChanged ? buildZebraStripes(transaction.state) : stripes,
  provide: (field) => EditorView.decorations.from(field),
});

export interface SchemaEditorModalProps {
  readonly fileName: string;
  readonly initialSchema: unknown;
  readonly themeId: RainglowThemeId;
  readonly validateSchema: (schema: unknown) => Promise<string | undefined>;
  readonly onCancel: () => void;
  readonly onSave: (schema: unknown) => void | Promise<void>;
}

export function SchemaEditorModal({
  fileName,
  initialSchema,
  themeId,
  validateSchema,
  onCancel,
  onSave,
}: SchemaEditorModalProps) {
  const [draft, setDraft] = useState(() => JSON.stringify(initialSchema, null, 2));
  const parsedDraft = useMemo<{ value: unknown; error?: undefined } | { value?: undefined; error: string }>(() => {
    try {
      return { value: JSON.parse(draft) as unknown };
    } catch {
      return { error: "Enter valid JSON before saving." };
    }
  }, [draft]);
  const [validation, setValidation] = useState<{ draft: string; error?: string }>({ draft: "" });
  const extensions = useMemo<Extension[]>(() => [
    jsonSchema(schemaMetaSchema as never),
    lintGutter(),
    zebraStripes,
    editorThemeExtension(themeId),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": "JSON Schema editor", spellcheck: "false" }),
  ], [themeId]);

  useEffect(() => {
    if (parsedDraft.error) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void validateSchema(parsedDraft.value).then((problem) => {
        if (cancelled) return;
        setValidation({ draft, ...(problem ? { error: problem } : {}) });
      }).catch((cause: unknown) => {
        if (cancelled) return;
        setValidation({ draft, error: cause instanceof Error ? cause.message : "This is not a valid JSON Schema." });
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [draft, parsedDraft, validateSchema]);

  const checking = !parsedDraft.error && validation.draft !== draft;
  const validationError = parsedDraft.error ?? (validation.draft === draft ? validation.error : undefined);

  const save = () => {
    if (checking || validationError || parsedDraft.error) return;
    void onSave(parsedDraft.value);
  };

  return <div className="modal-backdrop schema-editor-backdrop">
    <section aria-describedby="schema-editor-description" aria-labelledby="schema-editor-title" aria-modal="true" className="schema-editor-modal" role="dialog">
      <header className="schema-editor-modal-header">
        <div><p className="eyebrow">{fileName}</p><h2 id="schema-editor-title">Edit JSON Schema</h2></div>
        <p id="schema-editor-description">Changes are applied only when you save.</p>
      </header>
      <div className="schema-editor-frame">
        <CodeMirror
          className="schema-code-editor"
          data-editor-label="JSON Schema editor"
          extensions={extensions}
          height="100%"
          indentWithTab={false}
          onChange={setDraft}
          value={draft}
        />
      </div>
      <div aria-live="polite" className={`schema-editor-validation${validationError ? " is-error" : ""}`} role={validationError ? "alert" : "status"}>
        {validationError ?? (checking ? "Checking schema..." : "Schema is valid and ready to save.")}
      </div>
      <footer className="schema-editor-modal-footer">
        <button className="button button-quiet" onClick={onCancel} type="button">Cancel</button>
        <button className="button button-primary" disabled={checking || Boolean(validationError) || Boolean(parsedDraft.error)} onClick={save} type="button">Save</button>
      </footer>
    </section>
  </div>;
}
