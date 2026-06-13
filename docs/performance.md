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

For bounded top-k sorts, use `orderBy(...).limit(...).topKWithState()` to
serialize or spill the retained heap state between slices. For full global sorts,
`sortWithState()` builds sorted runs capped by `maxBufferedRows`, merges those runs
for output, and can persist each run plus the compact run manifest through a
`SpillAdapter`:

```ts
const result = await lake
  .path("events.parquet")
  .orderBy([{ column: "created_at" }])
  .sortWithState({ spill, spillId: "sort-events" });
```

Plain `orderBy().toArray()` remains available for small direct reads.
