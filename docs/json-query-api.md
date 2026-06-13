# JSON Query API

`lake.query()` accepts versioned JSON query objects.

```ts
const query = lake.query({
  version: 1,
  from: "sales.parquet",
  select: ["store_id", "amount"],
  where: { gt: ["amount", 100] },
  orderBy: [{ column: "amount", direction: "desc" }],
  limit: 10,
});
```

Invalid shapes throw typed `LAQL_PARSE_ERROR` or `LAQL_TYPE_ERROR` errors depending on where validation fails.
