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

export const handler = async (event, context) => app.handleLambda(event, context);
