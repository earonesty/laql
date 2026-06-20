import { LakeqlError } from "./errors.js";
import type { CacheAdapter, CacheEntry } from "./runtime.js";
import type { ObjectStore } from "./store.js";

export interface ObjectStoreJsonCacheOptions {
  store: ObjectStore;
  prefix: string;
  ttlMs?: number;
  now?: () => number;
}

interface StoredJsonCacheEntry<T> {
  value: T;
  expiresAt?: number;
}

export class ObjectStoreJsonCache<T> implements CacheAdapter<T> {
  private readonly store: ObjectStore;
  private readonly prefix: string;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(options: ObjectStoreJsonCacheOptions) {
    this.store = options.store;
    this.prefix = normalizeCachePrefix(options.prefix);
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const path = this.pathFor(key);
    const bytes = await this.store.get(path);
    if (bytes === null) return undefined;
    let parsed: StoredJsonCacheEntry<T>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredJsonCacheEntry<T>;
    } catch (cause) {
      throw new LakeqlError("LAKEQL_CATALOG_ERROR", `Invalid JSON cache entry at ${path}`, {
        path,
        cause,
      });
    }
    if (!isStoredJsonCacheEntry(parsed)) {
      throw new LakeqlError("LAKEQL_CATALOG_ERROR", `Invalid JSON cache entry at ${path}`, {
        path,
      });
    }
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= this.now()) {
      await this.store.delete(path);
      return undefined;
    }
    const entry: CacheEntry<T> = { value: parsed.value as T };
    if (parsed.expiresAt !== undefined) entry.expiresAt = parsed.expiresAt;
    return entry;
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    if (entry.value === undefined) {
      throw new LakeqlError("LAKEQL_TYPE_ERROR", "JSON cache value is not JSON serializable", {
        key,
      });
    }
    const stored: StoredJsonCacheEntry<T> = { value: entry.value };
    if (entry.expiresAt !== undefined) {
      stored.expiresAt = entry.expiresAt;
    } else if (this.ttlMs !== undefined) {
      stored.expiresAt = this.now() + this.ttlMs;
    }
    let json: string;
    try {
      json = JSON.stringify(stored);
    } catch (cause) {
      throw new LakeqlError("LAKEQL_TYPE_ERROR", "JSON cache value is not JSON serializable", {
        key,
        cause,
      });
    }
    await this.store.put(this.pathFor(key), new TextEncoder().encode(json), {
      contentType: "application/json",
    });
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(this.pathFor(key));
  }

  private pathFor(key: string): string {
    return `${this.prefix}/${encodeURIComponent(key)}.json`;
  }
}

export function objectStoreJsonCache<T>(options: ObjectStoreJsonCacheOptions): CacheAdapter<T> {
  return new ObjectStoreJsonCache<T>(options);
}

function normalizeCachePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "JSON cache prefix must be non-empty");
  }
  return trimmed;
}

function isStoredJsonCacheEntry(value: unknown): value is StoredJsonCacheEntry<unknown> {
  return typeof value === "object" && value !== null && "value" in value;
}
