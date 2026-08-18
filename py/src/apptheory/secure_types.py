from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from apptheory.context import Context


class AuthPostureKind(StrEnum):
    """Closed secure-route authorization posture vocabulary."""

    PUBLIC = "public"
    OPTIONAL = "optional"
    AUTHENTICATED = "authenticated"
    INTERNAL_ONLY = "internal_only"


class PrincipalKind(StrEnum):
    """Classification assigned after application-owned credential verification."""

    EXTERNAL = "external"
    INTERNAL = "internal"


_POSTURE_TOKEN = object()


class AuthPosture:
    """Opaque secure route posture; construct through the posture factories."""

    __slots__ = ("_kind", "_scopes", "_scopes_supplied")

    def __init__(self, token: object, kind: AuthPostureKind, scopes: list[str], scopes_supplied: bool) -> None:
        if token is not _POSTURE_TOKEN:
            raise TypeError("apptheory: invalid auth posture")
        self._kind = kind
        self._scopes = tuple(scopes)
        self._scopes_supplied = bool(scopes_supplied)


def _normalize_scopes(scopes: list[str] | tuple[str, ...]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in scopes:
        scope = str(raw or "").strip()
        if not scope or scope in seen:
            continue
        seen.add(scope)
        out.append(scope)
    return out


def public() -> AuthPosture:
    """Create an anonymous secure route posture."""
    return AuthPosture(_POSTURE_TOKEN, AuthPostureKind.PUBLIC, [], False)


def optional() -> AuthPosture:
    """Create an optional-principal secure route posture."""
    return AuthPosture(_POSTURE_TOKEN, AuthPostureKind.OPTIONAL, [], False)


def authenticated(*scopes: str) -> AuthPosture:
    """Create an authenticated posture requiring all normalized scopes."""
    return AuthPosture(_POSTURE_TOKEN, AuthPostureKind.AUTHENTICATED, _normalize_scopes(list(scopes)), bool(scopes))


def internal_only() -> AuthPosture:
    """Create an internal-principal-only secure route posture."""
    return AuthPosture(_POSTURE_TOKEN, AuthPostureKind.INTERNAL_ONLY, [], False)


def decode_auth_posture(posture: AuthPosture) -> tuple[AuthPostureKind, list[str]]:
    if not isinstance(posture, AuthPosture):
        raise TypeError("apptheory: invalid auth posture")
    kind = posture._kind
    scopes = list(posture._scopes)
    if kind not in set(AuthPostureKind):
        raise TypeError("apptheory: invalid auth posture")
    if kind != AuthPostureKind.AUTHENTICATED and (scopes or posture._scopes_supplied):
        raise TypeError("apptheory: invalid auth posture")
    if kind == AuthPostureKind.AUTHENTICATED and posture._scopes_supplied and not scopes:
        raise TypeError("apptheory: authenticated scopes normalize to empty")
    return kind, scopes


@dataclass(slots=True)
class SecurePrincipal:
    """Principal normalized and classified by a SecureApp resolver."""

    identity: str = ""
    scopes: list[str] = field(default_factory=list)
    claims: dict[str, Any] = field(default_factory=dict)
    kind: PrincipalKind | str = PrincipalKind.EXTERNAL


SecurePrincipalResolver = Callable[["Context"], SecurePrincipal | None | Awaitable[SecurePrincipal | None]]


@dataclass(slots=True)
class SecureRoute:
    """Immutable-copy route metadata returned by SecureApp.routes()."""

    surface: str
    method: str
    path: str
    posture: str
    scopes: list[str] = field(default_factory=list)
    appsync_parent_type: str = ""
    appsync_field: str = ""
    websocket_route_key: str = ""


def clone_secure_principal(principal: SecurePrincipal | None) -> SecurePrincipal | None:
    if principal is None:
        return None
    return SecurePrincipal(
        identity=str(principal.identity or ""),
        scopes=[str(scope) for scope in list(principal.scopes or [])],
        claims=copy.deepcopy(dict(principal.claims or {})),
        kind=str(principal.kind or ""),
    )


def normalize_secure_principal(principal: SecurePrincipal | None) -> tuple[SecurePrincipal | None, bool]:
    if principal is None:
        return None, False
    kind = str(principal.kind or "").strip() or PrincipalKind.EXTERNAL.value
    if kind not in {PrincipalKind.EXTERNAL.value, PrincipalKind.INTERNAL.value}:
        return None, True
    normalized = clone_secure_principal(principal)
    if normalized is None:
        return None, False
    normalized.identity = str(normalized.identity or "").strip()
    normalized.scopes = _normalize_scopes(normalized.scopes)
    normalized.kind = PrincipalKind(kind)
    return normalized, False
