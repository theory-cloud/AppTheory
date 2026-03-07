# AppTheory Core Patterns

This document captures the canonical usage patterns for AppTheory.

## Canonical Patterns

### Pattern: Document from the snapshot-backed public surface

**Problem:** Engineers need a stable way to document AppTheory without guessing from internal implementation details.

**CORRECT**

```bash
# CORRECT: verify the public surface from the canonical snapshots first
less api-snapshots/go.txt
less api-snapshots/ts.txt
less api-snapshots/py.txt
```

Why this is correct:
- The repo already treats `api-snapshots/` as the no-drift public interface reference.
- It keeps docs aligned with released Go, TypeScript, and Python package surfaces.
- It protects business value by reducing support churn caused by documenting unsupported exports.

**INCORRECT**

```text
# INCORRECT: infer the supported API by skimming internal files and guessing which symbols are public
TODO: do not promote internal-only helpers into the public docs contract without snapshot evidence
```

Why this is incorrect:
- It creates documentation drift.
- It can mislead integrators into depending on unstable or private internals.

### Pattern: Use the universal dispatcher for mixed AWS triggers

**Problem:** One Lambda may need to accept many AWS event shapes, and hand-rolled dispatch logic is error-prone.

**CORRECT**

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
    return app.HandleLambda(ctx, event)
}
```

Why this is correct:
- The existing repo docs already present `HandleLambda` / `handleLambda` / `handle_lambda` as the supported mixed-trigger path.
- It keeps cross-language behavior aligned with the shared runtime contract.

**INCORRECT**

```go
// INCORRECT: partial custom dispatch that assumes every requestContext.http event is API Gateway v2
func handler(ctx context.Context, event map[string]any) (any, error) {
    if event["requestContext"] != nil {
        return app.ServeAPIGatewayV2(ctx, event)
    }
    return nil, nil
}
```

Why this is incorrect:
- It bypasses the documented dispatcher semantics.
- It risks breaking ALB, Lambda Function URL, SNS, SQS, or WebSocket handling.

### Pattern: Treat headers as case-insensitive, but expect lowercase output keys

**Problem:** Header names are case-insensitive, but response maps are not.

**CORRECT**

```go
reqID := ctx.Header("X-Request-Id")
resp.Headers["x-request-id"] = []string{reqID}
```

Why this is correct:
- The existing repo patterns and troubleshooting docs confirm lowercase output normalization.
- It produces deterministic tests across Go, TypeScript, and Python.

**INCORRECT**

```go
resp.Headers["X-Request-Id"] = []string{reqID}
```

Why this is incorrect:
- It assumes mixed-case response header keys are preserved.
- It causes confusing parity and test failures.

### Pattern: Keep generated artifacts aligned with source changes

**Problem:** AppTheory publishes generated artifacts and snapshot evidence that are part of the public contract review path.

**CORRECT**

```bash
./scripts/verify-version-alignment.sh
./scripts/update-api-snapshots.sh
make rubric
```

Why this is correct:
- The Makefile and existing development/testing docs treat version alignment and snapshot updates as first-class gates.
- It preserves release integrity across Go, TypeScript, Python, and CDK artifacts.

**INCORRECT**

```bash
# INCORRECT: change TypeScript or CDK source but do not regenerate dist, jsii outputs, or snapshots
cd ts && npm run build
# stop here and do not commit the generated outputs
```

Why this is incorrect:
- The repo explicitly expects generated artifacts to be reviewed and committed.
- CI, packaging checks, or downstream consumers may observe stale contract data.

## Pattern Selection

- Prefer repo-confirmed public interfaces over inferred internals.
- Prefer deterministic examples and verification commands over aspirational pseudocode.
- Prefer sanctioned migration and optional surfaces when splitting specialized guidance out of the fixed contract files.
- If a detail is not confirmed from current canonical sources, write `TODO:` or `UNKNOWN:` instead of guessing.
