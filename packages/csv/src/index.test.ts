import { eq, gt } from "lakeql-core";
import { describe, expect, it } from "vitest";
import { createCsvLake, readCsvObjects } from "./index.js";

describe("CSV ingest", () => {
  it("reads headered CSV with quoted fields, nulls, and type sniffing", async () => {
    await expect(
      readCsvObjects('id,active,amount,label\n1,true,12.5,"west, large"\n2,false,,east\n'),
    ).resolves.toEqual([
      { id: 1, active: true, amount: 12.5, label: "west, large" },
      { id: 2, active: false, amount: null, label: "east" },
    ]);
  });

  it("supports explicit delimiter and headerless CSV", async () => {
    await expect(
      readCsvObjects("1;Alice\n2;Bob\n", { delimiter: ";", header: false }),
    ).resolves.toEqual([
      { column1: 1, column2: "Alice" },
      { column1: 2, column2: "Bob" },
    ]);
  });

  it("creates a queryable Lake from browser-friendly CSV inputs", async () => {
    const lake = await createCsvLake(
      {
        uploads: new TextEncoder().encode("id,amount,region\n1,10,west\n2,30,east\n3,50,west\n"),
      },
      { queryId: () => "csv-query" },
    );
    const result = lake.path("uploads").select(["id"]).where(gt("amount", 20)).run();

    await expect(result.toArray()).resolves.toEqual([{ id: 2 }, { id: 3 }]);
    expect(result.stats).toMatchObject({
      queryId: "csv-query",
      filesPlanned: 1,
      filesRead: 1,
      rowsDecoded: 3,
      rowsMatched: 2,
      rowsReturned: 2,
    });
  });

  it("keeps multiple CSV tables isolated behind the in-memory scanner", async () => {
    const lake = await createCsvLake({
      "uploads/a.csv": "id,kind\n1,a\n",
      "uploads/b.csv": "id,kind\n2,b\n",
    });

    await expect(
      lake.path("uploads/*").select(["kind"]).where(eq("id", 2)).toArray(),
    ).resolves.toEqual([{ kind: "b" }]);
  });

  it("enforces CSV ingest budgets", async () => {
    await expect(readCsvObjects("id\n1\n2\n", { maxRows: 1 })).rejects.toMatchObject({
      code: "LAKEQL_BUDGET_EXCEEDED",
      details: { metric: "csv rows", limit: 1, actual: 2 },
    });
    await expect(readCsvObjects("id\n123\n", { maxBytes: 1 })).rejects.toMatchObject({
      code: "LAKEQL_BUDGET_EXCEEDED",
      details: { metric: "csv bytes", limit: 1 },
    });
  });

  it("rejects malformed and ragged CSV instead of guessing", async () => {
    await expect(readCsvObjects('id,name\n1,"unterminated')).rejects.toMatchObject({
      code: "LAKEQL_PARSE_ERROR",
    });
    await expect(readCsvObjects("id,name\n1,Alice,extra\n")).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
      details: { rowNumber: 2, expectedColumns: 2, actualColumns: 3 },
    });
  });
});
