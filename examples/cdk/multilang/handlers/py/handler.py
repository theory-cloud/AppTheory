import os

from apptheory import SSEEvent, create_app, event_bridge_rule, json, sse


def _build_app():
    tier = os.getenv("APPTHEORY_TIER", "p2")
    name = os.getenv("APPTHEORY_DEMO_NAME", "apptheory-multilang")
    lang = os.getenv("APPTHEORY_LANG", "py")
    queue_name = os.getenv("APPTHEORY_DEMO_QUEUE_NAME", "")
    rule_name = os.getenv("APPTHEORY_DEMO_RULE_NAME", "")
    table_name = os.getenv("APPTHEORY_DEMO_TABLE_NAME", "")

    app = create_app(tier=tier)

    @app.get("/")
    def root(ctx):
        return json(
            200,
            {
                "ok": True,
                "lang": lang,
                "name": name,
                "tier": tier,
                "request_id": ctx.request_id,
                "tenant_id": ctx.tenant_id,
            },
        )

    app.sqs(queue_name, lambda _ctx, _msg: None)
    app.event_bridge(
        event_bridge_rule(rule_name),
        lambda _ctx, _event: {"ok": True, "trigger": "eventbridge", "lang": lang},
    )
    app.dynamodb(table_name, lambda _ctx, _record: None)

    @app.get("/hello/{name}")
    def hello(ctx):
        return json(
            200,
            {
                "message": f"hello {ctx.param('name')}",
                "lang": lang,
                "name": name,
                "tier": tier,
                "request_id": ctx.request_id,
                "tenant_id": ctx.tenant_id,
            },
        )

    @app.get("/sse")
    def sse_demo(_ctx):
        return sse(200, [SSEEvent(id="1", event="message", data={"ok": True, "lang": lang, "name": name})])

    return app


_APP = _build_app()


def handler(event, context):  # noqa: ARG001
    return _APP.handle_lambda(event, ctx=context)
