# Recipe: Append Events

Write events to partitioned Parquet, then append those files to Iceberg metadata:

```ts
const written = await writePartitionedParquet(store, "events", {
  rows,
  partitionBy: ["date"],
  jobId: "events_2026_01_01",
});

await table.appendFiles({
  jobId: "events_2026_01_01",
  files: written.files.map((file) => ({
    path: file.path,
    partition: file.partitionValues,
    recordCount: file.rowCount,
    fileSizeInBytes: file.byteSize,
  })),
});
```
