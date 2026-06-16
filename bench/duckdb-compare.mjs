import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBConnection } from "@duckdb/node-api";
import { evaluate, memoryStore } from "../packages/core/dist/index.js";
import { createParquetLake } from "../packages/parquet/dist/index.js";
import { parseSql } from "../packages/sql/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(repoRoot, "fixtures/data");
const reportPath = join(repoRoot, "bench/DUCKDB.md");

const cases = [
  {
    name: "filtered ordered scan",
    fixture: "sales.parquet",
    lakeql:
      "select store_id, region, amount from input where region = 'west' order by amount asc limit 5",
    duckdb: (path) =>
      `select store_id, region, amount from read_parquet('${sqlString(path)}') where region = 'west' order by amount asc limit 5`,
  },
  {
    name: "computed projection",
    fixture: "sales.parquet",
    lakeql:
      "select store_id, amount * 2 as doubled, case when amount > 10 then 'large' else 'small' end as bucket from input where amount < 20 order by amount asc limit 2",
    duckdb: (path) =>
      `select store_id, amount * 2 as doubled, case when amount > 10 then 'large' else 'small' end as bucket from read_parquet('${sqlString(path)}') where amount < 20 order by amount asc limit 2`,
  },
  {
    name: "row-group pruning",
    fixture: "stats.parquet",
    lakeql: "select id, metric from input where metric > 199 order by id asc",
    duckdb: (path) =>
      `select id, metric from read_parquet('${sqlString(path)}') where metric > 199 order by id asc`,
  },
  {
    name: "global aggregate",
    fixture: "sales.parquet",
    lakeql: "select count(*) as rows, max(amount) as max_amount from input",
    duckdb: (path) =>
      `select count(*) as rows, max(amount) as max_amount from read_parquet('${sqlString(path)}')`,
  },
  {
    name: "grouped aggregate",
    fixture: "sales.parquet",
    lakeql:
      "select region, count(*) as rows, max(amount) as max_amount from input group by region order by region asc",
    duckdb: (path) =>
      `select region, count(*) as rows, max(amount) as max_amount from read_parquet('${sqlString(path)}') group by region order by region asc`,
  },
  {
    name: "grouped expression aggregate",
    fixture: "sales.parquet",
    lakeql:
      "select region, max(amount * 2) as max_doubled, count(distinct store_id) as stores from input group by region order by region asc",
    duckdb: (path) =>
      `select region, max(amount * 2) as max_doubled, count(distinct store_id) as stores from read_parquet('${sqlString(path)}') group by region order by region asc`,
  },
];

const iterations = Number(process.env.LAKEQL_BENCH_ITERATIONS ?? 5);
const warmup = Number(process.env.LAKEQL_BENCH_WARMUP ?? 1);

const duckdb = await DuckDBConnection.create();
const rows = [];
for (const testCase of cases) {
  rows.push(await compareCase(testCase));
}

await writeFile(reportPath, renderReport(rows));
console.log(renderConsole(rows));
console.log(`wrote ${reportPath}`);

async function compareCase(testCase) {
  const fixturePath = join(fixtureRoot, testCase.fixture);
  const duckdbSql = testCase.duckdb(fixturePath);

  const lakeqlRows = await runLakeql(testCase.fixture, testCase.lakeql);
  const duckdbRows = await runDuckDb(duckdbSql);
  assertSameRows(testCase.name, lakeqlRows.rows, duckdbRows);

  for (let index = 0; index < warmup; index++) {
    await runLakeql(testCase.fixture, testCase.lakeql);
    await runDuckDb(duckdbSql);
  }

  const lakeqlSamples = [];
  const duckdbSamples = [];
  let lastLakeql = lakeqlRows;
  for (let index = 0; index < iterations; index++) {
    lastLakeql = await timed(() => runLakeql(testCase.fixture, testCase.lakeql));
    lakeqlSamples.push(lastLakeql.ms);
    const duck = await timed(() => runDuckDb(duckdbSql));
    duckdbSamples.push(duck.ms);
  }

  const lakeqlStats = summarize(lakeqlSamples);
  const duckdbStats = summarize(duckdbSamples);
  return {
    name: testCase.name,
    rows: lakeqlRows.rows.length,
    lakeql: {
      ...lakeqlStats,
      bytes: lastLakeql.bytesFetched,
      requests: lastLakeql.objectRequests,
      rangeRequests: lastLakeql.rangeRequests,
      bytesRequested: lastLakeql.bytesRequested,
      rowsScanned: lastLakeql.rowsScanned,
      rowGroupsRead: lastLakeql.rowGroupsRead,
      rowGroupsSkipped: lastLakeql.rowGroupsSkipped,
    },
    duckdb: duckdbStats,
  };
}

