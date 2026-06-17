import { LakeqlError } from "./errors.js";

export interface QuantileAggregateConfig {
  quantile?: number;
}

export function continuousQuantile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = quantile * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (rank - lowerIndex);
}

export function requiredQuantile(aggregate: QuantileAggregateConfig): number {
  if (
    typeof aggregate.quantile !== "number" ||
    !Number.isFinite(aggregate.quantile) ||
    aggregate.quantile < 0 ||
    aggregate.quantile > 1
  ) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "quantile must be a number between 0 and 1", {
      aggregate,
    });
  }
  return aggregate.quantile;
}
