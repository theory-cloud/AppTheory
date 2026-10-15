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
from typing import Any, Literal, NamedTuple
from urllib.parse import SplitResult, urlparse, urlsplit

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
    revocation_endpoint: str = ""
    device_authorization_endpoint: str = ""
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
            "revocation_endpoint",
            "device_authorization_endpoint",
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
    required_audience_func: Callable[[Context], str] | None = None
    required_scopes_func: Callable[[Context], list[str]] | None = None


BearerTokenValidator = Callable[[Context, str], None]
BearerTokenClaimsValidator = Callable[[Context, str], BearerTokenClaims]


@dataclass(slots=True)
class RequireBearerTokenOptions:
    resource_metadata_url: str = ""
    validator: BearerTokenValidator | None = None
    claims_validator: BearerTokenClaimsValidator | None = None
    resource_metadata_url_func: Callable[[Context], str] | None = None
    required_scopes_func: Callable[[Context], list[str]] | None = None
    # An absolute HTTPS URL template whose `{param}` placeholders are
    # interpolated from the matched route's path parameters, so a per-actor
    # route advertises that actor's own RFC 9728 metadata URL with no hand-rolled
    # resolver. It is explicit application configuration: the middleware reads
    # no environment variable.
    #
    # The template is compiled when the middleware is built, and a malformed
    # template raises ValueError there, so a bad configuration fails closed at
    # registration instead of advertising a broken discovery URL. It must be an
    # absolute HTTPS URL with no userinfo, query, fragment, or percent-escape
    # and no "." or ".." path segment. At request time a placeholder the matched
    # route does not supply, or a value outside the pinned alphabet, emits the
    # bare `Bearer` challenge: a literal placeholder is never advertised and an
    # unresolvable template never falls back to resource_metadata_url. When set
    # it takes precedence over resource_metadata_url;
    # resource_metadata_url_func still takes precedence over it.
    resource_metadata_url_template: str = ""


def new_protected_resource_metadata(resource: str, authorization_servers: list[str]) -> ProtectedResourceMetadata:
    value = str(resource or "").strip()
    if not _is_absolute_url(value):
        raise ValueError(f"{ERR_INVALID_URL}: resource must be an absolute URL")
    servers = [str(item or "").strip() for item in authorization_servers or [] if str(item or "").strip()]
    if not servers or any(not _is_absolute_url(item) for item in servers):
        raise ValueError(f"{ERR_INVALID_URL}: authorization server must be an absolute URL")
    return ProtectedResourceMetadata(resource=value, authorization_servers=servers)


