import assert from "node:assert/strict";

import { buildAPIGatewayV2Request, createTestEnv, json } from "../../ts/dist/index.js";

const env = createTestEnv({ now: new Date("2026-01-01T00:00:00.000Z") });
env.ids.queue("req-1");

const app = env.app();
app.get("/hello", (ctx) => json(200, { now: ctx.now().toISOString(), id: ctx.newId() }));

const event = buildAPIGatewayV2Request("GET", "/hello", { headers: { "x-request-id": "request-1" } });
const resp = await env.invokeAPIGatewayV2(app, event);

assert.equal(resp.statusCode, 200);
assert.equal(resp.headers["content-type"], "application/json; charset=utf-8");
assert.equal(resp.headers["x-request-id"], "request-1");

const body = JSON.parse(resp.body);
assert.equal(body.id, "req-1");
assert.equal(body.now, "2026-01-01T00:00:00.000Z");

console.log("examples/testkit/ts.mjs: PASS");
