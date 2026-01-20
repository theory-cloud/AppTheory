import { createApp, json } from "./vendor/apptheory/index.js";

const tier = process.env.APPTHEORY_TIER ?? "p2";
const name = process.env.APPTHEORY_DEMO_NAME ?? "apptheory-multilang";
const lang = process.env.APPTHEORY_LANG ?? "ts";

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

export const handler = async (event, context) => app.serveAPIGatewayV2(event, context);
