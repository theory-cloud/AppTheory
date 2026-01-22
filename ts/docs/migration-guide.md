# TypeScript Migration Guide

AppTheory TypeScript is designed for “easy migration” from raw Lambda handlers and ad-hoc router code.

✅ CORRECT migration order:
1. Express your handler as `handler(ctx) => Response`.
2. Move routing into `app.get/post/...`.
3. Add middleware with `app.use(...)`.
4. Add deterministic tests using `createTestEnv(...)`.

