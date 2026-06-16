# Recipe: BBox Search

Use bbox predicates for coarse geospatial filtering:

```ts
import { readFile } from "node:fs/promises";
import { col, fn, lit, memoryStore } from "lakeql-core";
import { createLake } from "lakeql";

const store = memoryStore();
await store.put("data/geo.parquet", await readFile("fixtures/data/geo.parquet"));

const lake = createLake({ store });
const queryBbox = fn("st_bbox", lit(-118.5), lit(34), lit(-118), lit(34.3));
const rows = await lake
  .path("data/geo.parquet")
  .where(fn("st_intersects", col("geom"), queryBbox))
  .toArray();
```

Sidecar bbox indexes can skip files whose indexed bbox cannot intersect the query bbox.
