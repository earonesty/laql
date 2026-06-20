import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fsJsonCache } from "./index.js";

describe("fsJsonCache", () => {
  it("persists JSON cache entries under a filesystem prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "lakeql-fs-cache-"));
    try {
      const cache = fsJsonCache<{ files: number }>({ root, prefix: "catalog/cache" });

      await cache.set("iceberg:manifest:path", { value: { files: 3 } });

      expect(await cache.get("iceberg:manifest:path")).toEqual({ value: { files: 3 } });
      await expect(
        readFile(join(root, "catalog/cache/iceberg%3Amanifest%3Apath.json"), "utf8"),
      ).resolves.toContain('"files":3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires entries using cache ttl", async () => {
    const root = await mkdtemp(join(tmpdir(), "lakeql-fs-cache-"));
    let now = 100;
    try {
      const cache = fsJsonCache<string>({
        root,
        ttlMs: 50,
        now: () => now,
      });

      await cache.set("key", { value: "value" });
      expect(await cache.get("key")).toEqual({ value: "value", expiresAt: 150 });

      now = 151;
      expect(await cache.get("key")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
