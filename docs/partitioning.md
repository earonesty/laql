# Partitioning

Hive partition paths are exposed through `lake.hive()` and participate in partition pruning.

```ts
const rows = await lake
  .hive("hive/**/*.parquet")
  .where(eq("country", "US"))
  .toArray();
```

Partition values are merged into scanned rows, and physical column projection avoids reading partition columns from the file when they come from the path.

Parquet writes can partition output with `partitionBy`, producing paths such as:

```txt
out/country=US/part-000000.parquet
```
