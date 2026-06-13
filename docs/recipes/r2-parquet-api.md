# Recipe: R2 Parquet API

This Worker reads Parquet rows from R2 and returns JSON.

```ts
import { createLake } from "laql/cloudflare";
import { r2Store } from "@laql/r2";

export default {
  async fetch(_request: Request, env: { DATA: R2Bucket }) {
    const lake = createLake({ store: r2Store(env.DATA), budget: { maxOutputRows: 1000 } });
    return Response.json(await lake.path("sales.parquet").limit(100).toArray());
  },
};
```

Fixture equivalent:

```sh
pnpm build
node packages/cli/dist/bin.js query --path fixtures/data/sales.parquet --sql "select store_id, amount limit 2" --format json
```
