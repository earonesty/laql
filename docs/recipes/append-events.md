# Recipe: Append Events

Write events to partitioned Parquet, then append those files to Iceberg metadata:

```ts
import { memoryStore } from "@laql/core";
import { writePartitionedParquet } from "@laql/parquet";

const store = memoryStore();
const rows = [
  { id: 1, date: "2026-01-01", event: "view" },
  { id: 2, date: "2026-01-02", event: "click" },
];

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

In production, `table` is the Iceberg table handle loaded from your catalog or object
store. The fixture harness verifies the partitioned write path and Iceberg fixture
planning separately.
