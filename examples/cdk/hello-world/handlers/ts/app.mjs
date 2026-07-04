export function buildHelloWorldApp(deps, env = process.env) {
  const { createApp, json } = deps;
  const lang = env.APPTHEORY_HELLO_LANG ?? "ts";
  const tier = env.APPTHEORY_TIER ?? "p2";
  const app = createApp({ tier });

  const hello = (ctx, name) =>
    json(200, {
      message: `hello ${name}`,
      runtime: lang,
      request_id: ctx.requestId,
      tenant_id: ctx.tenantId,
    });

  app.get("/", (ctx) => hello(ctx, "world"));
  app.get("/hello/{name}", (ctx) => hello(ctx, ctx.param("name")));
  return app;
}
