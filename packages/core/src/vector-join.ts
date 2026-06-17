import { type Batch, batchFromColumns, type Selection, vectorValue } from "./batch.js";
import { LakeqlError } from "./errors.js";
import type { Scalar } from "./expr.js";
import type { JoinKey, JoinType } from "./join.js";
import { stableStringify } from "./manifest.js";

export interface VectorHashJoinOptions {
  leftKey: JoinKey;
  rightKey: JoinKey;
  maxRightRows: number;
  type?: JoinType;
  rightPrefix?: string;
  leftSelection?: Selection;
  rightSelection?: Selection;
}

type OutputColumns = Record<string, Scalar[]>;

export function vectorHashJoin(left: Batch, right: Batch, options: VectorHashJoinOptions): Batch {
  const normalized = validateVectorJoinOptions(left, right, options);
  const rightIndices = selectedIndices(right.rowCount, options.rightSelection);
  enforceMaxRightRows(rightIndices.length, options.maxRightRows);
  const index = buildRightIndex(right, rightIndices, normalized.rightKeys);
  const output = createOutputColumns(left, right, normalized);
  for (const leftIndex of selectedIndices(left.rowCount, options.leftSelection)) {
    const matches = index.get(joinKey(left, leftIndex, normalized.leftKeys));
    if (normalized.type === "semi") {
      if (matches !== undefined && matches.length > 0) appendLeftOnly(output, left, leftIndex);
      continue;
    }
    if (normalized.type === "anti") {
      if (matches === undefined || matches.length === 0) appendLeftOnly(output, left, leftIndex);
      continue;
    }
    if (matches === undefined || matches.length === 0) {
      if (normalized.type === "left")
        appendLeftWithNullRight(output, left, right, leftIndex, normalized);
      continue;
    }
    for (const rightIndex of matches)
      appendJoined(output, left, right, leftIndex, rightIndex, normalized);
  }
  return batchFromOutput(output);
}

interface NormalizedVectorHashJoinOptions {
  leftKeys: string[];
  rightKeys: string[];
  type: JoinType;
  rightPrefix: string;
  outputRightColumns: { input: string; output: string }[];
}

function validateVectorJoinOptions(
  left: Batch,
  right: Batch,
  options: VectorHashJoinOptions,
): NormalizedVectorHashJoinOptions {
  const leftKeys = normalizeJoinKeys(options.leftKey, "leftKey");
  const rightKeys = normalizeJoinKeys(options.rightKey, "rightKey");
  if (leftKeys.length !== rightKeys.length) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "Vector join key counts must match", {
      leftKey: options.leftKey,
      rightKey: options.rightKey,
    });
  }
  if (!Number.isInteger(options.maxRightRows) || options.maxRightRows < 1) {
    throw new LakeqlError(
      "LAKEQL_TYPE_ERROR",
      "Vector join maxRightRows must be a positive integer",
    );
  }
  const type = options.type ?? "inner";
  if (type !== "inner" && type !== "left" && type !== "semi" && type !== "anti") {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "Vector join type is not supported", { type });
  }
  for (const key of leftKeys) assertColumn(left, key);
  for (const key of rightKeys) assertColumn(right, key);
  const rightPrefix = options.rightPrefix ?? "right.";
  return {
    leftKeys,
    rightKeys,
    type,
    rightPrefix,
    outputRightColumns:
      type === "semi" || type === "anti"
        ? []
        : outputRightColumns(left, right, leftKeys, rightKeys, rightPrefix),
  };
}

function buildRightIndex(
  right: Batch,
  rightIndices: readonly number[],
  rightKeys: readonly string[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const rightIndex of rightIndices) {
    const key = joinKey(right, rightIndex, rightKeys);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [rightIndex]);
    else bucket.push(rightIndex);
  }
  return index;
}

