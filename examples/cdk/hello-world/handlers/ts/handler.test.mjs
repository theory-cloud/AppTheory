import assert from "node:assert/strict";

import { createTestEnv, json } from "../../../../../ts/dist/index.js";
import { buildHelloWorldApp } from "./app.mjs";

const env = createTestEnv();
const app = buildHelloWorldApp({ createApp: (options) => env.app(options), json }, {
  APPTHEORY_HELLO_LANG: "ts",
  APPTHEORY_TIER: "p0",
});

const resp = await env.invoke(app, { method: "GET", path: "/hello/AppTheory" });
assert.equal(resp.status, 200);
const body = JSON.parse(new TextDecoder().decode(resp.body));
assert.equal(body.message, "hello AppTheory");
assert.equal(body.runtime, "ts");

const root = await env.invoke(app, { method: "GET", path: "/" });
assert.equal(root.status, 200);
console.log("examples/cdk/hello-world/handlers/ts/handler.test.mjs: PASS");
