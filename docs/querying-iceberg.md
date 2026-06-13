# Querying Iceberg

Iceberg support plans deterministic data files from metadata JSON fixtures and applies snapshot selection, schema projection, partition pruning, and strict delete-file handling.

```ts
import { eq, memoryStore } from "@laql/core";
import { loadIcebergTable } from "@laql/iceberg";

const table = await loadIcebergTable({
  store,
  metadataPath: "iceberg/warehouse/places/metadata/v2.metadata.json",
});

const plan = table.planFiles({
  ref: "main",
  select: ["id", "country"],
  where: eq("country", "US"),
  readMode: "ignore-deletes",
});
```

Strict mode throws `LAQL_UNSUPPORTED_DELETE_FILES` when a planned file has delete files. Use `ignore-deletes` only when raw scans are acceptable.
