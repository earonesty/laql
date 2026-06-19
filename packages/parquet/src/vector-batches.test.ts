import {
  gt,
  materializeBatchRows,
  memoryStore,
  type QueryStats,
  SharedMemoryCache,
} from "lakeql-core";
import { describe, expect, it } from "vitest";
import { DecodedColumnCache } from "./decoded-column-cache.js";
import { readParquetMetadata, writeParquet } from "./index.js";
import type { StoreAsyncBuffer } from "./types.js";
import { canReadParquetVectorBatches, readParquetVectorBatchesFromFile } from "./vector-batches.js";

describe("direct Parquet vector batches", () => {
  it("reads supported scalar leaf types with row windows and decoded cache reuse", async () => {
    const store = memoryStore();
    await writeParquet(store, "data/vector-batches.parquet", {
      rowGroupSize: [4],
      columnData: [
        {
          name: "flag",
          data: [true, false, null, true, false, true, null, false],
          type: "BOOLEAN",
        },
        { name: "i32", data: [1, 2, null, 4, 5, 6, 7, 8], type: "INT32" },
        { name: "i64", data: [1n, 2n, 3n, null, 5n, 6n, 7n, 8n], type: "INT64" },
        { name: "f32", data: [1.5, 2.5, 3.5, 4.5, null, 6.5, 7.5, 8.5], type: "FLOAT" },
        { name: "f64", data: [10, 20, 30, 40, 50, null, 70, 80], type: "DOUBLE" },
        { name: "name", data: ["a", "b", null, "d", "e", "f", "g", null], type: "STRING" },
      ],
    });
    const file = await fileBuffer(store, "data/vector-batches.parquet");
    const metadata = await readParquetMetadata(store, "data/vector-batches.parquet");
    const shared = new SharedMemoryCache({ maxBytes: 256 * 1024 * 1024 });
    const decodedColumnCache = new DecodedColumnCache(shared, {
      maxBytes: 256 * 1024 * 1024,
      policy: "latency",
    });
    const options = {
      columns: ["flag", "i32", "i64", "f32", "f64", "name"],
      rowStart: 1,
      rowEnd: 7,
      batchSize: 2,
      decodedColumnCache,
      decodedColumnCacheKey: "data/vector-batches.parquet",
      stats: queryStats(),
    };

    expect(canReadParquetVectorBatches(metadata, options)).toBe(true);
    const first = await collectVectorRows(file, metadata, options);
    const firstStats = options.stats;
    options.stats = queryStats();
    const second = await collectVectorRows(file, metadata, options);

    expect(first).toEqual([
      { flag: false, i32: 2, i64: 2n, f32: 2.5, f64: 20, name: "b" },
      { flag: null, i32: null, i64: 3n, f32: 3.5, f64: 30, name: null },
      { flag: true, i32: 4, i64: null, f32: 4.5, f64: 40, name: "d" },
      { flag: false, i32: 5, i64: 5n, f32: null, f64: 50, name: "e" },
      { flag: true, i32: 6, i64: 6n, f32: 6.5, f64: null, name: "f" },
      { flag: null, i32: 7, i64: 7n, f32: 7.5, f64: 70, name: "g" },
    ]);
    expect(second).toEqual(first);
    expect(firstStats.cacheMisses).toBeGreaterThan(0);
    expect(options.stats.cacheHits).toBeGreaterThan(0);
    expect(firstStats.rowGroupsRead).toBe(2);
    expect(firstStats.columnsRead).toEqual(["f32", "f64", "flag", "i32", "i64", "name"]);
  });

  it("returns no direct batches for empty or unsupported vector requests", async () => {
    const store = memoryStore();
    await writeParquet(store, "data/vector-capability.parquet", {
      columnData: [
        { name: "id", data: [1, 2], type: "INT32" },
        { name: "name", data: ["a", "b"], type: "STRING" },
      ],
    });
    const file = await fileBuffer(store, "data/vector-capability.parquet");
    const metadata = await readParquetMetadata(store, "data/vector-capability.parquet");
    const unsupportedDateMetadata = structuredClone(metadata);
    const idLeaf = unsupportedDateMetadata.schema.find((entry) => entry.name === "id");
    if (idLeaf !== undefined) idLeaf.converted_type = "DATE";

    expect(canReadParquetVectorBatches(metadata, { columns: undefined })).toBe(false);
    expect(canReadParquetVectorBatches(metadata, { columns: [] })).toBe(false);
    expect(canReadParquetVectorBatches(metadata, { columns: ["missing"] })).toBe(false);
    expect(canReadParquetVectorBatches(unsupportedDateMetadata, { columns: ["id"] })).toBe(false);
    expect(canReadParquetVectorBatches(metadata, { columns: ["id", "name"] })).toBe(true);

    const rows = await collectVectorRows(file, metadata, {
      columns: ["id", "name"],
      rowStart: 0,
      rowEnd: 2,
      batchSize: 10,
      stats: queryStats(),
    });
    expect(rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    const none = [];
    for await (const batch of readParquetVectorBatchesFromFile(file, metadata, {
      columns: undefined,
      stats: queryStats(),
    })) {
      none.push(batch);
    }
    expect(none).toEqual([]);
  });

  it("reads timestamp and raw byte vectors across pruned row groups", async () => {
    const store = memoryStore();
    await writeParquet(store, "data/vector-pruned.parquet", {
      rowGroupSize: [2, 2, 2],
      schema: [
        { name: "root", num_children: 4 },
        { name: "id", type: "INT32", repetition_type: "OPTIONAL" },
        {
          name: "loaded_at",
          type: "INT64",
          converted_type: "TIMESTAMP_MICROS",
          repetition_type: "OPTIONAL",
        },
        { name: "raw", type: "BYTE_ARRAY", repetition_type: "OPTIONAL" },
        { name: "label", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "OPTIONAL" },
      ],
      columnData: [
        { name: "id", data: [1, 2, 3, 4, 5, 6] },
        {
          name: "loaded_at",
          data: [
            1_700_000_000_000_001n,
            null,
            1_700_000_000_000_003n,
            1_700_000_000_000_004n,
            null,
            1_700_000_000_000_006n,
          ],
        },
        {
          name: "raw",
          data: [
            new Uint8Array([1]),
            new Uint8Array([2]),
            new Uint8Array([3]),
            null,
            new Uint8Array([5]),
            new Uint8Array([6]),
          ],
        },
        { name: "label", data: ["a", "a", "b", "b", "c", "c"] },
      ],
    });
    const file = await fileBuffer(store, "data/vector-pruned.parquet");
    const metadata = await readParquetMetadata(store, "data/vector-pruned.parquet");
    const options = {
      columns: ["id", "loaded_at", "raw", "label"],
      rowStart: 1,
      rowEnd: 6,
      batchSize: 2,
      where: gt("id", 3),
      stats: queryStats(),
    };

    expect(canReadParquetVectorBatches(metadata, options)).toBe(true);
    const batches = [];
    for await (const batch of readParquetVectorBatchesFromFile(file, metadata, options)) {
      batches.push(batch);
    }
    expect(batches.map((batch) => [batch.rowOffset, batch.batch.rowCount])).toEqual([
      [2, 2],
      [4, 2],
    ]);
    expect(batches.flatMap(({ batch }) => materializeBatchRows(batch))).toEqual([
      {
        id: 3,
        loaded_at: expect.objectContaining({
          epochNanoseconds: 1_700_000_000_000_003_000n,
          unit: "micros",
          isAdjustedToUTC: true,
        }),
        raw: "\x03",
        label: "b",
      },
      {
        id: 4,
        loaded_at: expect.objectContaining({
          epochNanoseconds: 1_700_000_000_000_004_000n,
          unit: "micros",
          isAdjustedToUTC: true,
        }),
        raw: null,
        label: "b",
      },
      { id: 5, loaded_at: null, raw: "\x05", label: "c" },
      {
        id: 6,
        loaded_at: expect.objectContaining({
          epochNanoseconds: 1_700_000_000_000_006_000n,
          unit: "micros",
          isAdjustedToUTC: true,
        }),
        raw: "\x06",
        label: "c",
      },
    ]);
    expect(options.stats.rowGroupsRead).toBe(2);
    expect(options.stats.rowGroupsSkipped).toBe(1);
    expect(options.stats.rowsDecoded).toBe(4);
    expect(options.stats.columnsRead).toEqual(["id", "label", "loaded_at", "raw"]);

    const uuidMetadata = structuredClone(metadata);
    const rawLeaf = uuidMetadata.schema.find((entry) => entry.name === "raw");
    if (rawLeaf !== undefined) rawLeaf.logical_type = { type: "UUID" };
    expect(canReadParquetVectorBatches(uuidMetadata, { columns: ["raw"] })).toBe(false);

    const unsignedMetadata = structuredClone(metadata);
    const idLeaf = unsignedMetadata.schema.find((entry) => entry.name === "id");
    if (idLeaf !== undefined) idLeaf.converted_type = "UINT_64";
    expect(canReadParquetVectorBatches(unsignedMetadata, { columns: ["id"] })).toBe(false);
  });
});

async function collectVectorRows(
  file: StoreAsyncBuffer,
  metadata: Awaited<ReturnType<typeof readParquetMetadata>>,
  options: Parameters<typeof readParquetVectorBatchesFromFile>[2],
): Promise<Record<string, unknown>[]> {
  const rows = [];
  for await (const { batch } of readParquetVectorBatchesFromFile(file, metadata, options)) {
    rows.push(...materializeBatchRows(batch));
  }
  return rows;
}

async function fileBuffer(
  store: ReturnType<typeof memoryStore>,
  path: string,
): Promise<StoreAsyncBuffer> {
  const head = await store.head(path);
  if (head === null) throw new Error(`missing ${path}`);
  return {
    byteLength: head.size,
    ...(head.etag === undefined ? {} : { etag: head.etag }),
    async slice(start, end) {
      return (await store.getRange(path, { offset: start, length: (end ?? head.size) - start }))
        .buffer;
    },
  };
}

function queryStats(): QueryStats {
  return {
    queryId: "vector-batches-test",
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
