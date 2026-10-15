"""Autheory adapter for the provider SPI (DESIGN section 6).

Autheory is the first (and, in this program, only) provider adapter. It speaks
RFC 8414 discovery, RFC 8707 ``resource``, RFC 9207 ``iss``, and mandatory S256
PKCE, and it always sends ``resource`` at authorize.

Two reuse targets come from :mod:`apptheory.oauth.jwks`: the bounded default
transport (deadline covering response head *and* body, 1 MiB response cap,
redirect refusal, connect-time non-public-host guard) and the RS256/JWKS
validator with OIDC discovery bootstrap. The adapter never re-implements the
bounded fetch, and it never forwards an upstream error body.
"""

from __future__ import annotations

import base64
import binascii
import functools
import json as jsonlib
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

from apptheory.context import Context
from apptheory.oauth import OAuthBearerError, canonicalize_issuer_url, jwks
from apptheory.oauth.provider import (
    ERROR_INVALID_GRANT,
    ERROR_INVALID_REQUEST,
    ERROR_REAUTH_REQUIRED,
    ERROR_TEMPORARILY_UNAVAILABLE,
    ERROR_UPSTREAM,
    AuthorizationRequest,
    CodeExchangeRequest,
    ProviderError,
    ProviderMetadata,
    RefreshRequest,
    TokenClaims,
    TokenExpectations,
    TokenSet,
)
from apptheory.request import Request

# ``(method, url, headers, body) -> (status, headers, body)``. An injected
# transport is caller-owned and is not re-timed or re-plumbed with the guard;
# the framework default transport below carries both.
HTTPTransport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, dict[str, str], bytes]]

DEFAULT_HTTP_TIMEOUT_SECONDS = 10.0
MAX_HTTP_RESPONSE_BYTES = jwks.MAX_HTTP_RESPONSE_BYTES
# Bounds the per-expectation-set validator cache so a caller that varies the
# audience or scope set per route cannot grow it without bound.
MAX_VALIDATOR_CACHE_ENTRIES = 32
S256 = "S256"

# Upstream token-endpoint error codes that carry an adapter-level meaning. The
# remaining terminal codes all map to invalid_grant, and an unrecognized code
# stays an upstream_error so an unknown signal is never upgraded into a
# client-facing decision. The mapping is identical in the Go and TypeScript
# adapters.
TOKEN_ERROR_REAUTH_REQUIRED = "reauth_required"  # noqa: S105 - an OAuth error code
TOKEN_ERROR_TEMPORARILY_UNAVAILABLE = "temporarily_unavailable"  # noqa: S105 - an OAuth error code
TERMINAL_TOKEN_ERROR_CODES = frozenset(
    {
        "invalid_grant",
        "invalid_client",
        "unauthorized_client",
        "invalid_scope",
        "invalid_request",
        "access_denied",
        "expired_token",
        "invalid_token",
    }
)

# The authorize parameters the adapter itself owns. A hint whose name collides
# with one of these — compared case-insensitively after trimming — is refused
# with invalid_request instead of being allowed to override or duplicate it.
# The required parameter is never silently replaced: a caller that tries to set
# one is asking for something this adapter will not do.
RESERVED_AUTHORIZE_PARAMETERS = frozenset(
    {
        "response_type",
        "client_id",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "state",
        "resource",
        "scope",
    }
)

# The JWKS validator receives the route-aware context, but this adapter pins
# issuer/audience/scopes per call, so the placeholder route is never consulted.
_VALIDATION_CONTEXT = Context(request=Request(method="POST", path="/", headers={}, query={}, body=b"", is_base64=False))


@dataclass(slots=True)
class AutheoryProviderOptions:
    """Construction options for :class:`AutheoryProvider`.

    ``client_id`` is the adapter's own upstream client registration id. It is
    never read: the adapter does not supply a request's client id from it.
    """

    issuer: str
    # The adapter's own upstream client registration id. It is retained for
    # parity with the Go option and is never read: the adapter does NOT derive a
    # request's client id from it, and a request that omits its own upstream
    # client id fails closed with invalid_request.
    client_id: str = ""
    discovery_url: str = ""
    token_endpoint: str = ""
    authorization_endpoint: str = ""
    jwks_uri: str = ""
    http_get: HTTPTransport | None = None
    # Disables the non-public-host check on the framework default transport.
    # Off by default; only local development and the loopback suites opt in.
    allow_private_hosts: bool = False
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS
    now: Callable[[], datetime] | None = None
    allowed_authorized_parties: list[str] = field(default_factory=list)


