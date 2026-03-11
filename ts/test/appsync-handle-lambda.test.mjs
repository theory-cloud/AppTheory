import assert from "node:assert/strict";
import test from "node:test";

import { App, json, text } from "../dist/index.js";

test("handleLambda routes AppSync mutation events and preserves metadata", async () => {
  const app = new App({ tier: "p2" });
  app.post("/createThing", (ctx) => {
    assert.equal(ctx.get("apptheory.trigger_type"), "appsync");
    assert.equal(ctx.get("apptheory.appsync.field_name"), "createThing");
    assert.equal(ctx.get("apptheory.appsync.parent_type_name"), "Mutation");
    assert.deepEqual(ctx.get("apptheory.appsync.identity"), {
      username: "user_1",
    });
    assert.deepEqual(ctx.get("apptheory.appsync.source"), { id: "parent_1" });
    assert.deepEqual(ctx.get("apptheory.appsync.variables"), {
      tenantId: "tenant_1",
    });
    assert.equal(ctx.get("apptheory.appsync.prev"), "prev_value");
    assert.deepEqual(ctx.get("apptheory.appsync.stash"), { trace: "abc123" });
    assert.deepEqual(ctx.get("apptheory.appsync.request_headers"), {
      "x-appsync": "yes",
    });
    assert.equal(
      ctx.get("apptheory.appsync.raw_event").info.fieldName,
      "createThing",
    );

    return json(200, { arguments: ctx.jsonValue() });
  });

  const out = await app.handleLambda({
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

  assert.deepEqual(out, { arguments: { id: "thing_123" } });
});

test("handleLambda routes AppSync query events to GET handlers", async () => {
  const app = new App({ tier: "p2" });
  app.get("/getThing", (ctx) => {
    assert.equal(ctx.request.method, "GET");
    return text(200, "ok");
  });

  const out = await app.handleLambda({
    arguments: {},
    info: {
      fieldName: "getThing",
      parentTypeName: "Query",
    },
  });

  assert.equal(out, "ok");
});

test("handleLambda does not treat blank AppSync field names as AppSync events", async () => {
  const app = new App({ tier: "p2" });

  await assert.rejects(
    app.handleLambda({
      arguments: {},
      info: {
        fieldName: " ",
        parentTypeName: "Mutation",
      },
    }),
    /unknown event type/,
  );
});
