# DuckDB-WASM Parity Plan — expand the footprint without bloating core

Goal: grow lakeql's addressable footprint by closing the parity gaps that block the
**most common duckdb-wasm browser use cases**, while keeping the "dependency-light,
no-WASM, runtime-agnostic, never-wrong" posture that is our actual advantage.

The bar is *not* "everything DuckDB does." It is: **the browser jobs people
reach for duckdb-wasm for today should work in lakeql**, and every new dependency
should be **lazily loaded only when a query needs it** — never in the static
edge graph.

> Guiding rule: adopt solved problems, keep correctness and resource limits
> non-negotiable, and **pay for a module only when you use it**.

---

## Why this plan exists — how people actually use duckdb-wasm

Three dominant patterns across the ecosystem:

1. **"Bring your own file" ad-hoc analysis** — upload/drag a CSV/JSON/Parquet,
   run SQL, no server. Data journalism, SQL teaching, "explore this export."
2. **Interactive dashboards / BI** — data loaded once as **Apache Arrow**, then
   queried on every filter change; results flow zero-copy into charting libs
   (Observable Plot, Perspective, Arquero). Arrow is duckdb-wasm's data protocol
   for *both* ingest and query results.
3. **Remote lake querying at the edge** — range-read Parquet on S3/GCS/R2,
   schema previews, Parquet-inspector extensions.

**lakeql already wins #3** — and beats duckdb-wasm there: no 4 GB/tab WASM ceiling,
real spill, resumable bookmarks, Iceberg-native reads. The footprint problem is
that **#1 and #2 — the majority of browser duckdb-wasm usage — are currently
impossible in lakeql**: it reads only Parquet + Iceberg and emits only
rows/NDJSON/CSV/Parquet.

---

## Design principle: smart-load everything optional

Today lakeql's loading strategy is **partial and inconsistent**:

- ✅ Lazy where it counts: `avsc` is `await import()`-ed only when an Iceberg
  table actually has Avro manifests (`packages/iceberg/src/index.ts`); the
  Cloudflare driver is dynamically imported in the workerd entry.
- ✅ Package-level separation: `lakeql-parquet`, `lakeql-iceberg`, `lakeql-sql`
  are separate packages, so you only bundle what you import.
- ❌ **Eager anti-pattern:** geospatial is statically imported straight into
  `lakeql-core`'s evaluator — `@turf/boolean-contains`, `@turf/boolean-intersects`,
  and `h3-js` (`packages/core/src/evaluator.ts:1-3`) are hard `lakeql-core`
  dependencies. **Every** core consumer bundles turf + h3-js even if it never
  calls an `st_*` / `h3_*` function. That directly undercuts the
  "dependency-light" pitch for the typical "query Parquet on R2" user.

**The principle for all parity work below:** follow the `avsc` precedent, not the
geo anti-pattern. Every new format reader and every new output encoder is either
(a) its own package, or (b) behind a dynamic `import()` triggered only by the API
call / function / format that needs it. The core static graph must not grow.

### Companion cleanup (do alongside Tier 1) — de-bundle geo from core into `lakeql-geo`

Move `@turf/*` + `h3-js` out of `lakeql-core`'s static graph and into the existing
**`lakeql-geo`** package as an opt-in function pack: the host registers `st_*` /
`h3_*` only when it needs them, and turf/h3 load lazily (the `avsc` pattern). Net
result: a `lakeql-core` build that ships zero geospatial weight unless a query
uses it. This is the proof-of-concept for the smart-load principle and should land
with Tier 1 so the pattern is established before new modules arrive.

---

## Top 10 parity gaps, ranked by adoption impact

### Tier 1 — table stakes (unlock whole use-case categories; do first)

Each is **independent of the lake engine** and is the highest-ROI work in the repo.

1. **Read CSV** — `read_csv`-style with type sniffing, header detection,
   delimiter/quote options. The #1 browser job. Ship as **`lakeql-csv`**
   (own package). *Status: ❌ not supported.*

