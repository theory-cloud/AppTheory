import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/app.js";
import { buildAppSyncEvent, createTestEnv } from "../dist/testkit.js";

test("buildAppSyncEvent applies defaults", () => {
  const event = buildAppSyncEvent({
    arguments: { id: "thing_123" },
    headers: { "x-appsync": "yes" },
  });

  assert.equal(event.info.fieldName, "field");
  assert.equal(event.info.parentTypeName, "Mutation");
  assert.deepEqual(event.arguments, { id: "thing_123" });
  assert.deepEqual(event.request?.headers, { "x-appsync": "yes" });
});

test("TestEnv.invokeAppSync delegates to serveAppSync", async () => {
  const env = createTestEnv();
  const app = createApp({ tier: "p2" });

  app.post("/createThing", (ctx) => {
    return {
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      cookies: [],
      body: Buffer.from(
        JSON.stringify({
          method: ctx.request.method,
          path: ctx.request.path,
        }),
        "utf8",
      ),
      isBase64: false,
    };
  });

  const out = await env.invokeAppSync(
    app,
    buildAppSyncEvent({
      fieldName: "createThing",
      parentTypeName: "Mutation",
      arguments: { id: "thing_123" },
    }),
  );

  assert.deepEqual(out, {
    method: "POST",
    path: "/createThing",
  });
});
