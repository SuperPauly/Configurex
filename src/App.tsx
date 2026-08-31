import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { AnalyticsConsent } from "./components/AnalyticsConsent";
import { applyRainglowTheme, loadEditorTheme, saveEditorTheme, type RainglowThemeId } from "./editor/rainglow";
import { parseSchemaManifest } from "./schema/manifest";
import type { TomlEngine } from "./taplo/service";
import type { SchemaManifest } from "./types/schema";
import { GenericWorkbench } from "./workbenches/GenericWorkbench";

export interface ValidatorWorkbenchProps {
  readonly engine: TomlEngine;
  readonly manifest: SchemaManifest;
}

export const DEFAULT_GA_MEASUREMENT_ID = "G-CET6VNKSBL";

const initialThemeId = loadEditorTheme();
// Paint with the saved palette before the first frame so the UI never flashes.
applyRainglowTheme(initialThemeId);

// Start the manifest download at module evaluation so it overlaps bundle parsing.
// In non-browser test environments the request falls back to a relative URL.
const manifestRequest: Promise<unknown> = (typeof window === "undefined"
  ? Promise.reject(new Error("Schema manifest is unavailable outside the browser."))
  : fetch(new URL(`${import.meta.env.BASE_URL}schemas/manifest.json`, window.location.href), { cache: "no-cache" })
).then(async (response) => {
  if (!response.ok) throw new Error(`Schema manifest returned ${response.status}.`);
  return response.json() as Promise<unknown>;
});
manifestRequest.catch(() => undefined);

export function ApplicationWorkbench({ engine, manifest }: ValidatorWorkbenchProps) {
  const [themeId, setThemeId] = useState<RainglowThemeId>(initialThemeId);
  const changeTheme = (next: RainglowThemeId) => { setThemeId(next); saveEditorTheme(next); };
  useEffect(() => { applyRainglowTheme(themeId); }, [themeId]);
  return <div className="application-shell">
    <main className="app-shell"><section className="tool-card"><GenericWorkbench engine={engine} manifest={manifest} onThemeChange={changeTheme} themeId={themeId} /></section></main>
    <AnalyticsConsent measurementId={import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() || DEFAULT_GA_MEASUREMENT_ID} />
  </div>;
}

export default function App() {
  const [state, setState] = useState<
    | { readonly type: "loading" }
    | { readonly type: "ready"; readonly engine: TomlEngine; readonly manifest: SchemaManifest }
    | { readonly type: "error"; readonly message: string }
  >({ type: "loading" });

  useEffect(() => {
    let active = true;
    Promise.all([
      import("./taplo/service").then(({ TaploService }) => TaploService.initialize()),
      manifestRequest.then((body) => parseSchemaManifest(body)),
    ]).then(
      ([engine, manifest]) => { if (active) setState({ type: "ready", engine, manifest }); },
      (error: unknown) => active && setState({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => { active = false; };
  }, []);

  if (state.type === "loading") return <div className="app-loading"><LoaderCircle aria-hidden="true" className="spin" /> Loading Taplo...</div>;
  if (state.type === "error") return <main className="fatal-error"><h1>Config Schema Workbench</h1><p role="alert">{state.message}</p></main>;
  return <ApplicationWorkbench engine={state.engine} manifest={state.manifest} />;
}
