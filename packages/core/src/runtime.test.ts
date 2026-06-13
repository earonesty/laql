import { describe, expect, it } from "vitest";
import { cacheApiCache, memoryCache, type RuntimeSubstrate } from "./runtime.js";

class FakeCache implements Cache {
  private readonly entries = new Map<string, Response>();

  async add(_request: RequestInfo | URL): Promise<void> {
    throw new Error("not implemented");
  }

  async addAll(_requests: RequestInfo[] | URL[]): Promise<void> {
    throw new Error("not implemented");
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(cacheKey(request));
  }

  async keys(_request?: RequestInfo | URL): Promise<readonly Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(cacheKey(request))?.clone();
  }

  async matchAll(_request?: RequestInfo | URL): Promise<readonly Response[]> {
    return [...this.entries.values()].map((response) => response.clone());
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(cacheKey(request), response.clone());
  }
}

function cacheKey(request: RequestInfo | URL): string {
  if (request instanceof Request) return request.url;
  return String(request);
}

describe("runtime substrate helpers", () => {
  it("stores, expires, and deletes memory cache entries", async () => {
    const cache = memoryCache<string>();
    await cache.set("fresh", { value: "ok", expiresAt: Date.now() + 10_000 });
    await cache.set("expired", { value: "old", expiresAt: Date.now() - 1 });

    await expect(cache.get("fresh")).resolves.toEqual({
      value: "ok",
      expiresAt: expect.any(Number),
    });
    await expect(cache.get("expired")).resolves.toBeUndefined();
    await cache.delete("fresh");
    await expect(cache.get("fresh")).resolves.toBeUndefined();
  });

  it("adapts the runtime Cache API with expiration metadata", async () => {
    let now = 1_000;
    const cache = cacheApiCache(new FakeCache(), {
      namespace: "test",
      now: () => now,
    });
    await cache.set("fresh/key", { value: new Uint8Array([1, 2, 3]), expiresAt: 2_000 });
    await cache.set("expired", { value: new Uint8Array([9]), expiresAt: 900 });

    await expect(cache.get("fresh/key")).resolves.toEqual({
      value: new Uint8Array([1, 2, 3]),
      expiresAt: 2_000,
    });
    await expect(cache.get("expired")).resolves.toBeUndefined();
    now = 2_001;
    await expect(cache.get("fresh/key")).resolves.toBeUndefined();

    await cache.set("delete-me", { value: new Uint8Array([4]) });
    await cache.delete("delete-me");
    await expect(cache.get("delete-me")).resolves.toBeUndefined();
  });

  it("accepts caller-supplied substrate interfaces", async () => {
    const substrate: RuntimeSubstrate = {
      clock: { now: () => 1 },
      ids: { id: (prefix = "id") => `${prefix}-1` },
      lock: { withLock: async (_key, fn) => fn() },
      metrics: { count() {}, timing() {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };

    await expect(substrate.lock?.withLock("x", async () => substrate.ids?.id("job"))).resolves.toBe(
      "job-1",
    );
  });
});
