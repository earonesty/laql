# SQL Plan — adopt a real parser, grow to "pretty damn good"

Goal: make `lakeql`'s SQL **feel like real SQL** and execute a meaningfully rich
subset correctly — without chasing full DuckDB parity. The bar is *"pretty damn
good and never wrong"*: standard syntax, the common analytical shapes, and a
**typed rejection** for anything we can't execute (never silently wrong rows).

This plan has two tracks that must move together:

- **Parser** — replace the hand-rolled FROM-first grammar with a maintained,
  standard-SQL parser.
- **Engine** — grow `@laql/core` so the parser has more it can legitimately map
  onto. The engine, not the parser, is the real limiter.

> Guiding rule (unchanged from `NEEDED.md`): hand-roll glue, not languages. A
> parser is a solved problem; adopt one. Keep correctness and resource limits
> non-negotiable.

---

## Where we are today

**Parser (`@laql/sql`)** — `pgsql-ast-parser` behind the existing `parseSql()`
entry point, with LaQL-owned input-length / AST-depth guards. Supports standard
`SELECT … FROM … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT … OFFSET …` for
the existing engine-facing AST (`select`, `where`, `orderBy`, `offset`,
`limit`, `groupBy`, `aggregates`, `having`). CLI + playground only; not in the
edge library bundle.

**Engine (`@laql/core`)** — already executes more than the dialect exposes:

- Projection / filter / order / offset / limit (`QueryBuilder`).
- **Aggregation**: `groupBy(cols).aggregate(spec)` with ops `count, sum, avg,
  min, max, count_distinct, approx_count_distinct, first, last, any`, with
  operator-state spill (`AggregateOptions.operatorState`).
- **Joins exist but are not in the query/SQL path**: `broadcastJoin` and
  `lookupJoin` (`JoinType = inner | left | semi | anti`) in `join.ts`.
- Rich **expression evaluator**: comparisons, `and/or/not`, `in/between`,
  `like/ilike`, null checks, and scalar fns (`lower/upper/trim/substr/replace/
  coalesce/nullif/cast/year/month/day/hour/date_trunc/round/floor/ceil/abs/
  least/greatest`, plus `st_*` and `h3_*`).
- **Resource budget**: `maxBufferedRows`, `maxMemoryBytes`, `maxRowsDecoded`,
  spill — the safety net for sort/group/join.

**Gaps** that block "pretty damn good":

- `HAVING`, aggregate expressions (`SUM(a * b)`),
  `COUNT(DISTINCT x)`, global aggregates, multiple group keys, and aggregate
  `ORDER BY`/`LIMIT`/`OFFSET` are wired through core execution and the SQL CLI.
- Computed scalar projections, arithmetic, and searched `CASE WHEN` are wired
  through parser, core query execution, CLI, and the DuckDB reference lane.
- Bounded two-table SQL `INNER JOIN` / `LEFT JOIN` over named CLI tables is
  wired through `broadcastJoin`, including multi-key `ON` / `USING`, safe
  side-filter/projection pushdown, and SQL-compatible left-join null handling;
  broader join forms are rejected.
- Scoped `IN` / `NOT IN` subqueries over named CLI tables are wired as bounded
  semi/anti joins, and non-recursive single-table CTEs are materialized in the
  CLI; uncorrelated scalar subqueries in `SELECT` and `WHERE` are wired for
  aggregate or `LIMIT 1` forms. Nested CTEs, correlated subqueries, and window
  functions remain open.

---

## Non-goals (explicit)

Keeping the lane tight so "grow significantly" doesn't become "reimplement a
warehouse":

- Recursive CTEs.
- Correlated subqueries (initially).
- Full window-frame specs (`ROWS BETWEEN …`) — only a streaming-friendly subset
  if Phase 5 happens at all.
- DDL / DML beyond the existing Iceberg append; transactions; multi-statement.
- Arbitrary N-way hash joins that blow the memory budget. Joins are
  **bounded** (broadcast/lookup with size guards) and degrade with a typed
  error, not OOM.

