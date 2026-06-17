import { eq, gt } from "lakeql-core";
import { describe, expect, it } from "vitest";
import { createJsonLake, readJsonObjects } from "./index.js";

describe("JSON ingest", () => {
  it("reads JSON arrays and preserves nested JSON cell values", async () => {
    await expect(
      readJsonObjects(
        JSON.stringify([
          { id: 1, active: true, amount: 12.5, tags: ["a"], meta: { region: "west" } },
          { id: 2, active: false, amount: null, tags: [], meta: { region: "east" } },
        ]),
      ),
    ).resolves.toEqual([
      { id: 1, active: true, amount: 12.5, tags: ["a"], meta: { region: "west" } },
      { id: 2, active: false, amount: null, tags: [], meta: { region: "east" } },
    ]);
  });

  it("reads a single JSON object as one row", async () => {
    await expect(readJsonObjects({ id: 1, name: "Alice" })).resolves.toEqual([
      { id: 1, name: "Alice" },
    ]);
  });

  it("reads NDJSON records", async () => {
    await expect(readJsonObjects('{"id":1,"kind":"a"}\n{"id":2,"kind":"b"}\n')).resolves.toEqual([
      { id: 1, kind: "a" },
      { id: 2, kind: "b" },
    ]);
  });

  it("creates a queryable Lake from browser-friendly JSON inputs", async () => {
    const lake = await createJsonLake(
      {
        uploads: new TextEncoder().encode(
          '[{"id":1,"amount":10,"region":"west"},{"id":2,"amount":30,"region":"east"},{"id":3,"amount":50,"region":"west"}]',
        ),
      },
      { queryId: () => "json-query" },
    );
    const result = lake.path("uploads").select(["id"]).where(gt("amount", 20)).run();

    await expect(result.toArray()).resolves.toEqual([{ id: 2 }, { id: 3 }]);
    expect(result.stats).toMatchObject({
      queryId: "json-query",
      filesPlanned: 1,
      filesRead: 1,
      rowsDecoded: 3,
      rowsMatched: 2,
      rowsReturned: 2,
    });
  });

  it("keeps multiple JSON tables isolated behind the in-memory scanner", async () => {
    const lake = await createJsonLake({
      "uploads/a.json": [{ id: 1, kind: "a" }],
      "uploads/b.json": [{ id: 2, kind: "b" }],
    });

    await expect(
      lake.path("uploads/*").select(["kind"]).where(eq("id", 2)).toArray(),
    ).resolves.toEqual([{ kind: "b" }]);
  });

  it("enforces JSON ingest budgets", async () => {
    await expect(readJsonObjects('[{"id":1},{"id":2}]', { maxRows: 1 })).rejects.toMatchObject({
      code: "LAKEQL_BUDGET_EXCEEDED",
      details: { metric: "json rows", limit: 1, actual: 2 },
    });
    await expect(readJsonObjects('[{"id":123}]', { maxBytes: 1 })).rejects.toMatchObject({
      code: "LAKEQL_BUDGET_EXCEEDED",
      details: { metric: "json bytes", limit: 1 },
    });
  });

  it("rejects malformed JSON and unsupported row shapes", async () => {
    await expect(readJsonObjects('[{"id":1}')).rejects.toMatchObject({
      code: "LAKEQL_PARSE_ERROR",
    });
    await expect(readJsonObjects("[1,2]")).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
      details: { rowNumber: 1, valueType: "number" },
    });
    await expect(readJsonObjects('{"id":1}\nnot-json', { format: "ndjson" })).rejects.toMatchObject(
      {
        code: "LAKEQL_PARSE_ERROR",
        details: expect.objectContaining({ lineNumber: 2 }),
      },
    );
  });
});
