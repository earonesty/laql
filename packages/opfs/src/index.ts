import { type CacheAdapter, type CacheEntry, LakeqlError } from "lakeql-core";

export const PACKAGE = "lakeql-opfs" as const;

export interface OpfsCacheOptions {
  directory?: FileSystemDirectoryHandle;
  namespace?: string;
}

export interface OpfsJsonCacheOptions extends OpfsCacheOptions {
  space?: number;
}

export function opfsByteCache(options: OpfsCacheOptions = {}): CacheAdapter<Uint8Array> {
  return new OpfsByteCache(options);
}

export function opfsJsonCache<T>(options: OpfsJsonCacheOptions = {}): CacheAdapter<T> {
  return new OpfsJsonCache<T>(options);
}

export class OpfsByteCache implements CacheAdapter<Uint8Array> {
  private readonly directory: Promise<FileSystemDirectoryHandle>;
  private readonly namespace: string;

  constructor(options: OpfsCacheOptions = {}) {
    this.directory =
      options.directory === undefined ? defaultOpfsRoot() : Promise.resolve(options.directory);
    this.namespace = normalizedNamespace(options.namespace ?? "lakeql");
  }

  async get(key: string): Promise<CacheEntry<Uint8Array> | undefined> {
    const file = await this.fileHandle(key, false);
    if (file === undefined) return undefined;
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    const entry = decodeByteEntry(bytes);
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: CacheEntry<Uint8Array>): Promise<void> {
    const file = await this.fileHandle(key, true);
    if (file === undefined) return;
    const writable = await file.createWritable();
    await writable.write(toArrayBuffer(encodeByteEntry(entry)));
    await writable.close();
  }

  async delete(key: string): Promise<void> {
    const directory = await this.cacheDirectory(false);
    if (directory === undefined) return;
    await directory.removeEntry(cacheFileName(key)).catch((error: unknown) => {
      if (isNotFoundError(error)) return;
      throw error;
    });
  }

  private async fileHandle(
    key: string,
    create: boolean,
  ): Promise<FileSystemFileHandle | undefined> {
    const directory = await this.cacheDirectory(create);
    if (directory === undefined) return undefined;
    try {
      return await directory.getFileHandle(cacheFileName(key), { create });
    } catch (error) {
      if (!create && isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  private async cacheDirectory(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    let directory = await this.directory;
    for (const segment of this.namespace.split("/")) {
      try {
        directory = await directory.getDirectoryHandle(segment, { create });
      } catch (error) {
        if (!create && isNotFoundError(error)) return undefined;
        throw error;
      }
    }
    return directory;
  }
}

export class OpfsJsonCache<T> implements CacheAdapter<T> {
  private readonly byteCache: CacheAdapter<Uint8Array>;
  private readonly space: number | undefined;

  constructor(options: OpfsJsonCacheOptions = {}) {
    this.byteCache = new OpfsByteCache(options);
    this.space = options.space;
  }

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const entry = await this.byteCache.get(key);
    if (entry === undefined) return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(entry.value)) as T;
    const result: CacheEntry<T> = { value: parsed };
    if (entry.expiresAt !== undefined) result.expiresAt = entry.expiresAt;
    return result;
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    let json: string;
    try {
      json = JSON.stringify(entry.value, undefined, this.space);
    } catch (cause) {
      throw new LakeqlError("LAKEQL_TYPE_ERROR", "OPFS JSON cache value is not JSON serializable", {
        key,
        cause,
      });
    }
    if (json === undefined) {
      throw new LakeqlError("LAKEQL_TYPE_ERROR", "OPFS JSON cache value is not JSON serializable", {
        key,
      });
    }
    const encoded: CacheEntry<Uint8Array> = { value: new TextEncoder().encode(json) };
    if (entry.expiresAt !== undefined) encoded.expiresAt = entry.expiresAt;
    await this.byteCache.set(key, encoded);
  }

  async delete(key: string): Promise<void> {
    await this.byteCache.delete(key);
  }
}

interface ByteEntryHeader {
  expiresAt?: number;
}

async function defaultOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage?.getDirectory?.();
  if (root === undefined) {
    throw new LakeqlError("LAKEQL_UNSUPPORTED_PUSHDOWN", "OPFS is not available in this runtime");
  }
  return root;
}

function normalizedNamespace(namespace: string): string {
  const parts = namespace.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "OPFS cache namespace must be relative", {
      namespace,
    });
  }
  return parts.join("/");
}

function cacheFileName(key: string): string {
  if (key.length === 0) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "OPFS cache key must not be empty");
  }
  return `${encodeURIComponent(key)}.bin`;
}

function encodeByteEntry(entry: CacheEntry<Uint8Array>): Uint8Array {
  const header: ByteEntryHeader = {};
  if (entry.expiresAt !== undefined) header.expiresAt = entry.expiresAt;
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.byteLength + entry.value.byteLength);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, false);
  out.set(headerBytes, 4);
  out.set(entry.value, 4 + headerBytes.byteLength);
  return out;
}

function decodeByteEntry(bytes: Uint8Array): CacheEntry<Uint8Array> {
  if (bytes.byteLength < 4) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "OPFS cache entry is truncated");
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    false,
  );
  const headerEnd = 4 + headerLength;
  if (headerEnd > bytes.byteLength) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "OPFS cache entry has an invalid header");
  }
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, headerEnd)),
  ) as ByteEntryHeader;
  const entry: CacheEntry<Uint8Array> = { value: bytes.slice(headerEnd) };
  if (header.expiresAt !== undefined) entry.expiresAt = header.expiresAt;
  return entry;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
