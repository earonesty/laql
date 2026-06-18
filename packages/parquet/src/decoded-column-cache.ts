import type {
  Batch,
  CachePolicy,
  ObjectStoreCacheOptions,
  SharedMemoryCache,
  Vector,
} from "lakeql-core";

export class DecodedColumnCache {
  constructor(
    private readonly cache: SharedMemoryCache,
    private readonly options: ObjectStoreCacheOptions,
  ) {}

  get(key: string): Batch | undefined {
    const entry = this.cache.get<Batch>(decodedKey(key));
    if (entry === undefined) return undefined;
    return cloneBatch(entry.value);
  }

  set(key: string, batch: Batch): void {
    this.cache.set(decodedKey(key), cloneBatch(batch), estimateBatchBytes(batch), {
      priority: decodedPriority(this.options.policy ?? "balanced"),
    });
  }
}

export function decodedColumnCacheKey(options: {
  path: string;
  byteLength: number;
  etag?: string;
  columns: readonly string[];
  rowStart: number;
  rowEnd: number;
}): string {
  return [
    options.path,
    options.byteLength,
    options.etag ?? "",
    options.rowStart,
    options.rowEnd,
    ...options.columns,
  ].join("\u001f");
}

function decodedKey(key: string): string {
  return `decoded-column:${key}`;
}

function decodedPriority(policy: CachePolicy): number {
  if (policy === "latency") return 4;
  if (policy === "io") return 1;
  return 2;
}

function cloneBatch(batch: Batch): Batch {
  return {
    rowCount: batch.rowCount,
    columns: Object.fromEntries(
      Object.entries(batch.columns).map(([name, vector]) => [name, cloneVector(vector)]),
    ),
  };
}

function cloneVector(vector: Vector): Vector {
  const valid =
    "valid" in vector && vector.valid !== undefined ? new Uint8Array(vector.valid) : undefined;
  switch (vector.type) {
    case "null":
      return { type: "null", length: vector.length };
    case "f64":
      return withValid({ type: "f64", values: new Float64Array(vector.values) }, valid);
    case "i64":
      return withValid({ type: "i64", values: new BigInt64Array(vector.values) }, valid);
    case "bool":
      return withValid({ type: "bool", values: new Uint8Array(vector.values) }, valid);
    case "utf8":
      return withValid({ type: "utf8", values: [...vector.values] }, valid);
    case "list":
      return withValid(
        {
          type: "list",
          offsets: new Int32Array(vector.offsets),
          child: cloneVector(vector.child),
        },
        valid,
      );
    case "struct":
      return withValid(
        {
          type: "struct",
          fields: Object.fromEntries(
            Object.entries(vector.fields).map(([name, field]) => [name, cloneVector(field)]),
          ),
          length: vector.length,
        },
        valid,
      );
    case "map":
      return withValid(
        {
          type: "map",
          offsets: new Int32Array(vector.offsets),
          keys: cloneVector(vector.keys),
          values: cloneVector(vector.values),
        },
        valid,
      );
  }
}

function withValid<T extends Vector>(vector: T, valid: Uint8Array | undefined): T {
  if (valid === undefined) return vector;
  return { ...vector, valid };
}

function estimateBatchBytes(batch: Batch): number {
  let bytes = 0;
  for (const vector of Object.values(batch.columns)) {
    bytes += estimateVectorBytes(vector);
  }
  return bytes;
}

function estimateVectorBytes(vector: Vector): number {
  let bytes = "valid" in vector && vector.valid !== undefined ? vector.valid.byteLength : 0;
  switch (vector.type) {
    case "null":
      return bytes;
    case "f64":
    case "i64":
    case "bool":
      return bytes + vector.values.byteLength;
    case "utf8":
      for (const value of vector.values) bytes += value.length * 2;
      return bytes;
    case "list":
      return bytes + vector.offsets.byteLength + estimateVectorBytes(vector.child);
    case "struct":
      for (const field of Object.values(vector.fields)) bytes += estimateVectorBytes(field);
      return bytes;
    case "map":
      return (
        bytes +
        vector.offsets.byteLength +
        estimateVectorBytes(vector.keys) +
        estimateVectorBytes(vector.values)
      );
  }
}
