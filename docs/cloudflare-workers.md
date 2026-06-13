# Cloudflare Workers

Use the `laql/cloudflare` subpath for Worker-oriented imports and `@laql/r2` for R2-backed object access.

```ts
import { createLake } from "laql/cloudflare";
import { r2Store } from "@laql/r2";

export default {
  async fetch(_request: Request, env: { DATA: R2Bucket }) {
    const lake = createLake({ store: r2Store(env.DATA) });
    const rows = await lake.path("sales.parquet").limit(10).toArray();
    return Response.json(rows);
  },
};
```

For queue-sized work, use `query.run({ slice })` and pass the returned bookmark through your queue or durable state. New bookmarks include the query shape, so a later invocation can call `lake.resume(bookmark).run({ slice: { maxRows } })`.
