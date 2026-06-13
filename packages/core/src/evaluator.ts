import { LaQLError } from "./errors.js";
import type { Expr, Scalar } from "./expr.js";
import type { Row } from "./types.js";

export type SqlBoolean = boolean | null;

type EvalValue = Scalar;

interface BBox {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

const textEncoder = new TextEncoder();

export function evaluate(expr: Expr, row: Row): EvalValue {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "column":
      return rowValue(row, expr.name);
    case "compare":
      return compare(expr.op, evaluate(expr.left, row), evaluate(expr.right, row));
    case "in": {
      const target = evaluate(expr.target, row);
      const result = inList(
        target,
        expr.values.map((value) => evaluate(value, row)),
      );
      return expr.negated ? sqlNot(result) : result;
    }
    case "between": {
      const target = evaluate(expr.target, row);
      const low = evaluate(expr.low, row);
      const high = evaluate(expr.high, row);
      return sqlAnd(compare("gte", target, low), compare("lte", target, high));
    }
    case "null-check": {
      const result = evaluate(expr.target, row) === null;
      return expr.negated ? !result : result;
    }
    case "logical":
      return expr.op === "and"
        ? expr.operands.reduce<SqlBoolean>(
            (acc, operand) => sqlAnd(acc, toSqlBoolean(evaluate(operand, row))),
            true,
          )
        : expr.operands.reduce<SqlBoolean>(
            (acc, operand) => sqlOr(acc, toSqlBoolean(evaluate(operand, row))),
            false,
          );
    case "not":
      return sqlNot(toSqlBoolean(evaluate(expr.operand, row)));
    case "like":
      return likeMatch(evaluate(expr.target, row), expr.pattern, expr.caseInsensitive);
    case "call":
      return callFunction(
        expr.fn,
        expr.args.map((arg) => evaluate(arg, row)),
      );
  }
}

export function matches(expr: Expr | undefined, row: Row): boolean {
  if (!expr) return true;
  return toSqlBoolean(evaluate(expr, row)) === true;
}

export function jsonSafeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = jsonSafeValue(inner);
    return out;
  }
  return value;
}