Anything out of scope must **reject with a specific `LaQLError` code**, never
parse-and-ignore.

---

## Decision: which parser

**Adopt `pgsql-ast-parser`.** Pure TypeScript, small, MIT, returns a clean
Postgres-flavored AST, no build step. Best fit for "parse → map onto our ops."

- `node-sql-parser` — heavier, multi-dialect, also serializes. Overkill here;
  reconsider only if we need multiple input dialects.
- Keep our own **guard layer** around whatever we adopt: cap input length and
  AST depth before/while walking (preserve the spirit of `MAX_TOKENS` /
  `MAX_PARSE_DEPTH`) so untrusted SQL can't DoS the walker.

`parseSql()` stays the public entry point — same signature, new internals — so
the CLI and playground don't churn.

---

## Cross-cutting requirements (every phase)

1. **Prove it against DuckDB.** A SQL conformance suite runs each supported
   query shape through `lakeql` *and* the existing `LAQL_REFERENCE=1` DuckDB lane
   and asserts **row-for-row equality**. "Pretty damn good" only counts if it's
   provably correct.
2. **Typed rejection matrix.** Every unsupported clause/function maps to a
   documented `LAQL_*` code. `docs/sql-dialect.md` becomes a real dialect spec +
   a supported/rejected feature matrix (same discipline as the Parquet/Iceberg
   compatibility matrix).
3. **Respect the budget.** Materializing ops (sort, group, join) honor
   `maxBufferedRows`/`maxMemoryBytes` and spill; exceeding the budget is
   `LAQL_BUDGET_EXCEEDED`, not a crash.
4. **Edge posture.** SQL stays out of the `lakeql` library entries (Workers
   bundle); it lives in the CLI + playground. If we ever export it from the lib,
   it must be a separate, tree-shakeable subpath.

---

## Phases

### Phase 0 — Parser swap, standard syntax, zero new capability
The foundation and an immediate DX win.

- Replace the FROM-first grammar with `pgsql-ast-parser` behind `parseSql()`.
- Support standard `SELECT cols FROM t [WHERE …] [GROUP BY …] [HAVING …]
  [ORDER BY …] [LIMIT n] [OFFSET m]`.
- Map the AST onto **existing** engine ops only; reject everything else with a
  typed code (`LAQL_SQL_UNSUPPORTED`).
- Map SQL expressions/functions to the existing evaluator; reject unknown
  functions explicitly.
- Keep input-size / depth guards.
- Update the CLI, playground default, `docs/sql-dialect.md`, and examples to
  standard syntax. Hard-cut the dialect (pre-1.0, safe to break).

**Acceptance:** every query the old dialect supported works in standard syntax;
the SQL conformance lane matches DuckDB row-for-row on that set;
unsupported syntax throws a documented code.

### Phase 1 — Expression & projection completeness
Make `SELECT`/`WHERE` genuinely expressive.

- Computed projections with aliases (`SELECT amount * qty AS total`) are wired
  for scalar expressions.
- `CASE WHEN … THEN … ELSE … END` is wired; simple `CASE <expr>` remains out of
  scope for now.
- `SELECT DISTINCT` is wired through parser, core query execution, CLI, and the
  DuckDB reference lane.
- Arithmetic operators are wired; fill remaining obvious scalar/operator gaps
  surfaced by the conformance suite.
- `count(*)` and qualified columns.

**Acceptance:** parametric expression suite (nulls, types, operators, `CASE`,
`DISTINCT`) matches DuckDB.

### Phase 2 — Aggregation depth
Finish what the engine half-supports.

- `HAVING` is wired into core aggregate execution.
- Aggregate over expressions (`SUM(a * b)`), `COUNT(DISTINCT x)`, multiple
  group keys, and global aggregates (no `GROUP BY`) are wired and covered by
  the DuckDB reference lane.
- `ORDER BY` / `LIMIT` / `OFFSET` over aggregated results are wired into core
  aggregate execution.
- Expose every engine aggregate op through SQL.

