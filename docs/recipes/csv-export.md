# Recipe: CSV Export

The current CLI exports JSON and NDJSON. For CSV, stream rows and format at the application boundary:

```ts
const headers = ["store_id", "amount"];
console.log(headers.join(","));
for await (const row of lake.path("sales.parquet").select(headers).rows()) {
  console.log(headers.map((header) => JSON.stringify(row[header] ?? "")).join(","));
}
```

This keeps CSV escaping policy under caller control.