2. **Read JSON / NDJSON** — auto-structure detection, arrays + line-delimited.
   Second-most-common ingest. Ship as **`lakeql-json`** (own package).
   *Status: ❌.*

3. **Ingest in-memory JS data** — register a JS array / `File` / `Blob` /
   `ArrayBuffer` / Arrow table as a queryable table (the duckdb-wasm
   `registerFileBuffer` / `insertJSONFromArray` loop). This is the core browser
   "bring your own data" interaction. *Status: ⚠️ an in-memory store exists for
   tests, but there is no ergonomic ingest API.*

4. **Apache Arrow output** — return results as an Arrow table / IPC stream
   (`.toArrow()`, `streamArrow()`). Arrow is the interop format: zero-copy into
   Plot/Perspective/Arquero, Transferable across workers, 10–100× faster than JS
   objects. **Must be lazy** — `apache-arrow` lives in a separate **`lakeql-arrow`**
   package, never in core. *Status: ❌ rows/NDJSON/CSV/Parquet only.*

### Tier 2 — SQL depth (blocks porting real analytical queries)

5. **Window functions** — `ROW_NUMBER`, `RANK`, `LAG`/`LEAD`, running sums,
   `OVER (PARTITION BY … ORDER BY …)`. Core of analytics/dashboards; the most
   conspicuous absence. *Status: ❌ rejected.*

6. **Broader JOINs** — N-way, `RIGHT` / `FULL` / `CROSS`, non-equi predicates.
   Real queries join 3+ tables / dimension tables. *Status: ⚠️ bounded two-table
   inner/left equi-join only.*

7. **Richer function library** — regex (`regexp_matches`/`regexp_replace`),
   statistical aggregates (`stddev`, `var`, `median`, `quantile`, `mode`), more
   date/string functions, list/struct accessors. A missing function silently
   breaks a ported query. *Status: ⚠️ ~30 scalar fns + basic aggs.*

### Tier 3 — ergonomics & retention

8. **Parameterized / prepared statements** — `$1` / named params bound per
   filter change without string-building SQL. Standard duckdb-wasm dashboard
   pattern; also the safe one. *Status: ⚠️ JSON query API, no param-binding
   story.*

9. **`DESCRIBE` / `SUMMARIZE` / `SAMPLE` as SQL** — the "preview an unknown file"
   workflow (Parquet-inspector extensions, first look at any dataset). *Status:
   ⚠️ partial via CLI `inspect`, not exposed as SQL.*

10. **OPFS / persistent local cache** — duckdb-wasm persists tables in OPFS so
    reloads are instant. lakeql's edge cache story is strong but lacks a
    browser-persistence tier for repeated local querying. Ship as an optional
    cache adapter (smart-loaded), not core. *Status: ❌.*

---

## Sequencing

- **Tier 1 (#1–4) + geo de-bundle** is the strategic move: it converts lakeql from
  "edge lake engine" into "drop-in duckdb-wasm alternative for the browser," and
  establishes the smart-load principle on a real case (`lakeql-arrow`) before more
  modules arrive.
- **Tier 2 (#5–7)** is where DuckDB users hit a wall porting queries. Window
  functions first — an analytics engine without them looks unfinished.
- **Tier 3 (#8–10)** is retention polish.

## Confirmed packaging decisions

- Arrow output ships as **`lakeql-arrow`** (separate package; `apache-arrow` never
  enters the core static graph).
- Geo de-bundle target is the existing **`lakeql-geo`** package (opt-in function
  pack; turf + h3-js leave `lakeql-core`).

## Non-negotiables

- **Never silently wrong:** unsupported CSV/JSON shapes, Arrow types we can't map,
  etc. get a typed `LAQL_*` rejection — same discipline as Parquet/Iceberg today.
- **Resource budgets apply to ingest too:** in-memory + CSV/JSON ingestion must
  respect `maxBytes` / `maxBufferedRows` / spill, not load unbounded files into a
  tab.
- **Core stays lean:** if a feature adds a dependency, it is lazily loaded or in
  its own package. The edge "query Parquet on R2" bundle must not grow because we
  added a CSV reader.
