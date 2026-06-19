import { timestampEpochForUnit } from "lakeql-core";
import { describe, expect, it } from "vitest";
import { lakeqlParquetParsers } from "./parsers.js";

describe("lakeql Parquet parsers", () => {
  it("converts timestamp physical values into unit-aware timestamp values", () => {
    const millis = lakeqlParquetParsers.timestampFromMilliseconds(1_700_000_000_123n);
    const micros = lakeqlParquetParsers.timestampFromMicroseconds(1_700_000_000_123_456);
    const nanos = lakeqlParquetParsers.timestampFromNanoseconds(1_700_000_000_123_456_789n);

    expect(millis).toMatchObject({ unit: "millis" });
    expect(micros).toMatchObject({ unit: "micros" });
    expect(nanos).toMatchObject({ unit: "nanos" });
    expect(timestampEpochForUnit(millis, "millis")).toBe(1_700_000_000_123n);
    expect(timestampEpochForUnit(micros, "micros")).toBe(1_700_000_000_123_456n);
    expect(timestampEpochForUnit(nanos, "nanos")).toBe(1_700_000_000_123_456_789n);
  });
});
