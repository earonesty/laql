import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gte, jsonWorkUnitBoundary, memoryCache } from "../packages/core/dist/index.js";
import {
  aggregateParquetTasks,
  createParquetLake,
  planParquetTaskWorkUnits,
  writeParquet,
} from "../packages/parquet/dist/index.js";
import {
  fileStore,
  formatBytes,
  formatOptionalBytes,
  formatOptionalMs,
  newStoreCounters,
  optionalPositiveIntegerEnv,
  positiveIntegerEnv,
  queryStats,
  summarizeSamples,
  timed,
} from "./bench-utils.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const generatedRoot = join(repoRoot, "bench/generated/workunits");
const reportPath = join(repoRoot, "bench/WORKUNITS.md");

const totalRows = positiveIntegerEnv("LAKEQL_WORKUNIT_ROWS", 100_000);
const rowsPerFile = positiveIntegerEnv("LAKEQL_WORKUNIT_ROWS_PER_FILE", 100_000);
const rowGroupRows = positiveIntegerEnv("LAKEQL_WORKUNIT_ROW_GROUP_ROWS", 10_000);
const maxRowGroupsPerTask = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_ROW_GROUPS_PER_TASK") ?? 1;
const maxRowsPerTask = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_ROWS_PER_TASK");
const maxConcurrentTasks = positiveIntegerEnv("LAKEQL_WORKUNIT_CONCURRENT_TASKS", 1);
const selectedTailRows = positiveIntegerEnv("LAKEQL_WORKUNIT_SELECTED_TAIL_ROWS", rowGroupRows);
const maxRssMb = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_RSS_MB");
const maxRssBytes = maxRssMb === undefined ? undefined : maxRssMb * 1024 * 1024;
const maxFanOutRssDeltaMb = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_FANOUT_RSS_DELTA_MB");
const maxFanOutRssDeltaBytes =
  maxFanOutRssDeltaMb === undefined ? undefined : maxFanOutRssDeltaMb * 1024 * 1024;
const maxFanOutBytesFetched = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_FANOUT_BYTES");
const maxFanOutRangeRequests = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_FANOUT_RANGES");
const maxPlanningBytesFetched = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_PLANNING_BYTES");
const maxPlanningRangeRequests = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_PLANNING_RANGES");
const maxFanOutRowsDecoded = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_ROWS_DECODED");
const maxPlannedRowGroups = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_PLANNED_ROW_GROUPS");
const maxWorkUnits = optionalPositiveIntegerEnv("LAKEQL_WORKUNIT_MAX_WORK_UNITS");
const maxRowsPerFanOutWaveGuard = optionalPositiveIntegerEnv(
  "LAKEQL_WORKUNIT_MAX_ROWS_PER_FANOUT_WAVE",
);
const regenerate = process.env.LAKEQL_WORKUNIT_REGENERATE === "1";
const compareMaterialized = process.env.LAKEQL_WORKUNIT_COMPARE_MATERIALIZED === "1";
const compareDuckDb = process.env.LAKEQL_WORKUNIT_COMPARE_DUCKDB === "1";
const duckDbIterations = positiveIntegerEnv("LAKEQL_WORKUNIT_DUCKDB_ITERATIONS", 5);
const duckDbWarmup = positiveIntegerEnv("LAKEQL_WORKUNIT_DUCKDB_WARMUP", 1);
const preserveTaskBoundaries = true;
const datasetConfig = { totalRows, rowsPerFile, rowGroupRows };

if (regenerate) await rm(generatedRoot, { recursive: true, force: true });
await mkdir(generatedRoot, { recursive: true });
if (!regenerate) await resetGeneratedDatasetIfConfigChanged(datasetConfig);
await writeDatasetConfig(datasetConfig);

const store = fileStore(generatedRoot);
const files = await ensureDataset(store);
store.resetCounters();
const metadataCache = memoryCache();
const planningCache = memoryCache();
const lake = createParquetLake({
  store,
  metadataCache,
  planningCache,
  queryId: () => "bench-workunits",
});
const threshold = Math.max(0, totalRows - selectedTailRows);
const query = lake
  .hive("parts/*.parquet")
  .select(["id", "metric", "bucket"])
  .where(gte("metric", threshold));

const plannedAt = performance.now();
const manifest = await query.taskManifest("bench_workunits");
const workUnits = [];
for (const task of manifest.tasks) {
  workUnits.push(
    ...(await planParquetTaskWorkUnits(store, task.input, {
      maxRowGroupsPerTask,
      maxRowsPerTask,
      metadataCache,
    })),
  );
}
const planningMs = performance.now() - plannedAt;
const planningCounters = store.takeCounters();
const warmPlannedAt = performance.now();
const warmManifest = await query.taskManifest("bench_workunits");
const warmWorkUnits = [];
for (const task of warmManifest.tasks) {
  warmWorkUnits.push(
    ...(await planParquetTaskWorkUnits(store, task.input, {
      maxRowGroupsPerTask,
      maxRowsPerTask,
      metadataCache,
    })),
  );
}
const warmPlanningMs = performance.now() - warmPlannedAt;
const warmPlanningCounters = store.takeCounters();
if (JSON.stringify(warmWorkUnits) !== JSON.stringify(workUnits)) {
  throw new Error("warm cached planning produced different work units");
}
const totalRowGroups = datasetRowGroups(totalRows, rowsPerFile, rowGroupRows);
const plannedRowGroups = taskRowGroupCount(workUnits);
const prunedRowGroups = totalRowGroups - plannedRowGroups;
const maxRowsPerFanOutWave = rowGroupRows * maxConcurrentTasks;
const transportedWorkUnits = transportWorkUnits(workUnits);
const boundaryStats = {
  workUnits: transportedWorkUnits.length,
  partials: 0,
};

