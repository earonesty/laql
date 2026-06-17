import { describe, expect, it } from "vitest";
import { batchFromColumns, materializeBatchRows, predicateSelection } from "./batch.js";
import { gt } from "./expr.js";
import { vectorHashJoin } from "./vector-join.js";

describe("vector hash join kernels", () => {
  it("performs inner joins with right column prefixing", () => {
    const left = batchFromColumns({
      id: [1, 2, 3],
      region: ["east", "west", "west"],
      amount: [10, 20, 30],
    });
    const right = batchFromColumns({
      region: ["west", "east", "west"],
      label: ["West A", "East", "West B"],
      amount: [200, 100, 300],
    });

    expect(
      materializeBatchRows(
        vectorHashJoin(left, right, {
          leftKey: "region",
          rightKey: "region",
          maxRightRows: 10,
        }),
      ),
    ).toEqual([
      { id: 1, region: "east", amount: 10, label: "East", "right.amount": 100 },
      { id: 2, region: "west", amount: 20, label: "West A", "right.amount": 200 },
      { id: 2, region: "west", amount: 20, label: "West B", "right.amount": 300 },
      { id: 3, region: "west", amount: 30, label: "West A", "right.amount": 200 },
      { id: 3, region: "west", amount: 30, label: "West B", "right.amount": 300 },
    ]);
  });

  it("supports left joins with null right values for unmatched rows", () => {
    const left = batchFromColumns({ id: [1, 2], region: ["east", "north"] });
    const right = batchFromColumns({ region: ["east"], label: ["East"] });

    expect(
      materializeBatchRows(
        vectorHashJoin(left, right, {
          leftKey: "region",
          rightKey: "region",
          maxRightRows: 10,
          type: "left",
        }),
      ),
    ).toEqual([
      { id: 1, region: "east", label: "East" },
      { id: 2, region: "north", label: null },
    ]);
  });

  it("supports semi and anti joins over selected left and right rows", () => {
    const left = batchFromColumns({ id: [1, 2, 3], region: ["east", "west", "north"] });
    const right = batchFromColumns({ region: ["east", "west"], active: [0, 1] });
    const rightSelection = predicateSelection(right, gt("active", 0));

    expect(
      materializeBatchRows(
        vectorHashJoin(left, right, {
          leftKey: "region",
          rightKey: "region",
          maxRightRows: 10,
          type: "semi",
          rightSelection,
        }),
      ),
    ).toEqual([{ id: 2, region: "west" }]);
    expect(
      materializeBatchRows(
        vectorHashJoin(left, right, {
          leftKey: "region",
          rightKey: "region",
          maxRightRows: 10,
          type: "anti",
          rightSelection,
        }),
      ),
    ).toEqual([
      { id: 1, region: "east" },
      { id: 3, region: "north" },
    ]);
  });

  it("matches composite keys and null join keys", () => {
    const left = batchFromColumns({
      region: ["east", "east", null],
      store: [1, 2, 3],
    });
    const right = batchFromColumns({
      area: ["east", null],
      store_id: [2, 3],
      label: ["match", "null-match"],
    });

    expect(
      materializeBatchRows(
        vectorHashJoin(left, right, {
          leftKey: ["region", "store"],
          rightKey: ["area", "store_id"],
          maxRightRows: 10,
        }),
      ),
    ).toEqual([
      { region: "east", store: 2, area: "east", store_id: 2, label: "match" },
      { region: null, store: 3, area: null, store_id: 3, label: "null-match" },
    ]);
  });

  it("enforces right-side row budgets and validates keys", () => {
    const left = batchFromColumns({ id: [1] });
    const right = batchFromColumns({ id: [1, 2] });

    expect(() =>
      vectorHashJoin(left, right, { leftKey: "id", rightKey: "id", maxRightRows: 1 }),
    ).toThrowError(
      expect.objectContaining({
        code: "LAKEQL_BUDGET_EXCEEDED",
        details: { metric: "maxRightRows", limit: 1, actual: 2 },
      }),
    );
    expect(() =>
      vectorHashJoin(left, right, { leftKey: "missing", rightKey: "id", maxRightRows: 10 }),
    ).toThrowError(expect.objectContaining({ code: "LAKEQL_UNKNOWN_COLUMN" }));
  });
});
