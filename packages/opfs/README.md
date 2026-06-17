# lakeql-opfs

Optional OPFS-backed persistent cache adapters for browser runtimes.

## Public Surface

- `opfsByteCache(options)` stores `Uint8Array` cache values.
- `opfsJsonCache<T>(options)` stores JSON-compatible cache values.

Both adapters implement `CacheAdapter<T>` from `lakeql-core`, so they can be
passed to runtime cache slots such as `planningCache`. Non-JSON values should use
`opfsByteCache` with caller-owned encoding.
