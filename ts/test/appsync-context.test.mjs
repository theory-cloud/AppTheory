import assert from "node:assert/strict";
import test from "node:test";

import { App, json } from "../dist/index.js";

test("serveAppSync exposes typed AppSync context metadata", async () => {
  const app = new App({ tier: "p2" });
  app.post("/createThing", (ctx) => {
    const appsync = ctx.asAppSync();
    assert.ok(appsync);
    assert.equal(appsync.fieldName, "createThing");
    assert.equal(appsync.parentTypeName, "Mutation");
    assert.deepEqual(appsync.arguments, { id: "thing_123" });
    assert.deepEqual(appsync.identity, { username: "user_1" });
    assert.deepEqual(appsync.source, { id: "parent_1" });
    assert.deepEqual(appsync.variables, { tenantId: "tenant_1" });
    assert.deepEqual(appsync.stash, { trace: "abc123" });
    assert.equal(appsync.prev, "prev_value");
    assert.deepEqual(appsync.requestHeaders, { "x-appsync": "yes" });
    assert.equal(appsync.rawEvent.info.fieldName, "createThing");
    return json(200, { ok: true });
  });

  const out = await app.serveAppSync({
    arguments: { id: "thing_123" },
    identity: { username: "user_1" },
    source: { id: "parent_1" },
    request: { headers: { "x-appsync": "yes" } },
    info: {
      fieldName: "createThing",
      parentTypeName: "Mutation",
      variables: { tenantId: "tenant_1" },
    },
    prev: "prev_value",
    stash: { trace: "abc123" },
  });

  assert.deepEqual(out, { ok: true });
});
