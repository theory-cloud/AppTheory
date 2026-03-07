# AppTheory API Reference

This document lists the confirmed public interfaces, commands, and contracts exposed by AppTheory.

## Overview

- **Purpose:** Cross-language AWS Lambda runtime contract with drift prevention across Go, TypeScript, and Python.
- **Primary languages:** Go, TypeScript, Python
- **Public interface summary:** Repo-level runtime docs are supported by canonical public API snapshots in `api-snapshots/`, package docs under `ts/docs/`, `py/docs/`, and `cdk/docs/`, and migration guidance under `docs/migration/`.

## Canonical Source of Truth

Use these files before documenting exports or claiming compatibility:
- `api-snapshots/go.txt` for the Go public API surface
- `api-snapshots/ts.txt` for the TypeScript public API surface
- `api-snapshots/py.txt` for the Python public API surface
- `README.md`, `docs/README.md`, and `docs/getting-started.md` for repo-level installation and positioning
- `docs/migration/from-lift.md` for the confirmed Lift migration surface

## Interface Map

| Interface | Type | Entry point | Notes |
|-----------|------|-------------|-------|
| `github.com/theory-cloud/apptheory/runtime` | Go module/package | Go module import path from `README.md` | Main Go runtime for app container, routing, middleware, and AWS adapters |
| `github.com/theory-cloud/apptheory/testkit` | Go package | Testkit import path shown in `README.md` and `docs/getting-started.md` | Deterministic local and adapter-specific testing surface |
| `pkg/jobs` | Go package | Documented in `docs/api-reference.md` and `api-snapshots/go.txt` | Job ledger, lease, and idempotency primitives |
| `@theory-cloud/apptheory` | TypeScript package | `ts/package.json` and `api-snapshots/ts.txt` | Exported runtime surface from `ts/dist/index.d.ts`; requires Node >= 24 |
| `apptheory` | Python package | `py/pyproject.toml` and `api-snapshots/py.txt` | Exported Python runtime surface; requires Python >= 3.14 |
| `@theory-cloud/apptheory-cdk` / `apptheory_cdk` | CDK package | `cdk/package.json` and `cdk/docs/README.md` | jsii constructs for deploying AppTheory apps with consistent defaults |
| `HandleLambda` / `handleLambda` / `handle_lambda` | Runtime entrypoint | `docs/api-reference.md` | Universal mixed-trigger Lambda dispatcher |
| `make test-unit`, `make rubric`, `make build` | Command surface | `Makefile` | Repo-level verification and build entrypoints |

## Confirmed Public Modules and Surfaces

### App container and routing
Confirmed across repo docs and snapshots:
- Go: `apptheory.New(...)`
- TypeScript: `createApp(...)`
- Python: `create_app(...)`
- Shared concepts: `Request`, `Response`, `Context`, middleware, route helpers, and AWS adapter entrypoints

### Universal Lambda dispatch
Use the runtime dispatcher when a single function may receive multiple AWS event shapes:

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
    return app.HandleLambda(ctx, event)
}
```

This behavior is described in the existing repo API reference and backed by cross-language runtime docs.

### Jobs ledger surface
Confirmed in `api-snapshots/go.txt` and the existing repo docs:
- Environment/config surface: `APPTHEORY_JOBS_TABLE_NAME`
- Core types include `JobLedger`, `JobMeta`, `JobRecord`, `JobLock`, `JobRequest`
- Core workflows include job creation, status transition, record upsert, lease acquisition, and idempotency completion

### TypeScript exported surface highlights
Confirmed in `api-snapshots/ts.txt`:
- `App`, `Context`, `createApp`, `createTestEnv`
- AWS event builders such as `buildAPIGatewayV2Request`, `buildSQSEvent`, `buildEventBridgeEvent`
- Response helpers such as `json`, `text`, `html`, `sse`, `htmlStream`
- Job-ledger and rate-limiter related exports such as `DynamoJobLedger`, `DynamoRateLimiter`, `JobStatus`, `RateLimiter`

### Python exported surface highlights
Confirmed in `api-snapshots/py.txt`:
- `App`, `Context`, `create_app`, `create_test_env`
- Builders such as `build_apigw_v2_request`, `build_sqs_event`, `build_eventbridge_event`
- Response helpers such as `json`, `text`, `html`, `sse`, `html_stream`
- Limited/rate-limiting submodule exports under `apptheory.limited`

## Configuration and Environment

Documented and confirmed config surfaces from the bounded discovery pass:
- `APPTHEORY_JOBS_TABLE_NAME` - jobs ledger table name (`api-snapshots/go.txt`)
- `APPTHEORY_EVENTBUS_TABLE_NAME` - migration-facing event bus table configuration (`docs/migration/from-lift.md`)
- `ERROR_NOTIFICATION_SNS_TOPIC_ARN` - accepted legacy SNS error notification environment variable (`docs/api-reference.md`)
- `x-request-id` - request ID propagation header (`README.md`, `docs/migration/from-lift.md`)
- `x-tenant-id` - tenant identification header (`docs/migration/from-lift.md`)

TODO: compile a complete environment-variable inventory from the canonical public sources before finalizing user-facing config docs.

## Installation and Distribution Contract

- Distribution model: GitHub Releases only
- Go module path: `github.com/theory-cloud/apptheory`
- npm package name: `@theory-cloud/apptheory`
- Python distribution/import name: `apptheory`
- Supported runtimes confirmed from manifests and docs:
  - Go 1.26.0
  - Node 24
  - Python 3.14

## Related Docs
- [Getting Started](./getting-started.md)
- [Core Patterns](./core-patterns.md)
- [Testing Guide](./testing-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration Guide](./migration-guide.md)
