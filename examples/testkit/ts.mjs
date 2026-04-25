import assert from "node:assert/strict";

import {
  buildAPIGatewayV2Request,
  buildDynamoDBStreamEvent,
  buildEventBridgeEvent,
  createTestEnv,
  json,
  normalizeDynamoDBStreamRecord,
  normalizeEventBridgeScheduledWorkload,
  normalizeEventBridgeWorkloadEnvelope,
} from "../../ts/dist/index.js";

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
app.eventBridge({ source: "apptheory.example", detailType: "example.item.changed" }, (ctx, event) =>
  normalizeEventBridgeWorkloadEnvelope(ctx, event),
);
app.eventBridge({ ruleName: "example-schedule" }, (ctx, event) =>
  normalizeEventBridgeScheduledWorkload(ctx, event),
);
app.dynamoDB("ExampleTable", (_ctx, record) => {
  const summary = normalizeDynamoDBStreamRecord(record);
  assert.equal(summary.table_name, "ExampleTable");
  assert.equal(summary.safe_log.includes("do-not-log"), false);
});

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

const ruleOut = await env.invokeEventBridge(
  app,
  buildEventBridgeEvent({
    id: "evt-rule",
    source: "apptheory.example",
    detailType: "example.item.changed",
    detail: { correlation_id: "corr-rule" },
  }),
);
assert.equal(ruleOut.correlation_id, "corr-rule");
assert.equal(ruleOut.detail_type, "example.item.changed");

const scheduleOut = await env.invokeEventBridge(
  app,
  buildEventBridgeEvent({
    ruleArn: "arn:aws:events:us-east-1:123456789012:rule/example-schedule",
    id: "evt-schedule",
    detail: { run_id: "run-1" },
  }),
);
assert.equal(scheduleOut.kind, "scheduled");
assert.equal(scheduleOut.run_id, "run-1");

const streamResp = await env.invokeDynamoDBStream(
  app,
  buildDynamoDBStreamEvent("arn:aws:dynamodb:us-east-1:123456789012:table/ExampleTable/stream/2026", [
    {
      eventID: "stream-1",
      dynamodb: {
        SequenceNumber: "1",
        SizeBytes: 1,
        StreamViewType: "NEW_AND_OLD_IMAGES",
        NewImage: { secret: { S: "do-not-log" } },
      },
    },
  ]),
);
assert.deepEqual(streamResp.batchItemFailures, []);

console.log("examples/testkit/ts.mjs: PASS");
