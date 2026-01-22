# Python Core Patterns

## Pattern: keep handlers deterministic

✅ CORRECT:
- structure handlers as `handler(ctx) -> Response`
- use `create_test_env(now=..., ids=...)` in unit tests
- store request-scoped values via `ctx.set(...)` / `ctx.get(...)`

❌ INCORRECT:
- using module globals for request-scoped state
- using wall-clock time in tests instead of the injected clock

## Pattern: middleware wraps `next_handler(ctx)`

```py
# CORRECT: middleware is a sync wrapper around the next handler
def mw(ctx, next_handler):
    ctx.set("mw", "ok")
    resp = next_handler(ctx)
    resp.headers["x-middleware"] = ["1"]
    return resp

app.use(mw)
```

## Pattern: header casing is canonicalized

Response header map keys are lowercased for cross-language parity.

✅ CORRECT: always use lowercase keys in tests/examples (`"content-type"`, `"x-request-id"`).