async function runLakeql(fixture, sql) {
  const { store, counters } = countingStore();
  await store.put(fixture, await readFile(join(fixtureRoot, fixture)));
  counters.reset();
  const lake = createParquetLake({ store });
  const ast = { ...parseSql(sql), source: fixture };
  let rows;
  let stats;

  const aggregates =
    ast.aggregates && Object.keys(ast.aggregates).length > 0 ? ast.aggregates : undefined;
  const grouped = (ast.groupBy?.length ?? 0) > 0;

  if (aggregates || grouped) {
    let base = lake.path(fixture);
    if (ast.where) base = base.where(ast.where);
    rows = await base.groupBy(ast.groupBy ?? []).aggregate(aggregates ?? {}, {
      ...(ast.having !== undefined ? { having: ast.having } : {}),
      ...(ast.orderBy !== undefined ? { orderBy: ast.orderBy } : {}),
      ...(ast.distinct === true ? {} : ast.limit !== undefined ? { limit: ast.limit } : {}),
      ...(ast.distinct === true ? {} : ast.offset !== undefined ? { offset: ast.offset } : {}),
    });
    if (ast.distinct === true) rows = distinctRows(rows);
    const offset = ast.offset ?? 0;
    if (ast.distinct === true && ast.limit !== undefined)
      rows = rows.slice(offset, offset + ast.limit);
    else if (ast.distinct === true && offset > 0) rows = rows.slice(offset);
  } else {
    let query = lake.path(fixture);
    if (ast.projections !== undefined) query = query.select(referencedColumns(ast));
    else if (ast.select) query = query.select(ast.select);
    if (ast.where) query = query.where(ast.where);
    if (ast.orderBy) query = query.orderBy(ast.orderBy);
    if (ast.offset !== undefined) query = query.offset(ast.offset);
    if (ast.limit !== undefined) query = query.limit(ast.limit);
    const result = query.run();
    rows = await result.toArray();
    if (ast.projections !== undefined) rows = projectRows(rows, ast);
    stats = result.stats;
  }

  return {
    rows,
    bytesFetched: counters.bytesFetched,
    objectRequests: counters.totalRequests,
    rangeRequests: stats?.rangeRequests ?? counters.getRange,
    bytesRequested: stats?.bytesRequested ?? counters.bytesFetched,
    rowsScanned: stats?.rowsDecoded ?? "",
    rowGroupsRead: stats?.rowGroupsRead ?? "",
    rowGroupsSkipped: stats?.rowGroupsSkipped ?? "",
  };
}

function projectRows(rows, ast) {
  return rows.map((row) => {
    const out = {};
    for (const select of ast.select ?? []) out[select] = row[select];
    for (const [alias, expr] of Object.entries(ast.projections ?? {})) {
      out[alias] = evaluate(expr, row);
    }
    return out;
  });
}

function referencedColumns(ast) {
  const columns = new Set(ast.select ?? []);
  if (ast.where !== undefined) collectExprColumns(ast.where, columns);
  for (const expr of Object.values(ast.projections ?? {})) collectExprColumns(expr, columns);
  for (const term of ast.orderBy ?? []) columns.add(term.column);
  return [...columns].filter((column) => column !== "*");
}

function collectExprColumns(expr, columns) {
  switch (expr.kind) {
    case "column":
      columns.add(expr.name);
      return;
    case "compare":
      collectExprColumns(expr.left, columns);
      collectExprColumns(expr.right, columns);
      return;
    case "between":
      collectExprColumns(expr.target, columns);
      collectExprColumns(expr.low, columns);
      collectExprColumns(expr.high, columns);
      return;
    case "in":
      collectExprColumns(expr.target, columns);
      for (const value of expr.values) collectExprColumns(value, columns);
      return;
    case "logical":
      for (const operand of expr.operands) collectExprColumns(operand, columns);
      return;
    case "not":
      collectExprColumns(expr.operand, columns);
      return;
    case "null-check":
      collectExprColumns(expr.target, columns);
      return;
    case "like":
      collectExprColumns(expr.target, columns);
      return;
    case "call":
      for (const arg of expr.args) collectExprColumns(arg, columns);
      return;
    case "arithmetic":
      collectExprColumns(expr.left, columns);
      collectExprColumns(expr.right, columns);
      return;
    case "case":
      for (const branch of expr.whens) {
        collectExprColumns(branch.when, columns);
        collectExprColumns(branch.value, columns);
      }
      if (expr.else !== undefined) collectExprColumns(expr.else, columns);
      return;
    case "literal":
      return;
  }
}

