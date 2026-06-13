# Performance

LaQL keeps reads bounded by batches and row groups. Projection is derived from `select`, `where`, and `orderBy`, so scans only request needed physical columns where the Parquet adapter can do so.

Use `explain()` to inspect planned files and projected columns:

```ts
const explanation = await lake.path("sales.parquet").select(["amount"]).explain();
console.log(explanation.text);
```

Budgets can cap files, bytes, decoded rows, returned rows, range requests, elapsed time, buffered rows, and serialized operator memory.
