import { createApp, json, sse } from "./vendor/apptheory/index.js";

const tier = process.env.APPTHEORY_TIER ?? "p2";
const name = process.env.APPTHEORY_DEMO_NAME ?? "apptheory-multilang";
const lang = process.env.APPTHEORY_LANG ?? "ts";
const queueName = process.env.APPTHEORY_DEMO_QUEUE_NAME ?? "";
const ruleName = process.env.APPTHEORY_DEMO_RULE_NAME ?? "";
const tableName = process.env.APPTHEORY_DEMO_TABLE_NAME ?? "";

const app = createApp({ tier });

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
app.eventBridge({ ruleName }, async () => ({ ok: true, trigger: "eventbridge", lang }));
app.dynamoDB(tableName, async () => {});

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
