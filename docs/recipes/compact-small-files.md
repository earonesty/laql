# Recipe: Compact Small Files

Run from the repository root:

```sh
pnpm build
node packages/cli/dist/bin.js compact \
  --path fixtures/data/sales.parquet \
  --output /tmp/lakeql-compact-sales \
  --max-rows-per-file 75
```

The sales fixture has 100 rows, so this command writes two output files with 75 and 25 rows.
