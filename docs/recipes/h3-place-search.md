# Recipe: H3 Place Search

Use the H3 fixture with the `h3_within` predicate:

```ts
import { readFile } from "node:fs/promises";
import { col, fn, lit, memoryStore } from "lakeql-core";
import { createLake } from "lakeql";

const store = memoryStore();
await store.put("data/h3.parquet", await readFile("fixtures/data/h3.parquet"));

const lake = createLake({ store });
const rows = await lake
  .path("data/h3.parquet")
  .where(fn("h3_within", col("h3_8"), lit("8829a1d757fffff"), lit(1)))
  .toArray();
```

The fixture assertion returns rows for ids `1` and `2`.
