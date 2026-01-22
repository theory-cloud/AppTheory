# TypeScript Core Patterns

## Pattern: keep handlers async and side-effect contained

✅ CORRECT: treat `handler(ctx)` as pure-ish:
- read inputs from `ctx.request`
- set request-scoped values via `ctx.set(...)`
- return a `Response` (use helpers like `json`, `text`)

❌ INCORRECT:
- writing to module globals for request-scoped state
- depending on `Date.now()` in tests (use `createTestEnv({ now })`)

## Pattern: middleware wraps `next(ctx)`

```ts
// CORRECT: middleware is an async wrapper around next(ctx)
app.use(async (ctx, next) => {
  ctx.set("mw", "ok");
  const resp = await next(ctx);
  resp.headers["x-middleware"] = ["1"];
  return resp;
});
```

## Pattern: streaming is explicit

✅ CORRECT:
- use streaming helpers (`htmlStream`, `sseEventStream`) when you need incremental output
- unit test streaming via the test env’s streaming invokers

❌ INCORRECT:
- assuming every AWS integration supports streaming the same way

