# Query Language

The fluent query API builds a logical plan:

```ts
lake
  .path("sales.parquet")
  .select(["store_id", "amount"])
  .where(and(eq("region", "west"), gt("amount", 100)))
  .orderBy([{ column: "amount", direction: "desc" }])
  .limit(10);
```

Expressions are plain serializable objects. Use helpers from `lakeql-core` for comparisons, logical operators, null checks, `like`, `ilike`, `between`, `in`, and scalar function calls.

Constrained joins are available as explicit helpers:

```ts
await broadcastJoin(events, users, {
  leftKey: "user_id",
  rightKey: "user_id",
  maxRightRows: 100_000,
});

await lookupJoin(events, lookupUserRows, {
  leftKey: "user_id",
  rightKey: "user_id",
  maxRightRows: 100_000,
});
```