export function encodeJsonLine(row: Row): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(jsonSafeValue(row))}\n`);
}

function rowValue(row: Row, name: string): EvalValue {
  if (!(name in row)) {
    throw new LaQLError("LAQL_UNKNOWN_COLUMN", `Unknown column ${name}`, { column: name });
  }
  const value = row[name];
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new LaQLError("LAQL_TYPE_ERROR", `Column ${name} is not a scalar value`, {
    column: name,
    valueType: typeof value,
  });
}

function toSqlBoolean(value: EvalValue): SqlBoolean {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  throw new LaQLError("LAQL_TYPE_ERROR", "Predicate expression must evaluate to boolean", {
    value,
  });
}

function compare(op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", left: EvalValue, right: EvalValue) {
  if (left === null || right === null) return null;
  if (typeof left !== typeof right && !(isNumberLike(left) && isNumberLike(right))) {
    throw new LaQLError("LAQL_TYPE_ERROR", "Cannot compare values of different types", {
      leftType: typeof left,
      rightType: typeof right,
    });
  }
  const order = left < right ? -1 : left > right ? 1 : 0;
  switch (op) {
    case "eq":
      return order === 0;
    case "ne":
      return order !== 0;
    case "lt":
      return order < 0;
    case "lte":
      return order <= 0;
    case "gt":
      return order > 0;
    case "gte":
      return order >= 0;
  }
}

function isNumberLike(value: EvalValue): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

function inList(target: EvalValue, values: EvalValue[]): SqlBoolean {
  if (target === null) return null;
  let sawNull = false;
  for (const value of values) {
    const result = compare("eq", target, value);
    if (result === true) return true;
    if (result === null) sawNull = true;
  }
  return sawNull ? null : false;
}

function sqlAnd(left: SqlBoolean, right: SqlBoolean): SqlBoolean {
  if (left === false || right === false) return false;
  if (left === null || right === null) return null;
  return true;
}

function sqlOr(left: SqlBoolean, right: SqlBoolean): SqlBoolean {
  if (left === true || right === true) return true;
  if (left === null || right === null) return null;
  return false;
}

function sqlNot(value: SqlBoolean): SqlBoolean {
  if (value === null) return null;
  return !value;
}

function likeMatch(value: EvalValue, pattern: string, caseInsensitive: boolean): SqlBoolean {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LaQLError("LAQL_TYPE_ERROR", "LIKE expects a string value", {
      valueType: typeof value,
    });
  }
  const regex = new RegExp(`^${escapeLikePattern(pattern)}$`, caseInsensitive ? "iu" : "u");
  return regex.test(value);
}

function escapeLikePattern(pattern: string): string {
  let out = "";
  for (const char of pattern) {
    if (char === "%") out += ".*";
    else if (char === "_") out += ".";
    else out += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return out;
}

function callFunction(name: string, args: EvalValue[]): EvalValue {
  const fn = name.toLowerCase();
  switch (fn) {
    case "lower":
      return unaryString(fn, args, (value) => value.toLowerCase());
    case "upper":
      return unaryString(fn, args, (value) => value.toUpperCase());
    case "trim":
      return unaryString(fn, args, (value) => value.trim());
    case "substr":
      return substr(args);
    case "replace":
      return replace(args);
    case "coalesce":
      return args.find((value) => value !== null) ?? null;
    case "nullif":
      requireArgCount(fn, args, 2);
      return compare("eq", args[0] ?? null, args[1] ?? null) === true ? null : (args[0] ?? null);
    case "cast":
      return cast(args);
    case "year":
      return datePart(fn, args, (date) => date.getUTCFullYear());
    case "month":
      return datePart(fn, args, (date) => date.getUTCMonth() + 1);
    case "day":
      return datePart(fn, args, (date) => date.getUTCDate());
    case "hour":
      return datePart(fn, args, (date) => date.getUTCHours());
    case "date_trunc":
      return dateTrunc(args);
    case "round":
      return round(args);
    case "floor":
      return unaryNumber(fn, args, Math.floor);
    case "ceil":
      return unaryNumber(fn, args, Math.ceil);
    case "abs":
      return unaryNumber(fn, args, Math.abs);
    case "least":
      return leastGreatest(fn, args, "least");
    case "greatest":
      return leastGreatest(fn, args, "greatest");
    case "st_bbox":
      return stBBox(args);
    case "st_intersects":
      return spatialPredicate(fn, args, bboxIntersects);
    case "st_contains":
      return spatialPredicate(fn, args, bboxContains);
    case "st_within":
      return spatialPredicate(fn, args, (left, right) => bboxContains(right, left));
    case "h3_in":
      return h3In(args);
    default:
      throw new LaQLError("LAQL_UNSUPPORTED_PUSHDOWN", `Unsupported scalar function ${name}`, {
        function: name,
      });
  }
}

function requireArgCount(name: string, args: EvalValue[], expected: number): void {
  if (args.length !== expected) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() expects ${expected} arguments`, {
      expected,
      received: args.length,
    });
  }
}

function unaryString(name: string, args: EvalValue[], cb: (value: string) => string): EvalValue {
  requireArgCount(name, args, 1);
  const value = args[0] ?? null;
  if (value === null) return null;
  if (typeof value !== "string") throwType(name, "string", value);
  return cb(value);
}

function unaryNumber(name: string, args: EvalValue[], cb: (value: number) => number): EvalValue {
  requireArgCount(name, args, 1);
  const value = args[0] ?? null;
  if (value === null) return null;
  if (typeof value !== "number") throwType(name, "number", value);
  return cb(value);
}

function substr(args: EvalValue[]): EvalValue {
  requireArgCount("substr", args, 3);
  const value = args[0] ?? null;
  const start = args[1] ?? null;
  const length = args[2] ?? null;
  if (value === null || start === null || length === null) return null;
  if (typeof value !== "string") throwType("substr", "string", value);
  if (typeof start !== "number" || typeof length !== "number") {
    throw new LaQLError("LAQL_TYPE_ERROR", "substr() start and length must be numbers");
  }
  return value.slice(start, start + length);
}

