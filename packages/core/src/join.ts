import { LaQLError } from "./errors.js";
import { stableStringify } from "./manifest.js";
import type { Row } from "./types.js";

export interface BroadcastJoinOptions {
  leftKey: string;
  rightKey: string;
  maxRightRows: number;
  type?: "inner" | "left";
  rightPrefix?: string;
}

export async function broadcastJoin(
  left: AsyncIterable<Row> | Iterable<Row>,
  right: AsyncIterable<Row> | Iterable<Row>,
  options: BroadcastJoinOptions,
): Promise<Row[]> {
  validateJoinOptions(options);
  const rightRows = await collectRightRows(right, options.maxRightRows);
  const index = new Map<string, Row[]>();
  for (const row of rightRows) {
    const key = joinKey(row, options.rightKey);
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }

  const out: Row[] = [];
  for await (const leftRow of left) {
    const matches = index.get(joinKey(leftRow, options.leftKey));
    if (!matches || matches.length === 0) {
      if (options.type === "left") out.push({ ...leftRow });
      continue;
    }
    for (const rightRow of matches) out.push(mergeRows(leftRow, rightRow, options));
  }
  return out;
}

async function collectRightRows(
  rows: AsyncIterable<Row> | Iterable<Row>,
  maxRightRows: number,
): Promise<Row[]> {
  const out: Row[] = [];
  for await (const row of rows) {
    if (out.length >= maxRightRows) {
      throw new LaQLError(
        "LAQL_BUDGET_EXCEEDED",
        `Broadcast join exceeded maxRightRows (${out.length + 1} > ${maxRightRows})`,
        { metric: "maxRightRows", limit: maxRightRows, actual: out.length + 1 },
      );
    }
    out.push(row);
  }
  return out;
}

function validateJoinOptions(options: BroadcastJoinOptions): void {
  if (!options.leftKey || !options.rightKey) {
    throw new LaQLError("LAQL_TYPE_ERROR", "Broadcast join requires leftKey and rightKey");
  }
  if (!Number.isInteger(options.maxRightRows) || options.maxRightRows < 1) {
    throw new LaQLError(
      "LAQL_TYPE_ERROR",
      "Broadcast join maxRightRows must be a positive integer",
    );
  }
}

function joinKey(row: Row, column: string): string {
  if (!(column in row)) {
    throw new LaQLError("LAQL_UNKNOWN_COLUMN", `Unknown join key ${column}`, { column });
  }
  const value = row[column];
  if (value === null || value === undefined) return "null";
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    typeof value !== "bigint"
  ) {
    throw new LaQLError("LAQL_TYPE_ERROR", `Join key ${column} must be scalar`, { column });
  }
  return stableStringify(value);
}

function mergeRows(left: Row, right: Row, options: BroadcastJoinOptions): Row {
  const out: Row = { ...left };
  const prefix = options.rightPrefix ?? "right.";
  for (const [key, value] of Object.entries(right)) {
    if (key === options.rightKey && options.leftKey === options.rightKey) continue;
    const outKey = key in out ? `${prefix}${key}` : key;
    out[outKey] = value;
  }
  return out;
}