**Acceptance:** group/having/order/limit combinations match DuckDB; the SQL CLI
no longer post-processes non-distinct aggregate ordering/windowing.

### Phase 3 — Joins in the query path (the big jump)
Surface the join primitives that already exist.

- SQL `INNER JOIN` / `LEFT JOIN` → `broadcastJoin` is wired for one bounded
  equi-join over named CLI tables, including multi-key `ON` predicates.
- The build side has a `--join-max-right-rows` guard and fails with
  `LAQL_BUDGET_EXCEEDED` when exceeded. This is the edge-safe join story, not a
  general hash join.
- `SEMI/ANTI` are exposed through scoped `IN` / `NOT IN` subqueries;
  `lookupJoin` remains helper-only.
- Join planning pushes side-qualified `WHERE` conjuncts and conservative
  side projections into each source scan before the bounded broadcast join.
- `USING` and `ON` equality keys are wired, including multiple keys.

**Acceptance:** supported join shapes match DuckDB on fixtures; oversized build
side rejects with the documented code; the compatibility matrix states the join
bounds.

### Phase 4 — Subqueries & CTEs (scoped, non-recursive)
- Non-recursive single-table `WITH name AS (…)` CTEs are materialized as named
  subplans in the CLI, including computed/distinct and aggregate CTE bodies.
- `IN (subquery)` → semi-join and `NOT IN` → anti-join are wired for scoped
  named-table subqueries, including tuple keys and subquery filters.
- Scalar subqueries in `SELECT` and `WHERE` are wired when the result is
  provably ≤1 row through an aggregate query or `LIMIT 1` (else typed error).
- Explicitly reject recursive/correlated forms.

**Acceptance:** CTE + `IN`-subquery shapes match DuckDB; recursive/correlated
inputs reject with documented codes.

### Phase 5 — Window functions (optional, streaming-friendly subset)
Only if Phases 0–4 land cleanly and there's demand.

- `ROW_NUMBER`, `RANK`, `DENSE_RANK`, and running `SUM/COUNT/AVG`
  `OVER (PARTITION BY … ORDER BY …)` — default frame only.
- Reject explicit frame specs initially.

**Acceptance:** the supported window shapes match DuckDB; unsupported frames
reject with a documented code.

---

## Testing strategy

- **SQL conformance lane** (new): a fixture matrix of query shapes, each asserted
  equal to DuckDB via the existing `LAQL_REFERENCE` harness. Grows every phase.
- **Rejection tests**: each unsupported feature has a test asserting its
  specific `LAQL_*` code (mirrors the existing unsupported-feature discipline).
- **Fuzz/guard tests**: oversized input, deep nesting, pathological predicates →
  bounded rejection, never hang.
- **Playground/CLI smoke**: the default queries and a few representative ones run
  end-to-end after each phase.

---

## Sequencing & exit criteria

1. **Phase 0** (parser swap + standard syntax) — highest leverage, ships alone.
2. **Phase 1–2** (expressions + aggregation depth) — makes single-table SQL
   genuinely good; this is most of "pretty damn good."
3. **Phase 3** (joins) — the headline capability jump.
4. **Phase 4–5** — depth, demand-driven.

**Done = "pretty damn good" when:** a newcomer writes ordinary `SELECT … FROM …
WHERE … GROUP BY … HAVING … ORDER BY … LIMIT`, plus a bounded `JOIN`, in the
playground or CLI, gets DuckDB-identical results, and anything unsupported comes
back as a precise typed error — all while staying inside the edge resource
budget.

---

## Risks / watch-items

- **Parser dialect drift**: `pgsql-ast-parser` is Postgres-flavored; document
  which functions/types we actually honor vs. parse-but-reject.
- **Scope creep**: the non-goals list is the contract. New capability requires
  engine work *and* a conformance + rejection test, or it doesn't ship.
- **Memory**: joins/sort/group are the OOM-risk ops; they must route through the
  budget + spill, and the join build-side guard is mandatory.
- **Bundle**: keep SQL out of the edge library bundle unless explicitly opted in
  via a tree-shakeable subpath.
