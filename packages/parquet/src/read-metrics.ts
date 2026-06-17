import type { QueryStats } from "lakeql-core";

export function recordReadColumns(stats: QueryStats | undefined, columns: readonly string[]): void {
  if (stats === undefined) return;
  const known = new Set(stats.columnsRead);
  for (const column of columns) {
    if (!known.has(column)) {
      known.add(column);
      stats.columnsRead.push(column);
    }
  }
  stats.columnsRead.sort();
}

export function recordRowGroupRead(stats: QueryStats | undefined): void {
  if (stats === undefined) return;
  stats.rowGroupsRead += 1;
}

export function recordRowGroupSkipped(stats: QueryStats | undefined): void {
  if (stats === undefined) return;
  stats.rowGroupsSkipped += 1;
}

export function recordRowsDecoded(stats: QueryStats | undefined, rows: number): void {
  if (stats === undefined) return;
  stats.rowsDecoded += rows;
}

export function recordRowsMatched(stats: QueryStats | undefined, rows: number): void {
  if (stats === undefined) return;
  stats.rowsMatched += rows;
}
