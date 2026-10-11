from __future__ import annotations

import threading
import sys
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory  # noqa: E402
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
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=20, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        def slow(_ctx: Context):
            # Ignores the cancellation token: the middleware runs it on the
            # invoking thread, so it simply runs to completion and the timeout is
            # reported afterwards. Nothing is abandoned and no thread is started.
            time.sleep(0.05)
            return "nope"

        with self.assertRaises(AppError) as cm:
            mw(ctx, slow)
        self.assertEqual(cm.exception.code, "app.timeout")

        def boom(_ctx: Context):
            raise ValueError("bad")

        with self.assertRaisesRegex(ValueError, "bad"):
            mw(ctx, boom)

    def test_timeout_middleware_propagates_cooperative_cancellation_before_side_effects(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))
        side_effect = threading.Event()

        def cooperative(handler_ctx: Context):
            # Observes the deadline-bearing cancellation token and returns as soon
            # as it is set, so it never commits a post-timeout side effect.
            carrier = getattr(handler_ctx, "ctx", None)
            cancelled = getattr(carrier, "cancelled", None)
            if cancelled is not None:
                cancelled.wait(timeout=2.0)
            side_effect.set()
            return "cancelled"

        with self.assertRaises(AppError) as cm:
            mw(ctx, cooperative)

        self.assertEqual(cm.exception.code, "app.timeout")
        # The handler ran on the invoking thread, so its side effect landed inside
        # the invocation; the middleware only reports the timeout afterwards.
        self.assertTrue(side_effect.is_set())

    def test_timeout_middleware_preserves_the_principal_for_authenticated_routes(self) -> None:
        principal = apptheory.SecurePrincipal(
            identity="verified-user",
            kind="external",
            scopes=["records:read"],
            claims={"tenant_id": "tenant-verified"},
        )
        app = apptheory.SecureApp(principal_resolver=lambda _ctx: principal)
        app.use(timeout_middleware(TimeoutConfig(default_timeout_ms=1000)))
        seen: list = []

        def handler(ctx) -> apptheory.Response:
            seen.append(ctx.secure_principal())
            return apptheory.text(200, "ok")

        app.get("/secure", handler, apptheory.authenticated())
        response = app.serve(apptheory.Request(method="GET", path="/secure"))

        self.assertEqual(response.status, 200)
        self.assertEqual(len(seen), 1)
        observed = seen[0]
        self.assertIsNotNone(observed)
        self.assertEqual(observed.identity, "verified-user")
        self.assertEqual(observed.scopes, ["records:read"])
        self.assertEqual(observed.claims, {"tenant_id": "tenant-verified"})
        self.assertEqual(observed.kind, "external")
