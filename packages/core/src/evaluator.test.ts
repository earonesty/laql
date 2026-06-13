import { describe, expect, it } from "vitest";
import { LaQLError } from "./errors.js";
import { evaluate, jsonSafeValue, matches } from "./evaluator.js";
import {
  and,
  between,
  col,
  eq,
  fn,
  gt,
  gte,
  ilike,
  isIn,
  isNotNull,
  isNull,
  like,
  lit,
  lt,
  lte,
  ne,
  not,
  notIn,
  or,
} from "./expr.js";

const row = {
  name: " Alice ",
  city: "Los Angeles",
  amount: 12.345,
  date: "2026-06-13T15:30:00Z",
  maybe: null,
  big: 9007199254740993n,
};

describe("evaluate", () => {
  it("implements SQL three-valued null semantics for predicates", () => {
    expect(evaluate(eq("maybe", null), row)).toBeNull();
    expect(evaluate(isNull("maybe"), row)).toBe(true);
    expect(evaluate(isNotNull("maybe"), row)).toBe(false);
    expect(evaluate(and(eq("maybe", 1), gt("amount", 1)), row)).toBeNull();
    expect(evaluate(or(eq("maybe", 1), gt("amount", 1)), row)).toBe(true);
    expect(evaluate(not(eq("maybe", 1)), row)).toBeNull();
  });

  it("supports comparison, in, between, like, and ilike", () => {
    expect(matches(and(gt("amount", 10), between("amount", 10, 13)), row)).toBe(true);
    expect(matches(and(ne("amount", 10), lt("amount", 13), lte("amount", 12.345)), row)).toBe(true);
    expect(matches(gte("amount", 12.345), row)).toBe(true);
    expect(matches(isIn("city", ["Seattle", "Los Angeles"]), row)).toBe(true);
    expect(matches(notIn("city", ["Seattle"]), row)).toBe(true);
    expect(matches(notIn("city", ["Seattle", null]), row)).toBe(false);
    expect(matches(isIn("maybe", [null]), row)).toBe(false);
    expect(matches(like("city", "Los%"), row)).toBe(true);
    expect(matches(ilike("city", "%angeles"), row)).toBe(true);
  });

  it("supports the phase 1 scalar function families", () => {
    expect(evaluate(fn("lower", col("city")), row)).toBe("los angeles");
    expect(evaluate(fn("upper", col("city")), row)).toBe("LOS ANGELES");
    expect(evaluate(fn("trim", col("name")), row)).toBe("Alice");
    expect(evaluate(fn("substr", col("city"), 4, 7), row)).toBe("Angeles");
    expect(evaluate(fn("replace", col("city"), "Los", "San"), row)).toBe("San Angeles");
    expect(evaluate(fn("coalesce", lit(null), col("city")), row)).toBe("Los Angeles");
    expect(evaluate(fn("nullif", col("city"), "Los Angeles"), row)).toBeNull();
    expect(evaluate(fn("year", col("date")), row)).toBe(2026);
    expect(evaluate(fn("month", col("date")), row)).toBe(6);
    expect(evaluate(fn("day", col("date")), row)).toBe(13);
    expect(evaluate(fn("hour", col("date")), row)).toBe(15);
    expect(evaluate(fn("date_trunc", "day", col("date")), row)).toBe("2026-06-13T00:00:00.000Z");
    expect(evaluate(fn("round", col("amount"), 1), row)).toBe(12.3);
    expect(evaluate(fn("floor", col("amount")), row)).toBe(12);
    expect(evaluate(fn("ceil", col("amount")), row)).toBe(13);
    expect(evaluate(fn("abs", -3), row)).toBe(3);
    expect(evaluate(fn("least", 3, 2, 5), row)).toBe(2);
    expect(evaluate(fn("greatest", 3, 2, 5), row)).toBe(5);
    expect(evaluate(fn("date_trunc", "year", col("date")), row)).toBe("2026-01-01T00:00:00.000Z");
    expect(evaluate(fn("date_trunc", "month", col("date")), row)).toBe("2026-06-01T00:00:00.000Z");
    expect(evaluate(fn("date_trunc", "hour", col("date")), row)).toBe("2026-06-13T15:00:00.000Z");
    expect(evaluate(fn("cast", col("amount"), "string"), row)).toBe("12.345");
    expect(evaluate(fn("cast", "42", "number"), row)).toBe(42);
    expect(evaluate(fn("cast", 1, "boolean"), row)).toBe(true);
  });

  it("returns null from null-propagating functions", () => {
    expect(evaluate(fn("lower", lit(null)), row)).toBeNull();
    expect(evaluate(fn("substr", lit(null), 0, 1), row)).toBeNull();
    expect(evaluate(fn("replace", col("city"), lit(null), "x"), row)).toBeNull();
    expect(evaluate(fn("year", lit(null)), row)).toBeNull();
    expect(evaluate(fn("date_trunc", "day", lit(null)), row)).toBeNull();
    expect(evaluate(fn("round", lit(null)), row)).toBeNull();
    expect(evaluate(fn("least", 1, lit(null)), row)).toBeNull();
  });

  it("throws typed errors for unknown columns and functions", () => {
    expect(() => evaluate(eq("missing", 1), row)).toThrowError(LaQLError);
    expect(() => evaluate(eq("city", 1), row)).toThrowError(LaQLError);
    expect(() => evaluate(eq("nested", 1), { nested: { value: 1 } })).toThrowError(LaQLError);
    expect(() => evaluate(fn("not_a_function", 1), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("lower"), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("lower", 1), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("substr", col("city"), "x", 1), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("replace", col("city"), 1, "x"), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("cast", col("city"), "unknown"), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("date_trunc", 1, col("date")), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("date_trunc", "week", col("date")), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("year", "not-a-date"), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("round"), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("round", col("city")), row)).toThrowError(LaQLError);
    expect(() => evaluate(fn("least"), row)).toThrowError(LaQLError);
    expect(() => evaluate(like("amount", "%"), row)).toThrowError(LaQLError);
    expect(() => matches(lit(1), row)).toThrowError(LaQLError);
  });

  it("maps unsafe bigint values to strings for JSON output", () => {
    expect(jsonSafeValue({ big: 9007199254740993n, small: 12n })).toEqual({
      big: "9007199254740993",
      small: 12,
    });
  });
});
