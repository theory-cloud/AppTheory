# AppTheory API Reference (Example)

This file is an example for `docs/api-reference.md`.

## Overview

- **Purpose:** Document confirmed public interfaces across Go, TypeScript, and Python.
- **Source of truth for exported API symbols:**
  - `api-snapshots/go.txt`
  - `api-snapshots/ts.txt`
  - `api-snapshots/py.txt`
- **Rule:** update snapshots and then align prose docs; do not document unconfirmed symbols.

## Interface Map

| Interface Group | Public Entry Points | Evidence |
|---|---|---|
| App container | `apptheory.New`, `createApp`, `create_app` | `docs/api-reference.md`, `api-snapshots/*` |
| Universal Lambda dispatch | `HandleLambda`, `handleLambda`, `handle_lambda` | `docs/api-reference.md` |
| APIGW v2 adapter | `ServeAPIGatewayV2`, `serveAPIGatewayV2`, `serve_apigw_v2` | `docs/api-reference.md` |
| Function URL adapter | `ServeLambdaFunctionURL`, `serveLambdaFunctionURL`, `serve_lambda_function_url` | `docs/api-reference.md` |
| Package exports (limited/sanitization/jobs) | language-specific package APIs | `docs/api-reference.md`, `api-snapshots/*` |

## Usage Examples

```go
// CORRECT: route all Lambda event shapes through AppTheory dispatcher.
func handler(ctx context.Context, event json.RawMessage) (any, error) {
    return app.HandleLambda(ctx, event)
}
```

```bash
# CORRECT: refresh API snapshots before updating reference prose.
./scripts/update-api-snapshots.sh
make rubric
```

```bash
# INCORRECT: edit API reference prose without confirming exported symbols.
# (This creates drift from api-snapshots/*.)
```
