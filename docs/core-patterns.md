# AppTheory Core Patterns

This document records the canonical patterns AppTheory expects across languages.

## Pattern: header handling is case-insensitive (but canonicalized)

**Problem:** HTTP header names are case-insensitive, but maps/dicts are not.

**Solution:** treat headers as case-insensitive on input and expect **lowercased keys** on output.

```go
// CORRECT: Read headers case-insensitively, write response header keys in lowercase.
reqID := ctx.Header("X-Request-Id")
resp.Headers["x-request-id"] = []string{reqID}
```

❌ INCORRECT: assuming mixed-case keys will survive normalization.

## Pattern: register more-specific routes first

If two routes are equally specific, the router prefers **earlier registration order**.

✅ CORRECT:
1. Register the most specific path first.
2. Register the fallback last.

```go
app.Get("/users/me", handleMe)
app.Get("/users/{id}", handleUser)
```

## Pattern: keep middleware pure and deterministic

✅ CORRECT: treat middleware as a pure function of `(ctx, next)`:
- store request-scoped values via `ctx.Set(...)` / `ctx.Get(...)`
- return a modified response rather than mutating global state

❌ INCORRECT:
- caching per-request values in package globals
- depending on wall-clock time (use the injected clock / test env)

## Pattern: streaming is adapter-specific

Streaming is validated by contract fixtures for supported adapters. Don’t assume every AWS integration supports the same streaming semantics.

✅ CORRECT:
- Use the runtime-provided streaming helpers (`htmlStream`, `sseEventStream`, etc.) where available.
- Test streaming deterministically using the language test env.