def new_autheory_provider(options: AutheoryProviderOptions) -> AutheoryProvider:
    """Builds the Autheory provider adapter."""
    return AutheoryProvider(options)


class AutheoryProvider:
    """Provider SPI adapter for Autheory (and any RFC 8414 upstream)."""

    def __init__(self, options: AutheoryProviderOptions) -> None:
        self._options = options
        self._issuer = canonicalize_issuer_url(options.issuer)
        self._timeout = _positive_float(options.http_timeout_seconds, DEFAULT_HTTP_TIMEOUT_SECONDS)
        self._transport: HTTPTransport = options.http_get or functools.partial(
            _default_http_transport,
            timeout=self._timeout,
            allow_private_hosts=options.allow_private_hosts is True,
        )
        self._metadata: ProviderMetadata | None = None
        self._validators: OrderedDict[tuple[Any, ...], Any] = OrderedDict()

    # -- SPI -----------------------------------------------------------------

    def discovery(self) -> ProviderMetadata:
        if self._metadata is None:
            self._metadata = self._fetch_metadata()
        return self._metadata

    def authorization_url(self, req: AuthorizationRequest) -> str:
        """Builds the upstream authorize URL.

        The required parameters are validated and built first, then the caller's
        hints are applied. A hint whose trimmed, lower-cased name is in
        :data:`RESERVED_AUTHORIZE_PARAMETERS` collides with a required or
        reserved authorize parameter and is refused with ``invalid_request``;
        a non-colliding hint is forwarded verbatim as an opaque provider hint.

        The hint rules are checked *before* discovery, so a refused hint never
        causes — and never depends on — an upstream metadata fetch.
        """
        op = "authorization_url"
        client_id = str(req.upstream_client_id or "").strip()
        callback_url = str(req.callback_url or "").strip()
        code_challenge = str(req.code_challenge or "").strip()
        code_challenge_method = str(req.code_challenge_method or "").strip()
        state = str(req.state or "").strip()
        resource = str(req.resource or "").strip()
        if (
            not client_id
            or not callback_url
            or not code_challenge
            or not state
            or not resource
            or code_challenge_method != S256
        ):
            raise ProviderError(ERROR_INVALID_REQUEST, op)
        # Checked here, before the endpoint is resolved, so a hint that collides
        # with a parameter the adapter owns is refused without reaching upstream.
        hints = _forwardable_authorize_hints(req.hints, op)
        endpoint = self.discovery().authorization_endpoint
        params: dict[str, str] = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": callback_url,
            "code_challenge": code_challenge,
            "code_challenge_method": S256,
            "state": state,
            # Autheory requires the resource indicator; it is always sent.
            "resource": resource,
        }
        scopes = [str(scope).strip() for scope in req.scopes or [] if str(scope).strip()]
        if scopes:
            params["scope"] = " ".join(scopes)
        # Every key ``params`` carries is drawn from
        # :data:`RESERVED_AUTHORIZE_PARAMETERS`, and the check above refused every
        # hint naming one of those, so a forwarded hint never overwrites a
        # required parameter.
        params.update(hints)
        separator = "&" if "?" in endpoint else "?"
        return f"{endpoint}{separator}{urlencode(params)}"

    def exchange_code(self, req: CodeExchangeRequest) -> TokenSet:
        op = "exchange_code"
        code = str(req.code or "").strip()
        client_id = str(req.upstream_client_id or "").strip()
        callback_url = str(req.callback_url or "").strip()
        code_verifier = str(req.code_verifier or "").strip()
        if not code or not client_id or not callback_url or not code_verifier:
            raise ProviderError(ERROR_INVALID_REQUEST, op)
        return self._token_request(
            op,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": callback_url,
                "client_id": client_id,
                "code_verifier": code_verifier,
            },
        )

    def refresh(self, req: RefreshRequest) -> TokenSet:
        op = "refresh"
        refresh_material = str(req.refresh_material or "").strip()
        client_id = str(req.upstream_client_id or "").strip()
        if not refresh_material or not client_id:
            raise ProviderError(ERROR_INVALID_REQUEST, op)
        return self._token_request(
            op,
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_material,
                "client_id": client_id,
            },
        )

    def validate_access_token(self, token: str, expected: TokenExpectations) -> TokenClaims:
        op = "validate_access_token"
        metadata = self.discovery()
        required_scopes = [str(scope).strip() for scope in expected.required_scopes or [] if str(scope).strip()]
        allowed_parties = _authorized_parties(
            expected.allowed_authorized_parties, self._options.allowed_authorized_parties
        )
        cache_key = (
            canonicalize_issuer_url(expected.expected_issuer) or str(expected.expected_issuer or ""),
            metadata.jwks_uri,
            str(expected.expected_audience or "").strip(),
            tuple(required_scopes),
            tuple(allowed_parties),
        )
        validator = self._validators.get(cache_key)
        if validator is None:
            validator = self._new_validator(metadata, expected, required_scopes, allowed_parties, op)
            self._remember_validator(cache_key, validator)
        try:
            claims = validator(_VALIDATION_CONTEXT, token)
        except Exception as exc:
            # Every validator failure is an upstream_error: a token the upstream
            # cannot vouch for is never accepted, and the reason is never
            # forwarded to the client. This matches the Go and TypeScript
            # adapters.
            raise ProviderError(ERROR_UPSTREAM, op) from exc
        authorized_party = _authorized_party_from_token(token)
        return TokenClaims(
            subject=str(claims.subject or ""),
            audience=str(claims.audience or ""),
            scopes=list(claims.scopes or []),
            expires_at=claims.expires_at,
            authorized_party=authorized_party,
        )

    # -- internals -----------------------------------------------------------

    def _new_validator(
        self,
        metadata: ProviderMetadata,
        expected: TokenExpectations,
        required_scopes: list[str],
        allowed_parties: list[str],
        op: str,
    ) -> Any:
        issuer = str(expected.expected_issuer or "").strip()
        options = jwks.JWKSValidatorOptions(
            issuer=issuer,
            jwks_uri=metadata.jwks_uri,
            http_get=self._jwks_transport,
            allow_private_hosts=self._options.allow_private_hosts is True,
            http_timeout_seconds=self._timeout,
            now=self._options.now,
            allowed_azp=list(allowed_parties),
            required_audience=str(expected.expected_audience or "").strip(),
            required_scopes=list(required_scopes),
        )
        try:
            return jwks.new_jwks_validator(options)
        except (ValueError, OAuthBearerError) as exc:
            raise ProviderError(ERROR_UPSTREAM, op) from exc

    def _remember_validator(self, cache_key: tuple[Any, ...], validator: Any) -> None:
        self._validators.pop(cache_key, None)
        self._validators[cache_key] = validator
        while len(self._validators) > MAX_VALIDATOR_CACHE_ENTRIES:
            self._validators.popitem(last=False)

    def _jwks_transport(self, url: str) -> tuple[int, dict[str, str], bytes]:
        # The JWKS validator itself enforces https, redirect refusal, and the
        # response-size cap; this adapter only supplies the transport seam.
        status, headers, body = self._transport("GET", url, {"accept": "application/json"}, None)
        return int(status), dict(headers or {}), body

    def _fetch_metadata(self) -> ProviderMetadata:
        op = "discovery"
        issuer = _secure_url(self._issuer or "")
        if issuer is None:
            raise ProviderError(ERROR_UPSTREAM, op)
        configured_discovery = str(self._options.discovery_url or "").strip()
        if configured_discovery:
            discovery_url = _secure_url(configured_discovery)
        else:
            discovery_url = _secure_url(f"{issuer}/.well-known/oauth-authorization-server")
        if discovery_url is None:
            raise ProviderError(ERROR_UPSTREAM, op)
        status, body = self._fetch(op, "GET", discovery_url, {"accept": "application/json"}, None)
        if status != 200:
            raise ProviderError(ERROR_UPSTREAM, op)
        document = _json_object(body)
        if document is None:
            raise ProviderError(ERROR_UPSTREAM, op)
        document_issuer = canonicalize_issuer_url(str(document.get("issuer") or ""))
        if document_issuer is None or document_issuer != self._issuer:
            raise ProviderError(ERROR_UPSTREAM, op)
        methods = [str(method) for method in document.get("code_challenge_methods_supported") or []]
        authorization_endpoint = _resolve_override(self._options.authorization_endpoint) or _secure_url(
            document.get("authorization_endpoint")
        )
        token_endpoint = _resolve_override(self._options.token_endpoint) or _secure_url(document.get("token_endpoint"))
        jwks_uri = _resolve_override(self._options.jwks_uri) or _secure_url(document.get("jwks_uri"))
        if authorization_endpoint is None or token_endpoint is None or jwks_uri is None:
            raise ProviderError(ERROR_UPSTREAM, op)
        return ProviderMetadata(
            issuer=self._issuer or "",
            authorization_endpoint=authorization_endpoint,
            token_endpoint=token_endpoint,
            jwks_uri=jwks_uri,
            code_challenge_methods_supported=methods,
            authorization_response_iss_parameter_supported=bool(
                document.get("authorization_response_iss_parameter_supported")
            ),
            resource_parameter_supported=bool(document.get("resource_parameter_supported")),
        )

    def _token_request(self, op: str, form: dict[str, str]) -> TokenSet:
        endpoint = self.discovery().token_endpoint
        payload = urlencode(form).encode("ascii")
        status, body = self._fetch(
            op,
            "POST",
            endpoint,
            {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
            payload,
        )
        if 200 <= status < 300:
            document = _json_object(body)
            if document is None:
                raise ProviderError(ERROR_UPSTREAM, op)
            access_token = str(document.get("access_token") or "").strip()
            if not access_token:
                raise ProviderError(ERROR_UPSTREAM, op)
            return TokenSet(
                access_token=access_token,
                refresh_token=str(document.get("refresh_token") or ""),
                token_type=str(document.get("token_type") or ""),
                scope=str(document.get("scope") or ""),
                id_token=str(document.get("id_token") or ""),
                expires_in=_int_or_zero(document.get("expires_in")),
            )
        # The error body may echo hidden material; only the closed class
        # crosses this boundary. An unrecognized code stays upstream_error so an
        # unknown signal is never upgraded into a client-facing decision.
        error_code = _json_error(body)
        if error_code == TOKEN_ERROR_REAUTH_REQUIRED:
            raise ProviderError(ERROR_REAUTH_REQUIRED, op)
        if error_code == TOKEN_ERROR_TEMPORARILY_UNAVAILABLE:
            raise ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, op)
        if 400 <= status < 500 and error_code in TERMINAL_TOKEN_ERROR_CODES:
            raise ProviderError(ERROR_INVALID_GRANT, op)
        raise ProviderError(ERROR_UPSTREAM, op)

    def _fetch(
        self,
        op: str,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes | None,
    ) -> tuple[int, bytes]:
        if _secure_url(url) is None:
            raise ProviderError(ERROR_UPSTREAM, op)
        try:
            status, _headers, response_body = self._transport(method, url, headers, body)
        except ProviderError:
            raise
        except urllib.error.HTTPError as exc:
            # A surfaced HTTP error (a refused redirect, for instance) is a
            # provider failure, not a transient one.
            raise ProviderError(ERROR_UPSTREAM, op) from exc
        except (TimeoutError, OSError) as exc:
            raise ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, op) from exc
        except Exception as exc:  # any other transport failure fails closed
            raise ProviderError(ERROR_UPSTREAM, op) from exc
        code = int(status) if isinstance(status, int) and not isinstance(status, bool) else 0
        if 300 <= code < 400:
            raise ProviderError(ERROR_UPSTREAM, op)
        if not isinstance(response_body, bytes | bytearray) or len(response_body) > MAX_HTTP_RESPONSE_BYTES:
            raise ProviderError(ERROR_UPSTREAM, op)
        return code, bytes(response_body)


