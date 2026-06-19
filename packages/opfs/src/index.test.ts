import { LakeqlError } from "lakeql-core";
import { describe, expect, it } from "vitest";
import { opfsByteCache, opfsJsonCache } from "./index.js";

class FakeDirectory {
  readonly directories = new Map<string, FakeDirectory>();
  readonly files = new Map<string, Uint8Array>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options?.create === true) {
      const directory = new FakeDirectory();
      this.directories.set(name, directory);
      return directory;
    }
    throw notFound();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (options?.create !== true) throw notFound();
      this.files.set(name, new Uint8Array());
    }
    return new FakeFileHandle(this.files, name);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.directories.delete(name)) throw notFound();
  }
}

class FakeFileHandle {
  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly name: string,
  ) {}

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.files.get(this.name) ?? new Uint8Array();
    return {
      async arrayBuffer() {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return buffer;
      },
    };
  }

  async createWritable(): Promise<{
    write(chunk: FileSystemWriteChunkType): Promise<void>;
    close(): Promise<void>;
  }> {
    return {
      write: async (chunk) => {
        this.files.set(this.name, bytesFromChunk(chunk));
      },
      close: async () => undefined,
    };
  }
}

describe("opfs cache adapters", () => {
  it("stores, expires, and deletes byte cache entries under a namespace", async () => {
    const root = new FakeDirectory();
    const cache = opfsByteCache({
      directory: root as unknown as FileSystemDirectoryHandle,
      namespace: "lakeql/test",
    });

    await cache.set("fresh/key", {
      value: new Uint8Array([1, 2, 3]),
      expiresAt: Date.now() + 10_000,
    });
    await cache.set("plain", { value: new Uint8Array([4, 5, 6]) });
    await cache.set("expired", { value: new Uint8Array([9]), expiresAt: Date.now() - 1 });

    await expect(cache.get("fresh/key")).resolves.toEqual({
      value: new Uint8Array([1, 2, 3]),
      expiresAt: expect.any(Number),
    });
    await expect(cache.get("expired")).resolves.toBeUndefined();
    await cache.delete("fresh/key");
    await expect(cache.get("fresh/key")).resolves.toBeUndefined();

    const lakeql = root.directories.get("lakeql");
    const namespace = lakeql?.directories.get("test");
    expect(namespace).toBeDefined();
    expect(namespace?.files.get("plain.bin")).toEqual(
      new Uint8Array([0, 0, 0, 2, 123, 125, 4, 5, 6]),
    );
  });

  it("stores JSON-compatible values for planning cache style entries", async () => {
    const root = new FakeDirectory();
    const cache = opfsJsonCache<{ path: string; size: number }[]>({
      directory: root as unknown as FileSystemDirectoryHandle,
    });

    await cache.set("objects:data/*.parquet", {
      value: [
        { path: "data/a.parquet", size: 10 },
        { path: "data/b.parquet", size: 20 },
      ],
    });

    await expect(cache.get("objects:data/*.parquet")).resolves.toEqual({
      value: [
        { path: "data/a.parquet", size: 10 },
        { path: "data/b.parquet", size: 20 },
      ],
    });
  });

  it("expires JSON entries, tolerates missing deletes, and preserves configured spacing", async () => {
    const root = new FakeDirectory();
    const cache = opfsJsonCache<{ path: string }>({
      directory: root as unknown as FileSystemDirectoryHandle,
      namespace: "json/cache",
      space: 2,
    });

    await cache.set("expired", { value: { path: "old" }, expiresAt: Date.now() - 1 });
    await cache.set("fresh", { value: { path: "new" }, expiresAt: Date.now() + 10_000 });
    await cache.delete("missing");

    await expect(cache.get("expired")).resolves.toBeUndefined();
    await expect(cache.get("fresh")).resolves.toEqual({
      value: { path: "new" },
      expiresAt: expect.any(Number),
    });

    const namespace = root.directories.get("json")?.directories.get("cache");
    const encoded = namespace?.files.get("fresh.bin");
    expect(encoded).toBeInstanceOf(Uint8Array);
    if (encoded === undefined) throw new Error("missing encoded cache entry");
    const headerLength = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    ).getUint32(0, false);
    expect(JSON.parse(new TextDecoder().decode(encoded.slice(4, 4 + headerLength)))).toMatchObject({
      expiresAt: expect.any(Number),
    });
    expect(new TextDecoder().decode(encoded.slice(4 + headerLength))).toContain(
      '\n  "path": "new"\n',
    );
  });

  it("rejects corrupt byte cache entries and unavailable default OPFS roots", async () => {
    const root = new FakeDirectory();
    const cache = opfsByteCache({ directory: root as unknown as FileSystemDirectoryHandle });
    const namespace = await root.getDirectoryHandle("lakeql", { create: true });
    namespace.files.set("short.bin", new Uint8Array([0, 1, 2]));
    namespace.files.set("bad-header.bin", new Uint8Array([0, 0, 0, 99, 123, 125]));

    await expect(cache.get("short")).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
    });
    await expect(cache.get("bad-header")).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
    });
    await expect(opfsByteCache().get("anything")).rejects.toMatchObject({
      code: "LAKEQL_UNSUPPORTED_PUSHDOWN",
    });
  });

  it("rejects invalid namespaces, empty keys, and non-JSON values with typed errors", async () => {
    const root = new FakeDirectory();
    expect(() =>
      opfsByteCache({ directory: root as unknown as FileSystemDirectoryHandle, namespace: "../x" }),
    ).toThrow(LakeqlError);

    const bytes = opfsByteCache({ directory: root as unknown as FileSystemDirectoryHandle });
    await expect(bytes.set("", { value: new Uint8Array([1]) })).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
    });

    const json = opfsJsonCache<unknown>({
      directory: root as unknown as FileSystemDirectoryHandle,
    });
    await expect(json.set("bigint", { value: 1n })).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
  });
});

function bytesFromChunk(chunk: FileSystemWriteChunkType): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    );
  }
  if (typeof chunk === "object" && "data" in chunk) return bytesFromChunk(chunk.data);
  return new Uint8Array();
}

function notFound(): DOMException {
  return new DOMException("Not found", "NotFoundError");
}
