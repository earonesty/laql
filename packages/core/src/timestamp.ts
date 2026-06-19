export type TimestampUnit = "millis" | "micros" | "nanos";

const NANOS_PER_MILLI = 1_000_000n;
const NANOS_PER_MICRO = 1_000n;

export class TimestampValue {
  readonly epochNanoseconds: bigint;
  readonly unit: TimestampUnit;
  readonly isAdjustedToUTC: boolean;

  constructor(epochNanoseconds: bigint, unit: TimestampUnit, isAdjustedToUTC = true) {
    this.epochNanoseconds = epochNanoseconds;
    this.unit = unit;
    this.isAdjustedToUTC = isAdjustedToUTC;
  }

  toJSON(): string {
    return timestampToIsoString(this);
  }

  toString(): string {
    return timestampToIsoString(this);
  }
}

export function timestampFromEpoch(
  value: bigint,
  unit: TimestampUnit,
  isAdjustedToUTC = true,
): TimestampValue {
  return new TimestampValue(epochNanoseconds(value, unit), unit, isAdjustedToUTC);
}

export function timestampValueFromIso(value: string): TimestampValue | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return undefined;
  const millis = Date.parse(`${match[1]}.000Z`);
  if (!Number.isFinite(millis)) return undefined;
  const fraction = (match[2] ?? "").padEnd(9, "0");
  const fractionNanos = fraction.length === 0 ? 0n : BigInt(fraction);
  return new TimestampValue(
    BigInt(millis) * NANOS_PER_MILLI + fractionNanos,
    unitForFraction(match[2] ?? ""),
  );
}

export function isTimestampValue(value: unknown): value is TimestampValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "epochNanoseconds" in value &&
    typeof value.epochNanoseconds === "bigint" &&
    "unit" in value &&
    (value.unit === "millis" || value.unit === "micros" || value.unit === "nanos") &&
    "isAdjustedToUTC" in value &&
    typeof value.isAdjustedToUTC === "boolean"
  );
}

export function timestampToIsoString(value: TimestampValue): string {
  const wholeMillis = value.epochNanoseconds / NANOS_PER_MILLI;
  const nanosWithinMillis = value.epochNanoseconds % NANOS_PER_MILLI;
  const millisWithinSecond = wholeMillis % 1000n;
  const secondMillis = wholeMillis - millisWithinSecond;
  const base = new Date(Number(secondMillis)).toISOString().replace(/\.\d{3}Z$/u, "");
  const nanosWithinSecond = millisWithinSecond * NANOS_PER_MILLI + nanosWithinMillis;
  const fraction = fractionForUnit(nanosWithinSecond, value.unit);
  return `${base}${fraction}Z`;
}

export function timestampEpochForUnit(value: TimestampValue, unit: TimestampUnit): bigint {
  switch (unit) {
    case "millis":
      return value.epochNanoseconds / NANOS_PER_MILLI;
    case "micros":
      return value.epochNanoseconds / NANOS_PER_MICRO;
    case "nanos":
      return value.epochNanoseconds;
  }
}

export function compareTimestampValues(left: TimestampValue, right: TimestampValue): number {
  if (left.epochNanoseconds < right.epochNanoseconds) return -1;
  if (left.epochNanoseconds > right.epochNanoseconds) return 1;
  return 0;
}

function epochNanoseconds(value: bigint, unit: TimestampUnit): bigint {
  switch (unit) {
    case "millis":
      return value * NANOS_PER_MILLI;
    case "micros":
      return value * NANOS_PER_MICRO;
    case "nanos":
      return value;
  }
}

function unitForFraction(fraction: string): TimestampUnit {
  if (fraction.length <= 3) return "millis";
  if (fraction.length <= 6) return "micros";
  return "nanos";
}

function fractionForUnit(nanos: bigint, unit: TimestampUnit): string {
  switch (unit) {
    case "millis": {
      const millis = nanos / NANOS_PER_MILLI;
      return `.${millis.toString().padStart(3, "0")}`;
    }
    case "micros": {
      const micros = nanos / NANOS_PER_MICRO;
      return `.${micros.toString().padStart(6, "0")}`;
    }
    case "nanos":
      return `.${nanos.toString().padStart(9, "0")}`;
  }
}