def _default_http_transport(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    *,
    timeout: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    allow_private_hosts: bool = False,
) -> tuple[int, dict[str, str], bytes]:
    """The framework default transport: bounded, redirect-refusing, guarded.

    GET delegates to the framework's own bounded fetch. The POST path reuses the
    same building blocks, so one deadline covers the response head *and* its
    body, the body is capped at 1 MiB, redirects are never followed, and the
    connect step is guarded against non-public addresses unless explicitly
    overridden. The caller validates that the URL is https before reaching here.
    """
    budget = _positive_float(timeout, DEFAULT_HTTP_TIMEOUT_SECONDS)
    verb = str(method or "GET").upper()
    if verb == "GET" and not body:
        return jwks._default_http_get(url, timeout=budget, allow_private_hosts=allow_private_hosts)
    deadline = time.monotonic() + budget
    request = urllib.request.Request(  # noqa: S310 - caller validated https
        url, data=body, method=verb, headers=dict(headers or {})
    )
    opener = urllib.request.build_opener(
        jwks._RefuseRedirectHandler(),
        jwks._GuardedHTTPSHandler(allow_private_hosts=allow_private_hosts),
    )
    try:
        with opener.open(request, timeout=budget) as response:
            payload = jwks._read_body_before(response, deadline)
            response_headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
            return int(response.status), response_headers, payload
    except urllib.error.HTTPError as exc:
        try:
            payload = jwks._read_body_before(exc, deadline)
        except Exception:  # noqa: BLE001 - a failed error-body read is just an empty body
            payload = b""
        finally:
            exc.close()
        return int(exc.code or 0), {}, payload