if (maxPlannedRowGroups !== undefined && plannedRowGroups > maxPlannedRowGroups) {
  throw new Error(
    `planned row groups exceeded LAKEQL_WORKUNIT_MAX_PLANNED_ROW_GROUPS: ${plannedRowGroups} > ${maxPlannedRowGroups}`,
  );
}
if (maxWorkUnits !== undefined && workUnits.length > maxWorkUnits) {
  throw new Error(
    `work units exceeded LAKEQL_WORKUNIT_MAX_WORK_UNITS: ${workUnits.length} > ${maxWorkUnits}`,
  );
}
if (maxRowsPerFanOutWaveGuard !== undefined && maxRowsPerFanOutWave > maxRowsPerFanOutWaveGuard) {
  throw new Error(
    `fan-out wave rows exceeded LAKEQL_WORKUNIT_MAX_ROWS_PER_FANOUT_WAVE: ${maxRowsPerFanOutWave} > ${maxRowsPerFanOutWaveGuard}`,
  );
}
if (planningCounters.get > 0) {
  throw new Error(`planning should use object range reads only: get=${planningCounters.get}`);
}
if (
  maxPlanningBytesFetched !== undefined &&
  planningCounters.bytesFetched > maxPlanningBytesFetched
) {
  throw new Error(
    `planning bytes fetched exceeded LAKEQL_WORKUNIT_MAX_PLANNING_BYTES: ${planningCounters.bytesFetched} > ${maxPlanningBytesFetched}`,
  );
}
if (
  maxPlanningRangeRequests !== undefined &&
  planningCounters.getRange > maxPlanningRangeRequests
) {
  throw new Error(
    `planning range requests exceeded LAKEQL_WORKUNIT_MAX_PLANNING_RANGES: ${planningCounters.getRange} > ${maxPlanningRangeRequests}`,
  );
}
if (warmPlanningCounters.get > 0 || warmPlanningCounters.getRange > 0) {
  throw new Error(
    `warm planning should use cached metadata without object reads: get=${warmPlanningCounters.get}, getRange=${warmPlanningCounters.getRange}`,
  );
}

let materialized;
let materializedCounters = newStoreCounters();
if (compareMaterialized) {
  const queryRun = query.run();
  materialized = await timed(() => queryRun.toArray());
  materializedCounters = store.takeCounters();
}
const fanOut = await timed(async () => {
  const stats = queryStats("bench-workunits-fanout");
  const aggregateSpec = {
    rows: { op: "count" },
    totalMetric: { op: "sum", column: "metric" },
    maxMetric: { op: "max", column: "metric" },
    buckets: { op: "count_distinct", column: "bucket" },
  };
  const aggregate = await aggregateParquetTasks(store, transportedWorkUnits, aggregateSpec, {
    batchSize: rowGroupRows,
    maxConcurrentTasks,
    metadataCache,
    preserveTaskBoundaries,
    stats,
    partialBoundary(partial) {
      boundaryStats.partials += 1;
      return jsonWorkUnitBoundary(partial);
    },
  });
  return { rows: aggregate.rows, aggregate, stats };
});
const fanOutCounters = store.takeCounters();

