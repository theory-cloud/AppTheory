import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const distDir = path.join(repoRoot, "ts", "dist");
const nodeModulesDir = path.join(repoRoot, "ts", "node_modules");

// Stage the Lambda asset exactly as the stack's local bundler does: the handler
// files plus the complete ts/dist runtime under vendor/apptheory.
const stage = mkdtempSync(path.join(tmpdir(), "apptheory-multilang-ts-"));
try {
  const vendorDir = path.join(stage, "vendor", "apptheory");
  mkdirSync(vendorDir, { recursive: true });
  for (const file of ["handler.mjs", "package.json"]) {
    cpSync(path.join(here, file), path.join(stage, file));
  }
  cpSync(distDir, vendorDir, { recursive: true });
  // The deployment environment provides the runtime's declared dependencies.
  symlinkSync(nodeModulesDir, path.join(stage, "node_modules"), "dir");

  process.env.APPTHEORY_TIER = "p0";
  process.env.APPTHEORY_DEMO_NAME = "demo";
  process.env.APPTHEORY_LANG = "ts";
  process.env.APPTHEORY_DEMO_QUEUE_NAME = "queue1";
  process.env.APPTHEORY_DEMO_SCHEDULE_RULE_NAME = "schedule1";
  process.env.APPTHEORY_DEMO_EVENT_SOURCE = "apptheory.example";
  process.env.APPTHEORY_DEMO_EVENT_DETAIL_TYPE = "example.item.changed";
  process.env.APPTHEORY_DEMO_TABLE_NAME = "tbl";

  const { handler } = await import(pathToFileURL(path.join(stage, "handler.mjs")).href);
  const {
    buildAPIGatewayV2Request,
    buildDynamoDBStreamEvent,
    buildEventBridgeEvent,
    buildSQSEvent,
  } = await import(pathToFileURL(path.join(vendorDir, "index.js")).href);

  const root = await handler(buildAPIGatewayV2Request("GET", "/"), {});
  assert.equal(root.statusCode, 200);
  const rootBody = JSON.parse(root.body);
  assert.equal(rootBody.ok, true);
  assert.equal(rootBody.lang, "ts");
  assert.equal(rootBody.name, "demo");
  assert.equal(rootBody.tier, "p0");

  const hello = await handler(buildAPIGatewayV2Request("GET", "/hello/world"), {});
  assert.equal(hello.statusCode, 200);
  assert.equal(JSON.parse(hello.body).message, "hello world");

  const stream = await handler(buildAPIGatewayV2Request("GET", "/sse"), {});
  assert.equal(stream.statusCode, 200);
  assert.equal(stream.headers["content-type"], "text/event-stream");
  assert.ok(stream.body.includes('"lang":"ts"'), `unexpected SSE body: ${stream.body}`);

  const connectEvent = {
    requestContext: {
      routeKey: "$connect",
      connectionId: "conn-1",
      requestId: "ws-connect",
      domainName: "example.execute-api.us-east-1.amazonaws.com",
      stage: "dev",
    },
    headers: {},
    queryStringParameters: null,
    body: null,
    isBase64Encoded: false,
  };
  const connect = await handler(connectEvent, {});
  assert.equal(connect.statusCode, 200);
  assert.equal(JSON.parse(connect.body).route_key, "$connect");

  const disconnect = await handler(
    {
      ...connectEvent,
      requestContext: { ...connectEvent.requestContext, routeKey: "$disconnect" },
    },
    {},
  );
  assert.equal(disconnect.statusCode, 200);
  assert.equal(JSON.parse(disconnect.body).route_key, "$disconnect");

  const sqs = await handler(
    buildSQSEvent("arn:aws:sqs:us-east-1:123:queue1", [{ messageId: "msg-1" }]),
    {},
  );
  assert.deepEqual(sqs.batchItemFailures, []);

  const rule = await handler(
    buildEventBridgeEvent({
      id: "evt-rule",
      source: "apptheory.example",
      detailType: "example.item.changed",
      detail: { correlation_id: "corr-rule" },
    }),
    {},
  );
  assert.equal(rule.kind, "rule");
  assert.equal(rule.correlation_id, "corr-rule");

  const schedule = await handler(
    buildEventBridgeEvent({
      resources: ["arn:aws:events:us-east-1:123:rule/schedule1"],
      detail: { run_id: "run-1" },
    }),
    {},
  );
  assert.equal(schedule.kind, "schedule");
  assert.equal(schedule.run_id, "run-1");

  const ddb = await handler(
    buildDynamoDBStreamEvent("arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020", [
      { eventID: "rec-1" },
    ]),
    {},
  );
  assert.deepEqual(ddb.batchItemFailures, []);
} finally {
  rmSync(stage, { force: true, recursive: true });
}

console.log("examples/cdk/multilang/handlers/ts/handler.test.mjs: PASS");
