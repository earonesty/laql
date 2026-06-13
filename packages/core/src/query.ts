import { LaQLError } from "./errors.js";
import { encodeJsonLine, jsonSafeValue, matches } from "./evaluator.js";
import type { Expr } from "./expr.js";
import { col, eq, gt, gte, isIn, isNotNull, isNull, lt, lte, ne, notIn } from "./expr.js";
import type { ObjectInfo, ObjectStore } from "./store.js";
import type { QueryStats, Row } from "./types.js";

export interface QueryBudget {
  maxFiles?: number;
  maxBytes?: number;
  maxRowsDecoded?: number;
  maxOutputRows?: number;
  maxRangeRequests?: number;
  maxElapsedMs?: number;
}

export interface LakeConfig {
  store: ObjectStore;
  scanner: ScanAdapter;
  budget?: QueryBudget;
  now?: () => number;
  queryId?: () => string;
}

export interface ScanOptions {
  columns?: string[];
  batchSize: number;
  stats: QueryStats;
  budget: QueryBudget;
  now: () => number;
  startedAt: number;
}

export interface ScanAdapter {
  scan(path: string, options: ScanOptions): AsyncIterable<Row[]>;
}

export interface PathQueryInit {
  source: string;
  select?: string[];
  where?: Expr;
  limit?: number;
  offset?: number;
  batchSize?: number;
}

export interface JsonQueryV1 {
  version: 1;
  from: string;
  select?: string[];
  where?: JsonExpr;
  limit?: number;
  offset?: number;
}

export type JsonExpr =
  | { eq: [string, unknown] }
  | { ne: [string, unknown] }
  | { lt: [string, unknown] }
  | { lte: [string, unknown] }
  | { gt: [string, unknown] }
  | { gte: [string, unknown] }
  | { in: [string, unknown[]] }
  | { notIn: [string, unknown[]] }
  | { between: [string, unknown, unknown] }
  | { isNull: string }
  | { isNotNull: string }
  | { like: [string, string] }
  | { ilike: [string, string] }
  | { and: JsonExpr[] }
  | { or: JsonExpr[] }
  | { not: JsonExpr };

export class Lake {
  readonly store: ObjectStore;
  private readonly scanner: ScanAdapter;
  private readonly budget: QueryBudget;
  private readonly now: () => number;
  private readonly queryId: () => string;

  constructor(config: LakeConfig) {
    this.store = config.store;
    this.scanner = config.scanner;
    this.budget = config.budget ?? {};
    this.now = config.now ?? (() => performance.now());
    this.queryId = config.queryId ?? (() => `q_${Math.random().toString(36).slice(2)}`);
  }

  path(source: string): QueryBuilder {
    return new QueryBuilder(this, { source });
  }

  query(input: JsonQueryV1): QueryBuilder {
    return new QueryBuilder(this, parseJsonQuery(input));
  }

  createResult(init: PathQueryInit): QueryResult {
    return new QueryResult({
      ...init,
      lake: this,
      budget: this.budget,
      now: this.now,
      queryId: this.queryId(),
      scanner: this.scanner,
    });
  }
}

export class QueryBuilder {
  private readonly lake: Lake;
  private readonly init: PathQueryInit;

  constructor(lake: Lake, init: PathQueryInit) {
    this.lake = lake;
    this.init = init;
  }

  select(columns: string[]): QueryBuilder {
    return new QueryBuilder(this.lake, { ...this.init, select: columns });
  }

  where(expr: Expr): QueryBuilder {
    return new QueryBuilder(this.lake, { ...this.init, where: expr });
  }

  limit(limit: number): QueryBuilder {
    return new QueryBuilder(this.lake, { ...this.init, limit });
  }

  offset(offset: number): QueryBuilder {
    return new QueryBuilder(this.lake, { ...this.init, offset });
  }

  batchSize(batchSize: number): QueryBuilder {
    return new QueryBuilder(this.lake, { ...this.init, batchSize });
  }

  run(): QueryResult {
    return this.lake.createResult(this.init);
  }

  rows(): AsyncIterable<Row> {
    return this.run().rows();
  }

  batches(): AsyncIterable<Row[]> {
    return this.run().batches();
  }

  toArray(): Promise<Row[]> {
    return this.run().toArray();
  }

  first(): Promise<Row | undefined> {
    return this.run().first();
  }

  count(): Promise<number> {
    return this.run().count();
  }