def new_authorization_server_metadata(
    issuer: str,
    *,
    revocation_endpoint: str | Literal[True] | None = None,
    device_authorization_endpoint: str | Literal[True] | None = None,
) -> AuthorizationServerMetadata:
    """Build the RFC 8414 document; pass True to derive the conventional
    /revoke or /device path, or an absolute URL to set it explicitly.

    Absent (None) leaves the member unset so the default document never
    advertises endpoints the framework does not implement.
    """
    parsed = urlparse(str(issuer or "").strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"{ERR_INVALID_URL}: issuer must be an absolute URL")
    canonical = parsed._replace(path=parsed.path.rstrip("/"), params="", query="", fragment="").geturl()

    def endpoint(suffix: str) -> str:
        p = urlparse(canonical)
        joined = _join_url_path(p.path, suffix)
        return p._replace(path=joined, params="", query="", fragment="").geturl()

    metadata = AuthorizationServerMetadata(
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
    if revocation_endpoint is True:
        metadata.revocation_endpoint = endpoint("/revoke")
    elif revocation_endpoint is not None:
        if not isinstance(revocation_endpoint, str) or not _is_absolute_url(revocation_endpoint):
            raise ValueError(f"{ERR_INVALID_URL}: revocation endpoint must be an absolute URL")
        metadata.revocation_endpoint = revocation_endpoint.strip()
    if device_authorization_endpoint is True:
        metadata.device_authorization_endpoint = endpoint("/device")
    elif device_authorization_endpoint is not None:
        if not isinstance(device_authorization_endpoint, str) or not _is_absolute_url(device_authorization_endpoint):
            raise ValueError(f"{ERR_INVALID_URL}: device authorization endpoint must be an absolute URL")
        metadata.device_authorization_endpoint = device_authorization_endpoint.strip()
    return metadata


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


def insufficient_scope_www_authenticate(scopes: list[str], resource_metadata_url: str = "") -> str:
    normalized = [str(scope or "").strip() for scope in scopes or [] if str(scope or "").strip()]
    parts = ['Bearer error="insufficient_scope"']
    if normalized:
        parts.append(f"scope={_quote_challenge_value(' '.join(normalized))}")
    url = str(resource_metadata_url or "").strip()
    if url:
        parts.append(f"resource_metadata={_quote_challenge_value(url)}")
    return ", ".join(parts)


def rfc9728_resource_metadata_url(resource_url: str) -> str | None:
    parsed = urlparse(str(resource_url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return None
    return parsed._replace(path=f"/.well-known/oauth-protected-resource{parsed.path}", params="", fragment="").geturl()


def resource_metadata_url_from_mcp_endpoint(mcp_endpoint: str) -> str | None:
    return rfc9728_resource_metadata_url(mcp_endpoint)


def canonical_resource_url(raw: str) -> str:
    return str(raw or "").strip().rstrip("/")


def resource_indicator_matches(expected: str, requested: str) -> bool:
    expected_canonical = canonical_resource_url(expected)
    requested_canonical = canonical_resource_url(requested)
    if not expected_canonical or not requested_canonical:
        return False
    return expected_canonical == requested_canonical


def canonicalize_issuer_url(raw: str) -> str | None:
    """Canonicalize an RFC 9207 ``iss`` value exactly as Go's
    ``oauth.CanonicalizeIssuerURL`` does, so the pinned issuer compares
    byte-for-byte across runtimes. The scheme is lowercased; the authority is
    preserved, so host case and an explicit port survive; the decoded path is
    re-encoded with the Go ``net/url`` path rules and its trailing slashes are
    trimmed; the raw query (including a bare trailing ``?``) and the raw
    fragment are kept. Relative, empty, control-byte and malformed
    percent-escape inputs return ``None``.

    ``urllib`` cannot express this: it lowercases neither host nor port but it
    drops ``;params``, discards a bare ``?``, keeps a malformed escape, and
    accepts a non-numeric port. The helpers below therefore re-implement the
    slice of ``net/url`` the reference depends on.
    """
    value = _go_trim_space(str(raw or ""))
    if value == "" or _go_has_control_byte(value):
        return None

    rest, raw_fragment = _go_split_fragment(value)

    scheme = _go_split_scheme(rest)
    if scheme is None:
        return None
    scheme_name, rest = scheme

    force_query, raw_query, rest = _go_split_query(rest)

    target = _go_split_authority(rest)
    if target is None:
        return None
    authority, raw_path = target

    parts = _go_parse_authority(authority)
    if parts is None:
        return None

    escaped_path = _go_escaped_path(raw_path)
    if escaped_path is None:
        return None

    decoded_host = _go_unescape(parts.host, "host")
    if decoded_host is None:
        return None

    out = f"{scheme_name}://"
    if parts.userinfo is not None:
        out += f"{parts.userinfo}@"
    out += _go_escape_bytes(decoded_host, _GO_HOST_ALLOWED)
    out += escaped_path
    if force_query or raw_query != "":
        out += f"?{raw_query}"

    if raw_fragment is not None:
        fragment = _go_fragment_suffix(raw_fragment)
        if fragment is None:
            return None
        out += fragment

    return out


def bearer_token_from_headers(headers: dict[str, Any] | None) -> str:
    auth = _first_header(headers, "authorization").strip()
    if not auth:
        raise OAuthBearerError(ERR_MISSING_BEARER_TOKEN)
    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].strip().lower() != "bearer" or not parts[1].strip():
        raise OAuthBearerError(ERR_INVALID_AUTHORIZATION_HEADER)
    return parts[1].strip()


def require_bearer_token_middleware(options: RequireBearerTokenOptions | None = None):
    """Enforce ``Authorization: Bearer <token>`` and, when it is missing or
    invalid, return 401 with the MCP 2025-06-18 compatible WWW-Authenticate
    challenge that points to the protected resource metadata.

    A ``resource_metadata_url_template`` is compiled here, at registration, and
    a malformed template raises ValueError: the middleware never serves a
    request whose challenge would advertise a broken or partially resolved
    discovery URL.
    """
    opts = options or RequireBearerTokenOptions()
    template: _ResourceMetadataURLTemplate | None = None
    if str(opts.resource_metadata_url_template or "").strip():
        template = _compile_resource_metadata_url_template(opts.resource_metadata_url_template)

    def middleware(ctx: Context, next_handler):
        try:
            token = bearer_token_from_headers(ctx.request.headers)
            if opts.claims_validator is not None:
                claims = opts.claims_validator(ctx, token)
                ctx.set(CONTEXT_KEY_BEARER_TOKEN, token)
                ctx.set(CONTEXT_KEY_BEARER_CLAIMS, _clone_claims(claims))
                return next_handler(ctx)
            if opts.validator is None:
                return _unauthorized_response(opts, ctx, template)
            opts.validator(ctx, token)
            ctx.set(CONTEXT_KEY_BEARER_TOKEN, token)
            return next_handler(ctx)
        except Exception as exc:  # noqa: BLE001
            return _bearer_error_response(opts, exc, ctx, template)

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
    required_scopes = _normalize_scopes(opts.required_scopes)
    now = opts.now or (lambda: datetime.now(UTC))

    def validate(ctx: Context, token: str) -> BearerTokenClaims:
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
        audience = required_audience
        if opts.required_audience_func is not None:
            audience = str(opts.required_audience_func(ctx) or "").strip()
        if audience and claims.audience != audience:
            raise OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE)
        scopes = required_scopes
        if opts.required_scopes_func is not None:
            scopes = _normalize_scopes(opts.required_scopes_func(ctx))
        if _missing_scopes(claims.scopes, scopes):
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


# A `{param}` protected-resource metadata URL template, compiled once when the
# middleware is built so request time only validates and interpolates the
# matched route parameters.
@dataclass(slots=True)
class _ResourceMetadataURLTemplate:
    base: SplitResult
    params: list[str]


_RESOURCE_METADATA_URL_TEMPLATE_MAX_PARAM_BYTES = 128

# Placeholder names are deliberately narrow: they name route parameters, not
# free-form expressions.
_RESOURCE_METADATA_URL_TEMPLATE_PARAM_PATTERN = re.compile(r"[a-z][a-z0-9_]*")

# The only bytes that may be interpolated into the advertised challenge URL. The
# alphabet is the RFC 3986 unreserved set plus the three path-safe punctuation
# bytes RFC 3986 allows unescaped; it is deliberately narrower than the router's
# own segment rule, so the advertised URL cannot differ from the matched route
# through case folding, percent-decoding, or separator handling in a proxy, CDN,
# or client.
_RESOURCE_METADATA_URL_TEMPLATE_VALUE_PATTERN = re.compile(
    rf"[a-z0-9._~-]{{1,{_RESOURCE_METADATA_URL_TEMPLATE_MAX_PARAM_BYTES}}}"
)


def _compile_resource_metadata_url_template(raw: str) -> _ResourceMetadataURLTemplate:
    """Validate a template and record the route parameters it interpolates.

    A template is valid when it is an absolute HTTPS URL with no userinfo,
    query, fragment, or percent-escape, with no ``.`` or ``..`` path segment,
    and every ``{param}`` placeholder sits in the URL path and names a
    lower-case route parameter. Placeholders outside the path are refused,
    because interpolating one would let a request steer the advertised authority
    rather than only its path suffix. ``urlsplit`` is used rather than
    ``urlparse`` because it keeps ``;`` in the path the way Go's ``net/url``
    does.

    Raises ValueError on any violation, so a malformed template fails loudly at
    registration rather than at request time.
    """
    trimmed = str(raw or "").strip()
    if not trimmed:
        raise ValueError("invalid ResourceMetadataURLTemplate: template is empty")
    try:
        parsed = urlsplit(trimmed)
    except ValueError as exc:
        raise ValueError("invalid ResourceMetadataURLTemplate: template is not an absolute URL") from exc
    if parsed.scheme.lower() != "https":
        raise ValueError("invalid ResourceMetadataURLTemplate: template must be an absolute HTTPS URL")
    if not parsed.netloc or not parsed.hostname:
        raise ValueError("invalid ResourceMetadataURLTemplate: template must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("invalid ResourceMetadataURLTemplate: template must not include userinfo")
    if "?" in trimmed:
        raise ValueError("invalid ResourceMetadataURLTemplate: template must not include a query")
    if "#" in trimmed:
        raise ValueError("invalid ResourceMetadataURLTemplate: template must not include a fragment")
    if "{" in parsed.netloc or "}" in parsed.netloc:
        raise ValueError(
            "invalid ResourceMetadataURLTemplate: template placeholders must appear in the path, not the authority"
        )
    if "%" in parsed.path:
        raise ValueError("invalid ResourceMetadataURLTemplate: template must not percent-encode its path")
    if _has_dot_path_segment(parsed.path):
        raise ValueError('invalid ResourceMetadataURLTemplate: template must not contain a "." or ".." path segment')
    params = _resource_metadata_url_template_params(parsed.path)
    return _ResourceMetadataURLTemplate(base=parsed, params=params)


def _has_dot_path_segment(raw_path: str) -> bool:
    """Report whether a URL path carries a ``.`` or ``..`` segment.

    A static dot segment in a template is never intended, and the runtimes do
    not agree on what to do with one: Go and Python advertise the literal
    segment while a WHATWG URL parser normalizes it away, so the advertised URL
    would depend on the runtime. The template is refused instead.
    """
    return any(segment in (".", "..") for segment in raw_path.split("/"))


def _resource_metadata_url_template_params(raw_path: str) -> list[str]:
    """Return the distinct placeholder names in path order, refusing anything
    that is not a well-formed ``{param}``."""
    params: list[str] = []
    seen: set[str] = set()
    index = 0
    while index < len(raw_path):
        char = raw_path[index]
        if char == "{":
            end = raw_path.find("}", index)
            if end < 0:
                raise ValueError("invalid ResourceMetadataURLTemplate: template placeholder is unterminated")
            name = raw_path[index + 1 : end]
            if _RESOURCE_METADATA_URL_TEMPLATE_PARAM_PATTERN.fullmatch(name) is None:
                raise ValueError(
                    f"invalid ResourceMetadataURLTemplate: template placeholder {name!r} is not a route parameter name"
                )
            if name not in seen:
                seen.add(name)
                params.append(name)
            index = end + 1
            continue
        if char == "}":
            raise ValueError('invalid ResourceMetadataURLTemplate: template has an unmatched "}"')
        index += 1
    return params


def _resolve_resource_metadata_url_template(
    template: _ResourceMetadataURLTemplate, params: dict[str, str] | None
) -> str | None:
    """Interpolate the matched route parameters into the template.

    Every placeholder must be present in the matched route and its value must
    satisfy the pinned value rule; the resolved URL is then checked to be free
    of leftover placeholders. A failure returns None so the caller emits the
    bare ``Bearer`` challenge instead of a literal placeholder or a partially
    resolved URL.
    """
    resolved_path = template.base.path
    for name in template.params:
        value = str((params or {}).get(name, "") or "")
        if not _is_safe_resource_metadata_url_template_value(value):
            return None
        resolved_path = resolved_path.replace("{" + name + "}", value)
    if "{" in resolved_path or "}" in resolved_path:
        return None
    return template.base._replace(path=resolved_path, query="", fragment="").geturl()


def _is_safe_resource_metadata_url_template_value(value: str) -> bool:
    """Report whether a route parameter value may be interpolated into the
    advertised challenge URL.

    The pinned rule accepts 1..128 bytes drawn from ``[a-z0-9._~-]``, excluding
    the dot segments ``.`` and ``..``. Everything else — empty, ``/``-containing,
    percent-encoded, upper-case, whitespace, control, backslash, or non-ASCII —
    is refused, and the caller then emits the bare ``Bearer`` challenge.
    """
    if value in (".", ".."):
        return False
    return _RESOURCE_METADATA_URL_TEMPLATE_VALUE_PATTERN.fullmatch(value) is not None


def _resolved_resource_metadata_url(
    opts: RequireBearerTokenOptions,
    ctx: Context | None,
    template: _ResourceMetadataURLTemplate | None = None,
) -> str:
    """Return the protected-resource metadata URL for the challenge.

    A route-derived resolver takes precedence, then a route-parameter template,
    then the static option; no environment variable is consulted. A configured
    template that cannot be resolved for the matched route returns "" so the
    caller emits the bare ``Bearer`` challenge rather than a literal placeholder
    or the static URL.
    """
    if opts.resource_metadata_url_func is not None and ctx is not None:
        try:
            return str(opts.resource_metadata_url_func(ctx) or "").strip()
        except Exception:  # noqa: BLE001
            return ""
    if template is not None:
        params = ctx.params if ctx is not None else None
        resolved = _resolve_resource_metadata_url_template(template, params)
        if resolved is None:
            return ""
        return resolved
    return str(opts.resource_metadata_url or "").strip()


def _unauthorized_response(
    opts: RequireBearerTokenOptions,
    ctx: Context | None = None,
    template: _ResourceMetadataURLTemplate | None = None,
) -> Response:
    metadata_url = _resolved_resource_metadata_url(opts, ctx, template)
    headers = {
        "content-type": ["application/json; charset=utf-8"],
        "www-authenticate": [protected_resource_www_authenticate(metadata_url) if metadata_url else "Bearer"],
    }
    body = jsonlib.dumps(
        {"error": {"code": "app.unauthorized", "message": "unauthorized", "status_code": 401}},
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
        body=jsonlib.dumps(
            {"error": {"code": "app.forbidden", "message": "forbidden", "status_code": 403}}, separators=(",", ":")
        ).encode("utf-8"),
        is_base64=False,
    )


def _insufficient_scope_response(
    opts: RequireBearerTokenOptions,
    ctx: Context | None,
    template: _ResourceMetadataURLTemplate | None = None,
) -> Response:
    scopes: list[str] = []
    if opts.required_scopes_func is not None and ctx is not None:
        try:
            scopes = [str(scope) for scope in opts.required_scopes_func(ctx) or []]
        except Exception:  # noqa: BLE001
            scopes = []
    headers = {
        "content-type": ["application/json; charset=utf-8"],
        "www-authenticate": [
            insufficient_scope_www_authenticate(scopes, _resolved_resource_metadata_url(opts, ctx, template))
        ],
    }
    body = jsonlib.dumps(
        {"error": {"code": "app.insufficient_scope", "message": "insufficient scope", "status_code": 403}},
        separators=(",", ":"),
    ).encode("utf-8")
    return Response(
        status=403,
        headers=headers,
        cookies=[],
        body=body,
        is_base64=False,
    )


def _bearer_error_response(
    opts: RequireBearerTokenOptions,
    exc: Exception,
    ctx: Context | None = None,
    template: _ResourceMetadataURLTemplate | None = None,
) -> Response:
    if isinstance(exc, OAuthBearerError):
        if exc.oauth_code == ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE:
            return _insufficient_scope_response(opts, ctx, template)
        if exc.oauth_code == ERR_BEARER_TOKEN_INVALID_AUDIENCE:
            return _forbidden_response()
    return _unauthorized_response(opts, ctx, template)


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


def _normalize_scopes(scopes: list[str] | None) -> list[str]:
    return [str(scope or "").strip() for scope in scopes or [] if str(scope or "").strip()]


def _quote_challenge_value(value: str) -> str:
    escaped = str(value or "").replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


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


# The helpers below re-implement the slice of Go's `net/url` that
# `oauth.CanonicalizeIssuerURL` depends on: scheme splitting, authority
# parsing, and the escape table of `net/url`'s encoding modes. They are
# deliberately local to this module (never `apptheory.mcpfacade`, which would be
# circular) so the issuer pin cannot drift from Go.

_GO_ALNUM = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

# The bytes each `net/url` encoding mode leaves unescaped, from its generated
# `encoding_table.go`.
_GO_PATH_ALLOWED = frozenset(_GO_ALNUM + b"-._~$&+,/:;=@")
_GO_HOST_ALLOWED = frozenset(_GO_ALNUM + b"-._~!\"$&'()*+,:;<=>[]")
_GO_FRAGMENT_ALLOWED = frozenset(_GO_ALNUM + b"-._~!$&()*+,/:;=?@")
_GO_USERINFO_ALLOWED = frozenset(_GO_ALNUM + b"-._~$&+,;=")
_GO_USERINFO_VALID = frozenset(_GO_ALNUM + b"-._:~!$&'()*+,;=%@")

_GO_ESCAPE_ALLOWED: dict[str, frozenset[int]] = {
    "path": _GO_PATH_ALLOWED,
    "host": _GO_HOST_ALLOWED,
    "fragment": _GO_FRAGMENT_ALLOWED,
    "userinfo": _GO_USERINFO_ALLOWED,
}

# `net/url.validEncoded` always accepts these bytes, whatever the mode.
_GO_ENCODED_LITERALS = frozenset(b"!$&'()*+,;=:@[]")

_GO_ESCAPE_TABLE = tuple(f"%{index:02X}".encode("ascii") for index in range(256))

# Go's `unicode.IsSpace`, which Python's `str.strip()` widens by the four ASCII
# separators U+001C..U+001F that Go treats as control bytes instead.
_GO_SPACE_CHARS = (
    "\t\n\v\f\r \x85\xa0"
    "\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)


class _GoAuthority(NamedTuple):
    """The ``host``/``userinfo`` half of a parsed authority."""

    host: str
    # Re-encoded the way Go's ``url.Userinfo.String()`` prints it, or None.
    userinfo: str | None


def _go_trim_space(value: str) -> str:
    return value.strip(_GO_SPACE_CHARS)


def _go_has_control_byte(value: str) -> bool:
    return any(byte < 0x20 or byte == 0x7F for byte in value.encode("utf-8"))


def _go_is_hex_byte(code: int) -> bool:
    return 0x30 <= code <= 0x39 or 0x41 <= code <= 0x46 or 0x61 <= code <= 0x66


def _go_unhex(code: int) -> int:
    if 0x30 <= code <= 0x39:
        return code - 0x30
    if 0x41 <= code <= 0x46:
        return code - 0x41 + 10
    return code - 0x61 + 10


def _go_escape_bytes(data: bytes, allowed: frozenset[int]) -> str:
    out = bytearray()
    for byte in data:
        if byte in allowed:
            out.append(byte)
        else:
            out += _GO_ESCAPE_TABLE[byte]
    return out.decode("ascii")


def _go_unescape(value: str, mode: str) -> bytes | None:
    data = value.encode("utf-8")
    out = bytearray()
    index = 0
    while index < len(data):
        byte = data[index]
        if byte == 0x25:
            if index + 2 >= len(data):
                return None
            high = data[index + 1]
            low = data[index + 2]
            if not _go_is_hex_byte(high) or not _go_is_hex_byte(low):
                return None
            decoded = (_go_unhex(high) << 4) | _go_unhex(low)
            escaped = high == 0x32 and low == 0x35
            # In the host component %-encoding is only for non-ASCII bytes,
            # except for the %25 that introduces an RFC 6874 zone identifier.
            if mode == "host" and decoded < 0x80 and not escaped:
                return None
            out.append(decoded)
            index += 3
            continue
        if mode == "host" and byte < 0x80 and byte not in _GO_HOST_ALLOWED:
            return None
        out.append(byte)
        index += 1
    return bytes(out)


def _go_valid_encoded(value: str, mode: str) -> bool:
    allowed = _GO_ESCAPE_ALLOWED[mode]
    data = value.encode("utf-8")
    index = 0
    while index < len(data):
        byte = data[index]
        if byte == 0x25:
            if index + 2 >= len(data):
                return False
            if not _go_is_hex_byte(data[index + 1]) or not _go_is_hex_byte(data[index + 2]):
                return False
            index += 3
            continue
        if byte not in _GO_ENCODED_LITERALS and byte not in allowed:
            return False
        index += 1
    return True


def _go_trim_trailing_slashes(data: bytes) -> bytes:
    end = len(data)
    while end > 0 and data[end - 1] == 0x2F:
        end -= 1
    return data[:end]


def _go_escaped_path(raw_path: str) -> str | None:
    """Go's `URL.EscapedPath` after `CanonicalizeIssuerURL` trimmed the path."""
    decoded = _go_unescape(raw_path, "path")
    if decoded is None:
        return None
    trimmed = _go_trim_trailing_slashes(decoded)
    if _go_escape_bytes(decoded, _GO_PATH_ALLOWED) != raw_path:
        hinted = _go_unescape(raw_path, "path")
        if _go_valid_encoded(raw_path, "path") and hinted is not None and hinted == trimmed:
            return raw_path
    return _go_escape_bytes(trimmed, _GO_PATH_ALLOWED)


def _go_fragment_suffix(raw_fragment: str) -> str | None:
    """The `#...` Go prints for a fragment, or "" when the fragment is empty."""
    decoded = _go_unescape(raw_fragment, "fragment")
    if decoded is None:
        return None
    if len(decoded) == 0:
        return ""
    if _go_valid_encoded(raw_fragment, "fragment"):
        return f"#{raw_fragment}"
    return f"#{_go_escape_bytes(decoded, _GO_FRAGMENT_ALLOWED)}"


def _go_split_fragment(value: str) -> tuple[str, str | None]:
    hash_index = value.find("#")
    if hash_index < 0:
        return value, None
    return value[:hash_index], value[hash_index + 1 :]


def _go_split_query(value: str) -> tuple[bool, str, str]:
    if value.endswith("?") and value.count("?") == 1:
        return True, "", value[:-1]
    query_index = value.find("?")
    if query_index < 0:
        return False, "", value
    return False, value[query_index + 1 :], value[:query_index]


def _go_split_authority(value: str) -> tuple[str, str] | None:
    if not value.startswith("//"):
        return None
    path_start = value.find("/", 2)
    if path_start < 0:
        return value[2:], ""
    return value[2:path_start], value[path_start:]


def _go_is_ascii_letter(code: int) -> bool:
    return 0x41 <= code <= 0x5A or 0x61 <= code <= 0x7A


def _go_is_scheme_tail(code: int) -> bool:
    return 0x30 <= code <= 0x39 or code in (0x2B, 0x2D, 0x2E)


def _go_split_scheme(value: str) -> tuple[str, str] | None:
    for index, char in enumerate(value):
        code = ord(char)
        if _go_is_ascii_letter(code):
            continue
        if index > 0 and _go_is_scheme_tail(code):
            continue
        if index > 0 and code == 0x3A:
            return value[:index].lower(), value[index + 1 :]
        return None
    return None


def _go_valid_optional_port(value: str) -> bool:
    if value == "":
        return True
    if not value.startswith(":"):
        return False
    return all(0x30 <= ord(char) <= 0x39 for char in value[1:])


def _go_is_ip_literal(value: str) -> bool:
    if ":" not in value:
        return False
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", value):
        return False
    return re.fullmatch(r"[0-9A-Fa-f:.]+", value) is not None


def _go_host_is_valid(host: str) -> bool:
    open_bracket = host.rfind("[")
    if open_bracket > 0:
        return False
    if open_bracket == 0:
        close_bracket = host.rfind("]")
        if close_bracket < 0:
            return False
        if not _go_valid_optional_port(host[close_bracket + 1 :]):
            return False
        if not _go_is_ip_literal(host[1:close_bracket]):
            return False
        return _go_unescape(host, "host") is not None
    separator = host.find(":")
    if separator >= 0 and not _go_valid_optional_port(host[separator:]):
        return False
    return _go_unescape(host, "host") is not None


def _go_userinfo_is_valid(value: str) -> bool:
    return all(ord(char) in _GO_USERINFO_VALID for char in value)


def _go_encode_userinfo(raw: str) -> str | None:
    separator = raw.find(":")
    if separator < 0:
        username = _go_unescape(raw, "userinfo")
        return None if username is None else _go_escape_bytes(username, _GO_USERINFO_ALLOWED)
    username = _go_unescape(raw[:separator], "userinfo")
    password = _go_unescape(raw[separator + 1 :], "userinfo")
    if username is None or password is None:
        return None
    encoded_username = _go_escape_bytes(username, _GO_USERINFO_ALLOWED)
    encoded_password = _go_escape_bytes(password, _GO_USERINFO_ALLOWED)
    return f"{encoded_username}:{encoded_password}"


def _go_parse_authority(value: str) -> _GoAuthority | None:
    at = value.rfind("@")
    host = value if at < 0 else value[at + 1 :]
    if host == "" or not _go_host_is_valid(host):
        return None
    if at < 0:
        return _GoAuthority(host=host, userinfo=None)
    raw = value[:at]
    if not _go_userinfo_is_valid(raw):
        return None
    userinfo = _go_encode_userinfo(raw)
    if userinfo is None:
        return None
    return _GoAuthority(host=host, userinfo=userinfo)


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


from apptheory.oauth.autheory import (  # noqa: E402
    AutheoryProvider,
    AutheoryProviderOptions,
    new_autheory_provider,
)
from apptheory.oauth.jwks import (  # noqa: E402
    JWKSValidatorOptions,
    bootstrap_oidc_discovery,
    new_jwks_validator,
)
from apptheory.oauth.provider import (  # noqa: E402
    ERROR_INVALID_GRANT,
    ERROR_INVALID_REQUEST,
    ERROR_REAUTH_REQUIRED,
    ERROR_TEMPORARILY_UNAVAILABLE,
    ERROR_UPSTREAM,
    AuthorizationRequest,
    CodeExchangeRequest,
    Provider,
    ProviderError,
    ProviderMetadata,
    RefreshRequest,
    TokenClaims,
    TokenExpectations,
    TokenSet,
)
from apptheory.oauth.store import (  # noqa: E402
    AuthorizationCodeRecord,
    AuthorizationCodeStore,
    BrokerLockedError,
    BrokerRevokedError,
    BrokerVersionConflictError,
    ClientRecord,
    ClientStore,
    ClientVersionConflictError,
    ConsumeResult,
    MemoryAuthorizationCodeStore,
    MemoryClientStore,
    MemoryRateLimitStore,
    MemoryRouteRefreshBrokerStore,
    MemoryTransactionStore,
    RateLimitBucketKey,
    RateLimitResult,
    RateLimitStore,
    RouteRefreshBrokerRecord,
    RouteRefreshBrokerSeeder,
    RouteRefreshBrokerStore,
    StoreError,
    Stores,
    TransactionRecord,
    TransactionStore,
    hash_key,
    run_store_conformance,
)

__all__ = [
    "CONTEXT_KEY_BEARER_CLAIMS",
    "CONTEXT_KEY_BEARER_TOKEN",
    "ERROR_INVALID_GRANT",
    "ERROR_INVALID_REQUEST",
    "ERROR_REAUTH_REQUIRED",
    "ERROR_TEMPORARILY_UNAVAILABLE",
    "ERROR_UPSTREAM",
    "ERR_BEARER_TOKEN_EXPIRED",
    "ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE",
    "ERR_BEARER_TOKEN_INVALID_AUDIENCE",
    "ERR_INVALID_AUTHORIZATION_HEADER",
    "ERR_INVALID_BEARER_TOKEN",
    "ERR_INVALID_URL",
    "ERR_MISSING_BEARER_TOKEN",
    "AutheoryProvider",
    "AutheoryProviderOptions",
    "AuthorizationCodeRecord",
    "AuthorizationCodeStore",
    "AuthorizationRequest",
    "AuthorizationServerMetadata",
    "BearerTokenClaims",
    "BearerTokenClaimsValidator",
    "BearerTokenRecord",
    "BearerTokenValidationOptions",
    "BearerTokenValidator",
    "BrokerLockedError",
    "BrokerRevokedError",
    "BrokerVersionConflictError",
    "ClientRecord",
    "ClientStore",
    "ClientVersionConflictError",
    "CodeExchangeRequest",
    "ConsumeResult",
    "DynamicClientRegistrationPolicy",
    "DynamicClientRegistrationRequest",
    "DynamicClientRegistrationResponse",
    "JWKSValidatorOptions",
    "MemoryAuthorizationCodeStore",
    "MemoryClientStore",
    "MemoryRateLimitStore",
    "MemoryRouteRefreshBrokerStore",
    "MemoryTransactionStore",
    "OAuthBearerError",
    "ProtectedResourceMetadata",
    "Provider",
    "ProviderError",
    "ProviderMetadata",
    "RateLimitBucketKey",
    "RateLimitResult",
    "RateLimitStore",
    "RefreshRequest",
    "RequireBearerTokenOptions",
    "RouteRefreshBrokerRecord",
    "RouteRefreshBrokerSeeder",
    "RouteRefreshBrokerStore",
    "StoreError",
    "Stores",
    "TokenClaims",
    "TokenExpectations",
    "TokenSet",
    "TransactionRecord",
    "TransactionStore",
    "authorization_server_metadata_handler",
    "bearer_token_claims_from_context",
    "bearer_token_from_headers",
    "bootstrap_oidc_discovery",
    "canonical_resource_url",
    "canonicalize_issuer_url",
    "claude_dynamic_client_registration_policy",
    "hash_key",
    "insufficient_scope_www_authenticate",
    "new_autheory_provider",
    "new_authorization_server_metadata",
    "new_jwks_validator",
    "new_memory_bearer_token_validator",
    "new_pkce_code_verifier",
    "new_protected_resource_metadata",
    "pkce_challenge_s256",
    "pkce_verify_s256",
    "protected_resource_metadata_handler",
    "protected_resource_www_authenticate",
    "require_bearer_token_middleware",
    "resource_indicator_matches",
    "resource_metadata_url_from_mcp_endpoint",
    "rfc9728_resource_metadata_url",
    "run_store_conformance",
    "validate_dynamic_client_registration_request",
    "validate_pkce_code_verifier",
]
