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

