import type {
  VectorAggregateSnapshotValue,
  VectorAggregateState,
  VectorAggregateStateSnapshot,
  VectorAggregateValue,
} from "./vector-aggregate.js";
import { distinctMemoryBytes } from "./vector-aggregate-distinct.js";

export function snapshotVectorAggregateState(
  state: VectorAggregateState,
): VectorAggregateStateSnapshot {
  switch (state.op) {
    case "count":
      return { op: "count", count: state.count };
    case "sum":
      return { op: "sum", sum: state.sum };
    case "avg":
      return { op: "avg", sum: state.sum, count: state.count };
    case "var_samp":
    case "var_pop":
    case "stddev_samp":
    case "stddev_pop":
      return { op: state.op, count: state.count, mean: state.mean, m2: state.m2 };
    case "median":
      return { op: "median", values: [...state.values] };
    case "quantile":
      return { op: "quantile", quantile: state.quantile, values: [...state.values] };
    case "min":
    case "max":
      return { op: state.op, value: snapshotValue(state.value) };
    case "count_distinct":
    case "approx_count_distinct":
      return { op: state.op, values: [...state.values].sort() };
    case "mode":
      return {
        op: "mode",
        values: [...state.values.entries()].map(([key, entry]) => ({
          key,
          value: snapshotValue(entry.value),
          count: entry.count,
        })),
      };
    case "first":
    case "last":
    case "any":
      return { op: state.op, seen: state.seen, value: snapshotValue(state.value) };
  }
}

export function vectorAggregateStateFromSnapshot(
  snapshot: VectorAggregateStateSnapshot,
): VectorAggregateState {
  switch (snapshot.op) {
    case "count":
      return { op: "count", count: snapshot.count };
    case "sum":
      return { op: "sum", sum: snapshot.sum };
    case "avg":
      return { op: "avg", sum: snapshot.sum, count: snapshot.count };
    case "var_samp":
    case "var_pop":
    case "stddev_samp":
    case "stddev_pop":
      return { op: snapshot.op, count: snapshot.count, mean: snapshot.mean, m2: snapshot.m2 };
    case "median":
      return { op: "median", values: [...snapshot.values], memoryBytes: 0 };
    case "quantile":
      return {
        op: "quantile",
        quantile: snapshot.quantile,
        values: [...snapshot.values],
        memoryBytes: 0,
      };
    case "min":
    case "max":
      return { op: snapshot.op, value: restoreValue(snapshot.value) };
    case "count_distinct":
    case "approx_count_distinct": {
      const values = new Set(snapshot.values);
      return { op: snapshot.op, values, memoryBytes: distinctMemoryBytes(values) };
    }
    case "mode": {
      const values = new Map(
        snapshot.values.map((entry) => [
          entry.key,
          {
            value: restoreValue(entry.value) as Exclude<VectorAggregateValue, null>,
            count: entry.count,
          },
        ]),
      );
      return { op: "mode", values, memoryBytes: distinctMemoryBytes(new Set(values.keys())) };
    }
    case "first":
    case "last":
    case "any":
      return { op: snapshot.op, seen: snapshot.seen, value: restoreValue(snapshot.value) };
  }
}

function snapshotValue(value: VectorAggregateValue): VectorAggregateSnapshotValue {
  return typeof value === "bigint" ? { type: "bigint", value: value.toString() } : value;
}

function restoreValue(value: VectorAggregateSnapshotValue): VectorAggregateValue {
  if (isBigintSnapshot(value)) return BigInt(value.value);
  return value;
}

function isBigintSnapshot(
  value: VectorAggregateSnapshotValue,
): value is { type: "bigint"; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "bigint" &&
    "value" in value &&
    typeof value.value === "string"
  );
}