def _secure_url(raw: Any) -> str | None:
    """Returns the normalized HTTPS URL, or None when it is not usable."""
    if not isinstance(raw, str):
        return None
    return jwks._normalize_secure_url(raw)


def _resolve_override(value: Any) -> str | None:
    """An explicitly configured endpoint override must itself be usable."""
    text = str(value or "").strip()
    if not text:
        return None
    resolved = jwks._normalize_secure_url(text)
    if resolved is None:
        raise ProviderError(ERROR_UPSTREAM, "discovery")
    return resolved


def _forwardable_authorize_hints(hints: dict[str, Any] | None, op: str) -> dict[str, str]:
    """The caller's hints with the reserved-name rule applied.

    A blank name is skipped; a name carrying leading or trailing whitespace is
    refused (the three runtimes previously disagreed about it: Go forwarded the
    untrimmed name as a second query parameter while TypeScript and Python
    collapsed it onto the trimmed one); a non-colliding, already-trimmed name is
    forwarded under its trimmed spelling, so a hint never reaches the upstream as
    a duplicate or an override of a parameter the adapter owns. A name that
    collides, case-insensitively after trimming, with a required or reserved
    authorize parameter is refused with ``invalid_request`` — the required
    parameter is never silently replaced, and the caller is never left believing
    it set something the adapter dropped.
    """
    forwarded: dict[str, str] = {}
    for key, value in (hints or {}).items():
        raw = str(key)
        name = raw.strip()
        if name != raw:
            raise ProviderError(ERROR_INVALID_REQUEST, op)
        if not name:
            continue
        if name.lower() in RESERVED_AUTHORIZE_PARAMETERS:
            raise ProviderError(ERROR_INVALID_REQUEST, op)
        forwarded[name] = str(value)
    return forwarded


