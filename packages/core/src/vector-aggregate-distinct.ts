import { LakeqlError } from "./errors.js";
import { jsonSafeValue } from "./evaluator.js";
import { stableStringify } from "./manifest.js";
import type { QueryBudget } from "./query.js";
import type { VectorAggregateValue } from "./vector-aggregate.js";

const textEncoder = new TextEncoder();

export type VectorDistinctAggregateState = {
  op: "count_distinct" | "approx_count_distinct";
  values: Set<string>;
  memoryBytes: number;
};

export function createDistinctAggregateState(
  op: VectorDistinctAggregateState["op"],
): VectorDistinctAggregateState {
  return { op, values: new Set(), memoryBytes: distinctMemoryBytes(new Set()) };
}

export function distinctKey(value: Exclude<VectorAggregateValue, null>): string {
  return `${typeof value}:${String(value)}`;
}

export function addDistinctValue(
  state: VectorDistinctAggregateState,
  key: string,
  budget?: QueryBudget,
): void {
  if (state.values.has(key)) return;
  state.values.add(key);
  state.memoryBytes = distinctMemoryBytes(state.values, budget);
  enforceDistinctBudget(state, budget);
}

export function enforceDistinctStateBudget(
  state: VectorDistinctAggregateState,
  budget?: QueryBudget,
): void {
  enforceDistinctBudget(state, budget);
}

export function distinctMemoryBytes(values: Set<string>, budget?: QueryBudget): number {
  if (budget?.maxMemoryBytes === undefined && values.size !== 0) return 0;
  return textEncoder.encode(stableStringify(jsonSafeValue([...values]))).byteLength;
}

function enforceDistinctBudget(state: VectorDistinctAggregateState, budget?: QueryBudget): void {
  if (budget?.maxMemoryBytes !== undefined) {
    state.memoryBytes = distinctMemoryBytes(state.values, budget);
  }
  if (budget?.maxBufferedRows !== undefined && state.values.size > budget.maxBufferedRows) {
    throwBudget("buffered rows", budget.maxBufferedRows, state.values.size);
  }
  if (budget?.maxMemoryBytes !== undefined && state.memoryBytes > budget.maxMemoryBytes) {
    throwBudget("operator memory bytes", budget.maxMemoryBytes, state.memoryBytes);
  }
}

function throwBudget(metric: string, limit: number, actual: number): never {
  throw new LakeqlError(
    "LAKEQL_BUDGET_EXCEEDED",
    `Query exceeded ${metric} budget (${actual} > ${limit}). Add a partition filter, date filter, h3 filter, or limit.`,
    { metric, limit, actual },
  );
}
