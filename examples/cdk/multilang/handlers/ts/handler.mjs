import {
  createApp,
  json,
  normalizeDynamoDBStreamRecord,
  normalizeEventBridgeScheduledWorkload,
  normalizeEventBridgeWorkloadEnvelope,
  sse,
} from "./vendor/apptheory/index.js";

const tier = process.env.APPTHEORY_TIER ?? "p2";
const name = process.env.APPTHEORY_DEMO_NAME ?? "apptheory-multilang";
const lang = process.env.APPTHEORY_LANG ?? "ts";
const queueName = process.env.APPTHEORY_DEMO_QUEUE_NAME ?? "";
const scheduleRuleName = process.env.APPTHEORY_DEMO_SCHEDULE_RULE_NAME ?? process.env.APPTHEORY_DEMO_RULE_NAME ?? "";
const eventSource = process.env.APPTHEORY_DEMO_EVENT_SOURCE ?? "apptheory.example";
const eventDetailType = process.env.APPTHEORY_DEMO_EVENT_DETAIL_TYPE ?? "example.item.changed";
const tableName = process.env.APPTHEORY_DEMO_TABLE_NAME ?? "";
const snsTopicName = process.env.APPTHEORY_DEMO_SNS_NAME ?? "";

const app = createApp({ tier });

let lastSNSRecord = null;

// recordSNSEvent stores the documented Lambda SNS record fields the harness
// asserts for every language.
function recordSNSEvent(record) {
  const sns = record?.Sns ?? {};
  const entry = {
    lang,
    eventSource: record?.EventSource ?? "",
    eventVersion: record?.EventVersion ?? "",
    eventSubscriptionArn: record?.EventSubscriptionArn ?? "",
    type: sns.Type ?? "",
    messageId: sns.MessageId ?? "",
    topicArn: sns.TopicArn ?? "",
    subject: sns.Subject ?? "",
    message: sns.Message ?? "",
    timestamp: sns.Timestamp ?? "",
    signatureVersion: sns.SignatureVersion ?? "",
    unsubscribeUrl: sns.UnsubscribeUrl ?? "",
    messageAttributes: sns.MessageAttributes ?? {},
  };
  entry.shapeOk =
    entry.type === "Notification" &&
    entry.messageId !== "" &&
    entry.topicArn !== "" &&
    entry.timestamp !== "" &&
    entry.signatureVersion !== "" &&
    entry.unsubscribeUrl !== "";
  return entry;
}

app.get("/", (ctx) =>
  json(200, {
    ok: true,
    lang,
    name,
    tier,
    request_id: ctx.requestId,
    tenant_id: ctx.tenantId,
  }),
);

app.sqs(queueName, async () => {});
app.eventBridge({ source: eventSource, detailType: eventDetailType }, async (ctx, event) => {
  const envelope = normalizeEventBridgeWorkloadEnvelope(ctx, event);
  return {
    ok: true,
    trigger: "eventbridge",
    kind: "rule",
    lang,
    correlation_id: envelope.correlation_id,
    source: envelope.source,
    detail_type: envelope.detail_type,
  };
});
app.eventBridge({ ruleName: scheduleRuleName }, async (ctx, event) => {
  const summary = normalizeEventBridgeScheduledWorkload(ctx, event);
  return {
    ok: true,
    trigger: "eventbridge",
    kind: "schedule",
    lang,
    correlation_id: summary.correlation_id,
    run_id: summary.run_id,
    scheduled_time: summary.scheduled_time,
  };
});
app.dynamoDB(tableName, async (_ctx, record) => {
  const summary = normalizeDynamoDBStreamRecord(record);
  if (!summary.event_id) throw new Error("missing dynamodb event id");
});

app.sns(snsTopicName, (_ctx, record) => {
  lastSNSRecord = recordSNSEvent(record);
  return lastSNSRecord;
});

app.get("/sns-record", () => json(200, { record: lastSNSRecord }));

app.get("/hello/{name}", (ctx) =>
  json(200, {
    message: `hello ${ctx.param("name")}`,
    lang,
    name,
    tier,
    request_id: ctx.requestId,
    tenant_id: ctx.tenantId,
  }),
);

app.get("/sse", () => sse(200, [{ id: "1", event: "message", data: { ok: true, lang, name } }]));

app.webSocket("$connect", (ctx) => {
  const ws = ctx.asWebSocket();
  return json(200, {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    request_id: ws?.requestId ?? ctx.requestId,
  });
});

app.webSocket("$disconnect", (ctx) => {
  const ws = ctx.asWebSocket();
  return json(200, {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    request_id: ws?.requestId ?? ctx.requestId,
  });
});

app.webSocket("$default", async (ctx) => {
  const ws = ctx.asWebSocket();
  if (ws) {
    await ws.sendJSONMessage({ ok: true, lang, name });
  }
  return json(200, {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    management_endpoint: ws?.managementEndpoint ?? "",
    request_id: ws?.requestId ?? ctx.requestId,
  });
});

export const handler = async (event, context) => app.handleLambda(event, context);
