import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const parquetTestingRepo = "https://github.com/apache/parquet-testing.git";
const parquetTestingBranch = "master";
const parquetTestingDest = fileURLToPath(new URL("../external/parquet-testing/", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

if (existsSync(parquetTestingDest) && !force) {
  console.error(
    `External parquet-testing fixtures already exist at ${parquetTestingDest}. Pass --force to replace them.`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(
    `would fetch ${parquetTestingRepo}#${parquetTestingBranch} into ${parquetTestingDest}`,
  );
  process.exit(0);
}

const tempRoot = fileURLToPath(new URL(`laql-external-${process.pid}/`, `file://${tmpdir()}/`));
const checkout = join(tempRoot, "parquet-testing");

rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });

try {
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    parquetTestingBranch,
    parquetTestingRepo,
    checkout,
  ]);
  rmSync(join(checkout, ".git"), { recursive: true, force: true });
  mkdirSync(dirname(parquetTestingDest), { recursive: true });
  rmSync(parquetTestingDest, { recursive: true, force: true });
  cpSync(checkout, parquetTestingDest, { recursive: true });
  console.log(`fetched parquet-testing fixtures into ${parquetTestingDest}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}
