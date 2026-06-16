# Recipe: NDJSON Export

Run from the repository root:

```sh
pnpm build
node packages/cli/dist/bin.js query \
  --path fixtures/data/sales.parquet \
  --sql "select store_id, amount from input where region = 'west' order by amount asc limit 2"
```

Expected fixture output:

```jsonl
{"store_id":"store-000","amount":0}
{"store_id":"store-000","amount":36.28}
```
