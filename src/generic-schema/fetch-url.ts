/**
 * URL adjustments for schema hosts whose canonical URLs redirect without
 * CORS headers: the browser blocks the redirect hop with a bare
 * "Failed to fetch", so the equivalent CORS-enabled endpoint is requested
 * directly. Byte parity between the redirect pair was verified (identical
 * sha256), and github.com blob/raw URLs resolve to raw.githubusercontent.com.
 */
export function normalizeSchemaUrl(url: URL): URL {
  if (url.host === "json.schemastore.org") {
    return new URL(`https://www.schemastore.org${url.pathname}${url.search}`);
  }
  const github = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
  if (url.host === "github.com" && github) {
    return new URL(`https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}`);
  }
  return url;
}

/**
 * Reader relay for URLs whose host blocks cross-origin fetches entirely.
 * r.jina.ai fetches server-side (following redirects) and serves the body
 * with permissive CORS headers, wrapped in a short markdown preamble.
 */
export const SCHEMA_RELAY_PREFIX = "https://r.jina.ai/";

export function schemaRelayUrl(url: URL): URL {
  return new URL(`${SCHEMA_RELAY_PREFIX}${url.href}`);
}

export function extractRelayedPayload(text: string): string {
  const marker = text.indexOf("Markdown Content:");
  const body = marker === -1 ? text : text.slice(marker + "Markdown Content:".length);
  return body.trim();
}

export function schemaFetchErrorMessage(url: URL): string {
  return `Could not fetch ${url.href}. The server may block cross-origin requests (CORS) or may be unreachable from the browser. Try the schema's direct download URL, or paste the schema content instead.`;
}

/** HTTP-level failure of the direct request; a relay cannot fix these. */
export class SchemaHttpStatusError extends Error {}

/**
 * Fetches schema text from a URL. A direct request is tried first; when the
 * browser blocks it (CORS redirects surface as TypeError), the request is
 * retried through the reader relay, which follows redirects server-side.
 */
export async function fetchRemoteSchemaText(url: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchImpl(url, { cache: "no-cache" });
    if (!response.ok) throw new SchemaHttpStatusError(`Schema returned HTTP ${response.status}.`);
    return await response.text();
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
  }
  try {
    const relayed = await fetchImpl(schemaRelayUrl(url), { cache: "no-cache" });
    if (!relayed.ok) throw new Error(schemaFetchErrorMessage(url), { cause: new Error(`Relay returned HTTP ${relayed.status}.`) });
    return extractRelayedPayload(await relayed.text());
  } catch (cause) {
    const message = cause instanceof Error && cause.message.startsWith("Could not fetch") ? cause.message : schemaFetchErrorMessage(url);
    throw new Error(message, { cause });
  }
}
