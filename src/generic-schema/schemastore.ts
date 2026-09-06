export const SCHEMASTORE_CATALOG_URL = "https://www.schemastore.org/api/json/catalog.json";
export const SCHEMASTORE_SITE_URL = "https://www.schemastore.org/#schemalist";

export interface CatalogEntry {
  readonly name: string;
  readonly url: string;
}

interface CatalogSchema {
  name?: unknown;
  url?: unknown;
}

interface CatalogResponse {
  schemas?: unknown;
}

function isValidSchemaUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:" && /\.(json|ya?ml|toml)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function normalize(body: unknown): readonly CatalogEntry[] {
  if (!body || typeof body !== "object") return [];
  const response = body as CatalogResponse;
  if (!Array.isArray(response.schemas)) return [];

  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];

  for (const schema of response.schemas) {
    if (!schema || typeof schema !== "object") continue;
    const item = schema as CatalogSchema;
    
    if (typeof item.name !== "string" || typeof item.url !== "string") continue;
    if (!isValidSchemaUrl(item.url)) continue;
    if (seen.has(item.url)) continue;

    seen.add(item.url);
    entries.push({ name: item.name, url: item.url });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

let cached: Promise<readonly CatalogEntry[]> | undefined;

/**
 * Fetches the SchemaStore catalog once per page load. Never throws: failure => [].
 */
export function loadSchemaStoreCatalog(fetchImpl: typeof fetch = fetch): Promise<readonly CatalogEntry[]> {
  cached ??= fetchImpl(SCHEMASTORE_CATALOG_URL, { cache: "force-cache" })
    .then(async (r) => {
      if (!r.ok) return [];
      const body: unknown = await r.json();
      return normalize(body);
    })
    .catch(() => []);
  return cached;
}

export function resetSchemaStoreCatalogForTests(): void {
  cached = undefined;
}
