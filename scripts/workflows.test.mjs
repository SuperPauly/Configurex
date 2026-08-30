import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function workflow(name) {
  return await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

test("schema synchronization runs every 6 hours and can commit both channels", async () => {
  const yaml = await workflow("sync-schemas.yml");

  assert.match(yaml, /cron:\s*["']0 \*\/6 \* \* \*["']/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /contents:\s*write/);
  assert.match(yaml, /npm run test:scripts/);
  assert.match(yaml, /node scripts\/sync-schemas\.mjs/);
  assert.match(yaml, /git push/);
});

test("Pages workflow tests, builds, and deploys every main push", async () => {
  const yaml = await workflow("pages.yml");

  assert.match(yaml, /push:[\s\S]*branches:\s*\[main\]/);
  assert.match(yaml, /npm ci/);
  assert.match(yaml, /npm run check/);
  assert.match(yaml, /npm run build/);
  assert.match(yaml, /actions\/upload-pages-artifact@[a-f0-9]{40}/);
  assert.match(yaml, /actions\/deploy-pages@[a-f0-9]{40}/);
  assert.match(yaml, /pages:\s*write/);
  assert.match(yaml, /id-token:\s*write/);
  assert.match(yaml, /VITE_GA_MEASUREMENT_ID:\s*\$\{\{\s*vars\.GA_MEASUREMENT_ID\s*\}\}/);
});

test("every external workflow action is pinned to a full commit SHA", async () => {
  const yaml = `${await workflow("sync-schemas.yml")}\n${await workflow("pages.yml")}`;
  const uses = [...yaml.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);

  assert.ok(uses.length >= 6);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/, action);
  }
});
