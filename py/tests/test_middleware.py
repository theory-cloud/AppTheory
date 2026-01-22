from __future__ import annotations

import threading
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.context import Context  # noqa: E402
from apptheory.errors import AppError  # noqa: E402
from apptheory.middleware import TimeoutConfig, _normalize_timeout_config, _timeout_for_context, timeout_middleware  # noqa: E402
from apptheory.request import Request  # noqa: E402


class TestMiddleware(unittest.TestCase):
    def test_normalize_timeout_config_sets_defaults(self) -> None:
        cfg = _normalize_timeout_config(TimeoutConfig(default_timeout_ms=0, timeout_message="  "))
        self.assertEqual(cfg.default_timeout_ms, 30_000)
        self.assertEqual(cfg.timeout_message, "request timeout")

        cfg2 = _normalize_timeout_config(
            TimeoutConfig(
                default_timeout_ms=10,
                timeout_message="  boom ",
                operation_timeouts_ms={"GET:/": 1},
                tenant_timeouts_ms={"t1": 2},
            )
        )
        self.assertEqual(cfg2.default_timeout_ms, 10)
        self.assertEqual(cfg2.timeout_message, "boom")
        self.assertEqual(cfg2.operation_timeouts_ms, {"GET:/": 1})
        self.assertEqual(cfg2.tenant_timeouts_ms, {"t1": 2})

        cfg3 = _normalize_timeout_config(
            TimeoutConfig(
                default_timeout_ms=10,
                operation_timeouts_ms="nope",  # type: ignore[arg-type]
                tenant_timeouts_ms=["bad"],  # type: ignore[arg-type]
            )
        )
        self.assertIsNone(cfg3.operation_timeouts_ms)
        self.assertIsNone(cfg3.tenant_timeouts_ms)

    def test_timeout_for_context_applies_overrides_and_remaining_ms(self) -> None:
        req = Request(method="get", path="/p")
        ctx = Context(request=req, tenant_id="t1", remaining_ms=5)
        cfg = _normalize_timeout_config(
            TimeoutConfig(
                default_timeout_ms=100,
                tenant_timeouts_ms={"t1": 50},
                operation_timeouts_ms={"GET:/p": 20},
            )
        )
        self.assertEqual(_timeout_for_context(ctx, cfg), 5)

        bad_cfg = _normalize_timeout_config(TimeoutConfig(default_timeout_ms=10, tenant_timeouts_ms={"t1": "bad"}))  # type: ignore[arg-type]
        self.assertEqual(_timeout_for_context(ctx, bad_cfg), 5)

    def test_timeout_middleware_short_circuits_when_timeout_non_positive(self) -> None:
        cfg = TimeoutConfig(default_timeout_ms=-1)
        mw = timeout_middleware(cfg)
        ctx = Context(request=Request(method="GET", path="/"))
        self.assertEqual(mw(ctx, lambda _ctx: "ok"), "ok")

    def test_timeout_middleware_raises_on_timeout_and_propagates_exceptions(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=1, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        block = threading.Event()

        def never(_ctx: Context):
            block.wait()
            return "nope"

        with self.assertRaises(AppError) as cm:
            mw(ctx, never)
        self.assertEqual(cm.exception.code, "app.timeout")

        def boom(_ctx: Context):
            raise ValueError("bad")

        with self.assertRaisesRegex(ValueError, "bad"):
            mw(ctx, boom)

