import type { ObjectStore, QueryStats } from "lakeql-core";
import type { ParquetMetadata } from "./types.js";

export function countingObjectStore(inner: ObjectStore): ObjectStore & {
  counters: { get: number; getRange: number; bytesFetched: number };
  resetCounters(): void;
} {
  const counters = { get: 0, getRange: 0, bytesFetched: 0 };
  return {
    counters,
    resetCounters() {
      counters.get = 0;
      counters.getRange = 0;
      counters.bytesFetched = 0;
    },
    async get(path) {
      counters.get += 1;
      const bytes = await inner.get(path);
      if (bytes !== null) counters.bytesFetched += bytes.byteLength;
      return bytes;
    },
    async getRange(path, range) {
      counters.getRange += 1;
      const bytes = await inner.getRange(path, range);
      counters.bytesFetched += bytes.byteLength;
      return bytes;
    },
    put(path, body, options) {
      return inner.put(path, body, options);
    },
    delete(path) {
      return inner.delete(path);
    },
    list(prefix, options) {
      return inner.list(prefix, options);
    },
    head(path) {
      return inner.head(path);
    },
  };
}

export function delayedHeadObjectStore(
  inner: ObjectStore,
  delayMs: number,
): ObjectStore & {
  readonly peakActiveHeads: number;
  resetPeakHeads(): void;
} {
  let activeHeads = 0;
  let peakActiveHeads = 0;
  return {
    get peakActiveHeads() {
      return peakActiveHeads;
    },
    resetPeakHeads() {
      activeHeads = 0;
      peakActiveHeads = 0;
    },
    get(path) {
      return inner.get(path);
    },
    getRange(path, range) {
      return inner.getRange(path, range);
    },
    put(path, body, options) {
      return inner.put(path, body, options);
    },
    delete(path) {
      return inner.delete(path);
    },
    list(prefix, options) {
      return inner.list(prefix, options);
    },
    async head(path) {
      activeHeads += 1;
      peakActiveHeads = Math.max(peakActiveHeads, activeHeads);
      try {
        await sleep(delayMs);
        return await inner.head(path);
      } finally {
        activeHeads -= 1;
      }
    },
  };
}

export function delayedPathHeadObjectStore(
  inner: ObjectStore,
  delays: Record<string, number>,
): ObjectStore {
  return {
    get(path) {
      return inner.get(path);
    },
    getRange(path, range) {
      return inner.getRange(path, range);
    },
    put(path, body, options) {
      return inner.put(path, body, options);
    },
    delete(path) {
      return inner.delete(path);
    },
    list(prefix, options) {
      return inner.list(prefix, options);
    },
    async head(path) {
      const delayMs = delays[path] ?? 0;
      if (delayMs > 0) await sleep(delayMs);
      return inner.head(path);
    },
  };
}

export function rangeGuardObjectStore(
  inner: ObjectStore,
  forbiddenRanges: { offset: number; length: number }[],
  options: { objectSize: number; allowedFullRangeReads: number },
): ObjectStore {
  let allowedFullRangeReads = options.allowedFullRangeReads;
  return {
    get(path) {
      return inner.get(path);
    },
    async getRange(path, range) {
      if (range.offset === 0 && range.length === options.objectSize && allowedFullRangeReads > 0) {
        allowedFullRangeReads -= 1;
        return inner.getRange(path, range);
      }
      const blocked = forbiddenRanges.find((forbidden) => rangesOverlap(forbidden, range));
      if (blocked !== undefined) {
        throw new Error(
          `unexpected range read for ${path}: ${range.offset}+${range.length} overlaps ${blocked.offset}+${blocked.length}`,
        );
      }
      return inner.getRange(path, range);
    },
    put(path, body, options) {
      return inner.put(path, body, options);
    },
    delete(path) {
      return inner.delete(path);
    },
    list(prefix, options) {
      return inner.list(prefix, options);
    },
    head(path) {
      return inner.head(path);
    },
  };
}

export function columnChunkRanges(
  metadata: ParquetMetadata,
  column: string,
): { offset: number; length: number }[] {
  const ranges: { offset: number; length: number }[] = [];
  for (const rowGroup of metadata.row_groups) {
    for (const chunk of rowGroup.columns) {
      if (chunk.meta_data?.path_in_schema[0] !== column) continue;
      const offset = Number(
        chunk.meta_data.dictionary_page_offset ?? chunk.meta_data.data_page_offset,
      );
      const length = Number(chunk.meta_data.total_compressed_size);
      if (Number.isFinite(offset) && Number.isFinite(length) && length > 0) {
        ranges.push({ offset, length });
      }
    }
  }
  return ranges;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function testQueryStats(): QueryStats {
  return {
    queryId: "batch-read-test",
    elapsedMs: 0,
    manifestsRead: 0,
    manifestsSkipped: 0,
    filesPlanned: 0,
    filesRead: 0,
    filesSkipped: 0,
    rowGroupsRead: 0,
    rowGroupsSkipped: 0,
    columnsRead: [],
    bytesRequested: 0,
    rangeRequests: 0,
    rowsDecoded: 0,
    rowsMatched: 0,
    rowsReturned: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
}

function rangesOverlap(
  left: { offset: number; length: number },
  right: { offset: number; length: number },
): boolean {
  return left.offset < right.offset + right.length && right.offset < left.offset + left.length;
}