if (fanOut.value.stats.cacheHits === 0 || fanOut.value.stats.cacheMisses > 0) {
  throw new Error(
    `fan-out should use warm cached metadata: hits=${fanOut.value.stats.cacheHits}, misses=${fanOut.value.stats.cacheMisses}`,
  );
}
if (maxRssBytes !== undefined && fanOut.peakMemoryBytes > maxRssBytes) {
  throw new Error(
    `fan-out RSS exceeded LAKEQL_WORKUNIT_MAX_RSS_MB: ${formatBytes(
      fanOut.peakMemoryBytes,
    )} > ${formatBytes(maxRssBytes)}`,
  );
}
if (maxFanOutRssDeltaBytes !== undefined && fanOut.peakMemoryDeltaBytes > maxFanOutRssDeltaBytes) {
  throw new Error(
    `fan-out RSS delta exceeded LAKEQL_WORKUNIT_MAX_FANOUT_RSS_DELTA_MB: ${formatBytes(
      fanOut.peakMemoryDeltaBytes,
    )} > ${formatBytes(maxFanOutRssDeltaBytes)}`,
  );
}
const expected = expectedAggregate(totalRows, threshold);
if (fanOut.value.rows !== expected.rows) {
  throw new Error(
    `fan-out row count mismatch: expected ${expected.rows}, got ${fanOut.value.rows}`,
  );
}
if (fanOutCounters.getRange === 0 || fanOutCounters.get > 0) {
  throw new Error(
    `fan-out should use object range reads only: get=${fanOutCounters.get}, getRange=${fanOutCounters.getRange}`,
  );
}
if (boundaryStats.workUnits !== workUnits.length) {
  throw new Error(
    `JSON boundary work-unit count mismatch: expected ${workUnits.length}, got ${boundaryStats.workUnits}`,
  );
}
if (boundaryStats.partials !== boundaryStats.workUnits) {
  throw new Error(
    `JSON boundary partial count mismatch: expected ${boundaryStats.workUnits}, got ${boundaryStats.partials}`,
  );
}
if (maxFanOutBytesFetched !== undefined && fanOutCounters.bytesFetched > maxFanOutBytesFetched) {
  throw new Error(
    `fan-out bytes fetched exceeded LAKEQL_WORKUNIT_MAX_FANOUT_BYTES: ${fanOutCounters.bytesFetched} > ${maxFanOutBytesFetched}`,
  );
}
if (maxFanOutRangeRequests !== undefined && fanOutCounters.getRange > maxFanOutRangeRequests) {
  throw new Error(
    `fan-out range requests exceeded LAKEQL_WORKUNIT_MAX_FANOUT_RANGES: ${fanOutCounters.getRange} > ${maxFanOutRangeRequests}`,
  );
}
if (fanOut.value.stats.rowsMatched !== expected.rows) {
  throw new Error(
    `fan-out matched row count mismatch: expected ${expected.rows}, got ${fanOut.value.stats.rowsMatched}`,
  );
}
if (fanOut.value.stats.rowGroupsRead !== plannedRowGroups) {
  throw new Error(
    `fan-out row groups read mismatch: expected ${plannedRowGroups}, got ${fanOut.value.stats.rowGroupsRead}`,
  );
}
if (
  fanOut.value.stats.rowsDecoded < fanOut.value.stats.rowsMatched ||
  fanOut.value.stats.rowsDecoded > totalRows
) {
  throw new Error(
    `fan-out decoded row count is outside expected bounds: decoded=${fanOut.value.stats.rowsDecoded}, matched=${fanOut.value.stats.rowsMatched}, total=${totalRows}`,
  );
}
if (maxFanOutRowsDecoded !== undefined && fanOut.value.stats.rowsDecoded > maxFanOutRowsDecoded) {
  throw new Error(
    `fan-out decoded rows exceeded LAKEQL_WORKUNIT_MAX_ROWS_DECODED: ${fanOut.value.stats.rowsDecoded} > ${maxFanOutRowsDecoded}`,
  );
}
if (
  fanOut.value.aggregate.rows !== expected.rows ||
  fanOut.value.aggregate.totalMetric !== expected.totalMetric ||
  fanOut.value.aggregate.maxMetric !== expected.maxMetric ||
  fanOut.value.aggregate.buckets !== expected.buckets
) {
  throw new Error(
    `fan-out aggregate mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
      fanOut.value.aggregate,
    )}`,
  );
}
const numericBoundaryStats = {
  partials: 0,
};
const numericFanOut = await timed(async () => {
  const stats = queryStats("bench-workunits-fanout-numeric");
  const aggregateSpec = {
    rows: { op: "count" },
    totalMetric: { op: "sum", column: "metric" },
    maxMetric: { op: "max", column: "metric" },
  };
  const aggregate = await aggregateParquetTasks(store, transportedWorkUnits, aggregateSpec, {
    batchSize: rowGroupRows,
    maxConcurrentTasks,
    metadataCache,
    preserveTaskBoundaries,
    stats,
    partialBoundary(partial) {
      numericBoundaryStats.partials += 1;
      return jsonWorkUnitBoundary(partial);
    },
  });
  return { rows: aggregate.rows, aggregate, stats };
});
const numericFanOutCounters = store.takeCounters();
if (
  numericFanOut.value.aggregate.rows !== expected.rows ||
  numericFanOut.value.aggregate.totalMetric !== expected.totalMetric ||
  numericFanOut.value.aggregate.maxMetric !== expected.maxMetric
) {
  throw new Error(
    `numeric fan-out aggregate mismatch: expected ${JSON.stringify({
      rows: expected.rows,
      totalMetric: expected.totalMetric,
      maxMetric: expected.maxMetric,
    })}, got ${JSON.stringify(numericFanOut.value.aggregate)}`,
  );
}
if (numericFanOut.value.stats.cacheHits === 0 || numericFanOut.value.stats.cacheMisses > 0) {
  throw new Error(
    `numeric fan-out should use warm cached metadata: hits=${numericFanOut.value.stats.cacheHits}, misses=${numericFanOut.value.stats.cacheMisses}`,
  );
}
if (numericBoundaryStats.partials !== workUnits.length) {
  throw new Error(
    `numeric JSON boundary partial count mismatch: expected ${workUnits.length}, got ${numericBoundaryStats.partials}`,
  );
}
const distinctBoundaryStats = {
  partials: 0,
};
const distinctFanOut = await timed(async () => {
  const stats = queryStats("bench-workunits-fanout-distinct");
  const aggregateSpec = {
    buckets: { op: "count_distinct", column: "bucket" },
  };
  const aggregate = await aggregateParquetTasks(store, transportedWorkUnits, aggregateSpec, {
    batchSize: rowGroupRows,
    maxConcurrentTasks,
    metadataCache,
    preserveTaskBoundaries,
    stats,
    partialBoundary(partial) {
      distinctBoundaryStats.partials += 1;
      return jsonWorkUnitBoundary(partial);
    },
  });
  return { aggregate, stats };
});
const distinctFanOutCounters = store.takeCounters();
if (distinctFanOut.value.aggregate.buckets !== expected.buckets) {
  throw new Error(
    `distinct fan-out aggregate mismatch: expected buckets=${expected.buckets}, got ${JSON.stringify(
      distinctFanOut.value.aggregate,
    )}`,
  );
}
if (distinctFanOut.value.stats.rowsMatched !== expected.rows) {
  throw new Error(
    `distinct fan-out matched row count mismatch: expected ${expected.rows}, got ${distinctFanOut.value.stats.rowsMatched}`,
  );
}
if (distinctFanOut.value.stats.cacheHits === 0 || distinctFanOut.value.stats.cacheMisses > 0) {
  throw new Error(
    `distinct fan-out should use warm cached metadata: hits=${distinctFanOut.value.stats.cacheHits}, misses=${distinctFanOut.value.stats.cacheMisses}`,
  );
}
if (distinctBoundaryStats.partials !== workUnits.length) {
  throw new Error(
    `distinct JSON boundary partial count mismatch: expected ${workUnits.length}, got ${distinctBoundaryStats.partials}`,
  );
}
if (materialized !== undefined) {
  const materializedExpected = aggregateRows(materialized.value);
  if (JSON.stringify(materializedExpected) !== JSON.stringify(expected)) {
    throw new Error(
      `materialized comparison mismatch: expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(materializedExpected)}`,
    );
  }
}
const duckDb = compareDuckDb
  ? await runDuckDbComparison({
      generatedRoot,
      threshold,
      expected,
      iterations: duckDbIterations,
      warmup: duckDbWarmup,
    })
  : undefined;

