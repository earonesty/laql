# SQL Dialect

The SQL parser covers the engine-facing subset used by the CLI:

```sql
from input
select store_id, amount
where region = 'west'
order by amount asc
limit 2
```

The CLI also accepts omitted `from input` and injects the `--path` as the source.

```sh
node packages/cli/dist/bin.js query \
  --path fixtures/data/sales.parquet \
  --sql "select store_id, amount where region = 'west' order by amount asc limit 2"
```
