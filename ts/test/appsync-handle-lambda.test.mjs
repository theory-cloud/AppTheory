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

test("handleLambda maps a panicking SNS handler to the event-workload error shape", async () => {
  const app = new App({ tier: "p2" });
  app.sns("topic1", () => {
    throw new Error("boom");
  });

  await assert.rejects(
    app.handleLambda({
      Records: [
        {
          EventSource: "aws:sns",
          Sns: { TopicArn: "arn:aws:sns:us-east-1:123:topic1" },
        },
      ],
    }),
    (err) => {
      // A panicking / throwing user callback must not take down the SNS
      // adapter path with an arbitrary error; it maps to the established
      // event-workload failure shape.
      assert.equal(err.message, "apptheory: event workload failed");
      return true;
    },
  );
});

test("handleLambda isolates a panicking SQS handler per record", async () => {
  const app = new App({ tier: "p2" });
  app.sqs("queue1", (ctx, record) => {
    if (String(record.messageId) === "2") {
      throw new Error("boom");
    }
    return undefined;
  });

  const out = await app.handleLambda({
    Records: [
      { eventSource: "aws:sqs", messageId: "1", eventSourceARN: "arn:aws:sqs:us-east-1:123:queue1" },
      { eventSource: "aws:sqs", messageId: "2", eventSourceARN: "arn:aws:sqs:us-east-1:123:queue1" },
    ],
  });

  assert.deepEqual(out, { batchItemFailures: [{ itemIdentifier: "2" }] });
});
