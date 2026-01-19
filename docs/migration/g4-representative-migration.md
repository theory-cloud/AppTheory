# G4 Representative Migration (Go) — Lessons Learned

This document records a representative migration exercise for the `pay-theory/limited` rate limiter into AppTheory’s
TableTheory-backed port.

Representative service example:

- `examples/migration/rate-limited-http/README.md`

## What worked well

- The `pay-theory/limited` API maps cleanly to AppTheory’s port:
  - `github.com/theory-cloud/apptheory/pkg/limited`
  - `github.com/theory-cloud/apptheory/pkg/limited/middleware`
- Import rewrites can be automated safely with a small Go-aware helper:
  - `scripts/migrate-from-lift-go.sh` (dry-run by default; prints diffs)

## Manual steps that remain

- **DynamORM → TableTheory:** legacy code that initializes DynamoDB via DynamORM must be updated to TableTheory:
  - `github.com/pay-theory/dynamorm/...` → `github.com/theory-cloud/tabletheory`
- **Logger differences:** legacy examples often pass a Zap logger to `limited`. AppTheory’s port avoids a Zap dependency;
  use your application logger outside the limiter or attach logging in the middleware layer.
- **Table naming:** TableTheory binds table name through model metadata; configure it once (recommended via env) before the
  limiter is first used:
  - `APPTHEORY_RATE_LIMIT_TABLE_NAME` (default `rate-limits`)

## Follow-up opportunities

- Extend the migration helper to optionally rewrite common DynamORM initialization patterns into TableTheory equivalents
  (keep it opt-in and diff-based).
- Add a second representative service exercise using Lift runtime + middleware stack once AppTheory’s P0 contract shape is
  available.

