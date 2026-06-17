import {
  concatBatches,
  gatherBatch,
  materializeBatchRows,
  vectorProjectBatch,
  vectorTopKIndices,
} from "../packages/core/dist/index.js";
import {
  aggregateParquetGroupTasksBatch,
  aggregateParquetTasks,
  scanParquetTaskColumnBatches,
  writePartitionedParquet,
} from "../packages/parquet/dist/index.js";
import { orderVectorScanBatch, referencedColumns } from "./duckdb-vector-helpers.mjs";
import { metricsFromStats, planBenchmarkWorkUnits } from "./duckdb-workunits.mjs";

export async function materializeBenchmarkCteIfNeeded(store, lake, ast, options) {
  if (ast.cte === undefined) return ast;
  if (ast.source !== ast.cte.name) {
    throw new Error("CTE benchmark only supports the CTE as the outer FROM source");
  }
  if (ast.join !== undefined || ast.subqueryJoin !== undefined) {
    throw new Error("CTE benchmark does not support joins around the materialized CTE");
  }

  const cte = normalizeCteQuery(ast.cte.query, options.defaultSource);
  const result = await materializeCteRows(store, lake, cte, options);
  if (result.rows.length === 0) throw new Error("CTE benchmark cannot materialize empty results");

  const prefix = `__bench_cte/${ast.cte.name}`;
  await writePartitionedParquet(store, prefix, {
    rows: result.rows,
    maxRowsPerFile: result.rows.length,
  });
  const { cte: _cte, ...rest } = ast;
  return {
    ...rest,
    source: `${prefix}/*.parquet`,
    __benchCteMetrics: result.metrics,
  };
}

export function cteMetric(ast, metric) {
  return ast.__benchCteMetrics?.[metric] ?? 0;
}

async function materializeCteRows(store, lake, ast, options) {
  const aggregates =
    ast.aggregates && Object.keys(ast.aggregates).length > 0 ? ast.aggregates : undefined;
  const grouped = (ast.groupBy?.length ?? 0) > 0;
  if (aggregates !== undefined || grouped || ast.having !== undefined) {
    return materializeAggregateCteRows(store, lake, ast, aggregates, grouped, options);
  }
  return materializeSimpleCteRows(store, lake, ast, options);
}

async function materializeSimpleCteRows(store, lake, ast, options) {
  if (ast.distinct === true) {
    throw new Error("CTE benchmark helper currently supports non-distinct CTE materialization");
  }

  const stats = options.benchQueryStats();
  let base = lake.path(ast.source).select(referencedColumns(ast));
  if (ast.where !== undefined) base = base.where(ast.where);
  const workUnits = await planBenchmarkWorkUnits(store, base, options);

  let candidates;
  for (const task of workUnits) {
    for await (const batch of scanParquetTaskColumnBatches(store, task, {
      metadataCache: options.metadataCache,
      stats,
    })) {
      const combined =
        candidates === undefined ? batch.batch : concatBatches([candidates, batch.batch]);
      candidates =
        ast.limit === undefined
          ? combined
          : gatherBatch(
              combined,
              vectorTopKIndices(combined, ast.orderBy, (ast.offset ?? 0) + ast.limit),
            );
    }
  }

  const orderedBatch = orderVectorScanBatch(candidates, ast);
  const resultBatch =
    orderedBatch === undefined
      ? undefined
      : vectorProjectBatch(orderedBatch, ast.select, ast.projections);
  return {
    rows: resultBatch === undefined ? [] : materializeBatchRows(resultBatch),
    metrics: metricsFromStats(stats, workUnits),
  };
}

async function materializeAggregateCteRows(store, lake, ast, aggregates, grouped, options) {
  if (aggregates === undefined) {
    throw new Error("CTE benchmark aggregate materialization requires aggregate expressions");
  }
  if (ast.having !== undefined || ast.distinct === true) {
    throw new Error("CTE benchmark helper currently supports plain aggregate CTE materialization");
  }
  if (
    !grouped &&
    (ast.orderBy !== undefined || ast.limit !== undefined || ast.offset !== undefined)
  ) {
    throw new Error("CTE benchmark helper does not support ordered global aggregate CTEs");
  }

  const stats = options.benchQueryStats();
  let base = lake.path(ast.source);
  if (ast.where !== undefined) base = base.where(ast.where);
  const workUnits = await planBenchmarkWorkUnits(store, base, options);

  const rows = grouped
    ? materializeBatchRows(
        await aggregateParquetGroupTasksBatch(store, workUnits, ast.groupBy ?? [], aggregates, {
          stats,
          metadataCache: options.metadataCache,
          maxConcurrentTasks: options.aggregateConcurrency,
          ...(ast.orderBy === undefined ? {} : { orderBy: ast.orderBy }),
          ...(ast.limit === undefined ? {} : { limit: ast.limit }),
          ...(ast.offset === undefined ? {} : { offset: ast.offset }),
        }),
      )
    : [
        await aggregateParquetTasks(store, workUnits, aggregates, {
          stats,
          metadataCache: options.metadataCache,
          maxConcurrentTasks: options.aggregateConcurrency,
        }),
      ];

  return { rows, metrics: metricsFromStats(stats, workUnits) };
}

function normalizeCteQuery(ast, defaultSource) {
  return { ...ast, source: ast.source === "input" ? defaultSource : ast.source };
}