async function runDuckDb(sql) {
  const result = await duckdb.runAndReadAll(sql);
  return result.getRowObjectsJson();
}

async function timed(fn) {
  const start = performance.now();
  const out = await fn();
  return { ...out, ms: performance.now() - start };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    minMs: sorted[0] ?? 0,
    medianMs: percentile(sorted, 0.5),
    maxMs: sorted.at(-1) ?? 0,
    meanMs: sum / Math.max(samples.length, 1),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

function countingStore() {
  const inner = memoryStore();
  const counters = {
    get: 0,
    getRange: 0,
    head: 0,
    list: 0,
    put: 0,
    delete: 0,
    bytesFetched: 0,
    get totalRequests() {
      return this.get + this.getRange + this.head + this.list + this.put + this.delete;
    },
    reset() {
      this.get = 0;
      this.getRange = 0;
      this.head = 0;
      this.list = 0;
      this.put = 0;
      this.delete = 0;
      this.bytesFetched = 0;
    },
  };
  return {
    counters,
    store: {
      async get(path) {
        counters.get += 1;
        const bytes = await inner.get(path);
        if (bytes !== null) counters.bytesFetched += bytes.byteLength;
        return bytes;
      },
      async getRange(path, range) {
        counters.getRange += 1;
        const bytes = await inner.getRange(path, range);
        counters.bytesFetched += bytes.byteLength;
        return bytes;
      },
      async put(path, body, options) {
        counters.put += 1;
        return await inner.put(path, body, options);
      },
      async delete(path) {
        counters.delete += 1;
        return await inner.delete(path);
      },
      async head(path) {
        counters.head += 1;
        return await inner.head(path);
      },
      async *list(prefix, options) {
        counters.list += 1;
        yield* inner.list(prefix, options);
      },
    },
  };
}

function distinctRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = stableStringify(normalizeRow(row));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function assertSameRows(name, lakeqlRows, duckdbRows) {
  const left = lakeqlRows.map((row) => stableStringify(normalizeRow(row)));
  const right = duckdbRows.map((row) => stableStringify(normalizeRow(row)));
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${name} result mismatch\nlakeql: ${JSON.stringify(lakeqlRows)}\nduckdb: ${JSON.stringify(duckdbRows)}`,
    );
  }
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value,
    ]),
  );
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function renderConsole(results) {
  const rows = results.map((row) => ({
    query: row.name,
    rows: row.rows,
    "lakeql median ms": row.lakeql.medianMs.toFixed(2),
    "duckdb median ms": row.duckdb.medianMs.toFixed(2),
    "lakeql requests": row.lakeql.requests,
    "lakeql bytes": row.lakeql.bytes,
  }));
  console.table(rows);
  return "";
}

function renderReport(results) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  const headers = [
    "Query",
    "Rows",
    "lakeql median ms",
    "DuckDB median ms",
    "Ratio",
    "lakeql req",
    "lakeql bytes",
    "lakeql ranges",
    "Rows scanned",
    "RG read/skipped",
  ];
  const rows = results.map((row) => [
    row.name,
    String(row.rows),
    row.lakeql.medianMs.toFixed(2),
    row.duckdb.medianMs.toFixed(2),
    ratio(row.lakeql.medianMs, row.duckdb.medianMs),
    String(row.lakeql.requests),
    String(row.lakeql.bytes),
    String(row.lakeql.rangeRequests),
    String(row.lakeql.rowsScanned),
    `${row.lakeql.rowGroupsRead}/${row.lakeql.rowGroupsSkipped}`,
  ]);
  return `# DuckDB Comparison Benchmarks

Generated by \`pnpm bench:duckdb\` on ${generatedAt}.

Each query is run against the same fixture data through lakeql and DuckDB's \`read_parquet\`.
The harness checks result parity before timing. Timings are local and machine-dependent; lakeql
request, byte, and row-group counters are the more stable regression signals.

Iterations: ${iterations}; warmup: ${warmup}.

${markdownTable(headers, rows)}
`;
}

function ratio(left, right) {
  if (right === 0) return "n/a";
  return `${(left / right).toFixed(2)}x`;
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function sqlString(value) {
  return value.replaceAll("'", "''");
}
