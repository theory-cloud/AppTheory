import {
  ApiGatewayManagementApiClient,
  GetConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

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

const wsDisconnects = [];

let lastSNSRecord = null;
const streamRecords = [];
const streamRecordHistory = 50;
const eventBridgeRecords = [];

function recordEventBridgeEvent(kind, event) {
  return {
    kind,
    id: event?.id ?? "",
    source: event?.source ?? "",
    detailType: event?.["detail-type"] ?? "",
    resources: event?.resources ?? [],
    detail: event?.detail ?? {},
    time: event?.time ?? "",
    region: event?.region ?? "",
    account: event?.account ?? "",
  };
}

function appendEventBridgeRecord(entry) {
  eventBridgeRecords.push(entry);
  if (eventBridgeRecords.length > streamRecordHistory) eventBridgeRecords.shift();
}

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
  appendEventBridgeRecord(recordEventBridgeEvent("rule", event));
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
  appendEventBridgeRecord(recordEventBridgeEvent("schedule", event));
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
  const entry = {
    eventID: record.EventID ?? "",
    eventName: record.eventName ?? "",
    eventSource: record.eventSource ?? "",
    eventSourceARN: record.eventSourceARN ?? "",
    awsRegion: record.awsRegion ?? "",
    keys: record.dynamodb?.Keys ?? {},
    newImage: record.dynamodb?.NewImage ?? {},
    sequenceNumber: record.dynamodb?.SequenceNumber ?? "",
  };
  if (record.userIdentity) {
    entry.userIdentity = {
      type: record.userIdentity.type,
      principalId: record.userIdentity.principalId,
    };
  }
  streamRecords.push(entry);
  if (streamRecords.length > streamRecordHistory) streamRecords.shift();
});

app.get("/stream-records", () => json(200, { records: streamRecords.slice() }));

app.get("/eventbridge-records", () => json(200, { records: eventBridgeRecords.slice() }));

// The harness supplies an instant as whole seconds and nanoseconds so the real
// SDK call carries a fractional Time and the rule delivers it back. The Lambda
// Node.js runtime ships the AWS SDK v3 on NODE_PATH; the lazy import keeps the
// host-side handler test free of the package.
app.post("/event-time/{seconds}/{nanos}", async (ctx) => {
  const { EventBridgeClient, PutEventsCommand } = await import("@aws-sdk/client-eventbridge");
  const seconds = Number(ctx.param("seconds"));
  const nanos = Number(ctx.param("nanos"));
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return json(400, { error: "seconds and nanos must be numbers" });
  }
  const instant = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
  const output = await new EventBridgeClient({}).send(
    new PutEventsCommand({
      Entries: [
        {
          Source: eventSource,
          DetailType: eventDetailType,
          Detail: JSON.stringify({ item: `${lang}-sdk-time` }),
          Time: instant,
        },
      ],
    }),
  );
  return json(200, {
    event_id: output.Entries?.[0]?.EventId ?? "",
    failed: output.FailedEntryCount ?? 0,
    time: instant.toISOString(),
  });
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
  wsDisconnects.push({ connection_id: ws?.connectionId ?? "", route_key: ws?.routeKey ?? "" });
  return json(200, {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    request_id: ws?.requestId ?? ctx.requestId,
  });
});

function messageBody(ctx) {
  try {
    const raw = ctx?.request?.body;
    if (!raw || raw.length === 0) return {};
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return {};
  }
}

app.get("/ws-disconnects", () => json(200, { events: wsDisconnects.slice() }));

app.webSocket("chat", (ctx) => {
  const ws = ctx.asWebSocket();
  const message = messageBody(ctx);
  return json(200, {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    echo: String(message.message ?? ""),
  });
});

app.webSocket("$default", async (ctx) => {
  const ws = ctx.asWebSocket();
  const command = messageBody(ctx);
  const response = {
    ok: true,
    lang,
    name,
    route_key: ws?.routeKey ?? "",
    connection_id: ws?.connectionId ?? "",
    management_endpoint: ws?.managementEndpoint ?? "",
    request_id: ws?.requestId ?? ctx.requestId,
  };
  if (command.cmd === "get" && ws) {
    // The client is built from the endpoint the request context reports, so a
    // handler that never reads the environment still reaches the local
    // @connections API.
    const client = new ApiGatewayManagementApiClient({ endpoint: ws.managementEndpoint });
    const connection = await client.send(new GetConnectionCommand({ ConnectionId: ws.connectionId }));
    response.connection = {
      connected_at: Number(connection.ConnectedAt ?? 0),
      last_active_at: Number(connection.LastActiveAt ?? 0),
    };
    return json(200, response);
  }
  if (ws) {
    await ws.sendJSONMessage({ ok: true, lang, name });
  }
  return json(200, response);
});

export const handler = async (event, context) => app.handleLambda(event, context);
