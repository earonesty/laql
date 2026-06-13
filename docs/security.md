# Security

LaQL security controls are caller-owned and explicit:

- `QueryPolicy.allowedColumns` restricts selected and predicate columns.
- `QueryPolicy.maxLimit` applies a hard row cap.
- `QueryPolicy.rowFilter` injects a required predicate into every query.
- Query budgets fail with `LAQL_BUDGET_EXCEEDED` before unbounded work continues.

Bookmarks and pagination tokens can be HMAC-signed with `signPaginationToken` and verified with `verifyPaginationToken`.
