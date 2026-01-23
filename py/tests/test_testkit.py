from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.testkit import (  # noqa: E402
    FakeWebSocketManagementClient,
    build_websocket_event,
    create_fake_websocket_client_factory,
    create_test_env,
)
from apptheory.errors import AppError  # noqa: E402
from apptheory.app import Limits, ObservabilityHooks, PolicyDecision  # noqa: E402
from apptheory.clock import ManualClock  # noqa: E402
from apptheory.ids import ManualIdGenerator  # noqa: E402
from apptheory.request import Request  # noqa: E402
from apptheory.response import Response  # noqa: E402


class TestTestkit(unittest.TestCase):
    def test_create_test_env(self) -> None:
        env = create_test_env()
        self.assertIsNotNone(env.clock)
        self.assertIsNotNone(env.ids)

    def test_build_websocket_event(self) -> None:
        evt = build_websocket_event(
            route_key="$default",
            connection_id="c1",
            domain_name="example.execute-api.us-east-1.amazonaws.com",
            stage="dev",
            request_id="req_1",
            method="post",
            path="/x",
            headers={"x": "y"},
            query={"a": "b"},
            body="ok",
        )
        self.assertEqual(evt["httpMethod"], "POST")
        self.assertEqual(evt["path"], "/x")
        self.assertEqual(evt["headers"]["x"], "y")
        self.assertEqual(evt["queryStringParameters"]["a"], "b")
        self.assertEqual(evt["requestContext"]["connectionId"], "c1")
        self.assertEqual(evt["requestContext"]["routeKey"], "$default")

    def test_fake_websocket_management_client_records_calls(self) -> None:
        ws = FakeWebSocketManagementClient("https://example.com/dev")
        ws.connections["c1"] = {"ok": True}

        ws.post_to_connection("c1", b"hi")
        self.assertEqual(ws.get_connection("c1"), {"ok": True})
        ws.delete_connection("c1")

        self.assertEqual(len(ws.calls), 3)
        self.assertEqual(ws.calls[0].op, "post_to_connection")
        self.assertEqual(ws.calls[1].op, "get_connection")
        self.assertEqual(ws.calls[2].op, "delete_connection")

        with self.assertRaisesRegex(RuntimeError, "connection not found"):
            ws.get_connection("missing")

    def test_fake_websocket_client_factory_caches_clients(self) -> None:
        factory = create_fake_websocket_client_factory()
        c1 = factory("https://example.com/dev", None)
        c2 = factory("https://example.com/dev", None)
        self.assertIs(c1, c2)

    def test_invoke_streaming_collects_chunks_and_error_codes(self) -> None:
        env = create_test_env()

        class App:
            def serve(self, _request, ctx=None):  # noqa: ARG002
                def stream():
                    yield b"a"
                    raise AppError("app.stream", "boom")

                return Response(
                    status=200,
                    headers={"x": ["1", 2]},
                    cookies=["a=b"],
                    body=b"p",
                    is_base64=False,
                    body_stream=stream(),
                )

        out = env.invoke_streaming(App(), request=Request(method="GET", path="/"))
        self.assertEqual(out.status, 200)
        self.assertEqual(out.headers, {"x": ["1", "2"]})
        self.assertEqual(out.cookies, ["a=b"])
        self.assertEqual(out.body, b"pa")
        self.assertEqual(out.stream_error_code, "app.stream")

    def test_fake_websocket_management_client_validates_connection_ids(self) -> None:
        ws = FakeWebSocketManagementClient("https://example.com/dev")
        with self.assertRaisesRegex(RuntimeError, "connection id is empty"):
            ws.post_to_connection("", b"x")
        ws.post_error = RuntimeError("boom")
        with self.assertRaisesRegex(RuntimeError, "boom"):
            ws.post_to_connection("c1", b"x")

        ws.get_error = RuntimeError("get boom")
        with self.assertRaisesRegex(RuntimeError, "connection id is empty"):
            ws.get_connection("")
        with self.assertRaisesRegex(RuntimeError, "get boom"):
            ws.get_connection("c1")

        ws.delete_error = RuntimeError("del boom")
        with self.assertRaisesRegex(RuntimeError, "connection id is empty"):
            ws.delete_connection("")
        with self.assertRaisesRegex(RuntimeError, "del boom"):
            ws.delete_connection("c1")

    def test_test_env_app_builder_and_invoke_delegates(self) -> None:
        env = create_test_env()
        app = env.app(
            tier="p0",
            limits=Limits(max_request_bytes=1, max_response_bytes=2),
            auth_hook=lambda _ctx: "user",
            policy_hook=lambda _ctx: PolicyDecision(code="app.rate_limited", message="", headers={}),
            observability=ObservabilityHooks(),
            websocket_client_factory=lambda endpoint, _ctx: FakeWebSocketManagementClient(endpoint),
            clock=ManualClock(),
            id_generator=ManualIdGenerator(),
        )
        resp = env.invoke(app, Request(method="GET", path="/", body=""))
        self.assertEqual(resp.status, 404)

        class FakeApp:
            def __init__(self) -> None:
                self.calls = []

            def serve_apigw_v2(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("apigw_v2", ctx))
                return {"ok": True, "event": event}

            def serve_lambda_function_url(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("lfu", ctx))
                return {"ok": True}

            def serve_alb(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("alb", ctx))
                return {"ok": True}

            def serve_sqs(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("sqs", ctx))
                return {"ok": True}

            def serve_eventbridge(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("eventbridge", ctx))
                return {"ok": True}

            def serve_dynamodb_stream(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("dynamodb", ctx))
                return {"ok": True}

            def serve_kinesis(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("kinesis", ctx))
                return {"ok": True}

            def serve_sns(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("sns", ctx))
                return []

            def serve_websocket(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("websocket", ctx))
                return {"ok": True}

            def handle_lambda(self, event, *, ctx=None):  # noqa: ANN001
                self.calls.append(("lambda", ctx))
                return {"ok": True}

        fake = FakeApp()
        self.assertEqual(env.invoke_apigw_v2(fake, {"v": 2}), {"ok": True, "event": {"v": 2}})
        self.assertEqual(env.invoke_lambda_function_url(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_alb(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_sqs(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_eventbridge(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_dynamodb_stream(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_kinesis(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_sns(fake, {}), [])
        self.assertEqual(env.invoke_websocket(fake, {}), {"ok": True})
        self.assertEqual(env.invoke_lambda(fake, {}), {"ok": True})
        self.assertEqual(len(fake.calls), 10)
