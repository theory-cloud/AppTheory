# AppTheory Core Patterns (Example)

This file is an example for `docs/core-patterns.md`.

## Canonical Patterns

### Pattern: Case-insensitive request headers, lowercase response header keys

**CORRECT**

```go
requestID := ctx.Header("X-Request-Id")
resp.Headers["x-request-id"] = []string{requestID}
```

Reason: response headers are normalized; tests stay deterministic across languages.

**INCORRECT**

```go
resp.Headers["X-Request-Id"] = []string{"abc-123"}
// test expects mixed-case output key to remain unchanged
```

Reason: this assumption drifts from normalization behavior.

### Pattern: Prefer deterministic verification gates over ad-hoc manual checks

**CORRECT**

```bash
make test-unit
./scripts/verify-contract-tests.sh
```

Reason: validates repo contract behavior consistently.

**INCORRECT**

```bash
# Only do manual cloud invocation and skip contract checks
aws lambda invoke ...
```

Reason: misses cross-language parity and can hide regressions.

### Pattern: Keep versions aligned before publishing docs claims

**CORRECT**

```bash
./scripts/verify-version-alignment.sh
make rubric
```

**INCORRECT**

```bash
# Bump one package in isolation
npm version patch --prefix ts
```

Reason: single-surface version bumps cause manifest drift.
