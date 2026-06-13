# Recipe: BBox Search

Use bbox predicates for coarse geospatial filtering:

```ts
import { col, fn, lit } from "@laql/core";

const queryBbox = JSON.stringify([0, 0, 10, 10]);
const rows = await lake
  .path("geo.parquet")
  .where(fn("st_intersects", col("bbox"), lit(queryBbox)))
  .toArray();
```

Sidecar bbox indexes can skip files whose indexed bbox cannot intersect the query bbox.
