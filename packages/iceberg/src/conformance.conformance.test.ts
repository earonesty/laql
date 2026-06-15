import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { memoryStore } from "@laql/core";
import { EXTERNAL_CONFORMANCE, externalFixturePath } from "@laql/fixtures";
import { describe, expect, it } from "vitest";
import { loadIcebergTable } from "./index.js";

const icebergReferenceDir = externalFixturePath(EXTERNAL_CONFORMANCE.icebergReferenceDir);
const jsonFiles = existsSync(icebergReferenceDir)
  ? listFiles(icebergReferenceDir).filter((path) => path.endsWith(".json"))
  : [];
const metadataFiles = jsonFiles.filter(
  (path) => path.endsWith(".metadata.json") || basename(path) === "metadata.json",
);
const describeExternal =
  process.env.LAQL_CONFORMANCE === "1" && metadataFiles.length > 0 ? describe : describe.skip;

describeExternal("iceberg reference warehouse conformance", () => {
  it.each(metadataFiles)("loads and plans %s", async (metadataFile) => {
    const store = memoryStore();
    for (const file of jsonFiles) {
      await store.put(relative(icebergReferenceDir, file), readFileSync(file));
    }

    const table = await loadIcebergTable({
      store,
      metadataPath: relative(icebergReferenceDir, metadataFile),
    });

    expect(table.planFiles().snapshotId).toBe(table.metadata["current-snapshot-id"]);
  });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}