function replace(args: EvalValue[]): EvalValue {
  requireArgCount("replace", args, 3);
  const value = args[0] ?? null;
  const search = args[1] ?? null;
  const replacement = args[2] ?? null;
  if (value === null || search === null || replacement === null) return null;
  if (typeof value !== "string") throwType("replace", "string", value);
  if (typeof search !== "string" || typeof replacement !== "string") {
    throw new LaQLError("LAQL_TYPE_ERROR", "replace() search and replacement must be strings");
  }
  return value.replaceAll(search, replacement);
}

function stBBox(args: EvalValue[]): EvalValue {
  requireArgCount("st_bbox", args, 4);
  const [minx, miny, maxx, maxy] = args;
  if (
    typeof minx !== "number" ||
    typeof miny !== "number" ||
    typeof maxx !== "number" ||
    typeof maxy !== "number" ||
    !Number.isFinite(minx) ||
    !Number.isFinite(miny) ||
    !Number.isFinite(maxx) ||
    !Number.isFinite(maxy)
  ) {
    throw new LaQLError("LAQL_TYPE_ERROR", "st_bbox() expects finite number bounds");
  }
  if (minx > maxx || miny > maxy) {
    throw new LaQLError("LAQL_TYPE_ERROR", "st_bbox() bounds must be ordered min <= max");
  }
  return JSON.stringify({ type: "BBox", minx, miny, maxx, maxy });
}

function spatialPredicate(
  name: string,
  args: EvalValue[],
  predicate: (left: BBox, right: BBox) => boolean,
): EvalValue {
  requireArgCount(name, args, 2);
  const left = args[0] ?? null;
  const right = args[1] ?? null;
  if (left === null || right === null) return null;
  return predicate(envelope(left, name), envelope(right, name));
}

function h3In(args: EvalValue[]): EvalValue {
  requireArgCount("h3_in", args, 2);
  const cell = args[0] ?? null;
  const cells = args[1] ?? null;
  if (cell === null || cells === null) return null;
  if (typeof cell !== "string" || typeof cells !== "string") {
    throw new LaQLError("LAQL_TYPE_ERROR", "h3_in() expects a string cell and JSON cell list");
  }
  const parsed: unknown = JSON.parse(cells);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new LaQLError("LAQL_TYPE_ERROR", "h3_in() cell list must be a JSON string array");
  }
  return parsed.includes(cell);
}

function envelope(value: EvalValue, name: string): BBox {
  if (typeof value !== "string") throwType(name, "GeoJSON or BBox JSON string", value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() received invalid geometry JSON`, {
      cause,
    });
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() expects GeoJSON or BBox JSON`);
  }
  if (parsed.type === "BBox") return bboxFromRecord(parsed, name);
  if (parsed.type === "Point") return pointEnvelope(parsed, name);
  if (parsed.type === "Polygon") return polygonEnvelope(parsed, name);
  throw new LaQLError("LAQL_TYPE_ERROR", `${name}() supports Point, Polygon, or BBox geometry`);
}

function bboxFromRecord(record: Record<string, unknown>, name: string): BBox {
  const { minx, miny, maxx, maxy } = record;
  if (
    typeof minx !== "number" ||
    typeof miny !== "number" ||
    typeof maxx !== "number" ||
    typeof maxy !== "number" ||
    !Number.isFinite(minx) ||
    !Number.isFinite(miny) ||
    !Number.isFinite(maxx) ||
    !Number.isFinite(maxy)
  ) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() BBox values must be finite numbers`);
  }
  return { minx, miny, maxx, maxy };
}

function pointEnvelope(record: Record<string, unknown>, name: string): BBox {
  const point = record.coordinates;
  if (!isPosition(point)) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() Point coordinates are invalid`);
  }
  const [x, y] = point;
  return { minx: x, miny: y, maxx: x, maxy: y };
}

