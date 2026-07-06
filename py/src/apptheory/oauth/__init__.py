from __future__ import annotations

import base64
import dataclasses
import hashlib
import json as jsonlib
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from apptheory.context import Context
from apptheory.response import Response, json

CONTEXT_KEY_BEARER_TOKEN = "oauth.bearer_token"  # noqa: S105
CONTEXT_KEY_BEARER_CLAIMS = "oauth.bearer_claims"

ERR_MISSING_BEARER_TOKEN = "missing bearer token"  # noqa: S105
ERR_INVALID_AUTHORIZATION_HEADER = "invalid authorization header"
ERR_INVALID_BEARER_TOKEN = "invalid bearer token"  # noqa: S105
ERR_BEARER_TOKEN_EXPIRED = "bearer token expired"  # noqa: S105
ERR_BEARER_TOKEN_INVALID_AUDIENCE = "bearer token invalid audience"  # noqa: S105
ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE = "bearer token insufficient scope"  # noqa: S105
ERR_INVALID_URL = "invalid url"


class OAuthBearerError(Exception):
    def __init__(self, oauth_code: str, message: str | None = None) -> None:
        self.oauth_code = str(oauth_code or "")
        super().__init__(str(message or oauth_code))


@dataclass(slots=True)
class ProtectedResourceMetadata:
    resource: str
    authorization_servers: list[str]
    jwks_uri: str = ""
    scopes_supported: list[str] = dataclasses.field(default_factory=list)
    bearer_methods_supported: list[str] = dataclasses.field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "resource": self.resource,
            "authorization_servers": list(self.authorization_servers),
        }
        if self.jwks_uri:
            out["jwks_uri"] = self.jwks_uri
        if self.scopes_supported:
            out["scopes_supported"] = list(self.scopes_supported)
        if self.bearer_methods_supported:
            out["bearer_methods_supported"] = list(self.bearer_methods_supported)
        return out


@dataclass(slots=True)
class AuthorizationServerMetadata:
    issuer: str
    authorization_endpoint: str = ""
    token_endpoint: str = ""
    registration_endpoint: str = ""
    jwks_uri: str = ""
    response_types_supported: list[str] = dataclasses.field(default_factory=list)
    grant_types_supported: list[str] = dataclasses.field(default_factory=list)
    token_endpoint_auth_methods_supported: list[str] = dataclasses.field(default_factory=list)
    code_challenge_methods_supported: list[str] = dataclasses.field(default_factory=list)
    scopes_supported: list[str] = dataclasses.field(default_factory=list)
    subject_types_supported: list[str] = dataclasses.field(default_factory=list)
    id_token_signing_alg_values_supported: list[str] = dataclasses.field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"issuer": self.issuer}
        for key in (
            "authorization_endpoint",
            "token_endpoint",
            "registration_endpoint",
            "jwks_uri",
        ):
            value = getattr(self, key)
            if value:
                out[key] = value
        for key in (
            "response_types_supported",
            "grant_types_supported",
            "token_endpoint_auth_methods_supported",
            "code_challenge_methods_supported",
            "scopes_supported",
            "subject_types_supported",
            "id_token_signing_alg_values_supported",
        ):
            value = getattr(self, key)
            if value:
                out[key] = list(value)
        return out


@dataclass(slots=True)
class DynamicClientRegistrationRequest:
    client_name: str = ""
    redirect_uris: list[str] = dataclasses.field(default_factory=list)
    token_endpoint_auth_method: str = ""
    grant_types: list[str] = dataclasses.field(default_factory=list)
    response_types: list[str] = dataclasses.field(default_factory=list)
    scope: str = ""


@dataclass(slots=True)
class DynamicClientRegistrationResponse:
    client_id: str
    client_secret: str = ""
    client_id_issued_at: int = 0
    client_secret_expires_at: int = 0

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"client_id": self.client_id}
        if self.client_secret:
            out["client_secret"] = self.client_secret
        if self.client_id_issued_at:
            out["client_id_issued_at"] = self.client_id_issued_at
        if self.client_secret_expires_at:
            out["client_secret_expires_at"] = self.client_secret_expires_at
        return out


@dataclass(slots=True)
class DynamicClientRegistrationPolicy:
    allowed_redirect_uris: list[str] = dataclasses.field(default_factory=list)
    require_public_client: bool = False
    require_refresh_token: bool = False


@dataclass(slots=True)
class BearerTokenClaims:
    subject: str = ""
    audience: str = ""
    scopes: list[str] = dataclasses.field(default_factory=list)
    expires_at: datetime | None = None


@dataclass(slots=True)
class BearerTokenRecord:
    token: str
    subject: str = ""
    audience: str = ""
    scope: str = ""
    scopes: list[str] = dataclasses.field(default_factory=list)
    expires_at: datetime | None = None


