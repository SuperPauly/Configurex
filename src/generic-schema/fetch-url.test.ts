import { describe, expect, it, vi } from "vitest";
import { extractRelayedPayload, fetchRemoteSchemaText, normalizeSchemaUrl, SchemaHttpStatusError, schemaFetchErrorMessage, schemaRelayUrl } from "./fetch-url";

describe("normalizeSchemaUrl", () => {
  it("rewrites json.schemastore.org to the CORS-enabled www host", () => {
    expect(normalizeSchemaUrl(new URL("https://json.schemastore.org/cargo.json")).href).toBe("https://www.schemastore.org/cargo.json");
  });

  it("preserves query strings when rewriting hosts", () => {
    expect(normalizeSchemaUrl(new URL("https://json.schemastore.org/a.json?x=1")).href).toBe("https://www.schemastore.org/a.json?x=1");
  });

  it("rewrites github.com blob URLs to raw.githubusercontent.com", () => {
    expect(normalizeSchemaUrl(new URL("https://github.com/o/r/blob/main/schema.json")).href).toBe("https://raw.githubusercontent.com/o/r/main/schema.json");
  });

  it("rewrites github.com raw URLs to raw.githubusercontent.com", () => {
    expect(normalizeSchemaUrl(new URL("https://github.com/o/r/raw/main/schema.yaml")).href).toBe("https://raw.githubusercontent.com/o/r/main/schema.yaml");
  });

  it("leaves other hosts untouched", () => {
    for (const href of [
      "https://www.schemastore.org/package.json",
      "https://raw.githubusercontent.com/o/r/main/s.json",
      "https://hermes-agent.nousresearch.com/docs/api/model-catalog.json",
      "https://example.com/s.toml",
    ]) {
      expect(normalizeSchemaUrl(new URL(href)).href).toBe(href);
    }
  });

  it("does not touch github.com paths that are not blob/raw files", () => {
    expect(normalizeSchemaUrl(new URL("https://github.com/o/r/releases")).href).toBe("https://github.com/o/r/releases");
  });
});

describe("schemaRelayUrl", () => {
  it("prefixes the relay host", () => {
    expect(schemaRelayUrl(new URL("https://example.com/s.json")).href).toBe("https://r.jina.ai/https://example.com/s.json");
  });
});

describe("extractRelayedPayload", () => {
  it("strips the markdown preamble from a relayed body", () => {
    const relayed = "Title: \n\nURL Source: https://example.com/s.json\n\nPublished Time: Sun\n\nMarkdown Content:\n{\"a\": 1}\n";
    expect(extractRelayedPayload(relayed)).toBe('{"a": 1}');
  });

  it("returns the text unchanged when no preamble marker exists", () => {
    expect(extractRelayedPayload('{"a": 1}')).toBe('{"a": 1}');
  });
});

describe("schemaFetchErrorMessage", () => {
  it("names the URL and suggests alternatives", () => {
    const message = schemaFetchErrorMessage(new URL("https://blocked.example/s.json"));
    expect(message).toContain("https://blocked.example/s.json");
    expect(message).toMatch(/CORS|cross-origin/);
    expect(message).toMatch(/paste/i);
  });
});

describe("fetchRemoteSchemaText", () => {
  const url = new URL("https://blocked.example/s.json");
  const relayed = "Title: \n\nURL Source: https://blocked.example/s.json\n\nMarkdown Content:\n{\"a\": 1}\n";

  it("returns the direct response body when the direct fetch succeeds", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"direct": true}', { status: 200 }));
    await expect(fetchRemoteSchemaText(url, fetchImpl as unknown as typeof fetch)).resolves.toBe('{"direct": true}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries through the relay and strips its preamble when the direct fetch is CORS-blocked", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://r.jina.ai/")) return new Response(relayed, { status: 200 });
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchRemoteSchemaText(url, fetchImpl as unknown as typeof fetch)).resolves.toBe('{"a": 1}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces HTTP status failures without attempting the relay", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchRemoteSchemaText(url, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(SchemaHttpStatusError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the actionable message when both the direct fetch and the relay fail", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const message = await fetchRemoteSchemaText(url, fetchImpl as unknown as typeof fetch).catch((error: unknown) => error instanceof Error ? error.message : "");
    expect(message).toContain("Could not fetch https://blocked.example/s.json");
  });
});
