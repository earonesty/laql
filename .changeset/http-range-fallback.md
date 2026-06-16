---
"@laql/http": patch
---

Make `httpStore` robust against static hosts that compress responses and treat
`Range` as advisory (e.g. GitHub Pages), which previously corrupted Parquet
reads with "footer != PAR1":

- `head()` now derives object size from a 1-byte ranged GET's `content-range`
  total instead of a `HEAD`'s `content-length`. Under transparent compression a
  `HEAD` reports the *compressed* size, but range reads operate on the
  uncompressed object — using the compressed size made the reader scan the
  wrong region.
- `getRange()` slices the response client-side when a server ignores `Range` and
  returns `200` with the full body, instead of returning the whole object as if
  it were the requested window.
