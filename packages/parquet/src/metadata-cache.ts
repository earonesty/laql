import { parquetMetadataAsync } from "hyparquet";
import type { CacheAdapter } from "lakeql-core";
import { lakeqlParquetParsers } from "./parsers.js";
import type { ParquetMetadata, StoreAsyncBuffer } from "./types.js";

const metadataInitialFetchSize = 64 * 1024;

export function readParquetMetadataFromFile(file: StoreAsyncBuffer): Promise<ParquetMetadata> {
  return parquetMetadataAsync(file, {
    initialFetchSize: metadataInitialFetchSize,
    parsers: lakeqlParquetParsers,
  });
}

export async function readCachedParquetMetadata(
  path: string,
  file: StoreAsyncBuffer,
  metadataCache: CacheAdapter<ParquetMetadata> | undefined,
): Promise<{ metadata: ParquetMetadata; cached: boolean }> {
  if (!metadataCache) return { metadata: await readParquetMetadataFromFile(file), cached: false };
  const key = metadataCacheKey(path, file.byteLength, file.etag);
  const cached = await metadataCache.get(key);
  if (cached) return { metadata: cached.value, cached: true };
  const metadata = await readParquetMetadataFromFile(file);
  await metadataCache.set(key, { value: metadata });
  return { metadata, cached: false };
}

function metadataCacheKey(path: string, byteLength: number, etag: string | undefined): string {
  return `parquet-metadata:${path}:${byteLength}:${etag ?? "no-etag"}`;
}
