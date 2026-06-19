import {
  and,
  eq,
  gt,
  memoryCache,
  memoryStore,
  type QueryStats,
  SharedMemoryCache,
} from "lakeql-core";
import { describe, expect, it } from "vitest";
import { DecodedColumnCache } from "./decoded-column-cache.js";
import { writeParquet } from "./index.js";
import { ParquetScanAdapter } from "./scan-adapter.js";
import { countingObjectStore } from "./test-helpers.js";

describe("ParquetScanAdapter", () => {
  it("scans rows and vector batches with shared metadata, decoded, and range cache state", async () => {
    const backing = memoryStore();
    await writeParquet(backing, "data/adapter.parquet", {
      rowGroupSize: [3],
      columnData: [
        { name: "id", data: [1, 2, 3, 4, 5, 6], type: "INT32" },
        { name: "amount", data: [5, 10, 15, 20, 25, 30], type: "DOUBLE" },
        { name: "region", data: ["west", "west", "east", "west", "east", "west"], type: "STRING" },
      ],
    });
    const counted = countingObjectStore(backing);
    const metadataCache = memoryCache();
    const sharedCache = new SharedMemoryCache({ maxBytes: 8 * 1024 * 1024 });
    const decodedColumnCache = new DecodedColumnCache(sharedCache, {
      maxBytes: 8 * 1024 * 1024,
      policy: "latency",
    });
    const adapter = new ParquetScanAdapter(counted, {
      batchSize: 2,
      metadataCache,
      decodedColumnCache,
      scanRangeCache: {
        maxBytes: 8 * 1024 * 1024,
        sharedCache,
        cacheOptions: { policy: "io" },
      },
    });

    const rows = [];
    const rowStats = queryStats();
    for await (const batch of adapter.scan("data/adapter.parquet", {
      batchSize: 2,
      columns: ["id", "amount"],
      where: gt("amount", 18),
      stats: rowStats,
      budget: {},
      now: () => 0,
      startedAt: 0,
    })) {
      rows.push(...batch);
    }
    expect(rows).toEqual([
      { id: 4, amount: 20 },
      { id: 5, amount: 25 },
      { id: 6, amount: 30 },
    ]);
    expect(rowStats.rowGroupsSkipped).toBe(1);
    expect(rowStats.rowGroupsRead).toBe(1);
    expect(rowStats.columnsRead).toContain("id");

    const vectorRows = [];
    const vectorStats = queryStats();
    for await (const { rowOffset, batch } of adapter.scanVectorBatches("data/adapter.parquet", {
      batchSize: 4,
      columns: ["id", "region"],
      rowStart: 1,
      rowEnd: 5,
      where: and(gt("id", 1), eq("region", "west")),
      stats: vectorStats,
      budget: {},
      now: () => 0,
      startedAt: 0,
    })) {
      vectorRows.push({ rowOffset, rowCount: batch.rowCount, columns: Object.keys(batch.columns) });
    }
    expect(vectorRows).toEqual([
      { rowOffset: 1, rowCount: 2, columns: ["id", "region"] },
      { rowOffset: 3, rowCount: 2, columns: ["id", "region"] },
    ]);
    expect(vectorStats.cacheHits).toBeGreaterThanOrEqual(1);

    const columnRows = [];
    for await (const batch of adapter.scanColumns("data/adapter.parquet", {
      batchSize: 3,
      columns: ["amount"],
      rowStart: 0,
      rowEnd: 3,
      stats: queryStats(),
      budget: {},
      now: () => 0,
      startedAt: 0,
    })) {
      columnRows.push(batch.rowCount);
    }
    expect(columnRows).toEqual([3]);

    const plan = await adapter.planTask("data/adapter.parquet", {
      partitionValues: {},
      where: gt("amount", 18),
    });
    expect(plan).toEqual({ rowGroupCount: 2, rowGroupRanges: [{ start: 1, end: 2 }] });
    expect(counted.counters.get + counted.counters.getRange).toBeGreaterThan(0);
  });
});

function queryStats(): QueryStats {
  return {
    queryId: "scan-adapter-test",
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
