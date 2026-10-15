"""Provider SPI for the MCP auth facade (DESIGN section 6).

The SPI is deliberately the minimum needed to derive the facade from
requirements: discovery, authorize-URL construction, code exchange, refresh,
and access-token validation. Autheory is the first adapter
(:mod:`apptheory.oauth.autheory`); the interface stays provider-neutral so the
facade never branches on a provider name.

No upstream error body ever reaches the caller. Every failure is a
:class:`ProviderError` carrying one of the closed classes below and a fixed
message, never upstream-supplied text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

# The closed client-facing vocabulary. The HTTP status is the facade mapping.
ERROR_UPSTREAM = "upstream_error"
ERROR_TEMPORARILY_UNAVAILABLE = "temporarily_unavailable"
ERROR_INVALID_GRANT = "invalid_grant"
ERROR_INVALID_REQUEST = "invalid_request"
ERROR_REAUTH_REQUIRED = "reauth_required"

_ERROR_HTTP_STATUS: dict[str, int] = {
    ERROR_UPSTREAM: 502,
    ERROR_TEMPORARILY_UNAVAILABLE: 503,
    ERROR_INVALID_GRANT: 400,
    ERROR_INVALID_REQUEST: 400,
    ERROR_REAUTH_REQUIRED: 400,
}

# Fixed messages, by class: they never carry an upstream response body, which
# may echo hidden material.
_ERROR_MESSAGES: dict[str, str] = {
    ERROR_UPSTREAM: "upstream provider error",
    ERROR_TEMPORARILY_UNAVAILABLE: "upstream provider temporarily unavailable",
    ERROR_INVALID_GRANT: "upstream provider rejected the grant",
    ERROR_INVALID_REQUEST: "provider request is invalid",
    ERROR_REAUTH_REQUIRED: "upstream provider requires reauthentication",
}


class ProviderError(Exception):
    """A provider SPI failure mapped to the closed client-facing vocabulary.

    ``error_class`` is one of the module's ``ERROR_*`` constants, ``op`` names
    the SPI operation that failed, and ``http_status`` is the facade status the
    class maps to. The message is a fixed per-class string.
    """

    def __init__(self, error_class: str, op: str = "", http_status: int | None = None) -> None:
        resolved = str(error_class or "").strip()
        if resolved not in _ERROR_HTTP_STATUS:
            raise ValueError(f"unknown provider error class: {error_class!r}")
        self.error_class = resolved
        self.op = str(op or "")
        self.http_status = int(http_status) if http_status is not None else _ERROR_HTTP_STATUS[resolved]
        super().__init__(_ERROR_MESSAGES[resolved])


@dataclass(slots=True)
class ProviderMetadata:
    """RFC 8414/OIDC metadata verified against the configured issuer."""

    issuer: str = ""
    authorization_endpoint: str = ""
    token_endpoint: str = ""
    jwks_uri: str = ""
    code_challenge_methods_supported: list[str] = field(default_factory=list)
    authorization_response_iss_parameter_supported: bool = False
    resource_parameter_supported: bool = False


@dataclass(slots=True)
class AuthorizationRequest:
    """The upstream authorize URL the browser is redirected to from /authorize."""

    upstream_client_id: str = ""
    callback_url: str = ""
    code_challenge: str = ""
    code_challenge_method: str = "S256"
    state: str = ""
    resource: str = ""
    scopes: list[str] = field(default_factory=list)
    # Opaque provider hints (e.g. ``account_id``). A hint is never the source of
    # authentication account context; the provider derives that from its own
    # validated binding.
    hints: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class CodeExchangeRequest:
    """Server-side upstream code exchange presenting the facade's own client."""

    code: str = ""
    upstream_client_id: str = ""
    callback_url: str = ""
    code_verifier: str = ""


@dataclass(slots=True)
class RefreshRequest:
    """Upstream refresh presenting the OAuth client that owns the material."""

    refresh_material: str = ""
    upstream_client_id: str = ""


@dataclass(slots=True)
class TokenExpectations:
    """The per-call pins ``validate_access_token`` must enforce."""

    expected_issuer: str = ""
    expected_audience: str = ""
    required_scopes: list[str] = field(default_factory=list)
    allowed_authorized_parties: list[str] = field(default_factory=list)


@dataclass(slots=True)
class TokenSet:
    """An upstream token response. ``id_token`` is dropped by the facade."""

    access_token: str = ""
    refresh_token: str = ""
    token_type: str = ""
    scope: str = ""
    id_token: str = ""
    expires_in: int = 0


@dataclass(slots=True)
class TokenClaims:
    """Verified claims. The token itself is never mutated."""

    subject: str = ""
    audience: str = ""
    scopes: list[str] = field(default_factory=list)
    expires_at: datetime | None = None
    authorized_party: str = ""


class Provider(Protocol):
    """The provider-neutral upstream IdP adapter."""

    def discovery(self) -> ProviderMetadata: ...

    def authorization_url(self, req: AuthorizationRequest) -> str: ...

    def exchange_code(self, req: CodeExchangeRequest) -> TokenSet: ...

    def refresh(self, req: RefreshRequest) -> TokenSet: ...

    def validate_access_token(self, token: str, expected: TokenExpectations) -> TokenClaims: ...


__all__ = [
    "ERROR_INVALID_GRANT",
    "ERROR_INVALID_REQUEST",
    "ERROR_REAUTH_REQUIRED",
    "ERROR_TEMPORARILY_UNAVAILABLE",
    "ERROR_UPSTREAM",
    "AuthorizationRequest",
    "CodeExchangeRequest",
    "Provider",
    "ProviderError",
    "ProviderMetadata",
    "RefreshRequest",
    "TokenClaims",
    "TokenExpectations",
    "TokenSet",
]
