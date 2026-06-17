import { describe, expect, it } from "vitest";
import { batchFromColumns, materializeBatchRows, predicateSelection } from "./batch.js";
import { col, gt, mul } from "./expr.js";
import {
  createVectorGroupByState,
  finalizeVectorGroupByBatch,
  finalizeVectorGroupByRows,
  mergeVectorGroupByStates,
  restoreVectorGroupByState,
  snapshotVectorGroupByState,
  updateVectorGroupByState,
  vectorGroupByBatch,
} from "./vector-group-by.js";

describe("vector group-by kernels", () => {
  it("groups selected batches with aggregate states without materializing input rows", () => {
    const batch = batchFromColumns({
      region: ["east", "west", "east", null, "west"],
      amount: [10, 20, null, 40, 5],
      id: [1, 2, 3, 4, 5],
    });
    const selection = predicateSelection(batch, gt("id", 1));
    const result = materializeBatchRows(
      vectorGroupByBatch(
        ["region"],
        {
          rows: { op: "count" },
          amountRows: { op: "count", column: "amount" },
          total: { op: "sum", column: "amount" },
          average: { op: "avg", column: "amount" },
          medianAmount: { op: "median", column: "amount" },
          amountP75: { op: "quantile", column: "amount", quantile: 0.75 },
          modeAmount: { op: "mode", column: "amount" },
          minId: { op: "min", column: "id" },
          maxId: { op: "max", column: "id" },
        },
        batch,
        selection,
      ),
    );

    expect(result).toEqual([
      {
        region: "west",
        rows: 2,
        amountRows: 2,
        total: 25,
        average: 12.5,
        medianAmount: 12.5,
        amountP75: 16.25,
        modeAmount: 20,
        minId: 2,
        maxId: 5,
      },
      {
        region: "east",
        rows: 1,
        amountRows: 0,
        total: 0,
        average: null,
        medianAmount: null,
        amountP75: null,
        modeAmount: null,
        minId: 3,
        maxId: 3,
      },
      {
        region: null,
        rows: 1,
        amountRows: 1,
        total: 40,
        average: 40,
        medianAmount: 40,
        amountP75: 40,
        modeAmount: 40,
        minId: 4,
        maxId: 4,
      },
    ]);
  });

  it("keeps nulls together and distinguishes composite key primitive types", () => {
    const batch = batchFromColumns({
      key: ["1", "1", null, null],
      flag: [true, false, true, true],
      amount: [1, 2, 3, 4],
    });
    const state = createVectorGroupByState(["key", "flag"], {
      rows: { op: "count" },
      total: { op: "sum", column: "amount" },
    });

    updateVectorGroupByState(state, batch);

    expect(finalizeVectorGroupByRows(state)).toEqual([
      { key: "1", flag: true, rows: 1, total: 1 },
      { key: "1", flag: false, rows: 1, total: 2 },
      { key: null, flag: true, rows: 2, total: 7 },
    ]);
  });

  it("uses collision-resistant composite key encoding", () => {
    const batch = batchFromColumns({
      left: ["a|boolean:true", "a"],
      right: [false, true],
      amount: [1, 2],
    });

    expect(
      materializeBatchRows(
        vectorGroupByBatch(
          ["left", "right"],
          {
            total: { op: "sum", column: "amount" },
          },
          batch,
        ),
      ),
    ).toEqual([
      { left: "a|boolean:true", right: false, total: 1 },
      { left: "a", right: true, total: 2 },
    ]);
  });

  it("supports aggregate expression inputs and distinct budgets", () => {
    const batch = batchFromColumns({
      region: ["east", "east", "west", "west"],
      amount: [10, 20, 30, 40],
      label: ["a", "b", "a", "a"],
    });
    const result = materializeBatchRows(
      vectorGroupByBatch(
        ["region"],
        {
          doubledMax: { op: "max", expr: mul(col("amount"), 2) },
          labels: { op: "count_distinct", column: "label" },
        },
        batch,
      ),
    );

    expect(result).toEqual([
      { region: "east", doubledMax: 40, labels: 2 },
      { region: "west", doubledMax: 80, labels: 1 },
    ]);
  });

  it("finalizes an incremental group-by state as a batch", () => {
    const state = createVectorGroupByState(["region"], {
      rows: { op: "count" },
      total: { op: "sum", column: "amount" },
    });

    updateVectorGroupByState(state, batchFromColumns({ region: ["east"], amount: [10] }));
    updateVectorGroupByState(state, batchFromColumns({ region: ["east", "west"], amount: [5, 7] }));

    expect(materializeBatchRows(finalizeVectorGroupByBatch(state))).toEqual([
      { region: "east", rows: 2, total: 15 },
      { region: "west", rows: 1, total: 7 },
    ]);
  });

  it("round-trips grouped partials through JSON and merges them", () => {
    const spec = {
      rows: { op: "count" },
      maxAmount: { op: "max", column: "amount" },
    } as const;
    const left = createVectorGroupByState(["account"], spec);
    const right = createVectorGroupByState(["account"], spec);
    updateVectorGroupByState(left, batchFromColumns({ account: [10n, 20n], amount: [1, 2] }));
    updateVectorGroupByState(right, batchFromColumns({ account: [10n], amount: [5] }));

    const transported = JSON.parse(JSON.stringify(snapshotVectorGroupByState(right)));
    mergeVectorGroupByStates(left, restoreVectorGroupByState(["account"], spec, transported));

    expect(finalizeVectorGroupByRows(left)).toEqual([
      { account: 10n, rows: 2, maxAmount: 5 },
      { account: 20n, rows: 1, maxAmount: 2 },
    ]);
  });

  it("enforces group and memory budgets", () => {
    const batch = batchFromColumns({ region: ["east", "west"], amount: [1, 2] });

    expect(() =>
      vectorGroupByBatch(["region"], { rows: { op: "count" } }, batch, undefined, {
        maxGroups: 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_GROUP_LIMIT_EXCEEDED",
        details: { limit: 1, actual: 2 },
      }),
    );

    expect(() =>
      vectorGroupByBatch(["region"], { total: { op: "sum", column: "amount" } }, batch, undefined, {
        budget: { maxMemoryBytes: 1 },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_BUDGET_EXCEEDED",
        details: expect.objectContaining({ metric: "operator memory bytes", limit: 1 }),
      }),
    );
  });
});
