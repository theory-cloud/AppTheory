from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

from apptheory.app import Context, Middleware, NextHandler
from apptheory.errors import AppError
from apptheory.secure_types import clone_secure_principal


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


# _TIMEOUT_MIDDLEWARE_JOIN_GRACE bounds how long the timeout middleware waits for
# the handler it timed out to unwind before raising the timeout response.
#
# A handler that observes its cancellation token returns immediately and is never
# left running. A handler that ignores cancellation is exactly the case this
# middleware exists to bound, so its response is not held open for the handler's
# full runtime; it is the one documented place where a handler the middleware
# started can still be running when the response is returned.
_TIMEOUT_MIDDLEWARE_JOIN_GRACE = 0.25


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
    clone._secure_principal = clone_secure_principal(ctx._secure_principal)
    return clone


def timeout_middleware(config: TimeoutConfig) -> Middleware:
    """Fail requests closed when timeout policy expires.

    The handler chain runs on a worker thread with a deadline-bearing cancellation
    token, and the middleware raises ``app.timeout`` when the deadline fires while
    the chain is still running -- at the deadline, not after the chain returns. A
    handler that observes the token returns immediately and is never left running;
    a handler that ignores cancellation is exactly the case this middleware exists
    to bound.

    The middleware does not abandon the worker: after the deadline it joins it for
    a bounded grace window (``_TIMEOUT_MIDDLEWARE_JOIN_GRACE``) before raising. A
    handler that ignores cancellation and does not unwind within that window is
    the one documented place where work the middleware started can still be
    running when the response returns; the Lambda function timeout remains its
    outer bound. A synchronous handler that never checks cancellation (for example
    a CPU loop with no cancellation points) cannot be interrupted by the
    middleware by construction.
    """

    cfg = _normalize_timeout_config(config)

    def mw(ctx: Context, next_handler: NextHandler) -> Any:
        timeout_ms = _timeout_for_context(ctx, cfg)
        if timeout_ms <= 0:
            return next_handler(ctx)

        timeout_seconds = float(timeout_ms) / 1000.0
        deadline = time.monotonic() + timeout_seconds
        cancelled = _DeadlineCancellation(deadline=deadline)
        handler_ctx = _clone_context_with_timeout_ctx(
            ctx,
            _TimeoutCancellationCarrier(getattr(ctx, "ctx", None), cancelled),
        )

        result: dict[str, Any] = {}
        done = threading.Event()

        def run() -> None:
            try:
                result["resp"] = next_handler(handler_ctx)
            except Exception as exc:  # noqa: BLE001
                result["exc"] = exc
            finally:
                done.set()

        worker = threading.Thread(target=run, name="apptheory-timeout-handler", daemon=True)
        worker.start()

        if not done.wait(timeout=timeout_seconds):
            # The deadline fired and the handler chain's token is set. Join the
            # worker for a bounded grace window so a cooperative handler is never
            # left running, then raise app.timeout without holding the invocation
            # open for an uncooperative handler.
            cancelled.set()
            worker.join(timeout=_TIMEOUT_MIDDLEWARE_JOIN_GRACE)
            raise AppError("app.timeout", cfg.timeout_message)

        # Release anything the handler left waiting on the token: the invocation
        # is over, so the token is done either way.
        cancelled.set()

        if "exc" in result:
            raise result["exc"]

        if time.monotonic() >= deadline:
            raise AppError("app.timeout", cfg.timeout_message)

        return result.get("resp")

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
