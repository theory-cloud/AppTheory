import os

from apptheory import (
    SSEEvent,
    create_app,
    event_bridge_pattern,
    event_bridge_rule,
    json,
    normalize_dynamodb_stream_record,
    normalize_eventbridge_scheduled_workload,
    normalize_eventbridge_workload_envelope,
    sse,
)


def _build_app():
    tier = os.getenv("APPTHEORY_TIER", "p2")
    name = os.getenv("APPTHEORY_DEMO_NAME", "apptheory-multilang")
    lang = os.getenv("APPTHEORY_LANG", "py")
    queue_name = os.getenv("APPTHEORY_DEMO_QUEUE_NAME", "")
    schedule_rule_name = os.getenv("APPTHEORY_DEMO_SCHEDULE_RULE_NAME") or os.getenv(
        "APPTHEORY_DEMO_RULE_NAME", ""
    )
    event_source = os.getenv("APPTHEORY_DEMO_EVENT_SOURCE", "apptheory.example")
    event_detail_type = os.getenv(
        "APPTHEORY_DEMO_EVENT_DETAIL_TYPE", "example.item.changed"
    )
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

    def eventbridge_rule_handler(ctx, event):
        envelope = normalize_eventbridge_workload_envelope(ctx, event)
        return {
            "ok": True,
            "trigger": "eventbridge",
            "kind": "rule",
            "lang": lang,
            "correlation_id": envelope["correlation_id"],
            "source": envelope["source"],
            "detail_type": envelope["detail_type"],
        }

    def eventbridge_schedule_handler(ctx, event):
        summary = normalize_eventbridge_scheduled_workload(ctx, event)
        return {
            "ok": True,
            "trigger": "eventbridge",
            "kind": "schedule",
            "lang": lang,
            "correlation_id": summary["correlation_id"],
            "run_id": summary["run_id"],
            "scheduled_time": summary["scheduled_time"],
        }

    def dynamodb_handler(_ctx, record):
        summary = normalize_dynamodb_stream_record(record)
        if not summary["event_id"]:
            raise RuntimeError("missing dynamodb event id")

    app.event_bridge(
        event_bridge_pattern(event_source, event_detail_type), eventbridge_rule_handler
    )
    app.event_bridge(
        event_bridge_rule(schedule_rule_name), eventbridge_schedule_handler
    )
    app.dynamodb(table_name, dynamodb_handler)

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
        return sse(
            200,
            [
                SSEEvent(
                    id="1",
                    event="message",
                    data={"ok": True, "lang": lang, "name": name},
                )
            ],
        )

    def ws_connect(ctx):
        ws = ctx.as_websocket()
        return json(
            200,
            {
                "ok": True,
                "lang": lang,
                "name": name,
                "route_key": ws.route_key if ws else "",
                "connection_id": ws.connection_id if ws else "",
                "request_id": ws.request_id if ws else ctx.request_id,
            },
        )

    def ws_disconnect(ctx):
        ws = ctx.as_websocket()
        return json(
            200,
            {
                "ok": True,
                "lang": lang,
                "name": name,
                "route_key": ws.route_key if ws else "",
                "connection_id": ws.connection_id if ws else "",
                "request_id": ws.request_id if ws else ctx.request_id,
            },
        )

    def ws_default(ctx):
        ws = ctx.as_websocket()
        if ws:
            ws.send_json_message({"ok": True, "lang": lang, "name": name})
        return json(
            200,
            {
                "ok": True,
                "lang": lang,
                "name": name,
                "route_key": ws.route_key if ws else "",
                "connection_id": ws.connection_id if ws else "",
                "management_endpoint": ws.management_endpoint if ws else "",
                "request_id": ws.request_id if ws else ctx.request_id,
            },
        )

    app.websocket("$connect", ws_connect)
    app.websocket("$disconnect", ws_disconnect)
    app.websocket("$default", ws_default)

    return app


_APP = _build_app()


def handler(event, context):  # noqa: ARG001
    return _APP.handle_lambda(event, ctx=context)
