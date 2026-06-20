import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CacheAdapter, type CacheEntry, LakeqlError } from "lakeql-core";

export const PACKAGE = "lakeql-fs" as const;

export interface FsJsonCacheOptions {
  root: string;
  prefix?: string;
  ttlMs?: number;
  now?: () => number;
  space?: number;
}

export function fsJsonCache<T = unknown>(options: FsJsonCacheOptions): CacheAdapter<T> {
  return new FsJsonCache<T>(options);
}

export class FsJsonCache<T> implements CacheAdapter<T> {
  private readonly root: string;
  private readonly prefix: string;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;
  private readonly space: number | undefined;

  constructor(options: FsJsonCacheOptions) {
    this.root = options.root;
    this.prefix = normalizedPrefix(options.prefix ?? "lakeql");
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.space = options.space;
  }

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const path = this.pathFor(key);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return undefined;
      throw cause;
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as StoredFsJsonCacheEntry<T>;
    if (!isStoredFsJsonCacheEntry(parsed)) {
      throw new LakeqlError("LAKEQL_CATALOG_ERROR", `Invalid filesystem cache entry at ${path}`, {
        path,
      });
    }
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= this.now()) {
      await this.delete(key);
      return undefined;
    }
    const entry: CacheEntry<T> = { value: parsed.value as T };
    if (parsed.expiresAt !== undefined) entry.expiresAt = parsed.expiresAt;
    return entry;
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(join(this.root, this.prefix), { recursive: true });
    const stored: StoredFsJsonCacheEntry<T> = { value: entry.value };
    if (entry.expiresAt !== undefined) {
      stored.expiresAt = entry.expiresAt;
    } else if (this.ttlMs !== undefined) {
      stored.expiresAt = this.now() + this.ttlMs;
    }
    await writeFile(path, jsonCacheValue(stored, key, this.space));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    if (key.length === 0) {
      throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "filesystem cache key must not be empty");
    }
    return join(this.root, this.prefix, `${encodeURIComponent(key)}.json`);
  }
}

interface StoredFsJsonCacheEntry<T> {
  value: T;
  expiresAt?: number;
}

function normalizedPrefix(prefix: string): string {
  const parts = prefix.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "filesystem cache prefix must be relative", {
      prefix,
    });
  }
  return parts.join("/");
}

function isStoredFsJsonCacheEntry(value: unknown): value is StoredFsJsonCacheEntry<unknown> {
  return typeof value === "object" && value !== null && "value" in value;
}

function jsonCacheValue(value: unknown, key: string, space: number | undefined): string {
  if ((value as { value?: unknown }).value === undefined) {
    throw new LakeqlError(
      "LAKEQL_TYPE_ERROR",
      "filesystem JSON cache value is not JSON serializable",
      { key },
    );
  }
  try {
    const json = JSON.stringify(value, undefined, space);
    if (json === undefined) {
      throw new LakeqlError(
        "LAKEQL_TYPE_ERROR",
        "filesystem JSON cache value is not JSON serializable",
        { key },
      );
    }
    return json;
  } catch (cause) {
    if (cause instanceof LakeqlError) throw cause;
    throw new LakeqlError(
      "LAKEQL_TYPE_ERROR",
      "filesystem JSON cache value is not JSON serializable",
      {
        key,
        cause,
      },
    );
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