@dataclass(slots=True)
class BearerTokenValidationOptions:
    required_audience: str = ""
    required_scopes: list[str] = dataclasses.field(default_factory=list)
    now: Callable[[], datetime] | None = None


BearerTokenValidator = Callable[[Context, str], None]
BearerTokenClaimsValidator = Callable[[Context, str], BearerTokenClaims]


@dataclass(slots=True)
class RequireBearerTokenOptions:
    resource_metadata_url: str = ""
    validator: BearerTokenValidator | None = None
    claims_validator: BearerTokenClaimsValidator | None = None


def new_protected_resource_metadata(resource: str, authorization_servers: list[str]) -> ProtectedResourceMetadata:
    value = str(resource or "").strip()
    if not _is_absolute_url(value):
        raise ValueError(f"{ERR_INVALID_URL}: resource must be an absolute URL")
    servers = [str(item or "").strip() for item in authorization_servers or [] if str(item or "").strip()]
    if not servers or any(not _is_absolute_url(item) for item in servers):
        raise ValueError(f"{ERR_INVALID_URL}: authorization server must be an absolute URL")
    return ProtectedResourceMetadata(resource=value, authorization_servers=servers)


def new_authorization_server_metadata(issuer: str) -> AuthorizationServerMetadata:
    parsed = urlparse(str(issuer or "").strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"{ERR_INVALID_URL}: issuer must be an absolute URL")
    canonical = parsed._replace(path=parsed.path.rstrip("/"), params="", query="", fragment="").geturl()

    def endpoint(suffix: str) -> str:
        p = urlparse(canonical)
        joined = _join_url_path(p.path, suffix)
        return p._replace(path=joined, params="", query="", fragment="").geturl()

    return AuthorizationServerMetadata(
        issuer=canonical,
        authorization_endpoint=endpoint("/authorize"),
        token_endpoint=endpoint("/token"),
        registration_endpoint=endpoint("/register"),
        jwks_uri=endpoint("/.well-known/jwks.json"),
        response_types_supported=["code"],
        grant_types_supported=["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported=["none"],
        code_challenge_methods_supported=["S256"],
    )


def protected_resource_metadata_handler(metadata: ProtectedResourceMetadata):
    return lambda _ctx: json(200, metadata.to_json())


def authorization_server_metadata_handler(metadata: AuthorizationServerMetadata):
    return lambda _ctx: json(200, metadata.to_json())


def protected_resource_www_authenticate(resource_metadata_url: str) -> str:
    value = str(resource_metadata_url or "").strip()
    if not value:
        return "Bearer"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'Bearer resource_metadata="{escaped}"'


def rfc9728_resource_metadata_url(resource_url: str) -> str | None:
    parsed = urlparse(str(resource_url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return None
    return parsed._replace(path=f"/.well-known/oauth-protected-resource{parsed.path}", params="", fragment="").geturl()


def resource_metadata_url_from_mcp_endpoint(mcp_endpoint: str) -> str | None:
    return rfc9728_resource_metadata_url(mcp_endpoint)


def canonical_resource_url(raw: str) -> str:
    return str(raw or "").strip().rstrip("/")


def canonicalize_issuer_url(raw: str) -> str | None:
    parsed = urlparse(str(raw or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return None
    return parsed._replace(path=parsed.path.rstrip("/"), params="", fragment="").geturl()


def bearer_token_from_headers(headers: dict[str, Any] | None) -> str:
    auth = _first_header(headers, "authorization").strip()
    if not auth:
        raise OAuthBearerError(ERR_MISSING_BEARER_TOKEN)
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer" or not parts[1].strip():
        raise OAuthBearerError(ERR_INVALID_AUTHORIZATION_HEADER)
    return parts[1].strip()


def require_bearer_token_middleware(options: RequireBearerTokenOptions | None = None):
    opts = options or RequireBearerTokenOptions()

    def middleware(ctx: Context, next_handler):
        try:
            token = bearer_token_from_headers(ctx.request.headers)
            if opts.claims_validator is not None:
                claims = opts.claims_validator(ctx, token)
                ctx.set(CONTEXT_KEY_BEARER_TOKEN, token)
                ctx.set(CONTEXT_KEY_BEARER_CLAIMS, _clone_claims(claims))
                return next_handler(ctx)
            if opts.validator is None:
                return _unauthorized_response(opts)
            opts.validator(ctx, token)
            ctx.set(CONTEXT_KEY_BEARER_TOKEN, token)
            return next_handler(ctx)
        except Exception as exc:  # noqa: BLE001
            return _bearer_error_response(opts, exc)

    return middleware


def new_memory_bearer_token_validator(
    records: list[BearerTokenRecord], options: BearerTokenValidationOptions | None = None
) -> BearerTokenClaimsValidator:
    opts = options or BearerTokenValidationOptions()
    by_token: dict[str, BearerTokenClaims] = {}
    for record in records or []:
        token = str(record.token or "").strip()
        if not token:
            continue
        record_scopes = record.scopes or _scope_fields(record.scope)
        scopes = [str(scope or "").strip() for scope in record_scopes if str(scope or "").strip()]
        by_token[token] = BearerTokenClaims(
            subject=str(record.subject or "").strip(),
            audience=str(record.audience or "").strip(),
            scopes=scopes,
            expires_at=record.expires_at,
        )
    required_audience = str(opts.required_audience or "").strip()
    required_scopes = [str(scope or "").strip() for scope in opts.required_scopes or [] if str(scope or "").strip()]
    now = opts.now or (lambda: datetime.now(UTC))

    def validate(_ctx: Context, token: str) -> BearerTokenClaims:
        claims = by_token.get(str(token or "").strip())
        if claims is None:
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
        expires_at = claims.expires_at
        if expires_at is not None:
            current = now()
            if current.tzinfo is None:
                current = current.replace(tzinfo=UTC)
            exp = expires_at if expires_at.tzinfo is not None else expires_at.replace(tzinfo=UTC)
            if current >= exp:
                raise OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED)
        if required_audience and claims.audience != required_audience:
            raise OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE)
        if _missing_scopes(claims.scopes, required_scopes):
            raise OAuthBearerError(ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE)
        return _clone_claims(claims)

    return validate


def bearer_token_claims_from_context(ctx: Context) -> BearerTokenClaims | None:
    value = ctx.get(CONTEXT_KEY_BEARER_CLAIMS)
    if isinstance(value, BearerTokenClaims):
        return _clone_claims(value)
    if isinstance(value, dict):
        return BearerTokenClaims(
            subject=str(value.get("subject") or ""),
            audience=str(value.get("audience") or ""),
            scopes=[str(scope) for scope in value.get("scopes") or []],
        )
    return None


def claude_dynamic_client_registration_policy() -> DynamicClientRegistrationPolicy:
    return DynamicClientRegistrationPolicy(
        allowed_redirect_uris=[
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.com/api/mcp/auth_callback",
        ],
        require_public_client=True,
        require_refresh_token=True,
    )


def validate_dynamic_client_registration_request(
    request: DynamicClientRegistrationRequest | dict[str, Any], policy: DynamicClientRegistrationPolicy
) -> None:
    req = _normalize_dcr_request(request)
    allowed = {str(uri or "").strip() for uri in policy.allowed_redirect_uris or [] if str(uri or "").strip()}
    if not req.redirect_uris:
        raise ValueError("dcr: redirect_uris is required")
    for raw in req.redirect_uris:
        uri = str(raw or "").strip()
        if not uri:
            raise ValueError("dcr: redirect_uris contains an empty value")
        if allowed and uri not in allowed:
            raise ValueError(f"dcr: redirect_uri not allowed: {uri}")
    method = str(req.token_endpoint_auth_method or "none").strip() or "none"
    if policy.require_public_client and method != "none":
        raise ValueError("dcr: token_endpoint_auth_method must be none")
    grants = sorted(str(value or "").strip() for value in req.grant_types or [] if str(value or "").strip())
    if grants:
        if "authorization_code" not in grants:
            raise ValueError("dcr: grant_types must include authorization_code")
        if policy.require_refresh_token and "refresh_token" not in grants:
            raise ValueError("dcr: grant_types must include refresh_token")
    responses = sorted(str(value or "").strip() for value in req.response_types or [] if str(value or "").strip())
    if responses and "code" not in responses:
        raise ValueError("dcr: response_types must include code")


def new_pkce_code_verifier() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def validate_pkce_code_verifier(verifier: str) -> None:
    if re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", str(verifier or "")) is None:
        raise ValueError("pkce: invalid code verifier")


def pkce_challenge_s256(verifier: str) -> str:
    validate_pkce_code_verifier(verifier)
    digest = hashlib.sha256(str(verifier).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def pkce_verify_s256(verifier: str, expected_challenge: str) -> bool:
    return pkce_challenge_s256(verifier) == str(expected_challenge or "")


def _unauthorized_response(opts: RequireBearerTokenOptions) -> Response:
    metadata_url = str(opts.resource_metadata_url or "").strip()
    headers = {
        "content-type": ["application/json; charset=utf-8"],
        "www-authenticate": [protected_resource_www_authenticate(metadata_url) if metadata_url else "Bearer"],
    }
    body = jsonlib.dumps(
        {"error": {"code": "app.unauthorized", "message": "unauthorized"}},
        separators=(",", ":"),
    ).encode("utf-8")
    return Response(
        status=401,
        headers=headers,
        cookies=[],
        body=body,
        is_base64=False,
    )


def _forbidden_response() -> Response:
    return Response(
        status=403,
        headers={"content-type": ["application/json; charset=utf-8"]},
        cookies=[],
        body=jsonlib.dumps({"error": {"code": "app.forbidden", "message": "forbidden"}}, separators=(",", ":")).encode(
            "utf-8"
        ),
        is_base64=False,
    )


def _bearer_error_response(opts: RequireBearerTokenOptions, exc: Exception) -> Response:
    if isinstance(exc, OAuthBearerError) and exc.oauth_code in {
        ERR_BEARER_TOKEN_INVALID_AUDIENCE,
        ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
    }:
        return _forbidden_response()
    return _unauthorized_response(opts)


def _first_header(headers: dict[str, Any] | None, name: str) -> str:
    needle = str(name or "").strip().lower()
    for key, value in dict(headers or {}).items():
        if str(key or "").strip().lower() != needle:
            continue
        values = value if isinstance(value, list) else [value]
        return str(values[0] if values else "")
    return ""


def _clone_claims(claims: BearerTokenClaims) -> BearerTokenClaims:
    return BearerTokenClaims(
        subject=str(claims.subject or ""),
        audience=str(claims.audience or ""),
        scopes=list(claims.scopes or []),
        expires_at=claims.expires_at,
    )


def _scope_fields(scope: str) -> list[str]:
    return [part.strip() for part in str(scope or "").split() if part.strip()]


def _missing_scopes(got: list[str], required: list[str]) -> list[str]:
    seen = {str(scope or "").strip() for scope in got or [] if str(scope or "").strip()}
    return [scope for scope in required or [] if str(scope or "").strip() not in seen]


def _is_absolute_url(raw: str) -> bool:
    parsed = urlparse(str(raw or "").strip())
    return bool(parsed.scheme and parsed.netloc)


def _join_url_path(base: str, suffix: str) -> str:
    left = str(base or "").rstrip("/")
    right = str(suffix or "").strip("/")
    if not left and not right:
        return "/"
    if not left:
        return f"/{right}"
    if not right:
        return left or "/"
    return f"{left}/{right}"


def _normalize_dcr_request(
    request: DynamicClientRegistrationRequest | dict[str, Any],
) -> DynamicClientRegistrationRequest:
    if isinstance(request, DynamicClientRegistrationRequest):
        return request
    if not isinstance(request, dict):
        raise ValueError("dcr: request is nil")
    return DynamicClientRegistrationRequest(
        client_name=str(request.get("client_name") or ""),
        redirect_uris=[str(item) for item in request.get("redirect_uris") or []],
        token_endpoint_auth_method=str(request.get("token_endpoint_auth_method") or ""),
        grant_types=[str(item) for item in request.get("grant_types") or []],
        response_types=[str(item) for item in request.get("response_types") or []],
        scope=str(request.get("scope") or ""),
    )


__all__ = [
    "CONTEXT_KEY_BEARER_CLAIMS",
    "CONTEXT_KEY_BEARER_TOKEN",
    "ERR_BEARER_TOKEN_EXPIRED",
    "ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE",
    "ERR_BEARER_TOKEN_INVALID_AUDIENCE",
    "ERR_INVALID_AUTHORIZATION_HEADER",
    "ERR_INVALID_BEARER_TOKEN",
    "ERR_INVALID_URL",
    "ERR_MISSING_BEARER_TOKEN",
    "AuthorizationServerMetadata",
    "BearerTokenClaims",
    "BearerTokenClaimsValidator",
    "BearerTokenRecord",
    "BearerTokenValidationOptions",
    "BearerTokenValidator",
    "DynamicClientRegistrationPolicy",
    "DynamicClientRegistrationRequest",
    "DynamicClientRegistrationResponse",
    "OAuthBearerError",
    "ProtectedResourceMetadata",
    "RequireBearerTokenOptions",
    "authorization_server_metadata_handler",
    "bearer_token_claims_from_context",
    "bearer_token_from_headers",
    "canonical_resource_url",
    "canonicalize_issuer_url",
    "claude_dynamic_client_registration_policy",
    "new_authorization_server_metadata",
    "new_memory_bearer_token_validator",
    "new_pkce_code_verifier",
    "new_protected_resource_metadata",
    "pkce_challenge_s256",
    "pkce_verify_s256",
    "protected_resource_metadata_handler",
    "protected_resource_www_authenticate",
    "require_bearer_token_middleware",
    "resource_metadata_url_from_mcp_endpoint",
    "rfc9728_resource_metadata_url",
    "validate_dynamic_client_registration_request",
    "validate_pkce_code_verifier",
]
