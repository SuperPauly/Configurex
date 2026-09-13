import { expect, test } from "@playwright/test";

// Runs only when LIVE_E2E=1: verifies a deployed bundle (default: GitHub
// Pages). CI runs the pre-deploy build, so this spec must stay skipped there.
// LIVE_BASE overrides the target (e.g. the local dev server) for pre-push checks.
test.skip(!process.env.LIVE_E2E, "set LIVE_E2E=1 to verify the deployed site");

const BASE = process.env.LIVE_BASE ?? "https://superpauly.github.io/Configurex/";
const HERMES_URL = "https://hermes-agent.nousresearch.com/docs/api/model-catalog.json";

async function openSite(page: import("@playwright/test").Page) {
  await page.goto(BASE);
  await expect(page.getByRole("heading", { name: "Check your config" })).toBeVisible();
  const decline = page.getByRole("button", { name: "No thanks" });
  if (await decline.isVisible()) await decline.click();
}

async function fetchHermesSchema(page: import("@playwright/test").Page) {
  await openSite(page);
  await page.getByRole("button", { name: /fetch url/i }).click();
  await page.locator("#schema-url").fill(HERMES_URL);
  await page.getByRole("button", { name: /^fetch schema$/i }).click();
}

test("loads the Hermes model catalog from its URL without errors", async ({ page }) => {
  await fetchHermesSchema(page);

  await expect(page.locator(".schema-feedback")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("model-catalog.json").first()).toBeVisible({ timeout: 30_000 });

  const summary = page.getByLabel(/active schema settings/i);
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/draft 2020-12/i);
  await expect(page.getByLabel(/schema load notices/i)).toContainText(/declares no `\$schema`/i);
});

test("validates a configuration against the fetched Hermes catalog schema", async ({ page }) => {
  await fetchHermesSchema(page);
  await expect(page.getByText("model-catalog.json").first()).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Configuration format").selectOption("json");
  const editor = page.getByRole("textbox", { name: /json configuration editor/i });
  await editor.fill('{"version": 1}');
  await page.getByRole("button", { name: /^validate$/i }).click();

  const status = page.locator(".validation-status");
  await expect(status).toContainText(/valid/i, { timeout: 30_000 });
  await expect(status).not.toContainText(/could not be compiled|error/i);
});
