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
    return entry.value;
  }

  set(key: string, batch: Batch): void {
    this.cache.set(decodedKey(key), batch, estimateBatchBytes(batch), {
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
