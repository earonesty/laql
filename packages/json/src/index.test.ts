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

  it("normalizes object arrays and browser byte inputs across explicit formats", async () => {
    await expect(readJsonObjects([{ id: 1, nested: { ok: true } }])).resolves.toEqual([
      { id: 1, nested: { ok: true } },
    ]);
    const arrayBuffer = new TextEncoder().encode('[{"id":4}]').buffer;
    await expect(readJsonObjects(arrayBuffer)).resolves.toEqual([{ id: 4 }]);
    const viewBytes = new TextEncoder().encode('{"id":5}');
    const view = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength);
    await expect(readJsonObjects(view)).resolves.toEqual([{ id: 5 }]);
    await expect(
      readJsonObjects(new Uint8Array(new TextEncoder().encode('{"id":1}\n{"id":2}\n')), {
        format: "ndjson",
      }),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    await expect(
      readJsonObjects(new Blob([JSON.stringify([{ id: 3, tags: ["x"] }])]), { format: "json" }),
    ).resolves.toEqual([{ id: 3, tags: ["x"] }]);
    await expect(readJsonObjects("")).resolves.toEqual([]);
  });

  it("falls back from auto JSON parsing to NDJSON when text starts like JSON", async () => {
    await expect(readJsonObjects('{"id":1}\n{"id":2}')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("creates a queryable Lake from browser-friendly JSON inputs", async () => {
    const lake = await createJsonLake(
      {
        uploads: new TextEncoder().encode(
          '[{"id":1,"amount":10,"region":"west"},{"id":2,"amount":30,"region":"east"},{"id":3,"amount":50,"region":"west"}]',
        ),
      },
      {
        queryId: () => "json-query",
        policy: { maxRowsPerBatch: 2 },
        budget: { maxRowsDecoded: 10 },
        substrate: "node",
        now: () => new Date("2024-01-01T00:00:00Z"),
        maxRows: 10,
        maxBytes: 10_000,
      },
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
    await expect(readJsonObjects({ id: undefined })).rejects.toMatchObject({
      code: "LAKEQL_VALIDATION_ERROR",
      details: { rowNumber: 1, column: "id", valueType: "undefined" },
    });
    await expect(readJsonObjects("[]", { format: "csv" as never })).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
    await expect(readJsonObjects("[]", { maxRows: 0 })).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
    await expect(readJsonObjects("[]", { maxBytes: 0 })).rejects.toMatchObject({
      code: "LAKEQL_TYPE_ERROR",
    });
  });
});