def _json_object(payload: bytes) -> dict[str, Any] | None:
    try:
        document = jsonlib.loads(bytes(payload).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _json_error(payload: bytes) -> str:
    document = _json_object(payload)
    if document is None:
        return ""
    return str(document.get("error") or "").strip()


def _authorized_parties(expected: list[str], fallback: list[str]) -> list[str]:
    """The expectation set's own allow-list, or the adapter default."""
    source = expected if expected else fallback
    return [str(party).strip() for party in source or [] if str(party).strip()]


def _authorized_party_from_token(token: str) -> str:
    """The verified token's azp claim, falling back to client_id.

    This only reads claims: the signature was already verified by the caller's
    validator, and the token itself is never mutated. An absent, null, or blank
    azp falls back to client_id, which is how the Go and TypeScript adapters read
    the same token. A present azp that is not a string is a malformed claim
    rather than an absent one, so it is attributed to no party instead of
    standing in as client_id. That is the fail-closed reading, and the one the
    Go adapter's claim decode already takes.
    """
    payload = _decode_payload(token)
    if payload is None:
        return ""
    azp = payload.get("azp")
    if azp is not None and not isinstance(azp, str):
        return ""
    trimmed = azp.strip() if isinstance(azp, str) else ""
    if trimmed:
        return trimmed
    client_id = payload.get("client_id")
    return client_id.strip() if isinstance(client_id, str) else ""


def _int_or_zero(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def _decode_payload(token: str) -> dict[str, Any] | None:
    """Decodes a compact JWS payload *after* verification; never a check."""
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return None
    segment = parts[1]
    if not segment:
        return None
    try:
        decoded = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
        document = jsonlib.loads(decoded.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _positive_float(value: Any, default: float) -> float:
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return default
    return resolved if resolved > 0 else default


__all__ = [
    "AutheoryProvider",
    "AutheoryProviderOptions",
    "new_autheory_provider",
]
