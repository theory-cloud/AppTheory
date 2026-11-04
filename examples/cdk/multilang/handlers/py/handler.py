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


def build_app():
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

    app.get("/", root)

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

    sns_topic_name = os.getenv("APPTHEORY_DEMO_SNS_NAME", "")
    sns_state = {"record": None}

    def record_sns_event(record):
        sns = record.get("Sns") or {}
        entry = {
            "lang": lang,
            "eventSource": record.get("EventSource", ""),
            "eventVersion": record.get("EventVersion", ""),
            "eventSubscriptionArn": record.get("EventSubscriptionArn", ""),
            "type": sns.get("Type", ""),
            "messageId": sns.get("MessageId", ""),
            "topicArn": sns.get("TopicArn", ""),
            "subject": sns.get("Subject", ""),
            "message": sns.get("Message", ""),
            "timestamp": sns.get("Timestamp", ""),
            "signatureVersion": sns.get("SignatureVersion", ""),
            "unsubscribeUrl": sns.get("UnsubscribeUrl", ""),
            "messageAttributes": sns.get("MessageAttributes") or {},
        }
        entry["shapeOk"] = (
            entry["type"] == "Notification"
            and bool(entry["messageId"])
            and bool(entry["topicArn"])
            and bool(entry["timestamp"])
            and bool(entry["signatureVersion"])
            and bool(entry["unsubscribeUrl"])
        )
        return entry

    def sns_handler(_ctx, record):
        sns_state["record"] = record_sns_event(record)
        return sns_state["record"]

    def sns_record(_ctx):
        return json(200, {"record": sns_state["record"]})

    app.sns(sns_topic_name, sns_handler)
    app.get("/sns-record", sns_record)

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

    app.get("/hello/{name}", hello)

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

    app.get("/sse", sse_demo)

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


_APP = build_app()


def handler(event, context):  # noqa: ARG001
    return _APP.handle_lambda(event, ctx=context)
