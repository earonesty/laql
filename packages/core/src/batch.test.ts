import { describe, expect, it } from "vitest";
import {
  batchExprValues,
  batchFromColumns,
  materializeBatchRows,
  materializeSelectedBatchRows,
  predicateSelection,
  selectedRowCount,
  tryPredicateSelection,
  vectorValue,
} from "./batch.js";
import { LakeqlError } from "./errors.js";
import { evaluate, matches } from "./evaluator.js";
import {
  add,
  and,
  between,
  col,
  eq,
  fn,
  gt,
  isIn,
  isNotNull,
  isNull,
  like,
  lit,
  not,
  or,
} from "./expr.js";

describe("column batches", () => {
  it("infers vector types, validity masks, and materializes rows at the boundary", () => {
    const batch = batchFromColumns({
      id: [1, 2, null],
      name: ["a", null, "c"],
      flag: [true, false, true],
      big: [1n, 2n, 3n],
    });

    expect(batch.rowCount).toBe(3);
    expect(batch.columns.id?.type).toBe("f64");
    expect(batch.columns.name?.type).toBe("utf8");
    expect(batch.columns.flag?.type).toBe("bool");
    expect(batch.columns.big?.type).toBe("i64");
    expect(batch.columns.name?.valid).toBeInstanceOf(Uint8Array);
    const nameVector = batch.columns.name;
    expect(nameVector).toBeDefined();
    if (nameVector === undefined) throw new Error("missing name vector");
    expect(vectorValue(nameVector, 1)).toBeNull();
    expect(materializeBatchRows(batch)).toEqual([
      { id: 1, name: "a", flag: true, big: 1n },
      { id: 2, name: null, flag: false, big: 2n },
      { id: null, name: "c", flag: true, big: 3n },
    ]);
  });

  it("rejects ragged columns and mixed primitive types", () => {
    expect(() => batchFromColumns({ a: [1], b: [1, 2] })).toThrowError(LakeqlError);
    expect(() => batchFromColumns({ a: [1, "two"] })).toThrowError(LakeqlError);
  });

  it("counts selected rows without materializing row objects", () => {
    const batch = batchFromColumns({ id: [1, 2, 3] });
    expect(selectedRowCount(batch.rowCount)).toBe(3);
    expect(selectedRowCount(batch.rowCount, new Uint8Array([1, 0, 1]))).toBe(2);
  });

  it("evaluates vector predicate selections with SQL null semantics", () => {
    const batch = batchFromColumns({
      id: [1, 2, 3, 4],
      amount: [5, 10, null, 20],
      label: ["a", "b", null, "d"],
      flag: [true, false, null, true],
    });
    const rows = materializeBatchRows(batch);
    const predicates = [
      gt("amount", 9),
      and(gt("amount", 9), isNotNull("label")),
      or(eq("label", "b"), isNull("amount")),
      not(eq("flag", true)),
      between("amount", 5, 10),
      isIn("label", ["a", lit(null)]),
      gt(add(col("amount"), 1), 10),
    ];

    for (const predicate of predicates) {
      const selection = predicateSelection(batch, predicate);
      expect(materializeSelectedBatchRows(batch, selection)).toEqual(
        rows.filter((row) => matches(predicate, row)),
      );
    }
  });

  it("evaluates searched CASE expressions with SQL null predicate semantics", () => {
    const batch = batchFromColumns({
      amount: [5, null, 15, 30],
      label: ["small", "missing", "medium", "large"],
    });
    const expr = {
      kind: "case",
      whens: [
        { when: gt("amount", 20), value: col("label") },
        { when: gt("amount", 10), value: lit("mid") },
      ],
      else: lit("low"),
    } as const;
    const values = batchExprValues(batch, expr);
    const rows = materializeBatchRows(batch);

    expect(rows.map((_row, index) => values.valueAt(index))).toEqual(
      rows.map((row) => {
        if (matches(gt("amount", 20), row)) return row.label;
        if (matches(gt("amount", 10), row)) return "mid";
        return "low";
      }),
    );
  });

  it("evaluates vector coalesce and nullif calls with row evaluator semantics", () => {
    const batch = batchFromColumns({
      amount: [5, null, 15, 30],
      fallback: [10, 20, null, 40],
      label: ["small", "skip", null, "large"],
    });
    const rows = materializeBatchRows(batch);
    const expressions = [
      fn("coalesce", col("amount"), col("fallback"), lit(0)),
      fn("coalesce", lit(null), col("label"), lit("missing")),
      fn("nullif", col("label"), lit("skip")),
      fn("nullif", col("amount"), col("fallback")),
      fn("nullif", lit(null), lit("x")),
      fn("lower", col("label")),
      fn("upper", col("label")),
      fn("trim", fn("coalesce", col("label"), lit(" missing "))),
      fn("substr", col("label"), lit(1), lit(3)),
      fn("substr", col("label"), lit(null), lit(3)),
      fn("replace", col("label"), lit("s"), lit("S")),
      fn("replace", col("label"), lit(null), lit("S")),
      fn("regexp_matches", col("label"), lit("a")),
      fn("regexp_matches", col("label"), lit("^S"), lit("i")),
      fn("regexp_replace", col("label"), lit("[ae]"), lit("X")),
      fn("regexp_replace", col("label"), lit("[ae]"), lit("X"), lit("g")),
      fn("regexp_replace", col("label"), lit("(s)(m)"), lit("\\2\\1")),
      fn("cast", col("amount"), lit("string")),
      fn("cast", col("label"), lit("number")),
      fn("cast", col("amount"), lit("boolean")),
      fn("cast", lit(null), lit("number")),
      fn("round", col("amount")),
      fn("round", col("amount"), lit(1)),
      fn("round", col("amount"), lit(null)),
      fn("floor", col("amount")),
      fn("ceil", col("amount")),
      fn("abs", fn("nullif", col("amount"), lit(15))),
    ];

    for (const expr of expressions) {
      const values = batchExprValues(batch, expr);
      expect(rows.map((_row, index) => values.valueAt(index))).toEqual(
        rows.map((row) => evaluate(expr, row)),
      );
    }
  });

  it("returns undefined for unsupported vector predicates", () => {
    const batch = batchFromColumns({ name: ["alpha", "beta"] });
    expect(tryPredicateSelection(batch, like("name", "a%"))).toBeUndefined();
  });

  it("evaluates vector regexp_matches predicates", () => {
    const batch = batchFromColumns({ label: ["alpha", "Beta", "gamma", null] });
    const predicate = fn("regexp_matches", col("label"), lit("^a|ta$"), lit("i"));
    const rows = materializeBatchRows(batch);
    const selection = predicateSelection(batch, predicate);

    expect(materializeSelectedBatchRows(batch, selection)).toEqual(
      rows.filter((row) => matches(predicate, row)),
    );
  });
});
