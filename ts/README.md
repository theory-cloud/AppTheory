# AppTheory (TypeScript)

This folder contains the TypeScript SDK/runtime for AppTheory.

The portable runtime behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## Minimal local invocation (P0)

```ts
import { createTestEnv, text } from "@theory-cloud/apptheory";

const env = createTestEnv();
const app = env.app();

app.get("/ping", () => text(200, "pong"));

const resp = await env.invoke(app, { method: "GET", path: "/ping" });
console.log(resp.status); // 200
```
