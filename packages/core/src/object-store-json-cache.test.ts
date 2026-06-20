import { describe, expect, it } from "vitest";
import { memoryStore } from "./memory-store.js";
import { objectStoreJsonCache } from "./object-store-json-cache.js";

describe("objectStoreJsonCache", () => {
  it("persists JSON cache entries in an object store namespace", async () => {
    const store = memoryStore();
    const cache = objectStoreJsonCache<{ rows: number }>({ store, prefix: "cache/catalog" });

    await cache.set("iceberg:table:manifest:path", { value: { rows: 20 } });

    expect(await cache.get("iceberg:table:manifest:path")).toEqual({
      value: { rows: 20 },
    });
    const objects = [];
    for await (const object of store.list("cache/catalog/")) objects.push(object.path);
    expect(objects).toEqual(["cache/catalog/iceberg%3Atable%3Amanifest%3Apath.json"]);
  });

  it("expires entries using cache ttl", async () => {
    let now = 100;
    const cache = objectStoreJsonCache<string>({
      store: memoryStore(),
      prefix: "cache",
      ttlMs: 50,
      now: () => now,
    });

    await cache.set("key", { value: "value" });
    expect(await cache.get("key")).toEqual({ value: "value", expiresAt: 150 });

    now = 151;
    expect(await cache.get("key")).toBeUndefined();
  });

  it("honors per-entry expiration over cache ttl", async () => {
    let now = 100;
    const cache = objectStoreJsonCache<string>({
      store: memoryStore(),
      prefix: "cache",
      ttlMs: 50,
      now: () => now,
    });

    await cache.set("key", { value: "value", expiresAt: 300 });
    now = 151;

    expect(await cache.get("key")).toEqual({ value: "value", expiresAt: 300 });
  });
});
