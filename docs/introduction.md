# lakeql

lakeql is a TypeScript query engine for Parquet and Iceberg data on object storage. The current implementation focuses on deterministic reads, pruning, resumable slices, writes to Parquet, and runtime adapters for local stores, HTTP, R2, and S3.

Use the umbrella package for application code:

```ts
import { createLake, eq, memoryStore } from "lakeql";
```

Use the package-specific entry points when you need lower-level control:

```ts
import { Lake, memoryStore } from "lakeql-core";
import { createParquetLake } from "lakeql-parquet";
import { loadIcebergTable } from "lakeql-iceberg";
```

The fixture suite under `fixtures/data/` is the canonical set for examples and tests.
