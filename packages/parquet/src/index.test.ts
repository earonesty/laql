import { readFileSync } from "node:fs";
import { eq, gt, LaQLError, memoryStore } from "@laql/core";
import { fixturePath, SALES, TYPES, WIDE } from "@laql/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { createParquetLake, readParquetMetadata, readParquetObjects } from "./index.js";

const store = memoryStore();

beforeAll(async () => {
  await store.put(`data/${SALES.file}`, readFileSync(fixturePath(SALES.file)));
  await store.put(`data/copy-${SALES.file}`, readFileSync(fixturePath(SALES.file)));
  await store.put(`data/${TYPES.file}`, readFileSync(fixturePath(TYPES.file)));
  await store.put(`data/${WIDE.file}`, readFileSync(fixturePath(WIDE.file)));
});

describe("readParquetObjects", () => {
  it("reads all rows from the sales fixture", async () => {
    const rows = await readParquetObjects(store, `data/${SALES.file}`);
    expect(rows).toHaveLength(SALES.rows);
    expect(rows[0]).toMatchObject({ store_id: "store-000", region: "west" });
  });

  it("projects columns", async () => {
    const rows = await readParquetObjects(store, `data/${SALES.file}`, {
      columns: ["region", "amount"],
    });
    expect(Object.keys(rows[0] as object).sort()).toEqual(["amount", "region"]);
  });

  it("respects rowStart/rowEnd", async () => {
    const rows = await readParquetObjects(store, `data/${SALES.file}`, {
      rowStart: 10,
      rowEnd: 15,
    });
    expect(rows).toHaveLength(5);
  });

  it("decodes the full type matrix, including int64 past MAX_SAFE_INTEGER", async () => {
    const rows = await readParquetObjects(store, `data/${TYPES.file}`);
    expect(rows).toHaveLength(TYPES.rows);
    const first = rows[0] as Record<string, unknown>;
    expect(first.id).toBe(0);
    expect(first.big).toBe(9007199254740991n);
    expect(first.flag).toBe(true);
    expect(first.name).toBeNull();
    const last = rows[TYPES.rows - 1] as Record<string, unknown>;
    expect(last.big).toBe(9007199254740991n + BigInt(TYPES.rows - 1));
  });

  it("fails loudly with LAQL_OBJECT_NOT_FOUND on a missing object", async () => {
    await expect(readParquetObjects(store, "data/nope.parquet")).rejects.toMatchObject({
      code: "LAQL_OBJECT_NOT_FOUND",
    });
  });

  it("wraps decode failures in LAQL_PARQUET_READ_ERROR", async () => {
    await store.put("data/garbage.parquet", new TextEncoder().encode("not parquet bytes"));
    await expect(readParquetObjects(store, "data/garbage.parquet")).rejects.toThrowError(LaQLError);
    await expect(readParquetObjects(store, "data/garbage.parquet")).rejects.toMatchObject({
      code: "LAQL_PARQUET_READ_ERROR",
    });
  });
});

describe("createParquetLake", () => {
  it("queries projected rows from a path", async () => {
    const lake = createParquetLake({ store, queryId: () => "test-query" });
    const rows = await lake
      .path(`data/${SALES.file}`)
      .select(["store_id", "amount"])
      .where(eq("region", "west"))
      .limit(3)
      .toArray();

    expect(rows).toEqual([
      { store_id: "store-000", amount: 0 },
      { store_id: "store-004", amount: 148.04 },
      { store_id: "store-001", amount: 296.08 },
    ]);
  });

  it("expands globs over ObjectStore.list in deterministic order", async () => {
    const lake = createParquetLake({ store });
    const count = await lake.path("data/*sales.parquet").where(gt("amount", 900)).count();
    const single = await lake.path(`data/${SALES.file}`).where(gt("amount", 900)).count();
    expect(count).toBe(single * 2);
  });

  it("streams NDJSON and JSON with unsafe int64 mapped safely", async () => {
    const lake = createParquetLake({ store });
    const ndjson = await new Response(
      lake.path(`data/${TYPES.file}`).select(["id", "big"]).limit(1).streamNdjson(),
    ).text();
    expect(ndjson).toBe('{"id":0,"big":9007199254740991}\n');

    const json = await new Response(
      lake.path(`data/${TYPES.file}`).select(["id", "big"]).offset(2).limit(1).streamJson(),
    ).text();
    expect(json).toBe('[{"id":2,"big":"9007199254740993"}]');
  });

  it("accepts JSON query v1 and records stats", async () => {
    const lake = createParquetLake({ store, queryId: () => "json-query" });
    const result = lake.query({
      version: 1,
      from: `data/${SALES.file}`,
      select: ["region", "amount"],
      where: { eq: ["region", "east"] },
      limit: 2,
    });
    expect(await result.toArray()).toEqual([
      { region: "east", amount: 37.01 },
      { region: "east", amount: 185.05 },
    ]);
    expect(result.run().stats.queryId).toBe("json-query");
  });

  it("keeps emitted batches bounded by the caller batch size", async () => {
    const lake = createParquetLake({ store });
    const sizes: number[] = [];
    for await (const batch of lake.path(`data/${WIDE.file}`).batchSize(5).batches()) {
      sizes.push(batch.length);
      expect(batch.length).toBeLessThanOrEqual(5);
      expect(Object.keys(batch[0] as object)).toHaveLength(WIDE.columns);
    }
    expect(sizes).toEqual([5, 5, 5, 5, 4]);
  });

  it("enforces typed query budgets", async () => {
    const lake = createParquetLake({ store, budget: { maxRowsDecoded: 2 } });
    await expect(lake.path(`data/${SALES.file}`).toArray()).rejects.toMatchObject({
      code: "LAQL_BUDGET_EXCEEDED",
    });
  });

  it("rejects invalid JSON queries with LAQL_PARSE_ERROR", () => {
    const lake = createParquetLake({ store });
    expect(() => lake.query({ version: 2, from: `data/${SALES.file}` })).toThrowError(LaQLError);
    expect(() => lake.query({ version: 2, from: `data/${SALES.file}` })).toThrowError(
      /version must be 1/u,
    );
  });
});

describe("readParquetMetadata", () => {
  it("sees the row-group layout the fixture generator promised", async () => {
    const meta = await readParquetMetadata(store, `data/${SALES.file}`);
    expect(Number(meta.num_rows)).toBe(SALES.rows);
    const expectedGroups = Math.ceil(SALES.rows / SALES.rowGroupSize);
    expect(meta.row_groups).toHaveLength(expectedGroups);
  });
});
