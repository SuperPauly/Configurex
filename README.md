# Codex Config Checker

A static, browser-only configuration validator, linter, formatter, and converter.
The unified workbench checks JSON, YAML, or TOML against a tracked Codex schema
or a JSON Schema you upload.

## Features

- Validates TOML with Taplo WebAssembly and the selected Codex release schema
- Gets the current stable Codex schema from OpenAI's documentation and release
  schemas from exact GitHub release assets named `config-schema.json`
- Selects the latest stable or alpha schema, or searches a scrollable archive of
  older release versions
- Validates JSON, YAML, and TOML against JSON Schema drafts 4, 7, 2019-09, and 2020-12
- Supports internal `$ref` values or an uploaded local schema bundle, without network fetching
- Runs configurable format-specific lint rules with Off, Info, Warning, and Error severities
- Explains every finding with its precise location, reason, suggested fix, actual value, expected value, data path, and schema path when available
- Highlights unknown keys in red, keys under the wrong table in orange, and
  wrong value types in green
- Offers one-click migration fixes for supported removed or renamed Codex keys
- Highlights complete editor lines and filters the Problems view by severity or source
- Formats JSON and YAML with Prettier and TOML with Taplo
- Includes 20 curated Rainglow editor colour themes, split evenly between dark and light presets
- Imports and exports lint settings as JSON
- Upload, paste, copy, download, format, validate, and clear controls
- Downloads a successfully validated configuration as JSON, YAML, or TOML
- Responsive layout with System, Light, and Dark themes
- Keeps configuration and schema text entirely inside the browser

## Using the workbench

1. Choose a program and use **Select Version** to load its latest stable, latest
   alpha, or an older tracked schema.
2. Paste a configuration or upload a `.json`, `.yaml`, `.yml`, or `.toml` file.
3. To use your own schema instead, upload a primary JSON Schema. Version
   selection remains locked until that custom schema is removed. For multi-file
   schemas, upload dependency files and select **Uploaded local bundle**.
4. Choose **Validate**. Ordinary typing does not trigger validation; Enter,
   pointer movement, and editor blur do.
5. After a successful validation, open **Download** and choose JSON, YAML, or
   TOML. Editing the configuration requires validating it again before download.

Remote schema references are deliberately blocked. Local dependencies are
matched by filename or declared `$id`. Configuration files are limited to 2 MiB;
schema bundles are limited to 50 files and 10 MiB.

## Local development

Requires Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Run all checks:

```sh
npm run check
npm run build
```

## Schema updates

`scripts/sync-schemas.mjs` downloads the current stable schema from
`https://learn.chatgpt.com/docs/config-schema.json`. It also reads Codex GitHub
releases and downloads every exact release asset named `config-schema.json`,
including alpha releases and older versions. It writes only verified JSON and
records each source, release version, SHA256 digest, and successful synchronization
time in `public/schemas/manifest.json`.

The `Sync Codex schemas` workflow runs this check every 30 minutes. Meaningful
schema or release metadata changes are committed to `main`, which starts the
separate tested GitHub Pages deployment workflow.

Each manifest entry records its own `syncedAt` timestamp. The website shows this
as the last time that exact schema was successfully copied from OpenAI and merged
into this repository.

## Optional visitor analytics

The site supports Google Analytics 4 for visitor and page view metrics. Create a
GA4 property and web data stream, then copy its measurement ID, such as
`G-AB12CD34`.

In this GitHub repository, open **Settings**, **Secrets and variables**,
**Actions**, then **Variables**. Add a repository variable named
`GA_MEASUREMENT_ID` containing that measurement ID and manually run the Pages
workflow, or push a new commit.

The measurement ID is public configuration rather than a secret. When the
variable is absent or malformed, analytics is disabled. When it is configured,
the Google tag is not loaded until a visitor explicitly allows analytics. Only
standard page visit data is sent. Configuration text, uploaded filenames,
schemas, diagnostics, validation results, and formatting results remain local.

## Deployment

Every push to `main` runs linting, type checks, browser tests, workflow tests,
and the production build before deploying `dist` to GitHub Pages.

The production site is configured for:

<https://superpauly.github.io/Configurex/>
