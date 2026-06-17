import { createInMemoryLake, type InMemoryLakeOptions, LakeqlError, type Row } from "lakeql-core";

export type CsvInput = string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

export interface CsvParseOptions {
  delimiter?: string;
  quote?: string;
  header?: boolean | "auto";
  trim?: boolean;
  nullValues?: string[];
  typeSniffing?: boolean;
}

export interface ReadCsvOptions extends CsvParseOptions {
  maxRows?: number;
  maxBytes?: number;
}

export interface CsvLakeOptions
  extends Omit<InMemoryLakeOptions, "maxRows" | "maxBytes">,
    ReadCsvOptions {}

interface NormalizedCsvOptions {
  delimiter: string | undefined;
  quote: string;
  header: boolean | "auto";
  trim: boolean;
  nullValues: Set<string>;
  typeSniffing: boolean;
  maxRows: number | undefined;
  maxBytes: number | undefined;
}

export async function readCsvObjects(
  input: CsvInput,
  options: ReadCsvOptions = {},
): Promise<Row[]> {
  const normalized = normalizeOptions(options);
  const { text, bytes } = await csvInputText(input);
  enforceCsvBudget(normalized, 0, bytes);
  return parseCsvText(text, normalized);
}

export async function createCsvLake(
  tables: Record<string, CsvInput>,
  options: CsvLakeOptions = {},
) {
  const rowsByTable: Record<string, Row[]> = {};
  for (const [name, input] of Object.entries(tables)) {
    rowsByTable[name] = await readCsvObjects(input, options);
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

function parseCsvText(text: string, options: NormalizedCsvOptions): Row[] {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter, options.quote, options.trim);
  if (records.length === 0) return [];

  const hasHeader = options.header === "auto" ? shouldUseHeader(records) : options.header === true;
  const columns = hasHeader
    ? normalizeHeader(records[0] ?? [])
    : generatedColumns(records[0]?.length ?? 0);
  const dataRecords = hasHeader ? records.slice(1) : records;
  const converters = inferConverters(dataRecords, columns.length, hasHeader ? 2 : 1, options);
  const rows: Row[] = [];

  for (const [index, record] of dataRecords.entries()) {
    validateRecordWidth(record, columns.length, index + (hasHeader ? 2 : 1));
    const row: Row = {};
    for (const [columnIndex, column] of columns.entries()) {
      row[column] = converters[columnIndex]?.(record[columnIndex] ?? "") ?? null;
    }
    rows.push(row);
    enforceCsvBudget(options, rows.length, 0);
  }
  return rows;
}

function parseCsvRecords(
  text: string,
  delimiter: string,
  quote: string,
  trim: boolean,
): string[][] {
  validateDelimiter(delimiter);
  validateQuote(quote);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === quote) {
        if (text[index + 1] === quote) {
          field += quote;
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === quote && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      continue;
    }
    if (char === delimiter) {
      record.push(finalizeField(field, trim));
      field = "";
      fieldStarted = false;
      continue;
    }
    if (char === "\n" || char === "\r") {
      record.push(finalizeField(field, trim));
      records.push(record);
      record = [];
      field = "";
      fieldStarted = false;
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    field += char;
    fieldStarted = true;
  }

  if (quoted) {
    throw new LakeqlError("LAKEQL_PARSE_ERROR", "CSV quoted field is not terminated");
  }
  if (field.length > 0 || fieldStarted || record.length > 0) {
    record.push(finalizeField(field, trim));
    records.push(record);
  }
  return records;
}

function inferConverters(
  records: string[][],
  width: number,
  rowNumberOffset: number,
  options: NormalizedCsvOptions,
): ((value: string) => Row[string])[] {
  const kinds = Array.from({ length: width }, () => new Set<"boolean" | "number" | "string">());
  for (const [index, record] of records.entries()) {
    validateRecordWidth(record, width, index + rowNumberOffset);
    for (let column = 0; column < width; column += 1) {
      const value = record[column] ?? "";
      if (options.nullValues.has(value)) continue;
      kinds[column]?.add(options.typeSniffing ? sniffScalarKind(value) : "string");
    }
  }
  return kinds.map((columnKinds) => {
    if (columnKinds.size === 0) return (value: string) => parseNull(value, options);
    if (columnKinds.size === 1 && columnKinds.has("number"))
      return (value) => parseNumber(value, options);
    if (columnKinds.size === 1 && columnKinds.has("boolean"))
      return (value) => parseBoolean(value, options);
    return (value) => parseString(value, options);
  });
}

function shouldUseHeader(records: string[][]): boolean {
  const first = records[0];
  if (first === undefined || records.length < 2) return false;
  const normalized = first.map((value) => value.trim());
  if (normalized.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))) return false;
  if (new Set(normalized).size !== normalized.length) return false;
  const rest = records.slice(1);
  return rest.some((record) => record.some((value) => sniffScalarKind(value) !== "string"));
}

