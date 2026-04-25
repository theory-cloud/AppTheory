import json as jsonlib
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py" / "src"))

from apptheory import (  # noqa: E402
    build_apigw_v2_request,
    build_dynamodb_stream_event,
    build_eventbridge_event,
    create_test_env,
    event_bridge_pattern,
    event_bridge_rule,
    json,
    normalize_dynamodb_stream_record,
    normalize_eventbridge_scheduled_workload,
    normalize_eventbridge_workload_envelope,
)


def main() -> None:
    env = create_test_env(now=datetime(2026, 1, 1, tzinfo=UTC))
    env.ids.push("req-1")

    app = env.app()

    def mw(ctx, next_handler):
        ctx.set("mw", "ok")
        resp = next_handler(ctx)
        resp.headers["x-middleware"] = ["1"]
        return resp

    app.use(mw)
    app.get(
        "/hello",
        lambda ctx: json(
            200, {"now": ctx.now().isoformat(), "id": ctx.new_id(), "mw": ctx.get("mw")}
        ),
    )
    app.event_bridge(
        event_bridge_pattern("apptheory.example", "example.item.changed"),
        lambda ctx, event: normalize_eventbridge_workload_envelope(ctx, event),
    )
    app.event_bridge(
        event_bridge_rule("example-schedule"),
        lambda ctx, event: normalize_eventbridge_scheduled_workload(ctx, event),
    )

    def handle_stream_record(_ctx, record):
        summary = normalize_dynamodb_stream_record(record)
        assert summary["table_name"] == "ExampleTable"
        assert "do-not-log" not in summary["safe_log"]

    app.dynamodb("ExampleTable", handle_stream_record)

    event = build_apigw_v2_request(
        "GET", "/hello", headers={"x-request-id": "request-1"}
    )
    resp = env.invoke_apigw_v2(app, event)

    assert resp["statusCode"] == 200
    assert resp["headers"]["x-request-id"] == "request-1"
    assert resp["headers"]["x-middleware"] == "1"
    body = jsonlib.loads(resp["body"])
    assert body["id"] == "req-1"
    assert body["now"] == "2026-01-01T00:00:00+00:00"
    assert body["mw"] == "ok"

    rule_out = env.invoke_eventbridge(
        app,
        build_eventbridge_event(
            id="evt-rule",
            source="apptheory.example",
            detail_type="example.item.changed",
            detail={"correlation_id": "corr-rule"},
        ),
    )
    assert rule_out["correlation_id"] == "corr-rule"
    assert rule_out["detail_type"] == "example.item.changed"

    schedule_out = env.invoke_eventbridge(
        app,
        build_eventbridge_event(
            rule_arn="arn:aws:events:us-east-1:123456789012:rule/example-schedule",
            id="evt-schedule",
            detail={"run_id": "run-1"},
        ),
    )
    assert schedule_out["kind"] == "scheduled"
    assert schedule_out["run_id"] == "run-1"

    stream_resp = env.invoke_dynamodb_stream(
        app,
        build_dynamodb_stream_event(
            "arn:aws:dynamodb:us-east-1:123456789012:table/ExampleTable/stream/2026",
            [
                {
                    "eventID": "stream-1",
                    "dynamodb": {
                        "SequenceNumber": "1",
                        "SizeBytes": 1,
                        "StreamViewType": "NEW_AND_OLD_IMAGES",
                        "NewImage": {"secret": {"S": "do-not-log"}},
                    },
                }
            ],
        ),
    )
    assert stream_resp["batchItemFailures"] == []

    print("examples/testkit/py.py: PASS")


if __name__ == "__main__":
    main()
