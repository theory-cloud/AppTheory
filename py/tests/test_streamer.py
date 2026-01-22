from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
import importlib.abc

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.streamer import Client, _normalize_endpoint  # noqa: E402


class _FakeBotoClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def post_to_connection(self, **kwargs):  # noqa: ANN003
        self.calls.append(("post_to_connection", dict(kwargs)))

    def get_connection(self, **kwargs):  # noqa: ANN003
        self.calls.append(("get_connection", dict(kwargs)))
        return {"ok": True}

    def delete_connection(self, **kwargs):  # noqa: ANN003
        self.calls.append(("delete_connection", dict(kwargs)))


class TestStreamer(unittest.TestCase):
    def test_normalize_endpoint(self) -> None:
        self.assertEqual(_normalize_endpoint(""), "")
        self.assertEqual(_normalize_endpoint("wss://example.com/dev"), "https://example.com/dev")
        self.assertEqual(_normalize_endpoint("ws://example.com/dev"), "http://example.com/dev")
        self.assertEqual(_normalize_endpoint("example.com/dev"), "https://example.com/dev")

    def test_client_requires_endpoint(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "endpoint is empty"):
            Client("")

    def test_client_requires_connection_id(self) -> None:
        c = Client("https://example.com/dev", region="us-east-1")
        with self.assertRaisesRegex(RuntimeError, "connection id is empty"):
            c.post_to_connection("", b"x")

    def test_client_missing_boto3_raises(self) -> None:
        class _BlockBoto3(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, _path, _target=None):  # noqa: ANN001
                if fullname == "boto3":
                    raise ModuleNotFoundError("blocked boto3")
                return None

        prev_mod = sys.modules.pop("boto3", None)
        finder = _BlockBoto3()
        sys.meta_path.insert(0, finder)
        try:
            c = Client("https://example.com/dev", region="us-east-1")
            with self.assertRaisesRegex(RuntimeError, "boto3 is required"):
                c.get_connection("c1")
        finally:
            sys.meta_path = [f for f in sys.meta_path if f is not finder]
            if prev_mod is not None:
                sys.modules["boto3"] = prev_mod

    def test_client_uses_fake_boto3(self) -> None:
        fake_client = _FakeBotoClient()

        fake_boto3 = types.ModuleType("boto3")
        fake_boto3.client = lambda *_a, **_kw: fake_client  # type: ignore[attr-defined]

        prev = sys.modules.get("boto3")
        sys.modules["boto3"] = fake_boto3
        try:
            c = Client("wss://example.com/dev", region="us-east-1")
            c.post_to_connection("c1", b"hi")
            out = c.get_connection("c1")
            c.delete_connection("c1")
        finally:
            if prev is None:
                sys.modules.pop("boto3", None)
            else:
                sys.modules["boto3"] = prev

        self.assertEqual(out, {"ok": True})
        self.assertEqual(len(fake_client.calls), 3)
        self.assertEqual(fake_client.calls[0][0], "post_to_connection")
        self.assertEqual(fake_client.calls[1][0], "get_connection")
        self.assertEqual(fake_client.calls[2][0], "delete_connection")
