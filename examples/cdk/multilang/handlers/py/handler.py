import json as jsonlib
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

    eventbridge_records = []

    def record_eventbridge_event(kind, event):
        return {
            "kind": kind,
            "id": event.get("id", ""),
            "source": event.get("source", ""),
            "detailType": event.get("detail-type", ""),
            "resources": event.get("resources", []),
            "detail": event.get("detail", {}),
            "time": event.get("time", ""),
            "region": event.get("region", ""),
            "account": event.get("account", ""),
        }

    def append_eventbridge_record(entry):
        eventbridge_records.append(entry)
        del eventbridge_records[:-50]

    def eventbridge_rule_handler(ctx, event):
        envelope = normalize_eventbridge_workload_envelope(ctx, event)
        append_eventbridge_record(record_eventbridge_event("rule", event))
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
        append_eventbridge_record(record_eventbridge_event("schedule", event))
        return {
            "ok": True,
            "trigger": "eventbridge",
            "kind": "schedule",
            "lang": lang,
            "correlation_id": summary["correlation_id"],
            "run_id": summary["run_id"],
            "scheduled_time": summary["scheduled_time"],
        }

    stream_records = []

    def dynamodb_handler(_ctx, record):
        summary = normalize_dynamodb_stream_record(record)
        if not summary["event_id"]:
            raise RuntimeError("missing dynamodb event id")
        change = record.get("dynamodb") or {}
        entry = {
            "eventID": record.get("eventID", ""),
            "eventName": record.get("eventName", ""),
            "eventSource": record.get("eventSource", ""),
            "eventSourceARN": record.get("eventSourceARN", ""),
            "awsRegion": record.get("awsRegion", ""),
            "keys": change.get("Keys") or {},
            "newImage": change.get("NewImage") or {},
            "sequenceNumber": change.get("SequenceNumber", ""),
        }
        identity = record.get("userIdentity")
        if identity:
            entry["userIdentity"] = {
                "type": identity.get("type", ""),
                "principalId": identity.get("principalId", ""),
            }
        stream_records.append(entry)
        del stream_records[:-50]

    def stream_records_handler(_ctx):
        return json(200, {"records": list(stream_records)})

    def eventbridge_records_handler(_ctx):
        return json(200, {"records": list(eventbridge_records)})

    app.event_bridge(
        event_bridge_pattern(event_source, event_detail_type), eventbridge_rule_handler
    )
    app.event_bridge(
        event_bridge_rule(schedule_rule_name), eventbridge_schedule_handler
    )
    app.dynamodb(table_name, dynamodb_handler)
    app.get("/stream-records", stream_records_handler)
    app.get("/eventbridge-records", eventbridge_records_handler)

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

    ws_disconnects = []

    def ws_disconnect(ctx):
        ws = ctx.as_websocket()
        ws_disconnects.append(
            {
                "connection_id": ws.connection_id if ws else "",
                "route_key": ws.route_key if ws else "",
            }
        )
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

    def ws_disconnects_view(ctx):  # noqa: ARG001
        return json(200, {"events": list(ws_disconnects)})

    def ws_chat(ctx):
        ws = ctx.as_websocket()
        message = {}
        if ctx.request.body:
            try:
                message = jsonlib.loads(ctx.request.body.decode("utf-8"))
            except ValueError:
                message = {}
        return json(
            200,
            {
                "ok": True,
                "lang": lang,
                "name": name,
                "route_key": ws.route_key if ws else "",
                "connection_id": ws.connection_id if ws else "",
                "echo": str(message.get("message", "")),
            },
        )

    def ws_default(ctx):
        ws = ctx.as_websocket()
        command = {}
        if ctx.request.body:
            try:
                command = jsonlib.loads(ctx.request.body.decode("utf-8"))
            except ValueError:
                command = {}
        response = {
            "ok": True,
            "lang": lang,
            "name": name,
            "route_key": ws.route_key if ws else "",
            "connection_id": ws.connection_id if ws else "",
            "management_endpoint": ws.management_endpoint if ws else "",
            "request_id": ws.request_id if ws else ctx.request_id,
        }
        if command.get("cmd") == "get" and ws:
            # boto3 is imported lazily: the Lambda Python image provides it, and
            # a host-side handler test imports this module without it. boto3
            # resolves the endpoint from the request context, so a handler that
            # never reads the environment still reaches the local @connections
            # API.
            import boto3  # noqa: PLC0415

            client = boto3.client("apigatewaymanagementapi", endpoint_url=ws.management_endpoint)
            connection = client.get_connection(ConnectionId=ws.connection_id)
            response["connection"] = {
                "connected_at": int(connection.get("ConnectedAt").timestamp() * 1000),
                "last_active_at": int(connection.get("LastActiveAt").timestamp() * 1000),
            }
            return json(200, response)
        if ws:
            ws.send_json_message({"ok": True, "lang": lang, "name": name})
        return json(200, response)

    app.websocket("$connect", ws_connect)
    app.websocket("$disconnect", ws_disconnect)
    app.get("/ws-disconnects", ws_disconnects_view)
    app.websocket("chat", ws_chat)
    app.websocket("$default", ws_default)

    return app


_APP = build_app()


def handler(event, context):  # noqa: ARG001
    return _APP.handle_lambda(event, ctx=context)
