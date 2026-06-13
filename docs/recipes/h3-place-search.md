# Recipe: H3 Place Search

Use the H3 fixture with the `h3_within` predicate:

```ts
import { col, fn, lit } from "@laql/core";

const rows = await lake
  .path("h3.parquet")
  .where(fn("h3_within", col("h3_8"), lit("8829a1d757fffff"), lit(1)))
  .toArray();
```

The fixture assertion returns rows for ids `1` and `2`.
