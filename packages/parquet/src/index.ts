import {
  Lake,
  type LakeConfig,
  LaQLError,
  type ObjectStore,
  type Row,
  type ScanAdapter,
  type ScanOptions,
} from "@laql/core";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";

export interface ReadParquetOptions {
  /** Columns to project; all columns when omitted. */
  columns?: string[];
  rowStart?: number;
  rowEnd?: number;
}

export interface ParquetLakeConfig extends Omit<LakeConfig, "scanner"> {
  batchSize?: number;
}

/**
 * Bridge an ObjectStore path to hyparquet's AsyncBuffer (length + ranged slice).
 */
export async function asyncBufferFromStore(
  store: ObjectStore,
  path: string,
  options: ScanOptions | undefined = undefined,
) {
  const head = await store.head(path);
  if (!head) {
    throw new LaQLError("LAQL_OBJECT_NOT_FOUND", `No object at ${path}`, { path });
  }
  return {
    byteLength: head.size,
    slice: async (start: number, end?: number): Promise<ArrayBuffer> => {
      const length = (end ?? head.size) - start;
      if (options) {
        options.stats.rangeRequests += 1;
        options.stats.bytesRequested += length;
      }
      const bytes = await store.getRange(path, { offset: start, length });
      const out = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(out).set(bytes);
      return out;
    },
  };
}

/**
 * Read rows from a Parquet object. Early scaffold: full planner-driven
 * row-group pruning and batch streaming land in phase 1-2 (see BUILD_PLAN.md).
 */
export async function readParquetObjects(
  store: ObjectStore,
  path: string,
  options: ReadParquetOptions = {},
): Promise<Record<string, unknown>[]> {
  const file = await asyncBufferFromStore(store, path);
  try {
    const readOptions: Parameters<typeof parquetReadObjects>[0] = { file };
    if (options.columns) readOptions.columns = options.columns;
    if (options.rowStart !== undefined) readOptions.rowStart = options.rowStart;
    if (options.rowEnd !== undefined) readOptions.rowEnd = options.rowEnd;
    return await parquetReadObjects(readOptions);
  } catch (cause) {
    throw new LaQLError("LAQL_PARQUET_READ_ERROR", `Failed to read ${path}`, { path, cause });
  }
}

/** Read Parquet footer metadata (row groups, schema, stats). */
export async function readParquetMetadata(store: ObjectStore, path: string) {
  const file = await asyncBufferFromStore(store, path);
  return parquetMetadataAsync(file);
}

export class ParquetScanAdapter implements ScanAdapter {
  private readonly store: ObjectStore;
  private readonly defaultBatchSize: number;

  constructor(store: ObjectStore, options: { batchSize?: number } = {}) {
    this.store = store;
    this.defaultBatchSize = options.batchSize ?? 4096;
  }

  async *scan(path: string, options: ScanOptions): AsyncIterable<Row[]> {
    const batchSize = options.batchSize || this.defaultBatchSize;
    const file = await asyncBufferFromStore(this.store, path, options);
    const metadata = await parquetMetadataAsync(file);
    const totalRows = Number(metadata.num_rows);
    const readColumns = options.columns;
    if (readColumns) {
      const known = new Set(options.stats.columnsRead);
      for (const column of readColumns) {
        if (!known.has(column)) {
          known.add(column);
          options.stats.columnsRead.push(column);
        }
      }
      options.stats.columnsRead.sort();
    }

    for (let rowStart = 0; rowStart < totalRows; rowStart += batchSize) {
      const rowEnd = Math.min(rowStart + batchSize, totalRows);
      options.stats.rowGroupsRead += 1;
      const readOptions: Parameters<typeof parquetReadObjects>[0] = {
        file,
        metadata,
        rowFormat: "object",
        rowStart,
        rowEnd,
      };
      if (readColumns) readOptions.columns = readColumns;
      try {
        yield await parquetReadObjects(readOptions);
      } catch (cause) {
        throw new LaQLError("LAQL_PARQUET_READ_ERROR", `Failed to read ${path}`, { path, cause });
      }
    }
  }
}

export function parquetScanner(
  store: ObjectStore,
  options: { batchSize?: number } = {},
): ScanAdapter {
  return new ParquetScanAdapter(store, options);
}

export function createParquetLake(config: ParquetLakeConfig): Lake {
  const scannerOptions: { batchSize?: number } = {};
  if (config.batchSize !== undefined) scannerOptions.batchSize = config.batchSize;
  return new Lake({
    ...config,
    scanner: parquetScanner(config.store, scannerOptions),
  });
}
