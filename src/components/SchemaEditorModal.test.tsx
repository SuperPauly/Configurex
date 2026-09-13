import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { SchemaEditorModal } from "./SchemaEditorModal";

describe("SchemaEditorModal", () => {
  it("renders zebra-striped CodeMirror lines and enables Save after validation", async () => {
    render(<SchemaEditorModal
      fileName="schema.json"
      initialSchema={{ type: "object", properties: { name: { type: "string" } } }}
      onCancel={vi.fn()}
      onSave={vi.fn()}
      themeId="github-light"
      validateSchema={vi.fn(async () => undefined)}
    />);

    expect(screen.getByRole("dialog", { name: /edit json schema/i })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled());
    expect(document.querySelectorAll(".cm-zebra-stripe").length).toBeGreaterThan(0);
  });

  it("reports malformed JSON immediately and keeps Save disabled", async () => {
    render(<SchemaEditorModal
      fileName="schema.json"
      initialSchema={{ type: "object" }}
      onCancel={vi.fn()}
      onSave={vi.fn()}
      themeId="github-light"
      validateSchema={vi.fn(async () => undefined)}
    />);

    const editor = screen.getByRole("textbox", { name: /json schema editor/i });
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{}"type":');
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/valid json/i);
  });
});