function normalizeHeader(record: string[]): string[] {
  const columns = record.map((value) => value.trim());
  const seen = new Set<string>();
  for (const [index, column] of columns.entries()) {
    if (column === "") {
      throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "CSV header columns must be non-empty", {
        columnIndex: index,
      });
    }
    if (seen.has(column)) {
      throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "CSV header columns must be unique", {
        column,
      });
    }
    seen.add(column);
  }
  return columns;
}

function generatedColumns(width: number): string[] {
  return Array.from({ length: width }, (_value, index) => `column${index + 1}`);
}

function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.length > 0) ?? "";
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = countDelimiterOutsideQuotes(line, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

function sniffScalarKind(value: string): "boolean" | "number" | "string" {
  if (/^(?:true|false)$/iu.test(value)) return "boolean";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value))) {
    return "number";
  }
  return "string";
}

function parseNull(value: string, options: NormalizedCsvOptions): Row[string] {
  return options.nullValues.has(value) ? null : value;
}

function parseNumber(value: string, options: NormalizedCsvOptions): Row[string] {
  if (options.nullValues.has(value)) return null;
  return Number(value);
}

function parseBoolean(value: string, options: NormalizedCsvOptions): Row[string] {
  if (options.nullValues.has(value)) return null;
  return value.toLowerCase() === "true";
}

function parseString(value: string, options: NormalizedCsvOptions): Row[string] {
  if (options.nullValues.has(value)) return null;
  return value;
}

function validateRecordWidth(record: string[], expected: number, rowNumber: number): void {
  if (record.length === expected) return;
  throw new LakeqlError("LAKEQL_VALIDATION_ERROR", "CSV rows must have a consistent column count", {
    rowNumber,
    expectedColumns: expected,
    actualColumns: record.length,
  });
}

function validateDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || delimiter === "\n" || delimiter === "\r") {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "CSV delimiter must be one non-newline character", {
      delimiter,
    });
  }
}

function validateQuote(quote: string): void {
  if (quote.length !== 1 || quote === "\n" || quote === "\r") {
    throw new LakeqlError("LAKEQL_TYPE_ERROR", "CSV quote must be one non-newline character", {
      quote,
    });
  }
}

function finalizeField(value: string, trim: boolean): string {
  return trim ? value.trim() : value;
}

function normalizeOptions(options: ReadCsvOptions): NormalizedCsvOptions {
  const normalized: NormalizedCsvOptions = {
    delimiter: options.delimiter,
    quote: options.quote ?? '"',
    header: options.header ?? "auto",
    trim: options.trim ?? false,
    nullValues: new Set(options.nullValues ?? [""]),
    typeSniffing: options.typeSniffing ?? true,
    maxRows: options.maxRows,
    maxBytes: options.maxBytes,
  };
  if (normalized.delimiter !== undefined) validateDelimiter(normalized.delimiter);
  validateQuote(normalized.quote);
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

function enforceCsvBudget(options: NormalizedCsvOptions, rows: number, bytes: number): void {
  if (options.maxRows !== undefined && rows > options.maxRows) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `CSV ingest exceeded row budget (${rows} > ${options.maxRows})`,
      { metric: "csv rows", limit: options.maxRows, actual: rows },
    );
  }
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new LakeqlError(
      "LAKEQL_BUDGET_EXCEEDED",
      `CSV ingest exceeded byte budget (${bytes} > ${options.maxBytes})`,
      { metric: "csv bytes", limit: options.maxBytes, actual: bytes },
    );
  }
}

async function csvInputText(input: CsvInput): Promise<{ text: string; bytes: number }> {
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
  if (typeof input.text === "function") {
    const text = await input.text();
    return { text, bytes: input.size };
  }
  throw new LakeqlError("LAKEQL_TYPE_ERROR", "Unsupported CSV input");
}
