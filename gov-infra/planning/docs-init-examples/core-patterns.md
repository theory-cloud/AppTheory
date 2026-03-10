# AppTheory Core Patterns

This is an example target for `docs/core-patterns.md`.

## Canonical Patterns

### Pattern: use snapshot-backed API evidence

**Problem:** External docs can drift from real exports.

**CORRECT**

```bash
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
```

Why this is correct:
- `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt` are canonical public API evidence.

**INCORRECT**

```text
Document a new exported symbol in docs first, then update snapshots later.
```

Why this is incorrect:
- It creates hallucinated APIs and breaks migration safety.

### Pattern: keep Lambda entrypoints thin

**CORRECT**

```go
func handler(ctx context.Context, event json.RawMessage) (any, error) {
  return app.HandleLambda(ctx, event)
}
```

**INCORRECT**

```go
if event.RequestContext.HTTP.Method != "" {
  return app.ServeAPIGatewayV2(ctx, parsed)
}
return nil, errors.New("unsupported")
```

Why this is incorrect:
- It can miss supported trigger shapes already handled by runtime dispatch.

### Pattern: sanitize payloads before logging

**CORRECT**

```go
safe := sanitization.SanitizeLogString("import\nstart")
logger.Info(safe)
```

**INCORRECT**

```go
logger.Info("payload", map[string]any{"body": string(rawPayload)})
```

Why this is incorrect:
- Raw payload logging can expose sensitive values and produce unsafe log output.
