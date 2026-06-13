# Cache

Core cache adapters are runtime-neutral. `memoryCache()` is useful for tests and local processes. `cacheApiCache()` wraps the Web Cache API for Worker-style runtimes.

Parquet metadata caches can be passed to `createParquetLake`:

```ts
const lake = createParquetLake({
  store,
  metadataCache: memoryCache(),
});
```

Cache entries use caller-owned TTL behavior and typed cache references.
