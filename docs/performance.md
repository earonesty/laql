# Performance

LaQL keeps reads bounded by batches and row groups. Projection is derived from `select`, `where`, and `orderBy`, so scans only request needed physical columns where the Parquet adapter can do so.

Use `explain()` to inspect planned files and projected columns:

```ts
const explanation = await lake.path("sales.parquet").select(["amount"]).explain();
console.log(explanation.text);
console.log(explanation.json.predicatePlan);
```

The JSON predicate plan classifies pruning candidates as partition, file stats, row-group stats, or residual predicates.

Parquet row-group pruning currently uses footer min/max statistics. hyparquet 1.26.0
does not expose a public dictionary-filter API; dictionary pruning should be added
when that surface becomes available without breaking row-group skip accounting.

Budgets can cap files, bytes, decoded rows, returned rows, range requests, elapsed time, buffered rows, and serialized operator memory.
