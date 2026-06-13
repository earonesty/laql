# Writing Parquet

Use `writePartitionedParquet` for deterministic partitioned Parquet output.

```ts
import { memoryStore } from "@laql/core";
import { writePartitionedParquet } from "@laql/parquet";

const store = memoryStore();
const result = await writePartitionedParquet(store, "out/sales", {
  rows,
  partitionBy: ["region"],
  maxRowsPerFile: 1000,
  jobId: "job_2026_01_01",
});
```

Output paths include partition values and deterministic file ordinals. The returned file list can be converted to output-manifest entries with `partitionedParquetOutputEntries`.
