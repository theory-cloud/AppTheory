# Getting Started (TypeScript)

This guide walks you through installing and running a minimal AppTheory app in TypeScript (Node.js 24).

## Install

AppTheory is distributed via **GitHub Releases** (no npm registry publishing).

Example (install from a downloaded release tarball):

```bash
npm i ./theory-cloud-apptheory-X.Y.Z.tgz
```

## Minimal local invocation (P2 default)

```ts
// CORRECT: Use the deterministic test env for unit tests and local invocation.
import { createTestEnv, text } from "@theory-cloud/apptheory";

const env = createTestEnv();
const app = env.app();

app.get("/ping", () => text(200, "pong"));

const resp = await env.invoke(app, { method: "GET", path: "/ping" });
console.log(resp.status); // 200
```

## Next steps

- Read [Core Patterns](./core-patterns.md) for middleware/streaming/SSE patterns.
- Use [API Reference](./api-reference.md) to find the right adapter/helpers for your AWS integration.

