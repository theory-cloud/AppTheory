from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.app import (  # noqa: E402
    App,
    CORSConfig,
    EventBridgeSelector,
    Limits,
    ObservabilityHooks,
    PolicyDecision,
    create_app,
    event_bridge_pattern,
    event_bridge_rule,
    _eventbridge_rule_name_from_arn,
    _kinesis_stream_name_from_arn,
    _request_from_websocket_event,
    _sns_topic_name_from_arn,
    _sqs_queue_name_from_arn,
    _websocket_management_endpoint,
)
from apptheory.errors import AppError  # noqa: E402
from apptheory.request import Request  # noqa: E402
from apptheory.response import Response  # noqa: E402


def _ok(_ctx) -> Response:
    return Response(status=200, headers={}, cookies=[], body=b"ok", is_base64=False)


class TestApp(unittest.TestCase):
    def test_async_http_and_event_handlers_are_supported(self) -> None:
        app = create_app(tier="p0")

        async def ok_async(_ctx) -> Response:
            await asyncio.sleep(0)
            return Response(status=200, headers={}, cookies=[], body=b"ok", is_base64=False)

        app.get("/", ok_async)
        resp = app.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(resp.status, 200)

        calls: list[str] = []

        async def sqs_handler(_ctx, rec: dict) -> None:
            await asyncio.sleep(0)
            calls.append(str(rec.get("messageId") or ""))

        app.sqs("q", sqs_handler)
        out = app.handle_lambda(
            {
                "Records": [
                    {"eventSource": "aws:sqs", "eventSourceARN": "arn:aws:sqs:us-east-1:0:q", "messageId": "m1"},
                    {"eventSource": "aws:sqs", "messageId": "m2"},
                ]
            }
        )
        self.assertEqual(out, {"batchItemFailures": []})
        self.assertEqual(calls, ["m1", "m2"])

    def test_tier_p0_routing_method_not_allowed_and_errors(self) -> None:
        app: App = create_app(tier="p0")
        app.get("/", _ok)

        ok = app.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(ok.status, 200)

        missing = app.serve(Request(method="GET", path="/missing", body=""))
        self.assertEqual(missing.status, 404)

        wrong_method = app.serve(Request(method="POST", path="/", body=""))
        self.assertEqual(wrong_method.status, 405)
        self.assertIn("allow", wrong_method.headers)

        bad_body = app.serve(Request(method="GET", path="/", body={"bad": True}))
        self.assertEqual(bad_body.status, 500)

        def conflict(_ctx) -> Response:
            raise AppError("app.conflict", "conflict")

        app.get("/conflict", conflict)
        resp = app.serve(Request(method="GET", path="/conflict", body=""))
        self.assertEqual(resp.status, 409)

    def test_handle_strict_rejects_invalid_patterns(self) -> None:
        app: App = create_app(tier="p0")
        with self.assertRaises(ValueError):
            app.handle_strict("GET", "/{proxy+}/x", _ok)

    def test_tier_p2_preflight_policy_auth_and_limits(self) -> None:
        cors = CORSConfig(allowed_origins=["*"], allow_credentials=True, allow_headers=["X-One", " X-Two ", ""])
        app: App = create_app(
            tier="p2",
            cors=cors,
            policy_hook=lambda _ctx: PolicyDecision(code="app.rate_limited", message=""),
        )
        app.get("/", _ok)

        preflight = app.serve(
            Request(
                method="OPTIONS",
                path="/",
                headers={"origin": "https://example.com", "access-control-request-method": "GET"},
                body="",
            )
        )
        self.assertEqual(preflight.status, 204)
        self.assertEqual(preflight.headers["access-control-allow-methods"], ["GET"])
        self.assertEqual(preflight.headers["access-control-allow-origin"], ["https://example.com"])
        self.assertEqual(preflight.headers["access-control-allow-credentials"], ["true"])
        self.assertEqual(preflight.headers["access-control-allow-headers"], ["X-One, X-Two"])

        limited = app.serve(Request(method="GET", path="/", headers={"x-request-id": "req_1"}, body=""))
        self.assertEqual(limited.status, 429)
        self.assertEqual(json.loads(limited.body)["error"]["code"], "app.rate_limited")

        def policy_boom(_ctx) -> PolicyDecision | None:
            raise AppError("app.overloaded", "nope")

        app2: App = create_app(tier="p2", policy_hook=policy_boom)
        app2.get("/", _ok)
        overloaded = app2.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(overloaded.status, 503)

        auth_missing: App = create_app(tier="p2")
        auth_missing.handle("GET", "/secure", _ok, auth_required=True)
        unauth = auth_missing.serve(Request(method="GET", path="/secure", body=""))
        self.assertEqual(unauth.status, 401)

        auth_blank: App = create_app(tier="p2", auth_hook=lambda _ctx: "  ")
        auth_blank.handle("GET", "/secure", _ok, auth_required=True)
        unauth2 = auth_blank.serve(Request(method="GET", path="/secure", body=""))
        self.assertEqual(unauth2.status, 401)

        auth_ok: App = create_app(tier="p2", auth_hook=lambda _ctx: "user_1")
        auth_ok.handle("GET", "/secure", _ok, auth_required=True)
        ok2 = auth_ok.serve(Request(method="GET", path="/secure", body=""))
        self.assertEqual(ok2.status, 200)

        limited_req: App = create_app(tier="p2", limits=Limits(max_request_bytes=1))
        limited_req.get("/", _ok)
        too_large_req = limited_req.serve(Request(method="POST", path="/", body="ab"))
        self.assertEqual(too_large_req.status, 413)

        limited_resp: App = create_app(tier="p2", limits=Limits(max_response_bytes=1))

        def big(_ctx) -> Response:
            return Response(status=200, headers={}, cookies=[], body=b"ab", is_base64=False)

        limited_resp.get("/", big)
        too_large_resp = limited_resp.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(too_large_resp.status, 413)

        bad_norm = limited_resp.serve(Request(method="GET", path="/", body={"bad": True}))
        self.assertEqual(bad_norm.status, 500)

    def test_remaining_ms_is_applied_and_observability_hooks_fire(self) -> None:
        logs = []
        metrics = []

        hooks = ObservabilityHooks(
            log=lambda r: logs.append(r),
            metric=lambda r: metrics.append(r),
        )

        def handler(ctx) -> Response:
            return Response(status=200, headers={"x-remaining-ms": [str(ctx.remaining_ms)]}, cookies=[], body=b"ok", is_base64=False)

        app = create_app(tier="p2", observability=hooks)
        app.get("/", handler)

        class Ctx:
            def get_remaining_time_in_millis(self) -> int:
                return 1234

        resp = app.serve(Request(method="GET", path="/", body=""), ctx=Ctx())
        self.assertEqual(resp.headers["x-remaining-ms"], ["1234"])
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].level, "info")
        self.assertEqual(len(metrics), 1)

    def test_event_bridge_helpers_and_invalid_tier_normalization(self) -> None:
        app = create_app(tier="nope")
        self.assertEqual(app._tier, "p2")

        sel = event_bridge_rule(" r1 ")
        self.assertEqual(sel.rule_name, "r1")

        sel2 = event_bridge_pattern("src", "type")
        self.assertEqual(sel2.source, "src")
        self.assertEqual(sel2.detail_type, "type")

    def test_event_routes_and_empty_inputs_short_circuit(self) -> None:
        app = create_app(tier="p2")
        app.sqs("", lambda _ctx, _rec: None)
        app.kinesis("", lambda _ctx, _rec: None)
        app.sns("", lambda _ctx, _rec: None)
        app.dynamodb("", lambda _ctx, _rec: None)
        app.websocket("", _ok)
        app.event_bridge(None, lambda _ctx, _evt: None)  # type: ignore[arg-type]
        app.event_bridge(EventBridgeSelector(), lambda _ctx, _evt: None)
        app.use(None)  # type: ignore[arg-type]
        app.use_events(None)  # type: ignore[arg-type]

    def test_portable_method_not_allowed_and_generic_handler_error(self) -> None:
        app = create_app(tier="p2")

        def boom(_ctx) -> Response:
            raise ValueError("boom")

        app.get("/", boom)

        not_allowed = app.serve(Request(method="POST", path="/", body=""))
        self.assertEqual(not_allowed.status, 405)

        internal = app.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(internal.status, 500)

    def test_http_entrypoints_return_error_responses_on_invalid_events(self) -> None:
        app = create_app(tier="p2")
        self.assertEqual(app.serve_apigw_v2(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_lambda_function_url(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_apigw_proxy(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_alb(None)["statusCode"], 500)  # type: ignore[arg-type]

    def test_websocket_helpers_and_not_found_route(self) -> None:
        app = create_app(tier="p2")

        evt = {
            "httpMethod": "POST",
            "path": "/",
            "headers": {},
            "queryStringParameters": {"a": "1"},
            "multiValueQueryStringParameters": {"b": ["2", None]},  # None should be skipped
            "body": "",
            "isBase64Encoded": False,
            "requestContext": "not-a-dict",
        }
        req = _request_from_websocket_event(evt)
        self.assertEqual(req.query, {"b": ["2", "None"]})

        resp = app.serve_websocket(evt)
        self.assertEqual(resp["statusCode"], 404)

        self.assertEqual(_websocket_management_endpoint("", "dev", "/"), "")
        self.assertEqual(
            _websocket_management_endpoint("example.execute-api.us-east-1.amazonaws.com", "dev", "/"),
            "https://example.execute-api.us-east-1.amazonaws.com/dev",
        )
        self.assertEqual(_websocket_management_endpoint("example.com", "production", "/"), "https://example.com")
        self.assertEqual(
            _websocket_management_endpoint("https://example.com/", "production", "/socket/"),
            "https://example.com/socket",
        )

    def test_lambda_event_routing_and_failure_shapes(self) -> None:
        app = create_app(tier="p2")

        with self.assertRaisesRegex(RuntimeError, "unknown event type"):
            app.handle_lambda("nope")  # type: ignore[arg-type]

        sqs = {
            "Records": [
                {"eventSource": "aws:sqs", "eventSourceARN": "arn:aws:sqs:us-east-1:000000000000:q", "messageId": "m1"},
                {"eventSource": "aws:sqs", "messageId": "m2"},
            ]
        }
        out = app.handle_lambda(sqs)
        self.assertEqual(out, {"batchItemFailures": [{"itemIdentifier": "m1"}, {"itemIdentifier": "m2"}]})

        ddb = {
            "Records": [
                {"eventSource": "aws:dynamodb", "eventSourceARN": "arn:aws:dynamodb:us-east-1:000000000000:table/t/stream/1", "eventID": "e1"},
            ]
        }
        out2 = app.handle_lambda(ddb)
        self.assertEqual(out2, {"batchItemFailures": [{"itemIdentifier": "e1"}]})

        kin = {
            "Records": [
                {"eventSource": "aws:kinesis", "eventSourceARN": "arn:aws:kinesis:us-east-1:000000000000:stream/s", "eventID": "k1"},
            ]
        }
        out3 = app.handle_lambda(kin)
        self.assertEqual(out3, {"batchItemFailures": [{"itemIdentifier": "k1"}]})

        sns = {
            "Records": [
                {"EventSource": "aws:sns", "Sns": {"TopicArn": "arn:aws:sns:us-east-1:000000000000:t"}},
            ]
        }
        with self.assertRaisesRegex(RuntimeError, "unrecognized sns topic"):
            app.handle_lambda(sns)

        eb = {"detail-type": "Scheduled Event", "resources": []}
        self.assertIsNone(app.handle_lambda(eb))

        self.assertEqual(_sqs_queue_name_from_arn(""), "")
        self.assertEqual(_kinesis_stream_name_from_arn("arn:aws:kinesis:us-east-1:0:stream/s"), "s")
        self.assertEqual(_sns_topic_name_from_arn("arn:aws:sns:us-east-1:0:t"), "t")
        self.assertEqual(_eventbridge_rule_name_from_arn("arn:aws:events:us-east-1:0:rule/r"), "r")
