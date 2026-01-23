from __future__ import annotations

import threading
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


def timeout_middleware(config: TimeoutConfig) -> Middleware:
    cfg = _normalize_timeout_config(config)

    def mw(ctx: Context, next_handler: NextHandler) -> Any:
        timeout_ms = _timeout_for_context(ctx, cfg)
        if timeout_ms <= 0:
            return next_handler(ctx)

        result: dict[str, Any] = {}
        done = threading.Event()

        def run() -> None:
            try:
                result["resp"] = next_handler(ctx)
            except Exception as exc:  # noqa: BLE001
                result["exc"] = exc
            finally:
                done.set()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()

        if not done.wait(timeout=float(timeout_ms) / 1000.0):
            raise AppError("app.timeout", cfg.timeout_message)

        if "exc" in result:
            raise result["exc"]

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
