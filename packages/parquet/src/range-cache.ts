import type { StoreAsyncBuffer } from "./types.js";

const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface RangeCacheOptions {
  maxBytes: number;
  maxEntryBytes?: number;
}

interface RangeCacheEntry {
  bytes: ArrayBuffer;
  byteLength: number;
}

export function cachedRangeBuffer(
  file: StoreAsyncBuffer,
  options: RangeCacheOptions,
): StoreAsyncBuffer {
  const maxBytes = options.maxBytes;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  if (maxBytes <= 0 || maxEntryBytes <= 0) return file;
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