  streamNdjson(): ReadableStream<Uint8Array> {
    return this.run().streamNdjson();
  }

  streamJson(): ReadableStream<Uint8Array> {
    return this.run().streamJson();
  }
}

interface QueryResultConfig extends PathQueryInit {
  lake: Lake;
  scanner: ScanAdapter;
  budget: QueryBudget;
  now: () => number;
  queryId: string;
}

export class QueryResult {
  readonly stats: QueryStats;
  private readonly config: QueryResultConfig;

  constructor(config: QueryResultConfig) {
    validateQueryInit(config);
    this.config = config;
    this.stats = initialStats(config.queryId);
  }

  async *rows(): AsyncIterable<Row> {
    for await (const batch of this.batches()) {
      for (const row of batch) yield row;
    }
  }

  async *batches(): AsyncIterable<Row[]> {
    const config = this.config;
    const { stats } = this;
    const startedAt = config.now();
    let skipped = 0;
    let returned = 0;
    const paths = await expandPaths(config.lake.store, config.source);
    const columns = projectedReadColumns(config.select, config.where);
    for (const object of paths) {
      stats.filesPlanned += 1;
      stats.filesRead += 1;
      stats.bytesRequested += object.size;
      enforceBudget(config.budget, stats, config.now, startedAt);
      const scanOptions: ScanOptions = {
        batchSize: config.batchSize ?? 4096,
        stats,
        budget: config.budget,
        now: config.now,
        startedAt,
      };
      if (columns !== undefined) scanOptions.columns = columns;
      for await (const rawBatch of config.scanner.scan(object.path, scanOptions)) {
        const out: Row[] = [];
        for (const rawRow of rawBatch) {
          stats.rowsDecoded += 1;
          enforceBudget(config.budget, stats, config.now, startedAt);
          if (!matches(config.where, rawRow)) continue;
          stats.rowsMatched += 1;
          if (skipped < (config.offset ?? 0)) {
            skipped += 1;
            continue;
          }
          if (config.limit !== undefined && returned >= config.limit) break;
          out.push(project(rawRow, config.select));
          returned += 1;
          stats.rowsReturned += 1;
          enforceBudget(config.budget, stats, config.now, startedAt);
        }
        stats.elapsedMs = config.now() - startedAt;
        if (out.length > 0) yield out;
        if (config.limit !== undefined && returned >= config.limit) return;
      }
    }
    stats.elapsedMs = config.now() - startedAt;
  }

  async toArray(): Promise<Row[]> {
    const rows: Row[] = [];
    for await (const row of this.rows()) rows.push(row);
    return rows;
  }

  async first(): Promise<Row | undefined> {
    for await (const row of this.rows()) return row;
    return undefined;
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _row of this.rows()) count += 1;
    return count;
  }

  streamNdjson(): ReadableStream<Uint8Array> {
    const iterator = this.rows()[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encodeJsonLine(next.value));
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }

  streamJson(): ReadableStream<Uint8Array> {
    const iterator = this.rows()[Symbol.asyncIterator]();
    let first = true;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(new TextEncoder().encode("]"));
          controller.close();
          return;
        }
        const prefix = first ? "" : ",";
        first = false;
        controller.enqueue(
          new TextEncoder().encode(`${prefix}${JSON.stringify(jsonSafeValue(next.value))}`),
        );
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
}

export function parseJsonQuery(input: unknown): PathQueryInit {
  if (!isRecord(input)) throwParse("JSON query must be an object");
  if (input.version !== 1) throwParse("JSON query version must be 1");
  if (typeof input.from !== "string") throwParse("JSON query from must be a string");
  const init: PathQueryInit = { source: input.from };
  if (input.select !== undefined) {
    if (!Array.isArray(input.select) || input.select.some((value) => typeof value !== "string")) {
      throwParse("JSON query select must be an array of strings");
    }
    init.select = input.select;
  }
  if (input.where !== undefined) init.where = parseJsonExpr(input.where);
  if (input.limit !== undefined) init.limit = parseNonNegativeInt(input.limit, "limit");
  if (input.offset !== undefined) init.offset = parseNonNegativeInt(input.offset, "offset");
  return init;
}

