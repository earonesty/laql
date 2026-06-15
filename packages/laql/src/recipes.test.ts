import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixturePath, GEO, H3, ICEBERG, SALES } from "@laql/fixtures";
import { describe, expect, it } from "vitest";
import {
  col,
  createLake,
  fn,
  lit,
  loadIcebergTable,
  memoryStore,
  writePartitionedParquet,
} from "./index.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const recipesDir = new URL("../../../docs/recipes/", import.meta.url);
const coveredRecipes = [
  "append-events.md",
  "bbox-search.md",
  "compact-small-files.md",
  "csv-export.md",
  "h3-place-search.md",
  "ndjson-export.md",
  "r2-iceberg-api.md",
  "r2-parquet-api.md",
] as const;

describe("docs recipes", () => {
  it("keeps every recipe covered by the fixture harness", async () => {
    await expect(readdir(recipesDir)).resolves.toEqual([...coveredRecipes].sort());
  });

  it("runs the bbox and H3 API recipes against committed fixtures", async () => {
    const store = memoryStore();
    await store.put(`data/${GEO.file}`, await readFile(fixturePath(GEO.file)));
    await store.put(`data/${H3.file}`, await readFile(fixturePath(H3.file)));
    const lake = createLake({ store });

    const queryBbox = fn("st_bbox", lit(-118.5), lit(34), lit(-118), lit(34.3));
    await expect(
      lake
        .path(`data/${GEO.file}`)
        .select(["id", "name"])
        .where(fn("st_intersects", col("geom"), queryBbox))
        .toArray(),
    ).resolves.toEqual([
      { id: 1, name: "downtown" },
      { id: 2, name: "valley" },
    ]);

    await expect(
      lake
        .path(`data/${H3.file}`)
        .select(["id"])
        .where(fn("h3_within", col("h3_8"), lit("8829a1d757fffff"), lit(1)))
        .toArray(),
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("runs export and R2 Parquet fixture-equivalent CLI recipes", async () => {
    const ndjson = await runCli([
      "query",
      "--path",
      fixturePath(SALES.file),
      "--sql",
      "select store_id, amount where region = 'west' order by amount asc limit 2",
    ]);
    expect(ndjson.stdout).toBe(
      '{"store_id":"store-000","amount":0}\n{"store_id":"store-000","amount":36.28}\n',
    );

    const csv = await runCli([
      "query",
      "--path",
      fixturePath(SALES.file),
      "--sql",
      "select store_id, amount where region = 'west' order by amount asc limit 2",
      "--format",
      "csv",
    ]);
    expect(csv.stdout).toBe("store_id,amount\nstore-000,0\nstore-000,36.28\n");

    const json = await runCli([
      "query",
      "--path",
      fixturePath(SALES.file),
      "--sql",
      "select store_id, amount limit 2",
      "--format",
      "json",
    ]);
    expect(JSON.parse(json.stdout)).toEqual([
      { store_id: "store-000", amount: 0 },
      { store_id: "store-001", amount: 37.01 },
    ]);
  });

  it("runs the compact recipe against the sales fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laql-recipe-compact-"));
    try {
      const output = join(dir, "sales");
      const result = await runCli([
        "compact",
        "--path",
        fixturePath(SALES.file),
        "--output",
        output,
        "--max-rows-per-file",
        "75",
      ]);

      const body = JSON.parse(result.stdout) as { files: { path: string; rowCount: number }[] };
      expect(body.files.map((file) => file.rowCount)).toEqual([75, 25]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs the append-events and R2 Iceberg fixture-equivalent recipes", async () => {
    const writeStore = memoryStore();
    const written = await writePartitionedParquet(writeStore, "events", {
      rows: [
        { id: 1, date: "2026-01-01", event: "view" },
        { id: 2, date: "2026-01-02", event: "click" },
      ],
      partitionBy: ["date"],
      jobId: "events_2026_01_01",
    });
    expect(written.files.map((file) => file.rowCount)).toEqual([1, 1]);

    const icebergStore = memoryStore();
    await icebergStore.put(ICEBERG.metadataFile, await readFile(fixturePath(ICEBERG.metadataFile)));
    await icebergStore.put(
      ICEBERG.manifestListFile,
      await readFile(fixturePath(ICEBERG.manifestListFile)),
    );
    for (const manifestFile of ICEBERG.manifestFiles) {
      await icebergStore.put(manifestFile, await readFile(fixturePath(manifestFile)));
    }

    const table = await loadIcebergTable({
      store: icebergStore,
      metadataPath: ICEBERG.metadataFile,
    });
    expect(table.planFiles({ ref: "main", readMode: "ignore-deletes" }).files.length).toBe(3);
  });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, ["packages/cli/dist/bin.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
