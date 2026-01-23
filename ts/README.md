# AppTheory (TypeScript)

This folder contains the TypeScript SDK/runtime for AppTheory.

The portable runtime behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## Documentation

- TypeScript docs index: `ts/docs/README.md`
- Repo docs index: `docs/README.md`

## Minimal local invocation (P2 default)

To force the P0 core (minimal surface area), pass `tier: "p0"` when creating the app.

Note: header names are case-insensitive, but response headers are emitted with lowercase keys.

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
  app.use(async (ctx, next) => {
    ctx.set("mw", "ok");
    const resp = await next(ctx);
    resp.headers["x-middleware"] = ["1"];
    return resp;
  });
  app.get("/hello", (ctx) => json(200, { now: ctx.now().toISOString(), id: ctx.newId(), mw: ctx.get("mw") }));

  const event = buildAPIGatewayV2Request("GET", "/hello", { headers: { "x-request-id": "request-1" } });
  const resp = await env.invokeAPIGatewayV2(app, event);

  assert.equal(resp.statusCode, 200);
  assert.equal(resp.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(resp.headers["x-request-id"], "request-1");
  assert.equal(resp.headers["x-middleware"], "1");

  const body = JSON.parse(resp.body);
  assert.equal(body.id, "req-1");
  assert.equal(body.now, "2026-01-01T00:00:00.000Z");
  assert.equal(body.mw, "ok");
});
```

## Lambda Function URL streaming (M14)

Streaming handler entrypoint:

```ts
import { createApp, createLambdaFunctionURLStreamingHandler } from "@theory-cloud/apptheory";

const app = createApp();
export const handler = createLambdaFunctionURLStreamingHandler(app);
```

Deterministic unit test (without AWS):

```ts
import assert from "node:assert/strict";

import { buildLambdaFunctionURLRequest, createTestEnv } from "@theory-cloud/apptheory";

const env = createTestEnv();
const app = env.app();

app.get("/stream", () => ({
  status: 200,
  headers: { "content-type": ["text/plain; charset=utf-8"] },
  cookies: [],
  body: Buffer.alloc(0),
  bodyStream: (async function* () {
    yield Buffer.from("hello", "utf8");
    yield Buffer.from("world", "utf8");
  })(),
  isBase64: false,
}));

const event = buildLambdaFunctionURLRequest("GET", "/stream");
const resp = await env.invokeLambdaFunctionURLStreaming(app, event);
assert.deepEqual(resp.chunks.map((c) => Buffer.from(c).toString("utf8")), ["hello", "world"]);
```

## Lint

```bash
cd ts
npm ci
npm run lint
```
