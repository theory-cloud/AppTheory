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

## Unit test without AWS (M7)

Deterministic time + IDs, invoked using an API Gateway v2 event shape:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildAPIGatewayV2Request, createTestEnv, json } from "@theory-cloud/apptheory";

test("unit test without AWS", async () => {
  const env = createTestEnv({ now: new Date("2026-01-01T00:00:00.000Z") });
  env.ids.queue("req-1");

  const app = env.app();
  app.get("/hello", (ctx) => json(200, { now: ctx.now().toISOString(), id: ctx.newId() }));

  const event = buildAPIGatewayV2Request("GET", "/hello");
  const resp = await env.invokeAPIGatewayV2(app, event);

  assert.equal(resp.statusCode, 200);
  assert.equal(resp.headers["content-type"], "application/json; charset=utf-8");

  const body = JSON.parse(resp.body);
  assert.equal(body.id, "req-1");
  assert.equal(body.now, "2026-01-01T00:00:00.000Z");
});
```
