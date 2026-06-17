import { planParquetTaskWorkUnits } from "../packages/parquet/dist/index.js";

export async function planBenchmarkWorkUnits(store, query, options) {
  const tasks = await query.planTasks();
  const workUnits = [];
  for (const task of tasks) {
    workUnits.push(
      ...(await planParquetTaskWorkUnits(store, task, {
        maxRowGroupsPerTask: options.rowGroupsPerWorkUnit,
        metadataCache: options.metadataCache,
      })),
    );
  }
  return workUnits;
}

export function metricsFromStats(stats, workUnits) {
  return {
    rowGroupsRead: stats.rowGroupsRead,
    rowGroupsSkipped: stats.rowGroupsSkipped,
    rangeRequests: stats.rangeRequests,
    bytesRequested: stats.bytesRequested,
    rowsMatched: stats.rowsMatched,
    rowsScanned: stats.rowsDecoded,
    workUnits: workUnits.length,
  };
}

export function workUnitSourceMetrics(workUnits) {
  return {
    filesRead: uniqueTaskPaths(workUnits).length,
    workUnits: workUnits.length,
  };
}

export function uniqueTaskPaths(tasks) {
  return [...new Set(tasks.map((task) => task.path))];
}
