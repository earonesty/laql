# SQL Dialect

The SQL parser covers the engine-facing subset used by the CLI:

```sql
select store_id, amount
from input
where region = 'west'
order by amount asc
limit 2
```

`SELECT DISTINCT` is supported for projected result rows:

```sql
select distinct region
from input
order by region
```

Computed projections with explicit aliases are supported for scalar functions,
arithmetic, and searched `CASE` expressions:

```sql
select amount * 2 as doubled,
  case when amount > 100 then 'large' else 'small' end as bucket
from input
```

Grouped aggregates support aggregate expressions and `COUNT(DISTINCT x)`:

```sql
select region,
  sum(amount * 2) as doubled_total,
  count(distinct store_id) as stores
from input
group by region
```

Global aggregates and multiple group keys are supported:

```sql
select count(*) as rows, max(amount) as max_amount
from input

select region, store_id, count(*) as rows
from input
group by region, store_id
order by region, store_id
limit 5
```

Bounded two-table `INNER JOIN` and `LEFT JOIN` are supported in the CLI with
named `--table` inputs. Join predicates must be equality comparisons between
qualified column references, optionally combined with `AND` for multi-key
joins:

```sql
select s.store_id as store_id, d.segment as segment
from sales s
join stores d on s.store_id = d.store_id
order by s.store_id
limit 10

select s.store_id as store_id, d.segment as segment
from sales s
join stores d on s.store_id = d.store_id and s.region = d.region

select s.store_id as store_id, d.segment as segment
from sales s
join stores d using (store_id, region)
```

Side-qualified `WHERE` filters such as `s.amount > 100 and d.segment = 'retail'`
are supported; the CLI pushes single-side conjuncts into the corresponding
source scan before the bounded broadcast join when that preserves SQL
semantics. `LEFT JOIN` preserves unmatched left rows with `NULL` right-side
projection values.

Scoped `IN` and `NOT IN` subqueries over named CLI tables are supported and
execute as bounded semi/anti joins:

```sql
select store_id, amount
from sales
where store_id in (
  select store_id
  from stores
  where segment = 'enterprise'
)
order by amount
limit 10
```

Uncorrelated scalar subqueries in `SELECT` projections and `WHERE` predicates
are supported when they are provably one row: aggregate scalar subqueries or
subqueries with `LIMIT 1`.

```sql
select store_id, amount
from input
where amount = (
  select max(amount) as max_amount
  from input
)

select store_id,
  (select max(amount) as max_amount from input) as max_amount
from input
limit 1
```

Non-recursive CTEs are supported when the CTE body is a single-table query
without nested joins or subqueries, and the outer query reads that CTE name:

```sql
with recent as (
  select store_id, amount
  from input
  where amount > 900
)
select store_id, amount
from recent
order by amount desc
limit 2

with totals as (
  select region, count(*) as rows, max(amount) as max_amount
  from input
  group by region
)
select region, rows
from totals
where max_amount > 990
```

The CLI also accepts omitted `from input` and injects the `--path` as the source.

```sh
node packages/cli/dist/bin.js query \
  --path fixtures/data/sales.parquet \
  --sql "select store_id, amount where region = 'west' order by amount asc limit 2"
```

Invalid SQL is rejected with `LAQL_PARSE_ERROR`. Valid SQL outside the supported
execution subset, including broad join forms, unsupported subqueries, nested or
recursive CTEs, simple `CASE <expr>` forms, and broad SQL execution, is rejected with
`LAQL_SQL_UNSUPPORTED`.

## Feature Matrix

| Feature | Status | Rejection code | Notes |
| --- | --- | --- | --- |
| Standard `SELECT ... FROM ...` | Supported |  | CLI also supports omitted `from input` for `--path` queries. |
| `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET` | Supported |  | Expressions use SQL three-valued null semantics. |
| Scalar functions, arithmetic, searched `CASE WHEN` | Supported | `LAQL_SQL_UNSUPPORTED` | Unknown functions and simple `CASE <expr>` are rejected. |
| `SELECT DISTINCT` | Supported |  | Distinct applies to projected rows. |
| `GROUP BY`, `HAVING`, aggregate expressions | Supported |  | Includes global aggregates and multiple group keys. |
| `COUNT(DISTINCT x)` and engine aggregate ops | Supported | `LAQL_SQL_UNSUPPORTED` | `COUNT(DISTINCT *)` is rejected. |
| Two-table `INNER JOIN` / `LEFT JOIN` | Supported | `LAQL_SQL_UNSUPPORTED` | Bounded broadcast joins over named CLI tables only. |
| Multi-key `JOIN ... ON` / `JOIN ... USING` | Supported | `LAQL_SQL_UNSUPPORTED` | Equality keys only. |
| Right/full/cross/N-way/non-equality joins | Rejected | `LAQL_SQL_UNSUPPORTED` | Broad join planning is intentionally out of scope. |
| `IN` / `NOT IN` subqueries | Supported | `LAQL_SQL_UNSUPPORTED` | Scoped named-table subqueries execute as bounded semi/anti joins. |
| Scalar subqueries | Supported subset | `LAQL_SQL_UNSUPPORTED` | Only uncorrelated aggregate or `LIMIT 1` scalar subqueries. |
| Non-recursive single-table CTEs | Supported subset | `LAQL_SQL_UNSUPPORTED` | One outer CTE; nested joins/subqueries/CTEs in the CTE body are rejected. |
| Recursive CTEs and correlated subqueries | Rejected | `LAQL_PARSE_ERROR` / `LAQL_SQL_UNSUPPORTED` | No partial execution. |
| Window functions and explicit frames | Rejected | `LAQL_SQL_UNSUPPORTED` | Reserved for a future streaming-friendly subset. |
| DDL, DML, multi-statement SQL | Rejected | `LAQL_SQL_UNSUPPORTED` | SQL is a CLI query dialect, not a database runtime. |