const report = {
  totalRows,
  files: files.length,
  rowsPerFile,
  rowGroupRows,
  selectedTailRows,
  totalRowGroups,
  plannedRowGroups,
  prunedRowGroups,
  plannedFileTasks: manifest.tasks.length,
  workUnits: workUnits.length,
  preserveTaskBoundaries,
  jsonBoundaryWorkUnits: boundaryStats.workUnits,
  jsonBoundaryPartials: boundaryStats.partials,
  numericJsonBoundaryPartials: numericBoundaryStats.partials,
  distinctJsonBoundaryPartials: distinctBoundaryStats.partials,
  maxRowGroupsPerTask,
  maxRowsPerTask,
  maxConcurrentTasks,
  maxRowsPerFanOutWave,
  compareMaterialized,
  queryRows: expected.rows,
  fanOutAggregate: fanOut.value.aggregate,
  fanOutStats: fanOut.value.stats,
  numericFanOutAggregate: numericFanOut.value.aggregate,
  numericFanOutStats: numericFanOut.value.stats,
  distinctFanOutAggregate: distinctFanOut.value.aggregate,
  distinctFanOutStats: distinctFanOut.value.stats,
  planningMs,
  warmPlanningMs,
  materializedMs: materialized?.ms,
  fanOutAggregateMs: fanOut.ms,
  numericFanOutAggregateMs: numericFanOut.ms,
  distinctFanOutAggregateMs: distinctFanOut.ms,
  duckDb,
  materializedPeakRssBytes: materialized?.peakMemoryBytes,
  materializedPeakRssDeltaBytes: materialized?.peakMemoryDeltaBytes,
  fanOutPeakRssBytes: fanOut.peakMemoryBytes,
  fanOutPeakRssDeltaBytes: fanOut.peakMemoryDeltaBytes,
  maxRssBytes,
  maxFanOutRssDeltaBytes,
  maxFanOutBytesFetched,
  maxFanOutRangeRequests,
  maxPlanningBytesFetched,
  maxPlanningRangeRequests,
  maxFanOutRowsDecoded,
  maxPlannedRowGroups,
  maxWorkUnits,
  maxRowsPerFanOutWaveGuard,
  planningCounters,
  warmPlanningCounters,
  materializedCounters,
  fanOutCounters,
  numericFanOutCounters,
  distinctFanOutCounters,
};

await writeFile(reportPath, renderReport(report));
console.log(renderConsole(report));
console.log(`wrote ${relative(repoRoot, reportPath)}`);

async function ensureDataset(store) {
  const files = [];
  for (let start = 0, ordinal = 0; start < totalRows; start += rowsPerFile, ordinal += 1) {
    const rows = Math.min(rowsPerFile, totalRows - start);
    const path = `parts/part-${String(ordinal).padStart(5, "0")}.parquet`;
    files.push(path);
    if (!regenerate && (await store.head(path)) !== null) continue;
    await writeParquet(store, path, {
      rowGroupSize: [rowGroupRows],
      columnData: [
        { name: "id", type: "INT32", data: range(rows, (index) => start + index) },
        { name: "metric", type: "INT32", data: range(rows, (index) => start + index) },
        { name: "amount", type: "DOUBLE", data: range(rows, (index) => (start + index) * 1.25) },
        {
          name: "bucket",
          type: "STRING",
          data: range(rows, (index) => `b${(start + index) % 16}`),
        },
      ],
    });
  }
  return files;
}

async function resetGeneratedDatasetIfConfigChanged(config) {
  const previous = await readDatasetConfig();
  if (previous === undefined || JSON.stringify(previous) === JSON.stringify(config)) return;
  await rm(generatedRoot, { recursive: true, force: true });
  await mkdir(generatedRoot, { recursive: true });
}

