import { LakeqlError } from "./errors.js";
import { jsonSafeValue } from "./evaluator.js";
import { stableStringify } from "./manifest.js";
import { Lake, type LakeConfig, type ScanAdapter, type ScanOptions } from "./query.js";
import type { ListOptions, ObjectHead, ObjectInfo, ObjectStore } from "./store.js";
import type { Row } from "./types.js";

export interface InMemoryTableOptions {
  maxRows?: number;
  maxBytes?: number;
}

export interface InMemoryLakeOptions
  extends Omit<LakeConfig, "store" | "scanner" | "sidecarIndex">,
    InMemoryTableOptions {}

interface InMemoryTable {
  path: string;
  rows: Row[];
  size: number;
  etag: string;
  lastModified: Date;
}

export class InMemoryRowsScanner implements ScanAdapter {
  private readonly tables: Map<string, InMemoryTable>;

  constructor(tables: Record<string, readonly Row[]>, options: InMemoryTableOptions = {}) {
    this.tables = normalizeInMemoryTables(tables, options);
  }

  async *scan(path: string, options: ScanOptions): AsyncIterable<Row[]> {
    const table = this.table(path);
    const batchSize = options.batchSize;
    for (let start = 0; start < table.rows.length; start += batchSize) {
      const out: Row[] = [];
      for (const row of table.rows.slice(start, start + batchSize)) {
        out.push(projectPhysicalColumns(row, options.columns));
      }
      yield out;
    }
  }

  async planTask(path: string) {
    return { rowGroupRanges: [{ start: 0, end: this.table(path).rows.length }] };
  }

  tableInfo(path: string): ObjectInfo {
    const table = this.table(path);
    return {
      path: table.path,
      size: table.size,
      etag: table.etag,
      lastModified: table.lastModified,
    };
  }

  listTables(prefix: string, options: ListOptions = {}): ObjectInfo[] {
    const out: ObjectInfo[] = [];
    for (const table of [...this.tables.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      if (!table.path.startsWith(prefix)) continue;
      out.push({
        path: table.path,
        size: table.size,
        etag: table.etag,
        lastModified: table.lastModified,
      });
      if (options.limit !== undefined && out.length >= options.limit) break;
    }
    return out;
  }

  private table(path: string): InMemoryTable {
    const table = this.tables.get(path);
    if (table === undefined) {
      throw new LakeqlError("LAKEQL_UNKNOWN_TABLE", `No in-memory table named ${path}`, { path });
    }
    return table;
  }
}

export class InMemoryRowsStore implements ObjectStore {
  constructor(private readonly scanner: InMemoryRowsScanner) {}

  async get(path: string): Promise<Uint8Array | null> {
    this.scanner.tableInfo(path);
    return null;
  }

  async getRange(path: string): Promise<Uint8Array> {
    this.scanner.tableInfo(path);
    return new Uint8Array();
  }

  async put(): Promise<void> {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "In-memory row stores are read-only");
  }

  async delete(): Promise<void> {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "In-memory row stores are read-only");
  }

  async *list(prefix: string, options?: ListOptions): AsyncIterable<ObjectInfo> {
    yield* this.scanner.listTables(prefix, options);
  }

  async head(path: string): Promise<ObjectHead | null> {
    try {
      const table = this.scanner.tableInfo(path);
      const head: ObjectHead = {
        size: table.size,
        contentType: "application/vnd.lakeql.rows+json",
      };
      if (table.etag !== undefined) head.etag = table.etag;
      if (table.lastModified !== undefined) head.lastModified = table.lastModified;
      return head;
    } catch (cause) {
      if (cause instanceof LakeqlError && cause.code === "LAKEQL_UNKNOWN_TABLE") return null;
      throw cause;
    }
  }
}

export function inMemoryRowsScanner(
  tables: Record<string, readonly Row[]>,
  options: InMemoryTableOptions = {},
): InMemoryRowsScanner {
  return new InMemoryRowsScanner(tables, options);
}

export function createInMemoryLake(
  tables: Record<string, readonly Row[]>,
  options: InMemoryLakeOptions = {},
): Lake {
  const { maxRows, maxBytes, ...lakeOptions } = options;
  const tableOptions: InMemoryTableOptions = {};
  if (maxRows !== undefined) tableOptions.maxRows = maxRows;
  if (maxBytes !== undefined) tableOptions.maxBytes = maxBytes;
  const scanner = inMemoryRowsScanner(tables, tableOptions);
  return new Lake({
    ...lakeOptions,
    store: new InMemoryRowsStore(scanner),
    scanner,
  });
}

function normalizeInMemoryTables(
  tables: Record<string, readonly Row[]>,
  options: InMemoryTableOptions,
): Map<string, InMemoryTable> {
  const normalized = new Map<string, InMemoryTable>();
  let totalRows = 0;
  let totalBytes = 0;
  for (const [path, rows] of Object.entries(tables)) {
    if (path.trim() === "") {
      throw new LakeqlError("LAKEQL_TYPE_ERROR", "In-memory table names must be non-empty");
    }
    const copiedRows = rows.map((row) => ({ ...row }));
    const size = estimateRowsBytes(copiedRows);
    totalRows += copiedRows.length;
    totalBytes += size;
    enforceInMemoryTableBudget(options, totalRows, totalBytes);
    normalized.set(path, {
      path,
      rows: copiedRows,
      size,
      etag: `memory-${stableStringify([path, copiedRows.length, size])}`,
      lastModified: new Date(0),
    });
  }
  return normalized;
}

function enforceInMemoryTableBudget(
  options: InMemoryTableOptions,
  rows: number,
  bytes: number,
): void {
  if (options.maxRows !== undefined && rows > options.maxRows) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `In-memory ingest exceeded row budget (${rows} > ${options.maxRows})`,
      { metric: "ingest rows", limit: options.maxRows, actual: rows },
    );
  }
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `In-memory ingest exceeded byte budget (${bytes} > ${options.maxBytes})`,
      { metric: "ingest bytes", limit: options.maxBytes, actual: bytes },
    );
  }
}

function estimateRowsBytes(rows: Row[]): number {
  return new TextEncoder().encode(stableStringify(jsonSafeValue(rows))).byteLength;
}

function projectPhysicalColumns(row: Row, columns: string[] | undefined): Row {
  if (columns === undefined) return { ...row };
  const out: Row = {};
  for (const column of columns) {
    if (column in row) out[column] = row[column];
  }
  return out;
}