function parseJsonExpr(input: unknown): Expr {
  if (!isRecord(input)) throwParse("JSON expression must be an object");
  const entries = Object.entries(input);
  if (entries.length !== 1) throwParse("JSON expression must have exactly one operator");
  const [op, value] = entries[0] ?? [];
  switch (op) {
    case "eq":
      return tuple2(value, op, eq);
    case "ne":
      return tuple2(value, op, ne);
    case "lt":
      return tuple2(value, op, lt);
    case "lte":
      return tuple2(value, op, lte);
    case "gt":
      return tuple2(value, op, gt);
    case "gte":
      return tuple2(value, op, gte);
    case "in":
      return tupleArray(value, op, isIn);
    case "notIn":
      return tupleArray(value, op, notIn);
    case "between": {
      const tuple = requireTuple(value, op, 3);
      return {
        kind: "between",
        target: col(requireColumn(tuple[0], op)),
        low: literal(tuple[1]),
        high: literal(tuple[2]),
      };
    }
    case "isNull":
      return isNull(requireColumn(value, op));
    case "isNotNull":
      return isNotNull(requireColumn(value, op));
    case "like":
      return tuplePattern(value, op, false);
    case "ilike":
      return tuplePattern(value, op, true);
    case "and":
    case "or": {
      if (!Array.isArray(value)) throwParse(`${op} expects an array`);
      if (value.length < 2) throwParse(`${op} expects at least two expressions`);
      return { kind: "logical", op, operands: value.map(parseJsonExpr) };
    }
    case "not":
      return { kind: "not", operand: parseJsonExpr(value) };
    default:
      throwParse(`Unsupported JSON expression operator ${op}`);
  }
}

function tuple2(
  value: unknown,
  op: string,
  cb: (column: string, value: string | number | boolean | bigint | null) => Expr,
): Expr {
  const tuple = requireTuple(value, op, 2);
  return cb(requireColumn(tuple[0], op), requireScalar(tuple[1], op));
}

function tupleArray(
  value: unknown,
  op: string,
  cb: (column: string, values: (string | number | boolean | bigint | null)[]) => Expr,
): Expr {
  const tuple = requireTuple(value, op, 2);
  if (!Array.isArray(tuple[1])) throwParse(`${op} values must be an array`);
  return cb(
    requireColumn(tuple[0], op),
    tuple[1].map((inner) => requireScalar(inner, op)),
  );
}

function tuplePattern(value: unknown, op: string, caseInsensitive: boolean): Expr {
  const tuple = requireTuple(value, op, 2);
  const pattern = tuple[1];
  if (typeof pattern !== "string") throwParse(`${op} pattern must be a string`);
  return { kind: "like", caseInsensitive, target: col(requireColumn(tuple[0], op)), pattern };
}

function literal(value: unknown): Expr {
  return { kind: "literal", value: requireScalar(value, "literal") };
}

function requireTuple(value: unknown, op: string, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throwParse(`${op} expects a ${length}-item array`);
  }
  return value;
}

function requireColumn(value: unknown, op: string): string {
  if (typeof value !== "string") throwParse(`${op} column must be a string`);
  return value;
}

function requireScalar(value: unknown, op: string): string | number | boolean | bigint | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throwParse(`${op} value must be a scalar`);
}

function parseNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throwParse(`${field} must be a non-negative integer`);
  }
  return value;
}

function validateQueryInit(init: PathQueryInit): void {
  if (init.limit !== undefined && (!Number.isInteger(init.limit) || init.limit < 0)) {
    throw new LaQLError("LAQL_TYPE_ERROR", "limit must be a non-negative integer");
  }
  if (init.offset !== undefined && (!Number.isInteger(init.offset) || init.offset < 0)) {
    throw new LaQLError("LAQL_TYPE_ERROR", "offset must be a non-negative integer");
  }
  if (init.batchSize !== undefined && (!Number.isInteger(init.batchSize) || init.batchSize <= 0)) {
    throw new LaQLError("LAQL_TYPE_ERROR", "batchSize must be a positive integer");
  }
}

