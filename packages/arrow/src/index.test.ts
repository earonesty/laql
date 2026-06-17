import { tableFromIPC } from "apache-arrow";
import { batchFromColumns, createInMemoryLake, gt } from "lakeql-core";
import { describe, expect, it } from "vitest";
import {
  batchToArrowIPC,
  batchToArrowTable,
  queryToArrowIPC,
  queryToArrowTable,
  rowsToArrowIPC,
  rowsToArrowTable,
} from "./index.js";

describe("Arrow output", () => {
  it("converts scalar rows with nulls into an Arrow table", () => {
    const table = rowsToArrowTable([
      { id: 1, label: "a", ok: true, amount: 12.5 },
      { id: 2, label: null, ok: false, amount: null },
    ]);

    expect(table.numRows).toBe(2);
    expect(table.numCols).toBe(4);
    expect(table.schema.fields.map((field) => field.name)).toEqual(["id", "label", "ok", "amount"]);
    expect(table.get(0)?.toJSON()).toEqual({ id: 1, label: "a", ok: true, amount: 12.5 });
    expect(table.get(1)?.toJSON()).toEqual({ id: 2, label: null, ok: false, amount: null });
  });

  it("projects requested columns for row conversion", () => {
    const table = rowsToArrowTable([{ id: 1, ignored: "x" }], { columns: ["id", "missing"] });

    expect(table.schema.fields.map((field) => field.name)).toEqual(["id", "missing"]);
    expect(table.get(0)?.toJSON()).toEqual({ id: 1, missing: null });
  });

  it("converts lakeql column batches without row materialization at the API boundary", () => {
    const batch = batchFromColumns({
      id: [1, 2, null],
      label: ["a", null, "c"],
      ok: [true, false, null],
      big: [1n, 2n, null],
    });

    const table = batchToArrowTable(batch);

    expect(table.numRows).toBe(3);
    expect(table.schema.fields.map((field) => `${field.name}:${field.type}`)).toEqual([
      "id:Float64",
      "label:Dictionary<Int32, Utf8>",
      "ok:Bool",
      "big:Int64",
    ]);
    expect(table.get(2)?.toJSON()).toEqual({ id: null, label: "c", ok: null, big: null });
  });

  it("converts query results to Arrow table and IPC payloads", async () => {
    const lake = createInMemoryLake({
      rows: [
        { id: 1, amount: 10 },
        { id: 2, amount: 30 },
        { id: 3, amount: 50 },
      ],
    });
    const query = lake.path("rows").select(["id", "amount"]).where(gt("amount", 20));

    const table = await queryToArrowTable(query);
    const ipc = await queryToArrowIPC(query);
    const restored = tableFromIPC(ipc);

    expect(table.numRows).toBe(2);
    expect(restored.numRows).toBe(2);
    expect(restored.get(0)?.toJSON()).toEqual({ id: 2, amount: 30 });
    expect(restored.get(1)?.toJSON()).toEqual({ id: 3, amount: 50 });
  });

  it("round-trips rows and batches through Arrow IPC", () => {
    const rowTable = tableFromIPC(rowsToArrowIPC([{ id: 1, label: "a" }]));
    const batchTable = tableFromIPC(batchToArrowIPC(batchFromColumns({ id: [1, 2] })));

    expect(rowTable.get(0)?.toJSON()).toEqual({ id: 1, label: "a" });
    expect(batchTable.get(1)?.toJSON()).toEqual({ id: 2 });
  });

  it("rejects unsupported nested row values instead of guessing Arrow types", () => {
    expect(() => rowsToArrowTable([{ id: 1, nested: { ok: true } }])).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_VALIDATION_ERROR",
        details: { rowIndex: 0, column: "nested", valueType: "object" },
      }),
    );
  });

  it("rejects unknown batch columns", () => {
    expect(() =>
      batchToArrowTable(batchFromColumns({ id: [1] }), { columns: ["missing"] }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_UNKNOWN_COLUMN",
        details: { column: "missing" },
      }),
    );
  });
});
