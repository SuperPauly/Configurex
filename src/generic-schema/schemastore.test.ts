import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEMASTORE_CATALOG_URL,
  SCHEMASTORE_SITE_URL,
  loadSchemaStoreCatalog,
  resetSchemaStoreCatalogForTests,
} from "./schemastore";

describe("schemastore", () => {
  beforeEach(() => {
    resetSchemaStoreCatalogForTests();
    vi.restoreAllMocks();
  });

  it("exports expected constants", () => {
    expect(SCHEMASTORE_CATALOG_URL).toBe("https://www.schemastore.org/api/json/catalog.json");
    expect(SCHEMASTORE_SITE_URL).toBe("https://www.schemastore.org/#schemalist");
  });

  it("normalizes and filters valid entries from catalog", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [
            { name: "Renovate", url: "https://docs.renovatebot.com/renovate-schema.json" },
            { name: "Ameba", url: "https://raw.githubusercontent.com/crystal-ameba/ameba/master/.ameba.yml.schema.json" },
            { name: "Invalid-HTTP", url: "http://example.com/schema.json" }, // http not allowed
            { name: "No-Extension", url: "https://meta.upsun.com/schema/upsun" }, // no extension
            { name: "Duplicate", url: "https://docs.renovatebot.com/renovate-schema.json" }, // duplicate
            { name: 123, url: "https://example.com/valid.json" }, // invalid name type
            { name: "Missing-URL" }, // missing url
            { url: "https://example.com/missing-name.json" }, // missing name
          ],
        }),
        { status: 200 },
      ),
    );

    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Ameba", url: "https://raw.githubusercontent.com/crystal-ameba/ameba/master/.ameba.yml.schema.json" });
    expect(entries[1]).toEqual({ name: "Renovate", url: "https://docs.renovatebot.com/renovate-schema.json" });
    expect(mockFetch).toHaveBeenCalledWith(SCHEMASTORE_CATALOG_URL, { cache: "force-cache" });
  });

  it("returns empty array on non-ok response", async () => {
    const mockFetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(entries).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("Network error");
    });
    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(entries).toEqual([]);
  });

  it("returns empty array on invalid JSON body", async () => {
    const mockFetch = vi.fn(async () => new Response("{ type: object }", { status: 200 }));
    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(entries).toEqual([]);
  });

  it("returns empty array when body is not catalog format", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ type: "object" }), { status: 200 }));
    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(entries).toEqual([]);
  });

  it("memoizes fetch across multiple calls", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [{ name: "Test", url: "https://example.com/test.json" }],
        }),
        { status: 200 },
      ),
    );

    const promise1 = loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    const promise2 = loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);

    expect(promise1).toBe(promise2); // same promise
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await promise1;
  });

  it("refetches after resetSchemaStoreCatalogForTests", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [{ name: "Test", url: "https://example.com/test.json" }],
        }),
        { status: 200 },
      ),
    );

    await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    resetSchemaStoreCatalogForTests();

    await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("sorts entries by name", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [
            { name: "Zebra", url: "https://example.com/zebra.json" },
            { name: "Apple", url: "https://example.com/apple.json" },
            { name: "Mango", url: "https://example.com/mango.json" },
          ],
        }),
        { status: 200 },
      ),
    );

    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);

    expect(entries.map((e) => e.name)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("accepts yaml and toml extensions", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [
            { name: "YAML", url: "https://example.com/schema.yaml" },
            { name: "YML", url: "https://example.com/schema.yml" },
            { name: "TOML", url: "https://example.com/schema.toml" },
          ],
        }),
        { status: 200 },
      ),
    );

    const entries = await loadSchemaStoreCatalog(mockFetch as unknown as typeof fetch);
    expect(entries).toHaveLength(3);
  });
});
