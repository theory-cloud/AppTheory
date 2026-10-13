"""MCP auth facade transport-posture registrar (M1 skeleton)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from apptheory.app import App, Handler, _resolve
from apptheory.context import Context
from apptheory.oauth import RequireBearerTokenOptions, require_bearer_token_middleware
from apptheory.response import Response

if TYPE_CHECKING:
    from collections.abc import Sequence

TRANSPORT_POSTURES: tuple[str, ...] = ("iam", "jwt", "runtime-bearer", "none-public")

_ERROR_PREFIX = "AppTheoryMcpFacade:"


@dataclass(slots=True)
class McpFacadeRegistration:
    """The transport posture and paths installed by register_mcp_facade."""

    transport_posture: str
    transport_paths: list[str]


def register_mcp_facade(
    app: App,
    mcp_paths: Sequence[str],
    mcp_handler: Handler,
    *,
    transport_posture: str = "iam",
    require_bearer_token: RequireBearerTokenOptions | None = None,
) -> McpFacadeRegistration:
    """Registers the MCP transport routes with a resolved transport posture.

    Registration fails closed before any route is added: an unknown posture is
    refused, ``runtime-bearer`` requires a bearer assertion, and a bearer
    assertion is refused under ``iam``, ``jwt``, and ``none-public``.
    """
    paths = _normalize_mcp_paths(mcp_paths)
    posture = _resolve_transport_posture(transport_posture, require_bearer_token)
    handler = mcp_handler
    if posture == "runtime-bearer":
        handler = _wrap_with_bearer_assertion(require_bearer_token, mcp_handler)

    for path in paths:
        app.post(path, handler)
        app.get(path, handler)
        app.delete(path, handler)

    return McpFacadeRegistration(transport_posture=posture, transport_paths=list(paths))


def _normalize_mcp_paths(mcp_paths: Sequence[str]) -> list[str]:
    if isinstance(mcp_paths, (str, bytes)) or not mcp_paths:
        raise ValueError(f"{_ERROR_PREFIX} mcp_paths must be a non-empty sequence")
    paths: list[str] = []
    for path in mcp_paths:
        value = str(path).strip() if isinstance(path, str) else ""
        if not value or not value.startswith("/"):
            raise ValueError(f"{_ERROR_PREFIX} mcp_paths entries must be non-empty absolute paths")
        paths.append(value)
    return paths


def _resolve_transport_posture(transport_posture: str, require_bearer_token: RequireBearerTokenOptions | None) -> str:
    posture = str(transport_posture or "").strip() or "iam"
    if posture not in TRANSPORT_POSTURES:
        raise ValueError(
            f"{_ERROR_PREFIX} transport_posture {posture!r} must be one of iam, jwt, runtime-bearer, none-public"
        )
    if posture == "runtime-bearer":
        if require_bearer_token is None:
            raise ValueError(f"{_ERROR_PREFIX} transport_posture runtime-bearer requires require_bearer_token")
        return posture
    if require_bearer_token is not None:
        if posture == "none-public":
            raise ValueError(
                f"{_ERROR_PREFIX} transport_posture none-public cannot be combined with require_bearer_token"
            )
        raise ValueError(f"{_ERROR_PREFIX} require_bearer_token is only valid with transport_posture runtime-bearer")
    return posture


def _wrap_with_bearer_assertion(require_bearer_token: RequireBearerTokenOptions | None, handler: Handler) -> Handler:
    middleware = require_bearer_token_middleware(require_bearer_token)

    def wrapped(ctx: Context) -> Response:
        return _resolve(middleware(ctx, lambda inner: _resolve(handler(inner))))

    return wrapped
