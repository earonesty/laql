import { describe, expect, it } from "vitest";
import { batchFromColumns, materializeBatchRows, predicateSelection } from "./batch.js";
import { gte } from "./expr.js";
import {
  concatBatches,
  gatherBatch,
  vectorOrderByBatch,
  vectorSortIndices,
  vectorTopKBatch,
  vectorTopKIndices,
} from "./vector-sort.js";

describe("vector sort kernels", () => {
  it("orders column batches with row-sort null defaults and stable ties", () => {
    const batch = batchFromColumns({
      id: [1, 2, 3, 4, 5],
      amount: [20, null, 10, 20, null],
      label: ["b", "n1", "a", "a", "n2"],
    });

    expect(
      materializeBatchRows(vectorOrderByBatch(batch, [{ column: "amount", direction: "asc" }])),
    ).toEqual([
      { id: 3, amount: 10, label: "a" },
      { id: 1, amount: 20, label: "b" },
      { id: 4, amount: 20, label: "a" },
      { id: 2, amount: null, label: "n1" },
      { id: 5, amount: null, label: "n2" },
    ]);

    expect(
      materializeBatchRows(vectorOrderByBatch(batch, [{ column: "amount", direction: "desc" }])),
    ).toEqual([
      { id: 2, amount: null, label: "n1" },
      { id: 5, amount: null, label: "n2" },
      { id: 1, amount: 20, label: "b" },
      { id: 4, amount: 20, label: "a" },
      { id: 3, amount: 10, label: "a" },
    ]);
  });

  it("supports explicit null ordering, secondary keys, and selected rows", () => {
    const batch = batchFromColumns({
      id: [1, 2, 3, 4, 5],
      amount: [20, null, 10, 20, null],
      label: ["b", "n1", "a", "a", "n2"],
    });
    const selection = predicateSelection(batch, gte("id", 2));

    expect(
      materializeBatchRows(
        vectorOrderByBatch(
          batch,
          [
            { column: "amount", direction: "asc", nulls: "first" },
            { column: "label", direction: "desc" },
          ],
          selection,
        ),
      ),
    ).toEqual([
      { id: 5, amount: null, label: "n2" },
      { id: 2, amount: null, label: "n1" },
      { id: 3, amount: 10, label: "a" },
      { id: 4, amount: 20, label: "a" },
    ]);
  });

  it("keeps top-k bounded by offset plus limit before final ordering", () => {
    const batch = batchFromColumns({
      id: [1, 2, 3, 4, 5, 6],
      score: [30, 10, 50, 20, 40, 60],
    });

    expect(vectorTopKIndices(batch, [{ column: "score", direction: "desc" }], 3)).toHaveLength(3);
    expect(
      materializeBatchRows(
        vectorTopKBatch(batch, [{ column: "score", direction: "desc" }], {
          offset: 1,
          limit: 2,
        }),
      ),
    ).toEqual([
      { id: 3, score: 50 },
      { id: 5, score: 40 },
    ]);
  });

  it("gathers typed columns and validity masks without changing vector layout", () => {
    const batch = batchFromColumns({
      id: [1, 2, 3],
      big: [10n, 20n, 30n],
      flag: [true, null, false],
      label: ["a", null, "c"],
    });
    const gathered = gatherBatch(batch, [2, 1]);

    expect(gathered.columns.id?.type).toBe("f64");
    expect(gathered.columns.big?.type).toBe("i64");
    expect(gathered.columns.flag?.type).toBe("bool");
    expect(gathered.columns.label?.type).toBe("utf8");
    expect(materializeBatchRows(gathered)).toEqual([
      { id: 3, big: 30n, flag: false, label: "c" },
      { id: 2, big: 20n, flag: null, label: null },
    ]);
  });

  it("preserves nested payload vectors while ordering by scalar columns", () => {
    const batch = batchFromColumns({
      score: [2, 9, 4],
      events: [[{ code: "b" }], [{ code: "winner" }], []],
      metadata: [{ carrier: "AA" }, { carrier: "DL" }, null],
    });

    expect(
      materializeBatchRows(
        vectorTopKBatch(batch, [{ column: "score", direction: "desc" }], { limit: 2 }),
      ),
    ).toEqual([
      { score: 9, events: [{ code: "winner" }], metadata: { carrier: "DL" } },
      { score: 4, events: [], metadata: null },
    ]);
  });

  it("concatenates compatible typed batches with validity masks", () => {
    const left = batchFromColumns({
      id: [1, 2],
      flag: [true, null],
      label: ["a", null],
    });
    const right = batchFromColumns({
      id: [3],
      flag: [false],
      label: ["c"],
    });

    const combined = concatBatches([left, right]);

    expect(combined.columns.id?.type).toBe("f64");
    expect(combined.columns.flag?.type).toBe("bool");
    expect(combined.columns.label?.type).toBe("utf8");
    expect(materializeBatchRows(combined)).toEqual([
      { id: 1, flag: true, label: "a" },
      { id: 2, flag: null, label: null },
      { id: 3, flag: false, label: "c" },
    ]);
  });

  it("rejects invalid ordering requests with typed errors", () => {
    const batch = batchFromColumns({ id: [1], amount: [10] });

    expect(() => vectorSortIndices(batch, [])).toThrowError(
      expect.objectContaining({ code: "LAKEQL_TYPE_ERROR" }),
    );
    expect(() => vectorSortIndices(batch, [{ column: "missing" }])).toThrowError(
      expect.objectContaining({ code: "LAKEQL_UNKNOWN_COLUMN" }),
    );
    expect(() => vectorTopKBatch(batch, [{ column: "amount" }], { limit: -1 })).toThrowError(
      expect.objectContaining({ code: "LAKEQL_TYPE_ERROR" }),
    );
  });
});
