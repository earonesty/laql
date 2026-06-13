# Geospatial

The current geospatial predicates operate over GeoJSON or BBox JSON strings:

```ts
fn("st_intersects", col("bbox"), lit(JSON.stringify([0, 0, 10, 10])));
fn("st_contains", col("geom"), lit(JSON.stringify({ type: "Point", coordinates: [1, 2] })));
fn("st_within", col("geom"), col("bbox"));
```

Sidecar bbox indexes can prune files for `st_intersects` when a file-level bbox cannot overlap the query bbox.
