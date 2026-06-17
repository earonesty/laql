import { describe, expect, it } from "vitest";
import { gt, gte } from "./expr.js";
import { createInMemoryLake } from "./in-memory.js";

describe("in-memory row ingest", () => {
  it("queries JavaScript row arrays through the normal Lake runtime", async () => {
    const lake = createInMemoryLake(
      {
        sales: [
          { id: 1, amount: 12, region: "west" },
          { id: 2, amount: 7, region: "east" },
          { id: 3, amount: 30, region: "west" },
        ],
      },
      { queryId: () => "memory-query" },
    );

    const result = lake
      .path("sales")
      .select(["id"])
      .where(gt("amount", 10))
      .orderBy([{ column: "id", direction: "desc" }])
      .run();

    await expect(result.toArray()).resolves.toEqual([{ id: 3 }, { id: 1 }]);
    expect(result.stats).toMatchObject({
      queryId: "memory-query",
      filesPlanned: 1,
      filesRead: 1,
      rowsDecoded: 3,
      rowsMatched: 2,
      rowsReturned: 2,
      rangeRequests: 0,
    });
    expect(result.stats.bytesRequested).toBeGreaterThan(0);
  });

  it("keeps table rows immutable from caller mutation and batches by query batch size", async () => {
    const rows = [
      { id: 1, amount: 10 },
      { id: 2, amount: 20 },
      { id: 3, amount: 30 },
    ];
    const lake = createInMemoryLake({ rows });
    rows[0] = { id: 99, amount: 99 };
    const batches: unknown[][] = [];

    for await (const batch of lake.path("rows").batchSize(2).batches()) {
      batches.push(batch);
    }

    expect(batches).toEqual([
      [
        { id: 1, amount: 10 },
        { id: 2, amount: 20 },
      ],
      [{ id: 3, amount: 30 }],
    ]);
  });

  it("plans globbed in-memory tables as portable task inputs", async () => {
    const lake = createInMemoryLake({
      "uploads/a": [{ id: 1, amount: 10 }],
      "uploads/b": [
        { id: 2, amount: 20 },
        { id: 3, amount: 30 },
      ],
    });

    const tasks = await lake.path("uploads/*").select(["id"]).where(gte("amount", 20)).planTasks();

    expect(tasks).toEqual([
      expect.objectContaining({
        path: "uploads/a",
        projectedColumns: ["amount", "id"],
        residualPredicate: gte("amount", 20),
        rowGroupRanges: [{ start: 0, end: 1 }],
      }),
      expect.objectContaining({
        path: "uploads/b",
        projectedColumns: ["amount", "id"],
        residualPredicate: gte("amount", 20),
        rowGroupRanges: [{ start: 0, end: 2 }],
      }),
    ]);
    await expect(
      lake.path("uploads/*").select(["id"]).where(gte("amount", 20)).toArray(),
    ).resolves.toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("enforces ingest budgets before registering tables", () => {
    expect(() =>
      createInMemoryLake(
        {
          rows: [{ id: 1 }, { id: 2 }],
        },
        { maxRows: 1 },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_BUDGET_EXCEEDED",
        details: { metric: "ingest rows", limit: 1, actual: 2 },
      }),
    );

    expect(() =>
      createInMemoryLake({ rows: [{ label: "too-large" }] }, { maxBytes: 1 }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_BUDGET_EXCEEDED",
        details: expect.objectContaining({ metric: "ingest bytes", limit: 1 }),
      }),
    );
  });

  it("still applies query-time row budgets", async () => {
    const lake = createInMemoryLake(
      {
        rows: [{ id: 1 }, { id: 2 }],
      },
      { budget: { maxRowsDecoded: 1 } },
    );

    await expect(lake.path("rows").toArray()).rejects.toMatchObject({
      code: "LAKEQL_BUDGET_EXCEEDED",
      details: { metric: "rows decoded", limit: 1, actual: 2 },
    });
  });
});