function createOutputColumns(
  left: Batch,
  _right: Batch,
  options: NormalizedVectorHashJoinOptions,
): OutputColumns {
  const output: OutputColumns = {};
  for (const column of Object.keys(left.columns)) output[column] = [];
  for (const { output: column } of options.outputRightColumns) output[column] = [];
  return output;
}

function appendJoined(
  output: OutputColumns,
  left: Batch,
  right: Batch,
  leftIndex: number,
  rightIndex: number,
  options: NormalizedVectorHashJoinOptions,
): void {
  appendLeft(output, left, leftIndex);
  appendRight(output, right, rightIndex, options);
}

function appendLeftOnly(output: OutputColumns, left: Batch, leftIndex: number): void {
  appendLeft(output, left, leftIndex);
}

function appendLeftWithNullRight(
  output: OutputColumns,
  left: Batch,
  right: Batch,
  leftIndex: number,
  options: NormalizedVectorHashJoinOptions,
): void {
  appendLeft(output, left, leftIndex);
  for (const { output: column } of options.outputRightColumns) output[column]?.push(null);
  void right;
}

function appendLeft(output: OutputColumns, left: Batch, leftIndex: number): void {
  for (const [column, vector] of Object.entries(left.columns)) {
    output[column]?.push(vectorValue(vector, leftIndex));
  }
}

function appendRight(
  output: OutputColumns,
  right: Batch,
  rightIndex: number,
  options: NormalizedVectorHashJoinOptions,
): void {
  for (const { input, output: column } of options.outputRightColumns) {
    const vector = right.columns[input];
    if (vector === undefined)
      throw new LakeqlError("LAKEQL_UNKNOWN_COLUMN", `Unknown column ${input}`, { column: input });
    output[column]?.push(vectorValue(vector, rightIndex));
  }
}

function outputRightColumns(
  left: Batch,
  right: Batch,
  leftKeys: readonly string[],
  rightKeys: readonly string[],
  rightPrefix: string,
): { input: string; output: string }[] {
  return Object.keys(right.columns).flatMap((column) => {
    if (rightKeys.includes(column) && leftKeys.includes(column)) return [];
    return [{ input: column, output: column in left.columns ? `${rightPrefix}${column}` : column }];
  });
}

function joinKey(batch: Batch, index: number, keys: readonly string[]): string {
  const values = keys.map((key) => scalarJoinValue(batch, index, key));
  return stableStringify(values.length === 1 ? values[0] : values);
}

function scalarJoinValue(batch: Batch, index: number, column: string): Scalar {
  const vector = batch.columns[column];
  if (vector === undefined)
    throw new LakeqlError("LAKEQL_UNKNOWN_COLUMN", `Unknown join key ${column}`, { column });
  return vectorValue(vector, index);
}

function normalizeJoinKeys(key: JoinKey, label: string): string[] {
  const keys = Array.isArray(key) ? key : [key];
  if (
    keys.length === 0 ||
    keys.some((column) => typeof column !== "string" || column.length === 0)
  ) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", `Vector join ${label} must contain column names`, {
      [label]: key,
    });
  }
  return keys;
}

function assertColumn(batch: Batch, column: string): void {
  if (batch.columns[column] === undefined) {
    throw new LakeqlError("LAKEQL_UNKNOWN_COLUMN", `Unknown join key ${column}`, { column });
  }
}

function selectedIndices(rowCount: number, selection?: Selection): number[] {
  const indices: number[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    if (selection !== undefined && selection[index] !== 1) continue;
    indices.push(index);
  }
  return indices;
}

function enforceMaxRightRows(actual: number, limit: number): void {
  if (actual <= limit) return;
  throw new LakeqlError(
    "LAKEQL_BUDGET_EXCEEDED",
    `Vector join exceeded maxRightRows (${actual} > ${limit})`,
    { metric: "maxRightRows", limit, actual },
  );
}

function batchFromOutput(output: OutputColumns): Batch {
  return batchFromColumns(output);
}
