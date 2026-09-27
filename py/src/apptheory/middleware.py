from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

from apptheory.app import Context, Middleware, NextHandler
from apptheory.errors import AppError


@dataclass(slots=True)
class TimeoutConfig:
    default_timeout_ms: int = 0
    operation_timeouts_ms: dict[str, int] | None = None
    tenant_timeouts_ms: dict[str, int] | None = None
    timeout_message: str = "request timeout"


class _DeadlineCancellation(threading.Event):
    """A cancellation token that becomes set once its deadline passes.

    Handlers observe it exactly like an event (``is_set`` / ``wait``, and
    ``isinstance(token, threading.Event)`` still holds for handlers written
    against the previous carrier), but nothing has to fire a timer to set it: the
    deadline is evaluated when the token is read. That is what lets the timeout
    middleware run the handler inline and still give the handler a cancellation
    token with no thread, promise or timer behind it.
    """

    def __init__(self, deadline: float) -> None:
        super().__init__()
        self._deadline = deadline

    def is_set(self) -> bool:
        return super().is_set() or time.monotonic() >= self._deadline

    def wait(self, timeout: float | None = None) -> bool:
        """Wait until the token is set, its deadline passes, or ``timeout`` elapses."""
        remaining = self._deadline - time.monotonic()
        if remaining > 0:
            if timeout is None or timeout > remaining:
                timeout = remaining
            if timeout > 0:
                super().wait(timeout)
        return self.is_set()


@dataclass(slots=True)
class _TimeoutCancellationCarrier:
    parent: Any | None
    cancelled: _DeadlineCancellation


def _clone_context_with_timeout_ctx(ctx: Context, carrier: Any) -> Context:
    clone = Context(
        request=ctx.request,
        params=ctx.params,
        clock=ctx.clock,
        id_generator=ctx.id_generator,
        ctx=carrier,
        request_id=ctx.request_id,
        trace_id=ctx.trace_id,
        tenant_id=ctx.tenant_id,
        auth_identity=ctx.auth_identity,
        remaining_ms=ctx.remaining_ms,
        middleware_trace=ctx.middleware_trace,
        websocket=ctx.websocket,
        appsync=ctx.appsync,
    )
    clone._values = ctx._values
    return clone


def timeout_middleware(config: TimeoutConfig) -> Middleware:
    """Fail requests closed when timeout policy expires.

    The handler chain runs on the invoking thread with a deadline-bearing
    cancellation token, and the middleware raises ``app.timeout`` when the deadline
    passed while the chain was running. It starts no thread of its own: a handler
    that observes the token returns immediately, and a handler that ignores it runs
    until it returns, bounded by the Lambda function timeout rather than abandoned
    by the middleware. There is no grace window and no abandoned work.
    """

    cfg = _normalize_timeout_config(config)

    def mw(ctx: Context, next_handler: NextHandler) -> Any:
        timeout_ms = _timeout_for_context(ctx, cfg)
        if timeout_ms <= 0:
            return next_handler(ctx)

        deadline = time.monotonic() + (float(timeout_ms) / 1000.0)
        cancelled = _DeadlineCancellation(deadline=deadline)
        handler_ctx = _clone_context_with_timeout_ctx(
            ctx,
            _TimeoutCancellationCarrier(getattr(ctx, "ctx", None), cancelled),
        )

        try:
            result = next_handler(handler_ctx)
        finally:
            # Release anything the handler left waiting on the token: the
            # invocation is over, so the token is done either way.
            cancelled.set()

        if time.monotonic() >= deadline:
            raise AppError("app.timeout", cfg.timeout_message)

        return result

    return mw


def _normalize_timeout_config(config: TimeoutConfig) -> TimeoutConfig:
    default_ms = int(getattr(config, "default_timeout_ms", 0) or 0)
    if default_ms == 0:
        default_ms = 30_000

    message = str(getattr(config, "timeout_message", "") or "").strip() or "request timeout"

    op_timeouts = getattr(config, "operation_timeouts_ms", None)
    tenant_timeouts = getattr(config, "tenant_timeouts_ms", None)

    return TimeoutConfig(
        default_timeout_ms=default_ms,
        operation_timeouts_ms=op_timeouts if isinstance(op_timeouts, dict) else None,
        tenant_timeouts_ms=tenant_timeouts if isinstance(tenant_timeouts, dict) else None,
        timeout_message=message,
    )


def _timeout_for_context(ctx: Context, config: TimeoutConfig) -> int:
    timeout_ms = int(config.default_timeout_ms)

    tenant = str(getattr(ctx, "tenant_id", "") or "").strip()
    if tenant and isinstance(config.tenant_timeouts_ms, dict):
        override = config.tenant_timeouts_ms.get(tenant)
        if override is not None:
            try:
                timeout_ms = int(override)
            except Exception:  # noqa: BLE001
                timeout_ms = int(config.default_timeout_ms)

    req = getattr(ctx, "request", None)
    if isinstance(config.operation_timeouts_ms, dict) and isinstance(req, object):
        method = str(getattr(req, "method", "") or "").strip().upper()
        path = str(getattr(req, "path", "") or "").strip() or "/"
        op_key = f"{method}:{path}"
        override = config.operation_timeouts_ms.get(op_key)
        if override is not None:
            try:
                timeout_ms = int(override)
            except Exception:  # noqa: BLE001
                timeout_ms = int(config.default_timeout_ms)

    remaining_ms = int(getattr(ctx, "remaining_ms", 0) or 0)
    if remaining_ms > 0 and remaining_ms < timeout_ms:
        timeout_ms = remaining_ms

    return timeout_ms
