import type { Bookmark } from "./types.js";

export interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
}

export interface CacheAdapter<T = Uint8Array> {
  get(key: string): Promise<CacheEntry<T> | undefined>;
  set(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCache<T = Uint8Array> implements CacheAdapter<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  async get(key: string): Promise<CacheEntry<T> | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, entry: CacheEntry<T>): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export function memoryCache<T = Uint8Array>(): CacheAdapter<T> {
  return new MemoryCache<T>();
}

export interface CacheApiCacheOptions {
  namespace?: string;
  now?: () => number;
}

export class CacheApiCache implements CacheAdapter<Uint8Array> {
  private readonly cache: Cache;
  private readonly namespace: string;
  private readonly now: () => number;

  constructor(cache: Cache, options: CacheApiCacheOptions = {}) {
    this.cache = cache;
    this.namespace = options.namespace ?? "laql";
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<CacheEntry<Uint8Array> | undefined> {
    const request = this.request(key);
    const response = await this.cache.match(request);
    if (!response) return undefined;
    const expiresAtHeader = response.headers.get("x-laql-expires-at");
    const expiresAt = expiresAtHeader === null ? undefined : Number(expiresAtHeader);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      await this.cache.delete(request);
      return undefined;
    }
    const entry: CacheEntry<Uint8Array> = {
      value: new Uint8Array(await response.arrayBuffer()),
    };
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
    return entry;
  }

  async set(key: string, entry: CacheEntry<Uint8Array>): Promise<void> {
    const headers = new Headers({ "content-type": "application/octet-stream" });
    if (entry.expiresAt !== undefined) headers.set("x-laql-expires-at", String(entry.expiresAt));
    await this.cache.put(this.request(key), new Response(toArrayBuffer(entry.value), { headers }));
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(this.request(key));
  }

  private request(key: string): Request {
    return new Request(`https://cache.laql.invalid/${this.namespace}/${encodeURIComponent(key)}`);
  }
}

export function cacheApiCache(
  cache: Cache,
  options: CacheApiCacheOptions = {},
): CacheAdapter<Uint8Array> {
  return new CacheApiCache(cache, options);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export interface CheckpointStore {
  get(jobId: string): Promise<Bookmark | undefined>;
  put(jobId: string, bookmark: Bookmark): Promise<void>;
  delete(jobId: string): Promise<void>;
}

export interface QueueAdapter<T> {
  send(message: T, options?: { delayMs?: number }): Promise<void>;
}

export interface LockAdapter {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  id(prefix?: string): string;
}

export interface MetricsHook {
  count(name: string, value?: number, tags?: Record<string, string>): void;
  timing(name: string, ms: number, tags?: Record<string, string>): void;
}

export interface LogHook {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RuntimeSubstrate {
  checkpointStore?: CheckpointStore;
  queue?: QueueAdapter<Bookmark>;
  lock?: LockAdapter;
  clock?: Clock;
  ids?: IdGenerator;
  metrics?: MetricsHook;
  log?: LogHook;
}