function polygonEnvelope(record: Record<string, unknown>, name: string): BBox {
  const rings = record.coordinates;
  if (!Array.isArray(rings)) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() Polygon coordinates are invalid`);
  }
  const points = rings.flat();
  if (points.length === 0 || !points.every(isPosition)) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() Polygon coordinates are invalid`);
  }
  let minx = Number.POSITIVE_INFINITY;
  let miny = Number.POSITIVE_INFINITY;
  let maxx = Number.NEGATIVE_INFINITY;
  let maxy = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minx = Math.min(minx, x);
    miny = Math.min(miny, y);
    maxx = Math.max(maxx, x);
    maxy = Math.max(maxy, y);
  }
  return { minx, miny, maxx, maxy };
}

function bboxIntersects(left: BBox, right: BBox): boolean {
  return (
    left.maxx >= right.minx &&
    left.minx <= right.maxx &&
    left.maxy >= right.miny &&
    left.miny <= right.maxy
  );
}

function bboxContains(left: BBox, right: BBox): boolean {
  return (
    left.minx <= right.minx &&
    left.miny <= right.miny &&
    left.maxx >= right.maxx &&
    left.maxy >= right.maxy
  );
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cast(args: EvalValue[]): EvalValue {
  requireArgCount("cast", args, 2);
  const value = args[0] ?? null;
  const target = args[1] ?? null;
  if (value === null) return null;
  if (typeof target !== "string") throwType("cast", "string type name", target ?? null);
  switch (target) {
    case "string":
      return String(value);
    case "float64":
    case "number": {
      const number = Number(value);
      return Number.isNaN(number) ? null : number;
    }
    case "boolean":
      return Boolean(value);
    default:
      throw new LaQLError("LAQL_TYPE_ERROR", `Unsupported cast target ${target}`, { target });
  }
}

function datePart(name: string, args: EvalValue[], cb: (date: Date) => number): EvalValue {
  requireArgCount(name, args, 1);
  const date = parseDateArg(name, args[0] ?? null);
  return date ? cb(date) : null;
}

function dateTrunc(args: EvalValue[]): EvalValue {
  requireArgCount("date_trunc", args, 2);
  const part = args[0] ?? null;
  const value = args[1] ?? null;
  if (part === null || value === null) return null;
  if (typeof part !== "string") throwType("date_trunc", "string part", part);
  const date = parseDateArg("date_trunc", value);
  if (!date) return null;
  if (part === "year") return `${date.getUTCFullYear()}-01-01T00:00:00.000Z`;
  if (part === "month") {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01T00:00:00.000Z`;
  }
  if (part === "day") {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T00:00:00.000Z`;
  }
  if (part === "hour") {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:00:00.000Z`;
  }
  throw new LaQLError("LAQL_TYPE_ERROR", `Unsupported date_trunc part ${part}`, { part });
}

function round(args: EvalValue[]): EvalValue {
  if (args.length < 1 || args.length > 2) {
    throw new LaQLError("LAQL_TYPE_ERROR", "round() expects 1 or 2 arguments", {
      received: args.length,
    });
  }
  const value = args[0] ?? null;
  const places = args[1] ?? 0;
  if (value === null || places === null) return null;
  if (typeof value !== "number" || typeof places !== "number") {
    throw new LaQLError("LAQL_TYPE_ERROR", "round() arguments must be numbers");
  }
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function leastGreatest(name: string, args: EvalValue[], mode: "least" | "greatest"): EvalValue {
  if (args.length === 0) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() expects at least 1 argument`);
  }
  if (args.some((value) => value === null)) return null;
  let best = args[0] ?? null;
  for (const value of args.slice(1)) {
    if (compare(mode === "least" ? "lt" : "gt", value, best) === true) best = value;
  }
  return best;
}

function parseDateArg(name: string, value: EvalValue): Date | null {
  if (value === null) return null;
  if (typeof value !== "string" && typeof value !== "number") throwType(name, "date string", value);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new LaQLError("LAQL_TYPE_ERROR", `${name}() received an invalid date`, { value });
  }
  return date;
}

function throwType(name: string, expected: string, value: EvalValue): never {
  throw new LaQLError("LAQL_TYPE_ERROR", `${name}() expects ${expected}`, {
    expected,
    received: typeof value,
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
