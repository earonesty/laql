# Recipe: R2 Iceberg API

Plan an Iceberg table from metadata stored in R2:

```ts
import { eq } from "@laql/core";
import { loadIcebergTable } from "@laql/iceberg";
import { r2Store } from "@laql/r2";

const table = await loadIcebergTable({
  store: r2Store(env.DATA),
  metadataPath: "warehouse/places/metadata/v2.metadata.json",
});

const plan = table.planFiles({
  ref: "main",
  where: eq("country", "US"),
  readMode: "ignore-deletes",
});
```

Fixture metadata is at `fixtures/data/iceberg/warehouse/places/metadata/v2.metadata.json`.
