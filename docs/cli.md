# CLI

Build first so the `lakeql` bin points at compiled files:

```sh
pnpm build
```

Commands:

```sh
node packages/cli/dist/bin.js schema --path fixtures/data/sales.parquet
node packages/cli/dist/bin.js inspect --path fixtures/data/sales.parquet
node packages/cli/dist/bin.js explain --path fixtures/data/sales.parquet --sql "select amount from input where amount > 900"
node packages/cli/dist/bin.js query --path fixtures/data/sales.parquet --sql "select store_id, amount from input limit 2"
node packages/cli/dist/bin.js query --path fixtures/data/sales.parquet --sql "select store_id, amount from input limit 2" --format csv
node packages/cli/dist/bin.js query --table sales=fixtures/data/sales.parquet --table stores=/tmp/stores.parquet --sql "select s.store_id, d.segment from sales s join stores d on s.store_id = d.store_id limit 10"
node packages/cli/dist/bin.js write --path fixtures/data/sales.parquet --sql "select store_id, region, amount from input limit 2" --output /tmp/laql-out
node packages/cli/dist/bin.js write --path fixtures/data/sales.parquet --sql "select store_id, region, amount from input limit 2" --output /tmp/laql-out --manifest /tmp/laql-out-manifest.json --job-id job_cli
node packages/cli/dist/bin.js compact --path fixtures/data/sales.parquet --output /tmp/laql-compact --max-rows-per-file 75
```
