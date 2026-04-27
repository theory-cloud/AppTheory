from __future__ import annotations

import asyncio
import base64
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
    _appsync_payload_from_response,
    _request_from_websocket_event,
    _sns_topic_name_from_arn,
    _sqs_queue_name_from_arn,
    _websocket_management_endpoint,
)
from apptheory.errors import AppError, AppTheoryError  # noqa: E402
from apptheory.request import Request, normalize_request_with_max_bytes  # noqa: E402
from apptheory.response import Response  # noqa: E402
from apptheory.testkit import create_test_env  # noqa: E402


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

        def invalid_response(_ctx) -> Response:
            return Response(
                status=200,
                headers={},
                cookies=[],
                body={"bad": True},  # type: ignore[arg-type]
                is_base64=False,
            )

        app.get("/invalid-response", invalid_response)
        invalid = app.serve(Request(method="GET", path="/invalid-response", body=""))
        self.assertEqual(invalid.status, 500)

    def test_handle_strict_rejects_invalid_patterns(self) -> None:
        app: App = create_app(tier="p0")
        with self.assertRaises(ValueError):
            app.handle_strict("GET", "/{proxy+}/x", _ok)

    def test_credentialed_cors_requires_allowlist(self) -> None:
        app: App = create_app(tier="p1", cors=CORSConfig(allow_credentials=True))
        app.get("/", _ok)

        resp = app.serve(
            Request(
                method="GET",
                path="/",
                headers={"origin": "https://example.com"},
                body="",
            )
        )

        self.assertEqual(resp.status, 200)
        self.assertNotIn("access-control-allow-origin", resp.headers)
        self.assertNotIn("access-control-allow-credentials", resp.headers)
        self.assertNotIn("access-control-allow-headers", resp.headers)
        self.assertIn("x-request-id", resp.headers)

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
        too_large_base64_req = limited_req.serve(
            Request(
                method="POST",
                path="/",
                body=base64.b64encode(b"ab").decode("ascii"),
                is_base64=True,
            )
        )
        self.assertEqual(too_large_base64_req.status, 413)
        with self.assertRaises(AppError) as invalid_base64:
            normalize_request_with_max_bytes(
                Request(method="POST", path="/", body="AAAA=AAA", is_base64=True),
                max_request_bytes=1,
            )
        self.assertEqual(invalid_base64.exception.code, "app.bad_request")

        limited_resp: App = create_app(tier="p2", limits=Limits(max_response_bytes=1))

        def big(_ctx) -> Response:
            return Response(status=200, headers={}, cookies=[], body=b"ab", is_base64=False)

        limited_resp.get("/", big)
        too_large_resp = limited_resp.serve(Request(method="GET", path="/", body=""))
        self.assertEqual(too_large_resp.status, 413)

        limited_stream_resp: App = create_app(tier="p2", limits=Limits(max_response_bytes=5))
        limited_stream_resp.get(
            "/stream",
            lambda _ctx: Response(
                status=200,
                headers={"content-type": ["text/html; charset=utf-8"]},
                cookies=[],
                body=b"",
                is_base64=False,
                body_stream=iter([b"<h1>", b"Hello</h1>"]),
            ),
        )
        stream_env = create_test_env()
        stream_out = stream_env.invoke_streaming(
            limited_stream_resp,
            Request(method="GET", path="/stream", body=""),
        )
        self.assertEqual(stream_out.status, 200)
        self.assertEqual(stream_out.body, b"<h1>")
        self.assertEqual(stream_out.chunks, [b"<h1>"])
        self.assertEqual(stream_out.stream_error_code, "app.too_large")

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
            return Response(
                status=200, headers={"x-remaining-ms": [str(ctx.remaining_ms)]}, cookies=[], body=b"ok", is_base64=False
            )

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

        invalid_app = create_app(tier="p2")

        def invalid_response(_ctx) -> Response:
            return Response(
                status=200,
                headers={},
                cookies=[],
                body={"bad": True},  # type: ignore[arg-type]
                is_base64=False,
            )

        invalid_app.get(
            "/",
            invalid_response,
        )
        invalid = invalid_app.serve(Request(method="GET", path="/", headers={"x-request-id": "req_bad"}, body=""))
        self.assertEqual(invalid.status, 500)
        self.assertEqual(invalid.headers["x-request-id"], ["req_bad"])
        self.assertEqual(json.loads(invalid.body)["error"]["code"], "app.internal")

    def test_http_entrypoints_return_error_responses_on_invalid_events(self) -> None:
        app = create_app(tier="p2")
        self.assertEqual(app.serve_apigw_v2(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_lambda_function_url(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_apigw_proxy(None)["statusCode"], 500)  # type: ignore[arg-type]
        self.assertEqual(app.serve_alb(None)["statusCode"], 500)  # type: ignore[arg-type]

    def test_legacy_http_error_format_preserves_flat_error_body(self) -> None:
        app = create_app(tier="p2", http_error_format="flat_legacy")

        def portable(_ctx) -> Response:
            raise AppTheoryError(
                code="VALIDATION_ERROR",
                message="bad input",
                status_code=422,
                details={"field": "config_type"},
                trace_id="trace_1",
                request_id="req_from_error",
            )

        app.get("/portable", portable)
        resp = app.serve(Request(method="GET", path="/portable", headers={"x-request-id": "req_123"}, body=""))
        self.assertEqual(resp.status, 422)
        self.assertEqual(resp.headers["x-request-id"], ["req_123"])
        self.assertEqual(
            json.loads(resp.body),
            {
                "code": "VALIDATION_ERROR",
                "message": "bad input",
                "details": {"field": "config_type"},
            },
        )

        missing = app.serve(Request(method="GET", path="/missing", headers={"x-request-id": "req_456"}, body=""))
        self.assertEqual(missing.status, 404)
        self.assertEqual(missing.headers["x-request-id"], ["req_456"])
        self.assertEqual(json.loads(missing.body), {"code": "app.not_found", "message": "not found"})

    def test_legacy_http_error_format_applies_to_http_adapter_parse_failures(self) -> None:
        app = create_app(tier="p2", http_error_format="flat_legacy")
        out = app.serve_apigw_v2(None)  # type: ignore[arg-type]
        self.assertEqual(out["statusCode"], 500)
        self.assertEqual(json.loads(out["body"]), {"code": "app.internal", "message": "internal error"})

    def test_serve_appsync_adapts_request_and_projects_payload(self) -> None:
        app = create_app(tier="p2")

        def mutation(ctx) -> Response:
            self.assertEqual(ctx.request.method, "POST")
            self.assertEqual(ctx.request.path, "/createThing")
            self.assertEqual(ctx.request.headers["x-test-header"], ["present"])
            payload = ctx.json_value()
            return Response(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=json.dumps({"method": ctx.request.method, "arguments": payload}, sort_keys=True).encode("utf-8"),
                is_base64=False,
            )

        app.post("/createThing", mutation)
        out = app.serve_appsync(
            {
                "arguments": {"id": "thing_123", "name": "example"},
                "request": {"headers": {"x-test-header": "present"}},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            }
        )
        self.assertEqual(out["method"], "POST")
        self.assertEqual(out["arguments"]["id"], "thing_123")
        self.assertEqual(out["arguments"]["name"], "example")

        app.get(
            "/getThing",
            lambda ctx: Response(
                status=200,
                headers={"content-type": ["text/plain; charset=utf-8"]},
                cookies=[],
                body=f"{ctx.request.method}:{ctx.request.path}".encode("utf-8"),
                is_base64=False,
            ),
        )
        out2 = app.serve_appsync(
            {
                "arguments": {},
                "info": {"fieldName": "getThing", "parentTypeName": "Query"},
            }
        )
        self.assertEqual(out2, "GET:/getThing")

        app.get(
            "/emptyThing",
            lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
        )
        out3 = app.serve_appsync(
            {
                "arguments": {},
                "info": {"fieldName": "emptyThing", "parentTypeName": "Query"},
            }
        )
        self.assertIsNone(out3)

    def test_appsync_payload_projection_rejects_binary_and_streaming_bodies(self) -> None:
        with self.assertRaises(AppTheoryError) as binary_err:
            _appsync_payload_from_response(Response(status=200, headers={}, cookies=[], body=b"abc", is_base64=True))
        self.assertEqual(binary_err.exception.code, "app.internal")
        self.assertEqual(binary_err.exception.message, "unsupported appsync response")
        self.assertEqual(binary_err.exception.details, {"reason": "binary_body_unsupported"})

        with self.assertRaises(AppTheoryError) as stream_err:
            _appsync_payload_from_response(
                Response(
                    status=200,
                    headers={},
                    cookies=[],
                    body=b"",
                    is_base64=False,
                    body_stream=iter([b"chunk"]),
                )
            )
        self.assertEqual(stream_err.exception.code, "app.internal")
        self.assertEqual(stream_err.exception.message, "unsupported appsync response")
        self.assertEqual(stream_err.exception.details, {"reason": "streaming_body_unsupported"})

    def test_handle_lambda_routes_appsync_and_preserves_metadata(self) -> None:
        app = create_app(tier="p2")

        def mutation(ctx) -> Response:
            self.assertEqual(ctx.get("apptheory.trigger_type"), "appsync")
            appsync = ctx.as_appsync()
            self.assertIsNotNone(appsync)
            self.assertEqual(appsync.field_name, "createThing")
            self.assertEqual(appsync.parent_type_name, "Mutation")
            self.assertEqual(appsync.arguments, {"id": "thing_123"})
            self.assertEqual(appsync.identity, {"username": "user_1"})
            self.assertEqual(appsync.source, {"id": "parent_1"})
            self.assertEqual(appsync.variables, {"tenantId": "tenant_1"})
            self.assertEqual(appsync.stash, {"trace": "abc123"})
            self.assertEqual(appsync.prev, "prev_value")
            self.assertEqual(appsync.request_headers, {"x-appsync": "yes"})
            self.assertEqual(appsync.raw_event["info"]["fieldName"], "createThing")
            self.assertEqual(ctx.get("apptheory.appsync.field_name"), "createThing")
            self.assertEqual(ctx.get("apptheory.appsync.parent_type_name"), "Mutation")
            self.assertEqual(ctx.get("apptheory.appsync.identity"), {"username": "user_1"})
            self.assertEqual(ctx.get("apptheory.appsync.source"), {"id": "parent_1"})
            self.assertEqual(ctx.get("apptheory.appsync.variables"), {"tenantId": "tenant_1"})
            self.assertEqual(ctx.get("apptheory.appsync.prev"), "prev_value")
            self.assertEqual(ctx.get("apptheory.appsync.stash"), {"trace": "abc123"})
            self.assertEqual(ctx.get("apptheory.appsync.request_headers"), {"x-appsync": "yes"})
            self.assertEqual(ctx.get("apptheory.appsync.raw_event")["info"]["fieldName"], "createThing")

            return Response(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=json.dumps({"arguments": ctx.json_value()}, sort_keys=True).encode("utf-8"),
                is_base64=False,
            )

        app.post("/createThing", mutation)
        out = app.handle_lambda(
            {
                "arguments": {"id": "thing_123"},
                "identity": {"username": "user_1"},
                "source": {"id": "parent_1"},
                "request": {"headers": {"x-appsync": "yes"}},
                "info": {
                    "fieldName": "createThing",
                    "parentTypeName": "Mutation",
                    "variables": {"tenantId": "tenant_1"},
                },
                "prev": "prev_value",
                "stash": {"trace": "abc123"},
            }
        )
        self.assertEqual(out, {"arguments": {"id": "thing_123"}})

    def test_handle_lambda_does_not_treat_blank_appsync_field_names_as_appsync(self) -> None:
        app = create_app(tier="p2")

        with self.assertRaisesRegex(RuntimeError, "unknown event type"):
            app.handle_lambda(
                {
                    "arguments": {},
                    "info": {
                        "fieldName": " ",
                        "parentTypeName": "Mutation",
                    },
                }
            )

    def test_serve_appsync_formats_portable_errors(self) -> None:
        app = create_app(tier="p2")

        def boom(_ctx) -> Response:
            raise AppTheoryError(
                code="app.validation_failed",
                message="bad input",
                status_code=422,
                details={"field": "name"},
                trace_id="trace_1",
                timestamp="2026-03-11T15:04:05Z",
            )

        class Ctx:
            aws_request_id = "aws_req_1"

        app.post("/createThing", boom)
        out = app.serve_appsync(
            {
                "arguments": {"id": "thing_123"},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            },
            ctx=Ctx(),
        )

        self.assertEqual(
            out,
            {
                "pay_theory_error": True,
                "error_message": "bad input",
                "error_type": "CLIENT_ERROR",
                "error_data": {
                    "status_code": 422,
                    "request_id": "aws_req_1",
                    "trace_id": "trace_1",
                    "timestamp": "2026-03-11T15:04:05Z",
                },
                "error_info": {
                    "code": "app.validation_failed",
                    "details": {"field": "name"},
                    "path": "/createThing",
                    "method": "POST",
                    "trigger_type": "appsync",
                },
            },
        )

    def test_serve_appsync_formats_app_errors(self) -> None:
        app = create_app(tier="p2")

        def boom(_ctx) -> Response:
            raise AppError("app.forbidden", "forbidden")

        app.post("/createThing", boom)

        class Ctx:
            aws_request_id = "aws_req_2"

        out = app.serve_appsync(
            {
                "arguments": {"id": "thing_123"},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            },
            ctx=Ctx(),
        )

        self.assertEqual(
            out,
            {
                "pay_theory_error": True,
                "error_message": "forbidden",
                "error_type": "CLIENT_ERROR",
                "error_data": {
                    "status_code": 403,
                    "request_id": "aws_req_2",
                },
                "error_info": {
                    "code": "app.forbidden",
                    "path": "/createThing",
                    "method": "POST",
                    "trigger_type": "appsync",
                },
            },
        )

    def test_serve_appsync_formats_unexpected_errors(self) -> None:
        app = create_app(tier="p2")

        def boom(_ctx) -> Response:
            raise RuntimeError("boom")

        app.post("/createThing", boom)

        out = app.serve_appsync(
            {
                "arguments": {"id": "thing_123"},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            }
        )

        self.assertEqual(
            out,
            {
                "pay_theory_error": True,
                "error_message": "internal error",
                "error_type": "SYSTEM_ERROR",
                "error_data": {},
                "error_info": {},
            },
        )

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
                {
                    "eventSource": "aws:dynamodb",
                    "eventSourceARN": "arn:aws:dynamodb:us-east-1:000000000000:table/t/stream/1",
                    "eventID": "e1",
                },
            ]
        }
        out2 = app.handle_lambda(ddb)
        self.assertEqual(out2, {"batchItemFailures": [{"itemIdentifier": "e1"}]})

        kin = {
            "Records": [
                {
                    "eventSource": "aws:kinesis",
                    "eventSourceARN": "arn:aws:kinesis:us-east-1:000000000000:stream/s",
                    "eventID": "k1",
                },
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
