import type { CachePolicy, ObjectStoreCacheOptions, SharedMemoryCache } from "lakeql-core";
import type { StoreAsyncBuffer } from "./types.js";

const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface RangeCacheOptions {
  maxBytes: number;
  maxEntryBytes?: number;
  sharedCache?: SharedMemoryCache;
  cacheOptions?: ObjectStoreCacheOptions;
}

interface RangeCacheEntry {
  bytes: ArrayBuffer;
  byteLength: number;
}

export function cachedRangeBuffer(
  file: StoreAsyncBuffer,
  options: RangeCacheOptions,
  cacheKey: string,
): StoreAsyncBuffer {
  const maxBytes = options.maxBytes;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  if (maxBytes <= 0 || maxEntryBytes <= 0) return file;
  if (options.sharedCache !== undefined) {
    return sharedCachedRangeBuffer(
      file,
      cacheKey,
      options.sharedCache,
      options.cacheOptions ?? {},
      {
        maxBytes,
        maxEntryBytes,
      },
    );
  }
  const cache = new Map<string, RangeCacheEntry>();
  let cachedBytes = 0;

  return {
    byteLength: file.byteLength,
    ...(file.etag === undefined ? {} : { etag: file.etag }),
    async slice(start, end) {
      const normalizedEnd = end ?? file.byteLength;
      const key = `${start}:${normalizedEnd}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.bytes;
      }

      const bytes = await file.slice(start, end);
      const byteLength = bytes.byteLength;
      if (byteLength <= maxEntryBytes && byteLength <= maxBytes) {
        cache.set(key, { bytes, byteLength });
        cachedBytes += byteLength;
        while (cachedBytes > maxBytes) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey === undefined) break;
          const oldest = cache.get(oldestKey);
          cache.delete(oldestKey);
          cachedBytes -= oldest?.byteLength ?? 0;
        }
      }
      return bytes;
    },
  };
}

function sharedCachedRangeBuffer(
  file: StoreAsyncBuffer,
  cacheKey: string,
  cache: SharedMemoryCache,
  cacheOptions: ObjectStoreCacheOptions,
  options: { maxBytes: number; maxEntryBytes: number },
): StoreAsyncBuffer {
  return {
    byteLength: file.byteLength,
    ...(file.etag === undefined ? {} : { etag: file.etag }),
    async slice(start, end) {
      const normalizedEnd = end ?? file.byteLength;
      const key = sharedRangeKey(file, cacheKey, start, normalizedEnd);
      const cached = cache.get<ArrayBuffer>(key);
      if (cached !== undefined) return cached.value;
      const bytes = await file.slice(start, end);
      if (bytes.byteLength <= options.maxEntryBytes && bytes.byteLength <= options.maxBytes) {
        cache.set(key, bytes, bytes.byteLength, {
          priority: scanRangePriority(cacheOptions.policy ?? "balanced"),
        });
      }
      return bytes;
    },
  };
}

function sharedRangeKey(
  file: StoreAsyncBuffer,
  cacheKey: string,
  start: number,
  end: number,
): string {
  return ["scan-range", cacheKey, file.byteLength, file.etag ?? "", start, end].join(":");
}

function scanRangePriority(policy: CachePolicy): number {
  if (policy === "io") return 4;
  if (policy === "latency") return 1;
  return 3;
}
