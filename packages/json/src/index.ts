import { createInMemoryLake, type InMemoryLakeOptions, LakeqlError, type Row } from "lakeql-core";

export type JsonInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | readonly unknown[]
  | Record<string, unknown>;

export interface ReadJsonOptions {
  format?: "auto" | "json" | "ndjson";
  maxRows?: number;
  maxBytes?: number;
}

export interface JsonLakeOptions
  extends Omit<InMemoryLakeOptions, "maxRows" | "maxBytes">,
    ReadJsonOptions {}

interface NormalizedJsonOptions {
  format: "auto" | "json" | "ndjson";
  maxRows: number | undefined;
  maxBytes: number | undefined;
}

export async function readJsonObjects(
  input: JsonInput,
  options: ReadJsonOptions = {},
): Promise<Row[]> {
  const normalized = normalizeOptions(options);
  if (typeof input === "string" || isBinaryJsonInput(input)) {
    const { text, bytes } = await jsonInputText(input);
    enforceJsonBudget(normalized, 0, bytes);
    return parseTextRows(text, normalized);
  }
  return normalizeRows(input, normalized);
}

export async function createJsonLake(
  tables: Record<string, JsonInput>,
  options: JsonLakeOptions = {},
) {
  const rowsByTable: Record<string, Row[]> = {};
  for (const [name, input] of Object.entries(tables)) {
    rowsByTable[name] = await readJsonObjects(input, options);
  }
  const lakeOptions: InMemoryLakeOptions = {};
  if (options.budget !== undefined) lakeOptions.budget = options.budget;
  if (options.policy !== undefined) lakeOptions.policy = options.policy;
  if (options.substrate !== undefined) lakeOptions.substrate = options.substrate;
  if (options.now !== undefined) lakeOptions.now = options.now;
  if (options.queryId !== undefined) lakeOptions.queryId = options.queryId;
  if (options.maxRows !== undefined) lakeOptions.maxRows = options.maxRows;
  if (options.maxBytes !== undefined) lakeOptions.maxBytes = options.maxBytes;
  return createInMemoryLake(rowsByTable, lakeOptions);
}

function parseTextRows(text: string, options: NormalizedJsonOptions): Row[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (options.format === "ndjson") return parseNdjsonRows(text, options);
  if (options.format === "json") return parseJsonRows(trimmed, options);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return parseJsonRows(trimmed, options);
    } catch (cause) {
      if (cause instanceof LakeqlError && cause.code === "LAKEQL_PARSE_ERROR") {
        return parseNdjsonRows(text, options);
      }
      throw cause;
    }
  }
  return parseNdjsonRows(text, options);
}

function parseJsonRows(text: string, options: NormalizedJsonOptions): Row[] {
  try {
    return normalizeRows(JSON.parse(text) as unknown, options);
  } catch (cause) {
    if (cause instanceof LakeqlError) throw cause;
    throw new LakeqlError("LAKEQL_PARSE_ERROR", "JSON input is invalid", { cause });
  }
}

function parseNdjsonRows(text: string, options: NormalizedJsonOptions): Row[] {
  const rows: Row[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(normalizeRow(JSON.parse(trimmed) as unknown, index + 1));
    } catch (cause) {
      if (cause instanceof LakeqlError) throw cause;
      throw new LakeqlError("LAKEQL_PARSE_ERROR", "NDJSON line is invalid JSON", {
        lineNumber: index + 1,
        cause,
      });
    }
    enforceJsonBudget(options, rows.length, 0);
  }
  return rows;
}

function normalizeRows(value: unknown, options: NormalizedJsonOptions): Row[] {
  const rows = Array.isArray(value)
    ? value.map((entry, index) => normalizeRow(entry, index + 1))
    : [normalizeRow(value, 1)];
  enforceJsonBudget(options, rows.length, 0);
  return rows;
}

function normalizeRow(value: unknown, rowNumber: number): Row {
  if (!isPlainObject(value)) {
    throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "JSON rows must be objects", {
      rowNumber,
      valueType: Array.isArray(value) ? "array" : typeof value,
    });
  }
  const row: Row = {};
  for (const [key, cell] of Object.entries(value)) {
    row[key] = normalizeJsonCell(cell, rowNumber, key);
  }
  return row;
}

function normalizeJsonCell(value: unknown, rowNumber: number, column: string): Row[string] {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Array.isArray(value) || isPlainObject(value)) return value as Row[string];
  throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "JSON cell value is unsupported", {
    rowNumber,
    column,
    valueType: typeof value,
  });
}

function normalizeOptions(options: ReadJsonOptions): NormalizedJsonOptions {
  const normalized: NormalizedJsonOptions = {
    format: options.format ?? "auto",
    maxRows: options.maxRows,
    maxBytes: options.maxBytes,
  };
  if (!["auto", "json", "ndjson"].includes(normalized.format)) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "JSON format must be auto, json, or ndjson", {
      format: normalized.format,
    });
  }
  validatePositiveBudget("maxRows", normalized.maxRows);
  validatePositiveBudget("maxBytes", normalized.maxBytes);
  return normalized;
}

function validatePositiveBudget(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", `${name} must be a positive integer`, {
      [name]: value,
    });
  }
}

function enforceJsonBudget(options: NormalizedJsonOptions, rows: number, bytes: number): void {
  if (options.maxRows !== undefined && rows > options.maxRows) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `JSON ingest exceeded row budget (${rows} > ${options.maxRows})`,
      { metric: "json rows", limit: options.maxRows, actual: rows },
    );
  }
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `JSON ingest exceeded byte budget (${bytes} > ${options.maxBytes})`,
      { metric: "json bytes", limit: options.maxBytes, actual: bytes },
    );
  }
}

async function jsonInputText(
  input: string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob,
): Promise<{ text: string; bytes: number }> {
  if (typeof input === "string") {
    return { text: input, bytes: new TextEncoder().encode(input).byteLength };
  }
  if (input instanceof Uint8Array) {
    return { text: new TextDecoder().decode(input), bytes: input.byteLength };
  }
  if (input instanceof ArrayBuffer) {
    return { text: new TextDecoder().decode(input), bytes: input.byteLength };
  }
  if (ArrayBuffer.isView(input)) {
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return { text: new TextDecoder().decode(bytes), bytes: input.byteLength };
  }
  const text = await input.text();
  return { text, bytes: input.size };
}

function isBinaryJsonInput(
  value: unknown,
): value is Uint8Array | ArrayBuffer | ArrayBufferView | Blob {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
