import { eq, gt, like, materializeBatchRows, memoryStore, type TaskInput } from "lakeql-core";
import { describe, expect, it } from "vitest";
import {
  aggregateParquetGroupTask,
  aggregateParquetGroupTasks,
  aggregateParquetGroupTasksBatch,
  aggregateParquetTask,
  aggregateParquetTasks,
  scanParquetTaskBatches,
  scanParquetTaskColumnBatches,
  writeParquet,
} from "./index.js";
import { testQueryStats } from "./test-helpers.js";

describe("Parquet task execution", () => {
  it("scans row and column task batches across projection, partition, and residual paths", async () => {
    const store = memoryStore();
    await writeParquet(store, "data/task-scan.parquet", {
      rowGroupSize: [3],
      columnData: [
        { name: "id", data: [1, 2, 3, 4, 5, 6], type: "INT32" },
        { name: "amount", data: [5, 10, 15, 20, 25, 30], type: "DOUBLE" },
        { name: "label", data: ["a", "b", "c", "d", "e", "f"], type: "STRING" },
      ],
    });

    const baseTask: TaskInput = {
      path: "data/task-scan.parquet",
      rowGroupRanges: [{ start: 0, end: 2 }],
      projectedColumns: ["id", "amount"],
      residualPredicate: gt("amount", 18),
      partitionValues: {},
    };
    const rowBatches = [];
    for await (const batch of scanParquetTaskBatches(store, baseTask, { batchSize: 2 })) {
      rowBatches.push(...batch);
    }
    expect(rowBatches).toEqual([
      { id: 4, amount: 20 },
      { id: 5, amount: 25 },
      { id: 6, amount: 30 },
    ]);

    const vectorStats = testQueryStats();
    const vectorBatches = [];
    for await (const batch of scanParquetTaskColumnBatches(store, baseTask, {
      batchSize: 3,
      stats: vectorStats,
    })) {
      vectorBatches.push(...materializeBatchRows(batch.batch));
    }
    expect(vectorBatches).toEqual([
      { id: 4, amount: 20 },
      { id: 5, amount: 25 },
      { id: 6, amount: 30 },
    ]);
    expect(vectorStats.rowsMatched).toBe(3);

    const partitionTask: TaskInput = {
      path: "data/task-scan.parquet",
      rowGroupRanges: [{ start: 0, end: 1 }],
      projectedColumns: ["country", "id"],
      residualPredicate: eq("country", "US"),
      partitionValues: { country: "US" },
    };
    const partitionRows = [];
    for await (const batch of scanParquetTaskColumnBatches(store, partitionTask, {
      batchSize: 2,
      stats: testQueryStats(),
    })) {
      partitionRows.push(...materializeBatchRows(batch.batch));
    }
    expect(partitionRows).toEqual([
      { country: "US", id: 1 },
      { country: "US", id: 2 },
      { country: "US", id: 3 },
    ]);

    const passthroughRows = [];
    for await (const batch of scanParquetTaskColumnBatches(
      store,
      {
        path: "data/task-scan.parquet",
        rowGroupRanges: [{ start: 0, end: 1 }],
        projectedColumns: ["id"],
        partitionValues: {},
      },
      { batchSize: 10, stats: testQueryStats() },
    )) {
      passthroughRows.push(...materializeBatchRows(batch.batch));
    }
    expect(passthroughRows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("aggregates task batches with vector residuals, partition groups, and result options", async () => {
    const store = memoryStore();
    await writeParquet(store, "data/task-aggregate.parquet", {
      rowGroupSize: [3],
      columnData: [
        { name: "id", data: [1, 2, 3, 4, 5, 6], type: "INT32" },
        { name: "amount", data: [5, 10, 15, 20, 25, 30], type: "DOUBLE" },
        { name: "region", data: ["west", "west", "east", "west", "east", "west"], type: "STRING" },
      ],
    });
    const tasks: TaskInput[] = [
      {
        path: "data/task-aggregate.parquet",
        rowGroupRanges: [{ start: 0, end: 2 }],
        projectedColumns: ["amount", "region"],
        residualPredicate: gt("amount", 10),
        partitionValues: {},
      },
    ];

    await expect(
      aggregateParquetTasks(
        store,
        tasks,
        { rows: { op: "count" }, total: { op: "sum", column: "amount" } },
        { stats: testQueryStats() },
      ),
    ).resolves.toEqual({ rows: 4, total: 90 });

    await expect(
      aggregateParquetTask(
        store,
        [
          {
            ...tasks[0],
            residualPredicate: like("region", "w%"),
          },
        ][0],
        { rows: { op: "count" } },
      ),
    ).rejects.toMatchObject({ code: "LAKEQL_UNSUPPORTED_PUSHDOWN" });

    const partitionTask: TaskInput = {
      path: "data/task-aggregate.parquet",
      rowGroupRanges: [{ start: 0, end: 2 }],
      projectedColumns: ["amount"],
      partitionValues: { country: "US" },
    };
    const grouped = await aggregateParquetGroupTask(
      store,
      partitionTask,
      ["country"],
      { rows: { op: "count" }, total: { op: "sum", column: "amount" } },
      { stats: testQueryStats() },
    );
    expect(grouped.groups).toHaveLength(1);
    await expect(
      aggregateParquetGroupTasks(store, [partitionTask], ["country"], {
        rows: { op: "count" },
        total: { op: "sum", column: "amount" },
      }),
    ).resolves.toEqual([{ country: "US", rows: 6, total: 105 }]);

    const optionTasks: TaskInput[] = [
      {
        path: "data/task-aggregate.parquet",
        rowGroupRanges: [{ start: 0, end: 2 }],
        projectedColumns: ["amount", "region"],
        partitionValues: {},
      },
    ];
    await expect(
      materializeBatchRows(
        await aggregateParquetGroupTasksBatch(
          store,
          optionTasks,
          ["region"],
          { rows: { op: "count" }, total: { op: "sum", column: "amount" } },
          { orderBy: [{ column: "total", direction: "desc" }], offset: 1 },
        ),
      ),
    ).toEqual([{ region: "east", rows: 2, total: 40 }]);

    await expect(
      materializeBatchRows(
        await aggregateParquetGroupTasksBatch(
          store,
          optionTasks,
          ["region"],
          { rows: { op: "count" }, total: { op: "sum", column: "amount" } },
          { offset: 1, limit: 1 },
        ),
      ),
    ).toEqual([{ region: "east", rows: 2, total: 40 }]);

    await expect(
      aggregateParquetGroupTasksBatch(
        store,
        optionTasks,
        ["region"],
        { rows: { op: "count" } },
        { offset: -1 },
      ),
    ).rejects.toMatchObject({ code: "LAKEQL_TYPE_ERROR" });
    await expect(
      aggregateParquetGroupTasksBatch(
        store,
        optionTasks,
        ["region"],
        { rows: { op: "count" } },
        { limit: -1 },
      ),
    ).rejects.toMatchObject({ code: "LAKEQL_TYPE_ERROR" });
  });
});