async function readDatasetConfig() {
  try {
    return JSON.parse(await readFile(datasetConfigPath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeDatasetConfig(config) {
  await writeFile(datasetConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function datasetConfigPath() {
  return join(generatedRoot, "dataset-config.json");
}

function range(length, value) {
  return Array.from({ length }, (_, index) => value(index));
}

function expectedAggregate(totalRows, threshold) {
  const first = Math.min(Math.max(0, threshold), totalRows);
  const rows = Math.max(0, totalRows - first);
  return {
    rows,
    totalMetric: arithmeticSeriesSum(first, totalRows - 1),
    maxMetric: rows === 0 ? null : totalRows - 1,
    buckets: rows === 0 ? 0 : Math.min(16, rows),
  };
}

function arithmeticSeriesSum(first, last) {
  if (last < first) return 0;
  return ((first + last) * (last - first + 1)) / 2;
}

function aggregateRows(rows) {
  return {
    rows: rows.length,
    totalMetric: rows.reduce((sum, row) => sum + row.metric, 0),
    maxMetric: rows.length === 0 ? null : Math.max(...rows.map((row) => row.metric)),
    buckets: new Set(rows.map((row) => row.bucket)).size,
  };
}

function datasetRowGroups(totalRows, rowsPerFile, rowGroupRows) {
  let groups = 0;
  for (let start = 0; start < totalRows; start += rowsPerFile) {
    const rows = Math.min(rowsPerFile, totalRows - start);
    groups += Math.ceil(rows / rowGroupRows);
  }
  return groups;
}

function taskRowGroupCount(tasks) {
  let groups = 0;
  for (const task of tasks) {
    for (const range of task.rowGroupRanges) {
      groups += Math.max(0, range.end - range.start);
    }
  }
  return groups;
}

function transportWorkUnits(workUnits) {
  const transported = jsonWorkUnitBoundary(workUnits);
  if (JSON.stringify(transported) !== JSON.stringify(workUnits)) {
    throw new Error("JSON boundary changed planned work-unit payloads");
  }
  return transported;
}

async function runDuckDbComparison({ generatedRoot, threshold, expected, iterations, warmup }) {
  const { DuckDBConnection } = await import("@duckdb/node-api");
  const partsRoot = join(generatedRoot, "parts");
  const files = (await readdir(partsRoot)).filter((file) => file.endsWith(".parquet")).sort();
  let parquetBytes = 0;
  for (const file of files) parquetBytes += (await stat(join(partsRoot, file))).size;
  const fromWhere = [
    `from read_parquet('${sqlString(`${partsRoot}/*.parquet`)}')`,
    `where metric >= ${threshold}`,
  ].join(" ");
  const fullSql = [
    "select",
    "count(*) as rows,",
    "sum(metric) as totalMetric,",
    "max(metric) as maxMetric,",
    "count(distinct bucket) as buckets",
    fromWhere,
  ].join(" ");
  const numericSql = [
    "select",
    "count(*) as rows,",
    "sum(metric) as totalMetric,",
    "max(metric) as maxMetric",
    fromWhere,
  ].join(" ");
  const distinctSql = ["select", "count(distinct bucket) as buckets", fromWhere].join(" ");
  const duckdb = await DuckDBConnection.create();
  const first = await timedDuckDb(duckdb, fullSql);
  assertDuckDbAggregate(first.rows[0], expected);
  for (let index = 0; index < warmup; index += 1) {
    assertDuckDbAggregate((await timedDuckDb(duckdb, fullSql)).rows[0], expected);
    assertDuckDbNumericAggregate((await timedDuckDb(duckdb, numericSql)).rows[0], expected);
    assertDuckDbDistinctAggregate((await timedDuckDb(duckdb, distinctSql)).rows[0], expected);
  }
  const full = await timeDuckDbLane(duckdb, fullSql, iterations, (row) =>
    assertDuckDbAggregate(row, expected),
  );
  const numeric = await timeDuckDbLane(duckdb, numericSql, iterations, (row) =>
    assertDuckDbNumericAggregate(row, expected),
  );
  const distinct = await timeDuckDbLane(duckdb, distinctSql, iterations, (row) =>
    assertDuckDbDistinctAggregate(row, expected),
  );
  return {
    files: files.length,
    parquetBytes,
    firstMs: first.ms,
    medianMs: full.medianMs,
    p95Ms: full.p95Ms,
    minMs: full.minMs,
    maxMs: full.maxMs,
    peakRssBytes: full.peakRssBytes,
    numericMedianMs: numeric.medianMs,
    numericP95Ms: numeric.p95Ms,
    numericMinMs: numeric.minMs,
    numericMaxMs: numeric.maxMs,
    distinctMedianMs: distinct.medianMs,
    distinctP95Ms: distinct.p95Ms,
    distinctMinMs: distinct.minMs,
    distinctMaxMs: distinct.maxMs,
  };
}

async function timeDuckDbLane(duckdb, sql, iterations, assertRow) {
  const samples = [];
  const rssSamples = [];
  for (let index = 0; index < iterations; index += 1) {
    const result = await timedDuckDb(duckdb, sql);
    assertRow(result.rows[0]);
    samples.push(result.ms);
    rssSamples.push(result.peakMemoryBytes);
  }
  return summarizeSamples(samples, rssSamples);
}

async function timedDuckDb(duckdb, sql) {
  const result = await timed(async () => {
    const reader = await duckdb.runAndReadAll(sql);
    return reader.getRowObjectsJson();
  });
  return {
    rows: result.value,
    ms: result.ms,
    peakMemoryBytes: result.peakMemoryBytes,
  };
}

function assertDuckDbAggregate(row, expected) {
  const actual = {
    rows: Number(row?.rows),
    totalMetric: Number(row?.totalMetric),
    maxMetric: row?.maxMetric ?? null,
    buckets: Number(row?.buckets),
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `DuckDB aggregate mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual,
      )}`,
    );
  }
}

function assertDuckDbNumericAggregate(row, expected) {
  const actual = {
    rows: Number(row?.rows),
    totalMetric: Number(row?.totalMetric),
    maxMetric: row?.maxMetric ?? null,
  };
  const expectedNumeric = {
    rows: expected.rows,
    totalMetric: expected.totalMetric,
    maxMetric: expected.maxMetric,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expectedNumeric)) {
    throw new Error(
      `DuckDB numeric aggregate mismatch: expected ${JSON.stringify(
        expectedNumeric,
      )}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDuckDbDistinctAggregate(row, expected) {
  const actual = {
    buckets: Number(row?.buckets),
  };
  const expectedDistinct = {
    buckets: expected.buckets,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expectedDistinct)) {
    throw new Error(
      `DuckDB distinct aggregate mismatch: expected ${JSON.stringify(
        expectedDistinct,
      )}, got ${JSON.stringify(actual)}`,
    );
  }
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function renderConsole(report) {
  return [
    `rows=${report.totalRows}`,
    `files=${report.files}`,
    `total_row_groups=${report.totalRowGroups}`,
    `planned_row_groups=${report.plannedRowGroups}`,
    `pruned_row_groups=${report.prunedRowGroups}`,
    `planned_file_tasks=${report.plannedFileTasks}`,
    `work_units=${report.workUnits}`,
    `preserve_task_boundaries=${report.preserveTaskBoundaries}`,
    `json_boundary_work_units=${report.jsonBoundaryWorkUnits}`,
    `json_boundary_partials=${report.jsonBoundaryPartials}`,
    `numeric_json_boundary_partials=${report.numericJsonBoundaryPartials}`,
    `distinct_json_boundary_partials=${report.distinctJsonBoundaryPartials}`,
    `max_row_groups_per_task=${report.maxRowGroupsPerTask}`,
    `max_rows_per_task=${report.maxRowsPerTask ?? "not set"}`,
    `max_concurrent_tasks=${report.maxConcurrentTasks}`,
    `max_rows_per_fanout_wave=${report.maxRowsPerFanOutWave}`,
    `compare_materialized=${report.compareMaterialized}`,
    `query_rows=${report.queryRows}`,
    `fanout_total_metric=${report.fanOutAggregate.totalMetric}`,
    `fanout_max_metric=${report.fanOutAggregate.maxMetric}`,
    `fanout_buckets=${report.fanOutAggregate.buckets}`,
    `fanout_rows_decoded=${report.fanOutStats.rowsDecoded}`,
    `fanout_rows_matched=${report.fanOutStats.rowsMatched}`,
    `fanout_row_groups_read=${report.fanOutStats.rowGroupsRead}`,
    `fanout_row_groups_skipped=${report.fanOutStats.rowGroupsSkipped}`,
    `fanout_metadata_cache_hits=${report.fanOutStats.cacheHits}`,
    `fanout_metadata_cache_misses=${report.fanOutStats.cacheMisses}`,
    `numeric_fanout_rows_decoded=${report.numericFanOutStats.rowsDecoded}`,
    `numeric_fanout_rows_matched=${report.numericFanOutStats.rowsMatched}`,
    `numeric_fanout_metadata_cache_hits=${report.numericFanOutStats.cacheHits}`,
    `numeric_fanout_metadata_cache_misses=${report.numericFanOutStats.cacheMisses}`,
    `distinct_fanout_buckets=${report.distinctFanOutAggregate.buckets}`,
    `distinct_fanout_rows_decoded=${report.distinctFanOutStats.rowsDecoded}`,
    `distinct_fanout_rows_matched=${report.distinctFanOutStats.rowsMatched}`,
    `distinct_fanout_metadata_cache_hits=${report.distinctFanOutStats.cacheHits}`,
    `distinct_fanout_metadata_cache_misses=${report.distinctFanOutStats.cacheMisses}`,
    `planning_ms=${report.planningMs.toFixed(1)}`,
    `warm_planning_ms=${report.warmPlanningMs.toFixed(1)}`,
    `materialized_ms=${formatOptionalMs(report.materializedMs)}`,
    `fanout_aggregate_ms=${report.fanOutAggregateMs.toFixed(1)}`,
    `numeric_fanout_aggregate_ms=${report.numericFanOutAggregateMs.toFixed(1)}`,
    `distinct_fanout_aggregate_ms=${report.distinctFanOutAggregateMs.toFixed(1)}`,
    `duckdb_first_ms=${formatOptionalMs(report.duckDb?.firstMs)}`,
    `duckdb_warm_median_ms=${formatOptionalMs(report.duckDb?.medianMs)}`,
    `duckdb_warm_p95_ms=${formatOptionalMs(report.duckDb?.p95Ms)}`,
    `duckdb_numeric_warm_median_ms=${formatOptionalMs(report.duckDb?.numericMedianMs)}`,
    `duckdb_numeric_warm_p95_ms=${formatOptionalMs(report.duckDb?.numericP95Ms)}`,
    `duckdb_distinct_warm_median_ms=${formatOptionalMs(report.duckDb?.distinctMedianMs)}`,
    `duckdb_distinct_warm_p95_ms=${formatOptionalMs(report.duckDb?.distinctP95Ms)}`,
    `duckdb_lakeql_fanout_ratio=${
      report.duckDb === undefined
        ? "not run"
        : (report.fanOutAggregateMs / report.duckDb.medianMs).toFixed(2)
    }`,
    `duckdb_lakeql_numeric_fanout_ratio=${
      report.duckDb === undefined
        ? "not run"
        : (report.numericFanOutAggregateMs / report.duckDb.numericMedianMs).toFixed(2)
    }`,
    `duckdb_lakeql_distinct_fanout_ratio=${
      report.duckDb === undefined
        ? "not run"
        : (report.distinctFanOutAggregateMs / report.duckDb.distinctMedianMs).toFixed(2)
    }`,
    `duckdb_lakeql_end_to_end_ratio=${
      report.duckDb === undefined
        ? "not run"
        : ((report.planningMs + report.fanOutAggregateMs) / report.duckDb.medianMs).toFixed(2)
    }`,
    `duckdb_lakeql_warm_planning_end_to_end_ratio=${
      report.duckDb === undefined
        ? "not run"
        : ((report.warmPlanningMs + report.fanOutAggregateMs) / report.duckDb.medianMs).toFixed(2)
    }`,
    `materialized_peak_rss=${formatOptionalBytes(report.materializedPeakRssBytes)}`,
    `materialized_peak_rss_delta=${formatOptionalBytes(report.materializedPeakRssDeltaBytes)}`,
    `fanout_peak_rss=${formatBytes(report.fanOutPeakRssBytes)}`,
    `fanout_peak_rss_delta=${formatBytes(report.fanOutPeakRssDeltaBytes)}`,
    `max_rss=${report.maxRssBytes === undefined ? "not set" : formatBytes(report.maxRssBytes)}`,
    `max_fanout_rss_delta=${
      report.maxFanOutRssDeltaBytes === undefined
        ? "not set"
        : formatBytes(report.maxFanOutRssDeltaBytes)
    }`,
    `max_fanout_bytes=${report.maxFanOutBytesFetched ?? "not set"}`,
    `max_fanout_ranges=${report.maxFanOutRangeRequests ?? "not set"}`,
    `max_planning_bytes=${report.maxPlanningBytesFetched ?? "not set"}`,
    `max_planning_ranges=${report.maxPlanningRangeRequests ?? "not set"}`,
    `max_fanout_rows_decoded=${report.maxFanOutRowsDecoded ?? "not set"}`,
    `max_planned_row_groups=${report.maxPlannedRowGroups ?? "not set"}`,
    `max_work_units=${report.maxWorkUnits ?? "not set"}`,
    `max_rows_per_fanout_wave_guard=${report.maxRowsPerFanOutWaveGuard ?? "not set"}`,
    `planning_store_full_gets=${report.planningCounters.get}`,
    `warm_planning_store_range_requests=${report.warmPlanningCounters.getRange}`,
    `warm_planning_store_full_gets=${report.warmPlanningCounters.get}`,
    `warm_planning_store_bytes_fetched=${report.warmPlanningCounters.bytesFetched}`,
    `fanout_store_range_requests=${report.fanOutCounters.getRange}`,
    `fanout_store_full_gets=${report.fanOutCounters.get}`,
    `fanout_store_bytes_fetched=${report.fanOutCounters.bytesFetched}`,
    `numeric_fanout_store_range_requests=${report.numericFanOutCounters.getRange}`,
    `numeric_fanout_store_full_gets=${report.numericFanOutCounters.get}`,
    `numeric_fanout_store_bytes_fetched=${report.numericFanOutCounters.bytesFetched}`,
    `distinct_fanout_store_range_requests=${report.distinctFanOutCounters.getRange}`,
    `distinct_fanout_store_full_gets=${report.distinctFanOutCounters.get}`,
    `distinct_fanout_store_bytes_fetched=${report.distinctFanOutCounters.bytesFetched}`,
  ].join("\n");
}

function renderReport(report) {
  return `# Work Unit Benchmark

Generated Parquet workload for validating bounded, deployment-agnostic work units.
The fan-out path range-reads only planned Parquet row groups, aggregates vector batches without
materializing result rows, and keeps the active row budget bounded by:

\`row-group rows (${report.rowGroupRows}) * max concurrent tasks (${
    report.maxConcurrentTasks
  }) = ${report.maxRowsPerFanOutWave} rows per fan-out wave\`.

The benchmark also warms shared planning and Parquet metadata caches after cold
planning. That proves repeated planning can avoid object re-listing/re-heading,
and aggregate fan-out can avoid footer rereads, without putting cache state into
the portable JSON work-unit payloads.

The numeric fan-out lane runs the same work-unit transport with only
\`count(*)\`, \`sum(metric)\`, and \`max(metric)\`. It isolates numeric vector
aggregation from the full lane's string \`count_distinct(bucket)\` cost.

The distinct fan-out lane runs only \`count_distinct(bucket)\` over the same
work units. It isolates bucket decode and distinct hashing from numeric
aggregate work.

For the explicit 10M-row claim, run:

\`\`\`sh
pnpm bench:workunits:10m
\`\`\`

For local curiosity, \`pnpm bench:workunits:10m:duckdb\` also compares the same
query against Node DuckDB's native engine. That is a CPU-optimized local baseline,
not DuckDB-WASM; browser WASM comparisons should include download/compile/init,
HTTP range behavior, and browser memory separately.

| Metric | Value |
| --- | ---: |
| rows | ${report.totalRows} |
| files | ${report.files} |
| rows per file | ${report.rowsPerFile} |
| row-group rows | ${report.rowGroupRows} |
| selected tail rows | ${report.selectedTailRows} |
| total row groups | ${report.totalRowGroups} |
| planned row groups | ${report.plannedRowGroups} |
| pruned row groups | ${report.prunedRowGroups} |
| planned file tasks | ${report.plannedFileTasks} |
| split work units | ${report.workUnits} |
| preserve task boundaries | ${report.preserveTaskBoundaries ? "yes" : "no"} |
| JSON boundary work units | ${report.jsonBoundaryWorkUnits} |
| JSON boundary aggregate partials | ${report.jsonBoundaryPartials} |
| numeric JSON boundary aggregate partials | ${report.numericJsonBoundaryPartials} |
| distinct JSON boundary aggregate partials | ${report.distinctJsonBoundaryPartials} |
| max row groups per task | ${report.maxRowGroupsPerTask} |
| max rows per task | ${report.maxRowsPerTask ?? "not set"} |
| max concurrent tasks | ${report.maxConcurrentTasks} |
| max rows per fan-out wave | ${report.maxRowsPerFanOutWave} |
| compare materialized query | ${report.compareMaterialized ? "yes" : "no"} |
| query rows | ${report.queryRows} |
| fan-out total metric | ${report.fanOutAggregate.totalMetric} |
| fan-out max metric | ${report.fanOutAggregate.maxMetric} |
| fan-out buckets | ${report.fanOutAggregate.buckets} |
| fan-out rows decoded | ${report.fanOutStats.rowsDecoded} |
| fan-out rows matched | ${report.fanOutStats.rowsMatched} |
| fan-out row groups read | ${report.fanOutStats.rowGroupsRead} |
| fan-out row groups skipped | ${report.fanOutStats.rowGroupsSkipped} |
| fan-out metadata cache hits | ${report.fanOutStats.cacheHits} |
| fan-out metadata cache misses | ${report.fanOutStats.cacheMisses} |
| numeric fan-out rows decoded | ${report.numericFanOutStats.rowsDecoded} |
| numeric fan-out rows matched | ${report.numericFanOutStats.rowsMatched} |
| numeric fan-out metadata cache hits | ${report.numericFanOutStats.cacheHits} |
| numeric fan-out metadata cache misses | ${report.numericFanOutStats.cacheMisses} |
| distinct fan-out buckets | ${report.distinctFanOutAggregate.buckets} |
| distinct fan-out rows decoded | ${report.distinctFanOutStats.rowsDecoded} |
| distinct fan-out rows matched | ${report.distinctFanOutStats.rowsMatched} |
| distinct fan-out metadata cache hits | ${report.distinctFanOutStats.cacheHits} |
| distinct fan-out metadata cache misses | ${report.distinctFanOutStats.cacheMisses} |
| planning ms | ${report.planningMs.toFixed(1)} |
| warm cached planning ms | ${report.warmPlanningMs.toFixed(1)} |
| materialized query ms | ${formatOptionalMs(report.materializedMs)} |
| fan-out aggregate ms | ${report.fanOutAggregateMs.toFixed(1)} |
| numeric fan-out aggregate ms | ${report.numericFanOutAggregateMs.toFixed(1)} |
| distinct fan-out aggregate ms | ${report.distinctFanOutAggregateMs.toFixed(1)} |
| DuckDB first query ms | ${formatOptionalMs(report.duckDb?.firstMs)} |
| DuckDB warm median ms | ${formatOptionalMs(report.duckDb?.medianMs)} |
| DuckDB warm p95 ms | ${formatOptionalMs(report.duckDb?.p95Ms)} |
| DuckDB numeric warm median ms | ${formatOptionalMs(report.duckDb?.numericMedianMs)} |
| DuckDB numeric warm p95 ms | ${formatOptionalMs(report.duckDb?.numericP95Ms)} |
| DuckDB distinct warm median ms | ${formatOptionalMs(report.duckDb?.distinctMedianMs)} |
| DuckDB distinct warm p95 ms | ${formatOptionalMs(report.duckDb?.distinctP95Ms)} |
| lakeql fan-out / DuckDB warm median | ${
    report.duckDb === undefined
      ? "not run"
      : `${(report.fanOutAggregateMs / report.duckDb.medianMs).toFixed(2)}x`
  } |
| lakeql numeric fan-out / DuckDB warm median | ${
    report.duckDb === undefined
      ? "not run"
      : `${(report.numericFanOutAggregateMs / report.duckDb.numericMedianMs).toFixed(2)}x`
  } |
| lakeql distinct fan-out / DuckDB warm median | ${
    report.duckDb === undefined
      ? "not run"
      : `${(report.distinctFanOutAggregateMs / report.duckDb.distinctMedianMs).toFixed(2)}x`
  } |
| lakeql planning + fan-out / DuckDB warm median | ${
    report.duckDb === undefined
      ? "not run"
      : `${((report.planningMs + report.fanOutAggregateMs) / report.duckDb.medianMs).toFixed(2)}x`
  } |
| lakeql warm planning + fan-out / DuckDB warm median | ${
    report.duckDb === undefined
      ? "not run"
      : `${((report.warmPlanningMs + report.fanOutAggregateMs) / report.duckDb.medianMs).toFixed(2)}x`
  } |
| materialized peak RSS | ${formatOptionalBytes(report.materializedPeakRssBytes)} |
| materialized peak RSS delta | ${formatOptionalBytes(report.materializedPeakRssDeltaBytes)} |
| fan-out peak RSS | ${formatBytes(report.fanOutPeakRssBytes)} |
| fan-out peak RSS delta | ${formatBytes(report.fanOutPeakRssDeltaBytes)} |
| max RSS guard | ${report.maxRssBytes === undefined ? "not set" : formatBytes(report.maxRssBytes)} |
| max fan-out RSS delta guard | ${
    report.maxFanOutRssDeltaBytes === undefined
      ? "not set"
      : formatBytes(report.maxFanOutRssDeltaBytes)
  } |
| max fan-out bytes guard | ${report.maxFanOutBytesFetched ?? "not set"} |
| max fan-out range requests guard | ${report.maxFanOutRangeRequests ?? "not set"} |
| max planning bytes guard | ${report.maxPlanningBytesFetched ?? "not set"} |
| max planning range requests guard | ${report.maxPlanningRangeRequests ?? "not set"} |
| max fan-out decoded rows guard | ${report.maxFanOutRowsDecoded ?? "not set"} |
| max planned row groups guard | ${report.maxPlannedRowGroups ?? "not set"} |
| max work units guard | ${report.maxWorkUnits ?? "not set"} |
| max rows per fan-out wave guard | ${report.maxRowsPerFanOutWaveGuard ?? "not set"} |
| planning store range requests | ${report.planningCounters.getRange} |
| planning store full gets | ${report.planningCounters.get} |
| planning store list calls | ${report.planningCounters.list} |
| planning store head calls | ${report.planningCounters.head} |
| planning store bytes fetched | ${report.planningCounters.bytesFetched} |
| warm planning store range requests | ${report.warmPlanningCounters.getRange} |
| warm planning store full gets | ${report.warmPlanningCounters.get} |
| warm planning store list calls | ${report.warmPlanningCounters.list} |
| warm planning store head calls | ${report.warmPlanningCounters.head} |
| warm planning store bytes fetched | ${report.warmPlanningCounters.bytesFetched} |
| materialized store range requests | ${report.materializedCounters.getRange} |
| materialized store bytes fetched | ${report.materializedCounters.bytesFetched} |
| fan-out store range requests | ${report.fanOutCounters.getRange} |
| fan-out store full gets | ${report.fanOutCounters.get} |
| fan-out store bytes fetched | ${report.fanOutCounters.bytesFetched} |
| numeric fan-out store range requests | ${report.numericFanOutCounters.getRange} |
| numeric fan-out store full gets | ${report.numericFanOutCounters.get} |
| numeric fan-out store bytes fetched | ${report.numericFanOutCounters.bytesFetched} |
| distinct fan-out store range requests | ${report.distinctFanOutCounters.getRange} |
| distinct fan-out store full gets | ${report.distinctFanOutCounters.get} |
| distinct fan-out store bytes fetched | ${report.distinctFanOutCounters.bytesFetched} |
`;
}
