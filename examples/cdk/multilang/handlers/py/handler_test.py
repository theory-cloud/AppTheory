from __future__ import annotations

import json as jsonlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "py" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ["APPTHEORY_TIER"] = "p0"
os.environ["APPTHEORY_DEMO_NAME"] = "demo"
os.environ["APPTHEORY_LANG"] = "py"
os.environ["APPTHEORY_DEMO_QUEUE_NAME"] = "queue1"
os.environ["APPTHEORY_DEMO_SCHEDULE_RULE_NAME"] = "schedule1"
os.environ["APPTHEORY_DEMO_EVENT_SOURCE"] = "apptheory.example"
os.environ["APPTHEORY_DEMO_EVENT_DETAIL_TYPE"] = "example.item.changed"
os.environ["APPTHEORY_DEMO_TABLE_NAME"] = "tbl"

import handler as handler_module  # noqa: E402

from apptheory import (  # noqa: E402
    Request,
    build_apigw_v2_request,
    build_dynamodb_stream_event,
    build_eventbridge_event,
    build_sqs_event,
    build_websocket_event,
    create_test_env,
)


def _json_body(response: dict) -> dict:
    body = response.get("body") or b""
    if isinstance(body, (bytes, bytearray)):
        body = body.decode()
    return jsonlib.loads(body)


def main() -> None:
    env = create_test_env()
    app = handler_module.build_app()

    root = handler_module.handler(build_apigw_v2_request("GET", "/"), None)
    assert root["statusCode"] == 200
    root_body = _json_body(root)
    assert root_body["ok"] is True
    assert root_body["lang"] == "py"
    assert root_body["name"] == "demo"
    assert root_body["tier"] == "p0"

    hello = handler_module.handler(
        build_apigw_v2_request("GET", "/hello/world"), None
    )
    assert hello["statusCode"] == 200
    assert _json_body(hello)["message"] == "hello world"

    stream = env.invoke_streaming(app, Request(method="GET", path="/sse"))
    assert stream.status == 200
    assert stream.headers["content-type"] == ["text/event-stream"]
    assert b'"lang": "py"' in stream.body or b'"lang":"py"' in stream.body

    connect = env.invoke_websocket(
        app, build_websocket_event(route_key="$connect", connection_id="conn-1")
    )
    assert connect["statusCode"] == 200
    assert _json_body(connect)["route_key"] == "$connect"

    disconnect = env.invoke_websocket(
        app, build_websocket_event(route_key="$disconnect", connection_id="conn-1")
    )
    assert disconnect["statusCode"] == 200
    assert _json_body(disconnect)["route_key"] == "$disconnect"

    sqs = env.invoke_sqs(
        app,
        build_sqs_event(
            "arn:aws:sqs:us-east-1:123:queue1", [{"messageId": "msg-1"}]
        ),
    )
    assert sqs["batchItemFailures"] == []

    rule = env.invoke_eventbridge(
        app,
        build_eventbridge_event(
            id="evt-rule",
            source="apptheory.example",
            detail_type="example.item.changed",
            detail={"correlation_id": "corr-rule"},
        ),
    )
    assert rule["kind"] == "rule"
    assert rule["correlation_id"] == "corr-rule"

    schedule = env.invoke_eventbridge(
        app,
        build_eventbridge_event(
            resources=["arn:aws:events:us-east-1:123:rule/schedule1"],
            detail={"run_id": "run-1"},
        ),
    )
    assert schedule["kind"] == "schedule"
    assert schedule["run_id"] == "run-1"

    ddb = env.invoke_dynamodb_stream(
        app,
        build_dynamodb_stream_event(
            "arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020",
            [{"eventID": "rec-1"}],
        ),
    )
    assert ddb["batchItemFailures"] == []

    print("examples/cdk/multilang/handlers/py/handler_test.py: PASS")


if __name__ == "__main__":
    main()
