# Writing Iceberg

Iceberg append support accepts already-written data files and creates the next metadata and manifest objects through an `IcebergCommitCatalog`.

```ts
const result = await table.appendFiles({
  jobId: "job_append_1",
  files: [
    {
      path: "data/new-file.parquet",
      partition: { country: "US" },
      recordCount: 100,
      fileSizeInBytes: 4096,
    },
  ],
});
```

The default catalog writes through the configured ObjectStore. Production catalogs should enforce compare-and-swap semantics around the current metadata pointer.
