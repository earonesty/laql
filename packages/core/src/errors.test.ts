import { describe, expect, it } from "vitest";
import { ERROR_CODES, isLakeqlError, LakeqlError } from "./errors.js";

describe("LakeqlError", () => {
  it("carries code, message, and details", () => {
    const err = new LakeqlError("LAKEQL_BUDGET_EXCEEDED", "Query would scan 14,822 files.", {
      filesPlanned: 14822,
      maxFiles: 500,
    });
    expect(err.code).toBe("LAKEQL_BUDGET_EXCEEDED");
    expect(err.message).toContain("14,822");
    expect(err.details.maxFiles).toBe(500);
    expect(err.name).toBe("LakeqlError");
  });

  it("defaults details to an empty object", () => {
    const err = new LakeqlError("LAKEQL_PARSE_ERROR", "bad input");
    expect(err.details).toEqual({});
  });

  it("is an Error and survives instanceof across catch", () => {
    try {
      throw new LakeqlError("LAKEQL_UNKNOWN_TABLE", "no such table");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(LakeqlError);
    }
  });

  it("isLakeqlError narrows correctly", () => {
    expect(isLakeqlError(new LakeqlError("LAKEQL_TYPE_ERROR", "x"))).toBe(true);
    expect(isLakeqlError(new Error("x"))).toBe(false);
    expect(isLakeqlError(null)).toBe(false);
    expect(isLakeqlError("LAKEQL_TYPE_ERROR")).toBe(false);
  });

  it("every spec error code is unique and LAKEQL_-prefixed", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^LAKEQL_[A-Z_]+$/);
    }
  });
});
