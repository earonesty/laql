import { describe, expect, it } from "vitest";
import {
  compareTimestampValues,
  isTimestampValue,
  TimestampValue,
  timestampEpochForUnit,
  timestampFromEpoch,
  timestampToIsoString,
  timestampValueFromIso,
} from "./timestamp.js";

describe("timestamp values", () => {
  it("round-trips epoch values across timestamp units", () => {
    const millis = timestampFromEpoch(1_700_000_000_123n, "millis");
    const micros = timestampFromEpoch(1_700_000_000_123_456n, "micros");
    const nanos = timestampFromEpoch(1_700_000_000_123_456_789n, "nanos", false);

    expect(millis.toString()).toBe("2023-11-14T22:13:20.123Z");
    expect(millis.toJSON()).toBe("2023-11-14T22:13:20.123Z");
    expect(timestampToIsoString(micros)).toBe("2023-11-14T22:13:20.123456Z");
    expect(timestampToIsoString(nanos)).toBe("2023-11-14T22:13:20.123456789Z");
    expect(timestampEpochForUnit(nanos, "millis")).toBe(1_700_000_000_123n);
    expect(timestampEpochForUnit(nanos, "micros")).toBe(1_700_000_000_123_456n);
    expect(timestampEpochForUnit(nanos, "nanos")).toBe(1_700_000_000_123_456_789n);
    expect(nanos.isAdjustedToUTC).toBe(false);
  });

  it("parses ISO strings with unit precision and rejects invalid values", () => {
    expect(timestampValueFromIso("not-a-timestamp")).toBeUndefined();
    expect(timestampValueFromIso("2024-99-99T00:00:00Z")).toBeUndefined();
    expect(timestampValueFromIso("2024-01-02T03:04:05Z")).toMatchObject({
      unit: "millis",
      epochNanoseconds: 1_704_164_645_000_000_000n,
    });
    expect(timestampValueFromIso("2024-01-02T03:04:05.123456Z")).toMatchObject({
      unit: "micros",
      epochNanoseconds: 1_704_164_645_123_456_000n,
    });
    expect(timestampValueFromIso("2024-01-02T03:04:05.123456789Z")).toMatchObject({
      unit: "nanos",
      epochNanoseconds: 1_704_164_645_123_456_789n,
    });
  });

  it("compares and identifies timestamp-like values structurally", () => {
    const earlier = new TimestampValue(10n, "nanos");
    const later = new TimestampValue(20n, "nanos");

    expect(compareTimestampValues(earlier, later)).toBe(-1);
    expect(compareTimestampValues(later, earlier)).toBe(1);
    expect(compareTimestampValues(earlier, new TimestampValue(10n, "millis"))).toBe(0);
    expect(isTimestampValue(earlier)).toBe(true);
    expect(isTimestampValue({ epochNanoseconds: 1n, unit: "days", isAdjustedToUTC: true })).toBe(
      false,
    );
    expect(isTimestampValue({ epochNanoseconds: 1, unit: "nanos", isAdjustedToUTC: true })).toBe(
      false,
    );
  });
});
