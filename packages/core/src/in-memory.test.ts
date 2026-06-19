import { describe, expect, it } from "vitest";
import { gt, gte } from "./expr.js";
import { createInMemoryLake, InMemoryRowsStore, inMemoryRowsScanner } from "./in-memory.js";

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

  it("exposes in-memory tables through the object-store contract", async () => {
    const scanner = inMemoryRowsScanner({
      "logs/b": [{ id: 2 }],
      "logs/a": [{ id: 1 }],
      other: [{ id: 3 }],
    });
    const store = new InMemoryRowsStore(scanner);

    await expect(store.get("logs/a")).resolves.toBeNull();
    await expect(store.getRange("logs/a", { offset: 0, length: 4 })).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(store.head("missing")).resolves.toBeNull();
    await expect(store.head("logs/a")).resolves.toEqual({
      size: expect.any(Number),
      contentType: "application/vnd.lakeql.rows+json",
      etag: expect.any(String),
      lastModified: new Date(0),
    });

    const listed = [];
    for await (const entry of store.list("logs/", { limit: 1 })) listed.push(entry.path);
    expect(listed).toEqual(["logs/a"]);
    await expect(store.put("logs/c", new Uint8Array())).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
    await expect(store.delete("logs/a")).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
  });

  it("rejects empty table names before exposing a scanner", () => {
    expect(() => inMemoryRowsScanner({ " ": [{ id: 1 }] })).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_TYPE_ERROR",
      }),
    );
  });
});
