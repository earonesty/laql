import { describe, expect, it } from "vitest";
import {
  cloudflareD1JsonCache,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type R2BucketLike,
  type R2ObjectBody,
  r2Store,
} from "./index.js";

const enc = new TextEncoder();

class FakeR2Object implements R2ObjectBody {
  readonly size: number;
  readonly uploaded = new Date("2026-06-13T00:00:00Z");
  readonly httpMetadata = { contentType: "application/octet-stream" };

  constructor(
    readonly key: string,
    private readonly bytes: Uint8Array,
    readonly etag = "etag",
  ) {
    this.size = bytes.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const out = new ArrayBuffer(this.bytes.byteLength);
    new Uint8Array(out).set(this.bytes);
    return out;
  }
}

class FakeBucket implements R2BucketLike {
  readonly objects = new Map<string, Uint8Array>();
  metadata = true;
  lastPutOptions: unknown;
  pageSize = Number.POSITIVE_INFINITY;

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const ranged = options?.range
      ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
      : bytes;
    return new FakeR2Object(key, ranged);
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    if (this.metadata) return new FakeR2Object(key, bytes);
    return { key, size: bytes.byteLength };
  }

  async put(key: string, value: Uint8Array | ReadableStream<Uint8Array>, options?: unknown) {
    this.lastPutOptions = options;
    if (value instanceof Uint8Array) this.objects.set(key, value);
    else this.objects.set(key, enc.encode("stream"));
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const start = options?.cursor === undefined ? 0 : Number(options.cursor);
    const limit = Math.min(options?.limit ?? Number.POSITIVE_INFINITY, this.pageSize);
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options?.prefix ?? ""))
      .sort(([a], [b]) => a.localeCompare(b));
    const page = matching.slice(start, start + limit);
    const objects = page.map(([key, bytes]) => new FakeR2Object(key, bytes));
    const next = start + page.length;
    return {
      objects,
      truncated: next < matching.length,
      cursor: next < matching.length ? String(next) : undefined,
    };
  }
}

class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<
    string,
    { value: string; expires_at: number | null; updated_at: number }
  >();
  readonly statements: string[] = [];

  prepare(query: string): D1PreparedStatementLike {
    this.statements.push(query);
    return new FakeD1Statement(this, query);
  }
}

class FakeD1Statement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async first<T = unknown>(_column?: string): Promise<T | null> {
    if (!this.query.startsWith("select value, expires_at")) return null;
    const key = String(this.values[0]);
    const row = this.db.rows.get(key);
    if (row === undefined) return null;
    return { value: row.value, expires_at: row.expires_at } as T;
  }

  async run(): Promise<unknown> {
    if (this.query.startsWith("create table")) return {};
    if (this.query.startsWith("insert into")) {
      const [key, value, expiresAt, updatedAt] = this.values;
      this.db.rows.set(String(key), {
        value: String(value),
        expires_at: expiresAt === null ? null : Number(expiresAt),
        updated_at: Number(updatedAt),
      });
      return {};
    }
    if (this.query.startsWith("delete from")) {
      this.db.rows.delete(String(this.values[0]));
      return {};
    }
    throw new Error(`unexpected D1 query: ${this.query}`);
  }
}

describe("cloudflareD1JsonCache", () => {
  it("persists JSON cache entries in D1 with namespaced keys", async () => {
    const db = new FakeD1();
    const cache = cloudflareD1JsonCache<{ manifests: number }>({
      db,
      table: "catalog_cache",
      prefix: "prod",
    });

    await cache.set("iceberg:manifest:path", { value: { manifests: 2 } });

    expect(await cache.get("iceberg:manifest:path")).toEqual({ value: { manifests: 2 } });
    expect(db.rows.has("prod:iceberg:manifest:path")).toBe(true);
    expect(db.statements[0]).toContain("create table if not exists catalog_cache");
  });

  it("expires entries using cache ttl", async () => {
    const db = new FakeD1();
    let now = 100;
    const cache = cloudflareD1JsonCache<string>({
      db,
      ttlMs: 50,
      now: () => now,
    });

    await cache.set("key", { value: "value" });
    expect(await cache.get("key")).toEqual({ value: "value", expiresAt: 150 });

    now = 151;
    expect(await cache.get("key")).toBeUndefined();
    expect(db.rows.has("lakeql:key")).toBe(false);
  });

  it("rejects unsafe D1 table names", () => {
    expect(() =>
      cloudflareD1JsonCache({ db: new FakeD1(), table: "cache; drop table cache" }),
    ).toThrow("D1 cache table name is invalid");
  });
});

describe("r2Store", () => {
  it("adapts R2 bucket operations to ObjectStore", async () => {
    const bucket = new FakeBucket();
    const store = r2Store(bucket);

    await store.put("b.txt", enc.encode("abcdef"));
    await store.put("a.txt", enc.encode("a"), {
      contentType: "text/plain",
      metadata: { owner: "test" },
    });
    expect(bucket.lastPutOptions).toEqual({
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { owner: "test" },
    });

    await expect(store.get("b.txt")).resolves.toEqual(enc.encode("abcdef"));
    await expect(store.getRange("b.txt", { offset: 2, length: 3 })).resolves.toEqual(
      enc.encode("cde"),
    );
    await expect(store.head("b.txt")).resolves.toMatchObject({
      size: 6,
      etag: "etag",
      contentType: "application/octet-stream",
    });

    const listed = [];
    for await (const object of store.list("", { limit: 1 })) listed.push(object.path);
    expect(listed).toEqual(["a.txt"]);

    await store.delete("a.txt");
    await expect(store.get("a.txt")).resolves.toBeNull();
    await expect(store.getRange("missing.txt", { offset: 0, length: 1 })).rejects.toMatchObject({
      code: "LAKEQL_OBJECT_NOT_FOUND",
    });
  });

  it("paginates truncated R2 listings", async () => {
    const bucket = new FakeBucket();
    bucket.pageSize = 1;
    await bucket.put("logs/2.txt", enc.encode("2"));
    await bucket.put("logs/1.txt", enc.encode("1"));
    await bucket.put("skip/0.txt", enc.encode("0"));
    const store = r2Store(bucket);

    const listed = [];
    for await (const object of store.list("logs/")) listed.push(object.path);
    expect(listed).toEqual(["logs/1.txt", "logs/2.txt"]);

    const limited = [];
    for await (const object of store.list("logs/", { limit: 1 })) limited.push(object.path);
    expect(limited).toEqual(["logs/1.txt"]);
  });

  it("accepts stream writes and optional metadata-less objects", async () => {
    const bucket = new FakeBucket();
    bucket.metadata = false;
    const store = r2Store(bucket);
    await store.put(
      "stream.txt",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("ignored"));
          controller.close();
        },
      }),
    );

    await expect(store.get("stream.txt")).resolves.toEqual(enc.encode("stream"));
    await expect(store.head("stream.txt")).resolves.toEqual({ size: 6 });

    const listed = [];
    for await (const object of store.list("")) listed.push(object);
    expect(listed[0]).toMatchObject({ path: "stream.txt", size: 6 });
  });
});
