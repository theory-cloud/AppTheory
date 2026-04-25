# G4 Representative Migration — Rate-limited HTTP Service (Go)

This example represents a common Lift-era pattern:

- a DynamoDB-backed rate limiter (historically via `pay-theory/limited`)
- applied as middleware to an HTTP handler

The goal is to demonstrate an **end-to-end migration** of rate limiting to AppTheory’s TableTheory-backed port:

- `github.com/theory-cloud/apptheory/pkg/limited`
- `github.com/theory-cloud/apptheory/pkg/limited/middleware`

## Files

- `before/main.go` — legacy shape (ignored by default build)
- `main.go` — migrated shape (compiles in this repo)

## Migration steps (what changed)

1. Rewrite imports from `pay-theory/limited` → AppTheory:
   - Dry-run: `./scripts/migrate-from-lift-go.sh -root examples/migration/rate-limited-http/before`
   - Apply: `./scripts/migrate-from-lift-go.sh -root examples/migration/rate-limited-http/before -apply`
2. Replace DynamORM DB initialization with TableTheory:
   - `github.com/pay-theory/dynamorm/...` → `github.com/theory-cloud/tabletheory`
3. Ensure the rate limit table name is configured once (recommended via env):
   - `APPTHEORY_RATE_LIMIT_TABLE_NAME=rate-limits` (default is `rate-limits`)

## v1 security note

The Go runtime’s default `RateLimitMiddleware(...)` identifier extraction now fingerprints credential-derived identifiers
before they reach the limiter backend:

- `x-api-key` → `api_key:hmac-sha256:<hex>`
- `Authorization: Bearer ...` → `bearer:hmac-sha256:<hex>`

That means:

- raw credentials are no longer stored in rate-limit keys or Dynamo rows by default
- any existing credential-backed buckets reset on first deploy of the new default
- dashboards or operational tooling that previously inspected raw identifier values must be updated

If your service needs a different key shape, set `ExtractIdentifier` explicitly instead of relying on the default.

For the broader v1.0 fail-closed migration checklist, see `docs/migration/v1-security.md`.

## Running (optional)

This is a minimal demo server; it requires AWS credentials unless you point TableTheory at DynamoDB Local.

Example (DynamoDB Local):

```bash
export AWS_REGION=us-east-1
export APPTHEORY_RATE_LIMIT_TABLE_NAME=rate-limits
export DDB_ENDPOINT=http://localhost:8000

go run ./examples/migration/rate-limited-http
```

Then request:

```bash
curl -i http://localhost:8080/hello
```
