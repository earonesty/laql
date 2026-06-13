import { describe, expect, it } from "vitest";
import { broadcastJoin, type LookupJoinFunction, lookupJoin } from "./join.js";
import type { Row } from "./types.js";

async function* asyncRows(rows: Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
}

describe("broadcastJoin", () => {
  it("joins bounded right-side rows by scalar keys", async () => {
    await expect(
      broadcastJoin(
        [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        [
          { id: 1, color: "red" },
          { id: 1, color: "blue" },
        ],
        { leftKey: "id", rightKey: "id", maxRightRows: 2 },
      ),
    ).resolves.toEqual([
      { id: 1, name: "a", color: "red" },
      { id: 1, name: "a", color: "blue" },
    ]);
  });

  it("supports async inputs, left joins, and right column prefixes", async () => {
    await expect(
      broadcastJoin(
        asyncRows([
          { user_id: "u1", value: 1 },
          { user_id: "u2", value: 2 },
        ]),
        asyncRows([{ id: "u1", value: "right" }]),
        {
          leftKey: "user_id",
          rightKey: "id",
          maxRightRows: 1,
          type: "left",
          rightPrefix: "dim_",
        },
      ),
    ).resolves.toEqual([
      { user_id: "u1", value: 1, id: "u1", dim_value: "right" },
      { user_id: "u2", value: 2 },
    ]);
  });

  it("supports bounded semi and anti joins", async () => {
    const left = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ];
    const right = [{ id: 1 }, { id: 3 }];

    await expect(
      broadcastJoin(left, right, {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 2,
        type: "semi",
      }),
    ).resolves.toEqual([
      { id: 1, name: "a" },
      { id: 3, name: "c" },
    ]);
    await expect(
      broadcastJoin(left, right, {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 2,
        type: "anti",
      }),
    ).resolves.toEqual([{ id: 2, name: "b" }]);
  });

  it("rejects unbounded or unsafe joins with typed errors", async () => {
    await expect(
      broadcastJoin([{ id: 1 }], [{ id: 1 }, { id: 2 }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_BUDGET_EXCEEDED" });
    await expect(
      broadcastJoin([{ id: 1 }], [{ id: 1 }], {
        leftKey: "",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_TYPE_ERROR" });
    await expect(
      broadcastJoin([{ id: 1 }], [{ missing: 1 }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_UNKNOWN_COLUMN" });
    await expect(
      broadcastJoin([{ id: { nested: true } }], [{ id: { nested: true } }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_TYPE_ERROR" });
    await expect(
      broadcastJoin([{ id: 1 }], [{ id: 1 }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
        type: "outer" as never,
      }),
    ).rejects.toMatchObject({ code: "LAQL_TYPE_ERROR" });
  });
});

describe("lookupJoin", () => {
  it("joins left rows through bounded keyed lookups", async () => {
    const calls: unknown[] = [];
    const lookup: LookupJoinFunction = async (key) => {
      calls.push(key);
      return key === 1
        ? [
            { id: 1, color: "red" },
            { id: 99, color: "wrong-key" },
          ]
        : [];
    };

    await expect(
      lookupJoin(
        [
          { id: 1, name: "a" },
          { id: 2, name: "b" },
        ],
        lookup,
        { leftKey: "id", rightKey: "id", maxRightRows: 3 },
      ),
    ).resolves.toEqual([{ id: 1, name: "a", color: "red" }]);
    expect(calls).toEqual([1, 2]);
  });

  it("supports async lookup rows, left joins, and right prefixes", async () => {
    await expect(
      lookupJoin(
        asyncRows([
          { user_id: "u1", value: 1 },
          { user_id: "u2", value: 2 },
        ]),
        async (key) => asyncRows(key === "u1" ? [{ id: "u1", value: "right" }] : []),
        {
          leftKey: "user_id",
          rightKey: "id",
          maxRightRows: 1,
          type: "left",
          rightPrefix: "dim_",
        },
      ),
    ).resolves.toEqual([
      { user_id: "u1", value: 1, id: "u1", dim_value: "right" },
      { user_id: "u2", value: 2 },
    ]);
  });

  it("supports semi and anti lookup joins", async () => {
    const left = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ];
    const lookup: LookupJoinFunction = (key) => (key === 2 ? [] : [{ id: key }]);

    await expect(
      lookupJoin(left, lookup, {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 2,
        type: "semi",
      }),
    ).resolves.toEqual([
      { id: 1, name: "a" },
      { id: 3, name: "c" },
    ]);
    await expect(
      lookupJoin(left, lookup, {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 2,
        type: "anti",
      }),
    ).resolves.toEqual([{ id: 2, name: "b" }]);
  });

  it("rejects unsafe lookup joins with typed errors", async () => {
    await expect(
      lookupJoin([{ id: 1 }], () => [{ id: 1 }, { id: 1 }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_BUDGET_EXCEEDED" });
    await expect(
      lookupJoin([{ id: 1 }], () => [{ id: 1 }], {
        leftKey: "",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_TYPE_ERROR" });
    await expect(
      lookupJoin([{ id: 1 }], () => [{ missing: 1 }], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_UNKNOWN_COLUMN" });
    await expect(
      lookupJoin([{ id: { nested: true } }], () => [], {
        leftKey: "id",
        rightKey: "id",
        maxRightRows: 1,
      }),
    ).rejects.toMatchObject({ code: "LAQL_TYPE_ERROR" });
  });
});
