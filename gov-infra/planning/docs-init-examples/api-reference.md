# AppTheory API Reference

This is an example target for `docs/api-reference.md`, grounded in the current AppTheory repo.

## Overview

- **Purpose:** Document confirmed external interfaces for the AppTheory runtime, migration tooling, and verification gates.
- **Primary runtimes:** Go (`go.mod`), TypeScript (`ts/`), Python (`py/`), plus CDK constructs (`cdk/`).
- **Canonical API evidence:** `api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`, `cdk/.jsii`, and `docs/api-reference.md`.

## Interface Map

| Interface | Type | Entry point | Notes |
|-----------|------|-------------|-------|
| Runtime app container (Go) | Public API | `github.com/theory-cloud/apptheory/runtime` | Use `apptheory.New(...)`; snapshot-backed in `api-snapshots/go.txt`. |
| Runtime app container (TS) | Public API | `@theory-cloud/apptheory` | Use `createApp()`; snapshot-backed in `api-snapshots/ts.txt`. |
| Runtime app container (Python) | Public API | `apptheory` | Use `create_app()`; snapshot-backed in `api-snapshots/py.txt`. |
| Universal Lambda dispatcher | Public API | `HandleLambda` / `handleLambda` / `handle_lambda` | Preferred mixed-trigger entrypoint for HTTP + events. |
| HTTP adapters | Public API | `ServeAPIGatewayV2`, `ServeLambdaFunctionURL`, `ServeAPIGatewayProxy` (and TS/Python equivalents) | Adapter naming is language-specific; behavior is contract-tested. |
| Strict route registration | Public API | `GetStrict` / `HandleStrict` / `handleStrict` / `handle_strict` | Use in tests/CI to fail fast on invalid patterns. |
| Deterministic test env | Public API | `testkit.New()` / `createTestEnv()` / `create_test_env()` | Deterministic local invocation and fixture-style testing. |
| Lift migration helper | CLI | `go run ./cmd/lift-migrate` | Confirmed flags in `cmd/lift-migrate/main.go`: `-root`, `-apply`. |
| Docs and release verification | Command surface | `make rubric`, `./scripts/verify-contract-tests.sh`, `./scripts/update-api-snapshots.sh` | These are user/operator-facing quality gates in docs and Makefile. |

## Configuration

Confirmed keys/flags from canonical docs and code:

- CLI flags:
  - `lift-migrate -root <path>`
  - `lift-migrate -apply`
- Environment variable (migration compatibility note in `docs/migration/from-lift.md`):
  - `APPTHEORY_EVENTBUS_TABLE_NAME`
  - `ERROR_NOTIFICATION_SNS_TOPIC_ARN`
- `UNKNOWN:` full stable environment-variable catalog for all runtimes is not centralized in a single canonical index yet.
- `TODO:` local agent should add a dedicated “Configuration Keys” section once repo owners nominate a single source-of-truth file.

## Usage Examples

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
  return app.HandleLambda(ctx, event)
}
```

```bash
# migration helper dry-run
go run ./cmd/lift-migrate -root ./path/to/service

# apply migration rewrite
go run ./cmd/lift-migrate -root ./path/to/service -apply
```

## Related Docs

- [Getting Started](./getting-started.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](./migration-guide.md)