async function expandPaths(store: ObjectStore, pattern: string): Promise<ObjectInfo[]> {
  if (!hasGlob(pattern)) {
    const head = await store.head(pattern);
    if (!head) {
      throw new LaQLError("LAQL_OBJECT_NOT_FOUND", `No object at ${pattern}`, { path: pattern });
    }
    const object: ObjectInfo = { path: pattern, size: head.size };
    if (head.etag !== undefined) object.etag = head.etag;
    if (head.lastModified !== undefined) object.lastModified = head.lastModified;
    return [object];
  }
  const prefix = globPrefix(pattern);
  const regex = globRegex(pattern);
  const paths: ObjectInfo[] = [];
  for await (const object of store.list(prefix)) {
    if (regex.test(object.path)) paths.push(object);
  }
  paths.sort((a, b) => a.path.localeCompare(b.path));
  return paths;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

function globPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?]/u);
  const slash = pattern.lastIndexOf("/", wildcard);
  return slash === -1 ? "" : pattern.slice(0, slash + 1);
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function projectedReadColumns(
  select: string[] | undefined,
  where: Expr | undefined,
): string[] | undefined {
  const columns = new Set<string>();
  for (const column of select ?? []) columns.add(column);
  collectExprColumns(where, columns);
  return columns.size === 0 ? undefined : [...columns].sort();
}

function collectExprColumns(expr: Expr | undefined, columns: Set<string>): void {
  if (!expr) return;
  switch (expr.kind) {
    case "column":
      columns.add(expr.name);
      return;
    case "literal":
      return;
    case "compare":
      collectExprColumns(expr.left, columns);
      collectExprColumns(expr.right, columns);
      return;
    case "in":
      collectExprColumns(expr.target, columns);
      for (const value of expr.values) collectExprColumns(value, columns);
      return;
    case "between":
      collectExprColumns(expr.target, columns);
      collectExprColumns(expr.low, columns);
      collectExprColumns(expr.high, columns);
      return;
    case "null-check":
      collectExprColumns(expr.target, columns);
      return;
    case "logical":
      for (const operand of expr.operands) collectExprColumns(operand, columns);
      return;
    case "not":
      collectExprColumns(expr.operand, columns);
      return;
    case "like":
      collectExprColumns(expr.target, columns);
      return;
    case "call":
      for (const arg of expr.args) collectExprColumns(arg, columns);
      return;
  }
}

function project(row: Row, select: string[] | undefined): Row {
  if (!select) return row;
  const out: Row = {};
  for (const column of select) {
    if (!(column in row)) {
      throw new LaQLError("LAQL_UNKNOWN_COLUMN", `Unknown column ${column}`, { column });
    }
    out[column] = row[column];
  }
  return out;
}

function enforceBudget(
  budget: QueryBudget,
  stats: QueryStats,
  now: () => number,
  startedAt: number,
): void {
  const elapsedMs = now() - startedAt;
  stats.elapsedMs = elapsedMs;
  if (budget.maxFiles !== undefined && stats.filesRead > budget.maxFiles) {
    throwBudget("files", budget.maxFiles, stats.filesRead);
  }
  if (budget.maxBytes !== undefined && stats.bytesRequested > budget.maxBytes) {
    throwBudget("bytes", budget.maxBytes, stats.bytesRequested);
  }
  if (budget.maxRowsDecoded !== undefined && stats.rowsDecoded > budget.maxRowsDecoded) {
    throwBudget("rows decoded", budget.maxRowsDecoded, stats.rowsDecoded);
  }
  if (budget.maxOutputRows !== undefined && stats.rowsReturned > budget.maxOutputRows) {
    throwBudget("output rows", budget.maxOutputRows, stats.rowsReturned);
  }
  if (budget.maxRangeRequests !== undefined && stats.rangeRequests > budget.maxRangeRequests) {
    throwBudget("range requests", budget.maxRangeRequests, stats.rangeRequests);
  }
  if (budget.maxElapsedMs !== undefined && elapsedMs > budget.maxElapsedMs) {
    throwBudget("elapsed milliseconds", budget.maxElapsedMs, elapsedMs);
  }
}

function throwBudget(metric: string, limit: number, actual: number): never {
  throw new LaQLError(
    "LAQL_BUDGET_EXCEEDED",
    `Query exceeded ${metric} budget (${actual} > ${limit}). Add a partition filter, date filter, h3 filter, or limit.`,
    { metric, limit, actual },
  );
}

function initialStats(queryId: string): QueryStats {
  return {
    queryId,
    elapsedMs: 0,
    manifestsRead: 0,
    manifestsSkipped: 0,
    filesPlanned: 0,
    filesRead: 0,
    filesSkipped: 0,
    rowGroupsRead: 0,
    rowGroupsSkipped: 0,
    columnsRead: [],
    bytesRequested: 0,
    rangeRequests: 0,
    rowsDecoded: 0,
    rowsMatched: 0,
    rowsReturned: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
}

function throwParse(message: string): never {
  throw new LaQLError("LAQL_PARSE_ERROR", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
