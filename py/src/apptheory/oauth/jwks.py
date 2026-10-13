"""Pure-Python RS256 JWT/JWKS validator with an OIDC discovery bootstrap.

No third-party crypto dependency is used: RSASSA-PKCS1-v1_5 verification is
implemented with integer arithmetic (``pow(signature, e, n)``) plus ``hashlib``.
Every failure path fails closed by raising :class:`OAuthBearerError`.
"""

from __future__ import annotations

import base64
import binascii
import functools
import hashlib
import hmac
import http.client
import ipaddress
import json as jsonlib
import re
import socket
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from apptheory.context import Context
from apptheory.oauth import (
    ERR_BEARER_TOKEN_EXPIRED,
    ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
    ERR_BEARER_TOKEN_INVALID_AUDIENCE,
    ERR_INVALID_BEARER_TOKEN,
    ERR_INVALID_URL,
    BearerTokenClaims,
    BearerTokenClaimsValidator,
    OAuthBearerError,
    canonicalize_issuer_url,
)

HTTPGet = Callable[[str], tuple[int, dict[str, str], bytes]]

MAX_HTTP_RESPONSE_BYTES = 1 << 20
MAX_JWKS_KEYS = 64
HTTP_TIMEOUT_SECONDS = 10
RS256 = "RS256"

# DER DigestInfo prefix for id-sha256: the AlgorithmIdentifier the PKCS#1 v1.5
# EMSA-PKCS1-v1_5 encoding carries ahead of the 32-byte SHA-256 digest.
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_BASE64URL_RE = re.compile(r"[A-Za-z0-9_-]*")

# Framework timing defaults, shared with the Go and TypeScript validators. The
# values are the documented defaults; callers override them explicitly.
_DEFAULT_CACHE_TTL_SECONDS = 900
_DEFAULT_REFRESH_COOLDOWN_SECONDS = 30

# Framework bounds on per-validator state, shared with the Go and TypeScript
# validators. A non-positive option means the framework default.
DEFAULT_MAX_KID_LENGTH = 256
DEFAULT_MAX_WINDOW_ENTRIES = 1024
DEFAULT_MAX_KEY_ENTRIES = 128
DEFAULT_MAX_UNKNOWN_KID_FETCHES = 32
DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS = 60.0

# Explicit RFC 1918 and fc00::/7 membership, rather than ``is_private`` alone:
# from Python 3.13 ``IPv4Address.is_private`` also reports the documentation
# ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, ...), which would make
# this runtime disagree with Go and TypeScript about those addresses.
_PRIVATE_V4_NETWORKS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)
_PRIVATE_V6_NETWORK = ipaddress.IPv6Network("fc00::/7")


def classify_host_address(address: str) -> str:
    """Classifies one IP address literal as one of the shared host classes.

    The refused classes are loopback (``127.0.0.0/8``, ``::1``), link-local
    (``169.254.0.0/16``, ``fe80::/10``), private (``10.0.0.0/8``,
    ``172.16.0.0/12``, ``192.168.0.0/16``, ``fc00::/7``), unspecified
    (``0.0.0.0``, ``::``) and multicast (``224.0.0.0/4``, ``ff00::/8``);
    everything else is ``public``. An IPv4-mapped IPv6 address is classified by
    the IPv4 address it maps to, so ``::ffff:127.0.0.1`` is loopback. Anything
    that is not an address literal is ``invalid``, which is never connectable.
    """
    try:
        parsed = ipaddress.ip_address(str(address or "").strip())
    except ValueError:
        return "invalid"
    mapped = parsed.ipv4_mapped if isinstance(parsed, ipaddress.IPv6Address) else None
    if mapped is not None:
        parsed = mapped
    if parsed.is_loopback:
        return "loopback"
    if parsed.is_link_local:
        return "link_local"
    if _is_private_address(parsed):
        return "private"
    if parsed.is_unspecified:
        return "unspecified"
    if parsed.is_multicast:
        return "multicast"
    return "public"


def _is_private_address(parsed: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(parsed, ipaddress.IPv4Address):
        return any(parsed in network for network in _PRIVATE_V4_NETWORKS)
    return parsed in _PRIVATE_V6_NETWORK


def is_public_host_address(address: str) -> bool:
    """Reports whether one host address literal may be connected to."""
    return classify_host_address(address) == "public"


def _positive_or_default(value: int | None, default: int) -> int:
    if value is None:
        return default
    resolved = int(value)
    return resolved if resolved > 0 else default


def _positive_float_or_default(value: float | None, default: float) -> float:
    if value is None:
        return default
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return default
    return resolved if resolved > 0 else default


@dataclass(slots=True)
class JWKSValidatorOptions:
    issuer: str
    jwks_uri: str = ""
    discovery_url: str = ""
    http_get: HTTPGet | None = None
    # Disables the non-public-host check. Off by default; the framework never
    # enables it. Local development and the loopback test suites opt in.
    allow_private_hosts: bool = False
    # Bounds one discovery or JWKS fetch; the default matches the Go and
    # TypeScript validators. A non-positive value means the framework default,
    # so the three runtimes share one set of timing defaults.
    http_timeout_seconds: float = HTTP_TIMEOUT_SECONDS
    now: Callable[[], datetime] | None = None
    clock_skew_seconds: int = 0
    cache_ttl_seconds: int = 900
    refresh_cooldown_seconds: int = 30
    max_refresh_per_kid: int = 1
    # Bounds on per-validator state, shared with the Go and TypeScript
    # validators. A non-positive value means the framework default.
    max_kid_length: int = DEFAULT_MAX_KID_LENGTH
    max_window_entries: int = DEFAULT_MAX_WINDOW_ENTRIES
    max_key_entries: int = DEFAULT_MAX_KEY_ENTRIES
    max_unknown_kid_fetches: int = DEFAULT_MAX_UNKNOWN_KID_FETCHES
    unknown_kid_fetch_window_seconds: float = DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS
    allowed_azp: list[str] = field(default_factory=list)
    required_audience: str | Callable[[Context], str] | None = None
    required_scopes: list[str] | Callable[[Context], list[str]] | None = None


@dataclass(slots=True)
class _CachedKey:
    n: int
    e: int
    expires_at: datetime


def bootstrap_oidc_discovery(
    discovery_url: str,
    issuer: str,
    http_get: HTTPGet | None = None,
    *,
    timeout_seconds: float = HTTP_TIMEOUT_SECONDS,
) -> str:
    """Fetches an OIDC discovery document and returns its verified ``jwks_uri``.

    The fetch requires HTTPS, refuses any surfaced redirect, verifies the
    document's ``issuer`` equals the configured issuer (canonicalized), and
    requires a non-empty HTTPS ``jwks_uri``. Every failure fails closed. When no
    ``http_get`` is injected, the default transport is bounded by
    ``timeout_seconds``.
    """
    expected_issuer = canonicalize_issuer_url(issuer)
    if expected_issuer is None:
        raise OAuthBearerError(ERR_INVALID_URL, "configured issuer must be an absolute url")
    url = _normalize_secure_url(discovery_url)
    if url is None:
        raise OAuthBearerError(ERR_INVALID_URL, "discovery url must be an https absolute url")
    transport = http_get or functools.partial(
        _default_http_get,
        timeout=_positive_float_or_default(timeout_seconds, HTTP_TIMEOUT_SECONDS),
    )
    document = _http_get_document(transport, url)
    document_issuer = canonicalize_issuer_url(str(document.get("issuer") or ""))
    if document_issuer is None or document_issuer != expected_issuer:
        raise OAuthBearerError(ERR_INVALID_URL, "discovery issuer mismatch")
    raw_jwks_uri = document.get("jwks_uri")
    jwks_uri = _normalize_secure_url(raw_jwks_uri) if isinstance(raw_jwks_uri, str) else None
    if not isinstance(raw_jwks_uri, str) or not raw_jwks_uri.strip():
        raise OAuthBearerError(ERR_INVALID_URL, "discovery document is missing jwks_uri")
    if jwks_uri is None:
        raise OAuthBearerError(ERR_INVALID_URL, "jwks_uri must be an https absolute url")
    return jwks_uri


def new_jwks_validator(options: JWKSValidatorOptions) -> BearerTokenClaimsValidator:
    """Builds a route-aware RS256 bearer validator backed by a bounded JWKS cache.

    When ``jwks_uri`` is empty the OIDC discovery document at ``discovery_url``
    is fetched lazily on the first validation and its ``jwks_uri`` is trusted
    only after its issuer has been verified.
    """
    issuer = canonicalize_issuer_url(options.issuer)
    if issuer is None:
        raise ValueError(f"{ERR_INVALID_URL}: issuer must be an absolute URL")
    jwks_uri = str(_normalize_secure_url(options.jwks_uri) or "") if str(options.jwks_uri or "").strip() else ""
    discovery_url = (
        str(_normalize_secure_url(options.discovery_url) or "") if str(options.discovery_url or "").strip() else ""
    )
    if not jwks_uri and not discovery_url:
        raise ValueError(f"{ERR_INVALID_URL}: jwks_uri or discovery_url is required")
    if str(options.jwks_uri or "").strip() and not jwks_uri:
        raise ValueError(f"{ERR_INVALID_URL}: jwks_uri must be an https absolute URL")
    if str(options.discovery_url or "").strip() and not discovery_url:
        raise ValueError(f"{ERR_INVALID_URL}: discovery_url must be an https absolute URL")
    allowed_azp = {str(value).strip() for value in options.allowed_azp or [] if str(value).strip()}
    return _JWKSValidator(options, issuer, jwks_uri, discovery_url, allowed_azp).validate


class _JWKSValidator:
    def __init__(
        self,
        options: JWKSValidatorOptions,
        issuer: str,
        jwks_uri: str,
        discovery_url: str,
        allowed_azp: set[str],
    ) -> None:
        self._options = options
        self._issuer = issuer
        self._discovery_url = discovery_url
        self._allowed_azp = allowed_azp
        # An explicitly injected transport is caller-owned and is not re-timed
        # and never re-plumbed with the non-public-host guard; only the
        # framework default transport is bound to the configured timeout and
        # carries the guard. The documented override drops the guard by
        # switching the transport back to the stock connection class.
        self._http_get = options.http_get or functools.partial(
            _default_http_get,
            timeout=_positive_float_or_default(options.http_timeout_seconds, HTTP_TIMEOUT_SECONDS),
            allow_private_hosts=options.allow_private_hosts is True,
        )
        self._now = options.now or _utc_now
        self._skew = max(0, int(options.clock_skew_seconds or 0))
        # Non-positive values mean "use the framework default", matching Go and
        # TypeScript, so the three runtimes share one set of timing defaults.
        self._ttl_seconds = _positive_or_default(options.cache_ttl_seconds, _DEFAULT_CACHE_TTL_SECONDS)
        self._cooldown = timedelta(
            seconds=_positive_or_default(options.refresh_cooldown_seconds, _DEFAULT_REFRESH_COOLDOWN_SECONDS)
        )
        self._max_refresh_per_kid = _positive_or_default(options.max_refresh_per_kid, 1)
        self._max_kid_length = _positive_or_default(options.max_kid_length, DEFAULT_MAX_KID_LENGTH)
        self._max_window_entries = _positive_or_default(options.max_window_entries, DEFAULT_MAX_WINDOW_ENTRIES)
        self._max_key_entries = _positive_or_default(options.max_key_entries, DEFAULT_MAX_KEY_ENTRIES)
        self._max_unknown_kid_fetches = _positive_or_default(
            options.max_unknown_kid_fetches, DEFAULT_MAX_UNKNOWN_KID_FETCHES
        )
        self._fetch_window = timedelta(
            seconds=_positive_float_or_default(
                options.unknown_kid_fetch_window_seconds, DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS
            )
        )
        self._jwks_uri = jwks_uri
        self._keys: dict[str, _CachedKey] = {}
        self._windows: dict[str, datetime] = {}
        self._fetch_window_start: datetime | None = None
        self._fetch_budget_used = 0

    def validate(self, ctx: Context, token: str) -> BearerTokenClaims:
        header, claims, signing_input, signature = _parse_compact_jws(token)
        _require_rs256(header)
        kid = _require_kid(header)
        # The issuer is checked before the key lookup so a token for another
        # issuer can never steer a fetch, and again after verification so
        # nothing observed before the signature is what authorizes the request.
        _require_issuer(claims, self._issuer)
        now = _as_utc(self._now())
        key = self._key_for(kid, now)
        if key is None:
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
        if not _rsa_pkcs1_v15_sha256_verify(signing_input, signature, key.n, key.e):
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
        _require_issuer(claims, self._issuer)
        expires_at = _require_time_claims(claims, now, self._skew)
        audience = _require_audience(claims, _resolve_required_audience(self._options, ctx))
        _require_scopes(claims, _resolve_required_scopes(self._options, ctx))
        _require_authorized_party(claims, self._allowed_azp)
        return BearerTokenClaims(
            subject=str(claims.get("sub") or "").strip(),
            audience=audience,
            scopes=_claimed_scopes(claims),
            expires_at=expires_at,
        )

    def _take_fetch_budget(self, now: datetime) -> bool:
        """Consumes one unit of the global unknown-kid fetch budget.

        The window reopens once the configured window has elapsed since it
        opened; an exhausted budget refuses the fetch so a stream of distinct
        attacker-chosen kids cannot amplify token traffic into unbounded
        key-set traffic.
        """
        if self._fetch_window_start is None or now - self._fetch_window_start >= self._fetch_window:
            self._fetch_window_start = now
            self._fetch_budget_used = 0
        if self._fetch_budget_used >= self._max_unknown_kid_fetches:
            return False
        self._fetch_budget_used += 1
        return True

    def _refresh(self, now: datetime) -> bool:
        # Returns False when the global unknown-kid fetch budget refuses the
        # fetch; the caller then fails closed as an unknown key.
        if not self._take_fetch_budget(now):
            return False
        if not self._jwks_uri:
            self._jwks_uri = bootstrap_oidc_discovery(self._discovery_url, self._issuer, self._http_get)
        document = _http_get_document(self._http_get, self._jwks_uri)
        entries = document.get("keys")
        if not isinstance(entries, list) or not entries:
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "jwks document has no keys")
        if len(entries) > MAX_JWKS_KEYS:
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "jwks document has too many keys")
        expires_at = now + timedelta(seconds=self._ttl_seconds)
        refreshed: dict[str, _CachedKey] = {}
        for entry in entries:
            parsed = _parse_jwk(entry)
            if parsed is None:
                continue
            kid, modulus, exponent = parsed
            if len(kid) > self._max_kid_length:
                continue
            if kid in refreshed:
                continue
            refreshed[kid] = _CachedKey(n=modulus, e=exponent, expires_at=expires_at)
        for kid, entry in refreshed.items():
            # Re-store at the tail so every refresh orders the cache by the
            # document's key order, which keeps eviction deterministic.
            self._keys.pop(kid, None)
            self._keys[kid] = entry
        self._prune_keys(now)
        return True

    def _prune_keys(self, now: datetime) -> None:
        """Drops cache entries whose expiry has passed, then evicts the
        earliest-expiring entries until the cache holds at most
        ``max_key_entries`` entries."""
        for kid in [key for key, entry in self._keys.items() if now >= entry.expires_at]:
            del self._keys[kid]
        while len(self._keys) > self._max_key_entries:
            oldest = min(self._keys, key=lambda key: self._keys[key].expires_at)
            del self._keys[oldest]

    def _record_window(self, kid: str, now: datetime) -> None:
        """Records a kid's resolution window.

        Entries older than the refresh cooldown are dropped, and a full map
        evicts its oldest entry first, so the map never holds more than
        ``max_window_entries`` entries however many distinct attacker-chosen
        kids arrive.
        """
        for existing in [key for key, started_at in self._windows.items() if now - started_at >= self._cooldown]:
            del self._windows[existing]
        if len(self._windows) >= self._max_window_entries:
            oldest = min(self._windows, key=lambda key: self._windows[key])
            del self._windows[oldest]
        self._windows[kid] = now

    def _key_for(self, kid: str, now: datetime) -> _CachedKey | None:
        # A kid longer than max_kid_length is refused as unknown without
        # touching any map and without a fetch. An unknown kid opens one
        # resolution window per refresh cooldown: the first fetch populates the
        # cache and up to max_refresh_per_kid further fetches absorb key
        # publication lag. Every further unknown-kid token inside the cooldown
        # is rejected without another fetch, and the global unknown-kid fetch
        # budget caps the fetches distinct kids can trigger, so token traffic
        # cannot be amplified into key-set traffic.
        if len(kid) > self._max_kid_length:
            return None
        key = self._cached_key(kid, now)
        if key is not None:
            return key
        started_at = self._windows.get(kid)
        if started_at is not None and now - started_at < self._cooldown:
            return None
        self._record_window(kid, now)
        for _ in range(self._max_refresh_per_kid + 1):
            if not self._refresh(now):
                return None
            key = self._cached_key(kid, now)
            if key is not None:
                return key
        return None

    def _cached_key(self, kid: str, now: datetime) -> _CachedKey | None:
        entry = self._keys.get(kid)
        if entry is not None and now < entry.expires_at:
            return entry
        return None


def _rsa_pkcs1_v15_sha256_verify(message: bytes, signature: bytes, n: int, e: int) -> bool:
    """RSASSA-PKCS1-v1_5 (RFC 8017 §8.2.2) verification for SHA-256.

    Rebuilds the expected encoded message and compares it in constant time.
    """
    if n <= 0 or e <= 1:
        return False
    key_size = (n.bit_length() + 7) // 8
    digest_info = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(bytes(message)).digest()
    padding_size = key_size - len(digest_info) - 3
    if padding_size < 8 or len(signature) != key_size:
        return False
    signature_int = int.from_bytes(bytes(signature), "big")
    if signature_int >= n:
        return False
    encoded = pow(signature_int, e, n).to_bytes(key_size, "big")
    expected = b"\x00\x01" + (b"\xff" * padding_size) + b"\x00" + digest_info
    return hmac.compare_digest(encoded, expected)


def _parse_compact_jws(token: str) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes]:
    parts = str(token or "").strip().split(".")
    if len(parts) != 3:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    header_segment, payload_segment, signature_segment = parts
    if not header_segment or not payload_segment:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    try:
        header = _decode_json_object(header_segment)
        claims = _decode_json_object(payload_segment)
        signature = _b64url_decode(signature_segment)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN) from None
    # An unrecognized critical header must fail closed rather than be ignored.
    if header.get("crit") is not None:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    return header, claims, f"{header_segment}.{payload_segment}".encode("ascii"), signature


def _decode_json_object(segment: str) -> dict[str, Any]:
    decoded = jsonlib.loads(_b64url_decode(segment).decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("expected a JSON object")
    return decoded


def _require_rs256(header: dict[str, Any]) -> None:
    if header.get("alg") != RS256:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)


def _require_kid(header: dict[str, Any]) -> str:
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid.strip():
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    return kid.strip()


def _require_issuer(claims: dict[str, Any], expected_issuer: str) -> None:
    token_issuer = canonicalize_issuer_url(str(claims.get("iss") or ""))
    if token_issuer is None or token_issuer != expected_issuer:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)


def _require_time_claims(claims: dict[str, Any], now: datetime, skew: int) -> datetime:
    now_seconds = now.timestamp()
    exp = _numeric_date(claims.get("exp"))
    if exp is None:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    if now_seconds >= exp + skew:
        raise OAuthBearerError(ERR_BEARER_TOKEN_EXPIRED)
    nbf = _numeric_date(claims.get("nbf"))
    if nbf is not None and now_seconds + skew < nbf:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)
    return datetime.fromtimestamp(exp, tz=UTC)


def _require_authorized_party(claims: dict[str, Any], allowed_azp: set[str]) -> None:
    if not allowed_azp:
        return
    value = claims.get("azp")
    if not isinstance(value, str) or not value.strip():
        value = claims.get("client_id")
    trimmed = value.strip() if isinstance(value, str) else ""
    if not trimmed or trimmed not in allowed_azp:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN)


def _require_audience(claims: dict[str, Any], required: str) -> str:
    values = _claimed_audiences(claims)
    if required:
        if required not in values:
            raise OAuthBearerError(ERR_BEARER_TOKEN_INVALID_AUDIENCE)
        return required
    return values[0] if values else ""


def _require_scopes(claims: dict[str, Any], required: list[str]) -> None:
    if any(scope not in _claimed_scopes(claims) for scope in required):
        raise OAuthBearerError(ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE)


def _claimed_audiences(claims: dict[str, Any]) -> list[str]:
    claim = claims.get("aud")
    if isinstance(claim, str):
        return [claim.strip()] if claim.strip() else []
    if isinstance(claim, list):
        return [value.strip() for value in claim if isinstance(value, str) and value.strip()]
    return []


def _claimed_scopes(claims: dict[str, Any]) -> list[str]:
    scopes: list[str] = []
    seen: set[str] = set()
    for source in (claims.get("scope"), claims.get("scp")):
        raw = [source] if isinstance(source, str) else source if isinstance(source, list) else []
        for value in raw:
            if not isinstance(value, str):
                continue
            for scope in value.split():
                if scope not in seen:
                    seen.add(scope)
                    scopes.append(scope)
    return scopes


def _resolve_required_audience(options: JWKSValidatorOptions, ctx: Context) -> str:
    configured = options.required_audience
    if configured is None:
        return ""
    if isinstance(configured, str):
        return configured.strip()
    return str(configured(ctx) or "").strip()


def _resolve_required_scopes(options: JWKSValidatorOptions, ctx: Context) -> list[str]:
    configured = options.required_scopes
    if configured is None:
        return []
    values = configured if isinstance(configured, list) else configured(ctx)
    return [str(scope).strip() for scope in values or [] if str(scope).strip()]


def _parse_jwk(entry: Any) -> tuple[str, int, int] | None:
    if not isinstance(entry, dict) or str(entry.get("kty") or "").strip().upper() != "RSA":
        return None
    use = str(entry.get("use") or "").strip()
    if use and use.lower() != "sig":
        return None
    alg = str(entry.get("alg") or "").strip()
    if alg and alg != RS256:
        return None
    kid = str(entry.get("kid") or "").strip()
    if not kid:
        return None
    modulus_raw = entry.get("n")
    exponent_raw = entry.get("e")
    if not isinstance(modulus_raw, str) or not isinstance(exponent_raw, str):
        return None
    try:
        modulus_bytes = _b64url_decode(modulus_raw)
        exponent_bytes = _b64url_decode(exponent_raw)
    except (binascii.Error, ValueError):
        return None
    modulus = int.from_bytes(modulus_bytes, "big")
    exponent = int.from_bytes(exponent_bytes, "big")
    if not modulus_bytes or not 3 <= exponent <= 0x7FFFFFFF:
        return None
    return kid, modulus, exponent


def _b64url_decode(segment: str) -> bytes:
    text = str(segment or "")
    if not _BASE64URL_RE.fullmatch(text):
        raise ValueError("segment is not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _numeric_date(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _http_get_document(http_get: HTTPGet, url: str) -> dict[str, Any]:
    status, _headers, body = _http_get_bytes(http_get, url)
    if status != 200:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, f"unexpected http status {status}")
    try:
        document = jsonlib.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "invalid json document") from None
    if not isinstance(document, dict):
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "invalid json document")
    return document


def _http_get_bytes(http_get: HTTPGet, url: str) -> tuple[int, dict[str, str], bytes]:
    if _normalize_secure_url(url) is None:
        raise OAuthBearerError(ERR_INVALID_URL, "endpoint must be an https absolute url")
    try:
        status, headers, body = http_get(url)
    except OAuthBearerError:
        raise
    except Exception as exc:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "endpoint fetch failed") from exc
    code = int(status) if isinstance(status, int) and not isinstance(status, bool) else 0
    if 300 <= code < 400:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "redirect refused")
    if not isinstance(body, bytes | bytearray) or len(body) > MAX_HTTP_RESPONSE_BYTES:
        raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "endpoint response is unusable")
    return code, dict(headers or {}), bytes(body)


def _default_http_get(
    url: str, timeout: float = HTTP_TIMEOUT_SECONDS, *, allow_private_hosts: bool = False
) -> tuple[int, dict[str, str], bytes]:
    # The caller validates that the URL is https before reaching this transport.
    request = urllib.request.Request(url, method="GET", headers={"accept": "application/json"})  # noqa: S310
    opener = urllib.request.build_opener(
        _RefuseRedirectHandler(),
        _GuardedHTTPSHandler(allow_private_hosts=allow_private_hosts),
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_HTTP_RESPONSE_BYTES + 1)
            headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
            return int(response.status), headers, body
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read(MAX_HTTP_RESPONSE_BYTES + 1)
        except Exception:  # noqa: BLE001
            body = b""
        return int(exc.code or 0), {}, body


class _RefuseRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never follows a redirect: the surfaced 3xx fails closed upstream."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


_AddressInfo = tuple[int, int, int, str, tuple[str, int] | tuple[str, int, int, int]]


def _public_addresses(host: str, port: int | None) -> list[_AddressInfo]:
    """Resolves ``host`` and keeps only the addresses that are public."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info for info in infos if is_public_host_address(str(info[4][0]))]


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection that only ever dials a public address.

    Resolving the name, classifying every address it resolves to, and opening
    the socket are one step, so there is no window in which a name could
    resolve to a public address for the check and to a non-public one for the
    connection. The certificate is still verified against the URL's host name,
    because ``server_hostname`` is the host, not the address connected to.
    """

    def connect(self) -> None:  # type: ignore[override]
        addresses = _public_addresses(self.host, self.port)
        if not addresses:
            raise OAuthBearerError(ERR_INVALID_BEARER_TOKEN, "endpoint host is not a public address")
        last_error: OSError | None = None
        sock: socket.socket | None = None
        for family, socktype, proto, _canonical, sockaddr in addresses:
            candidate = socket.socket(family, socktype, proto)
            try:
                if isinstance(self.timeout, int | float):
                    candidate.settimeout(self.timeout)
                if self.source_address:
                    candidate.bind(self.source_address)
                candidate.connect(sockaddr)
            except OSError as exc:
                candidate.close()
                last_error = exc
                continue
            sock = candidate
            break
        if sock is None:
            raise last_error or OSError(f"connection to {self.host!r} failed")
        self.sock = sock
        if self._tunnel_host:
            self._tunnel()
            server_hostname = self._tunnel_host
        else:
            server_hostname = self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    """An HTTPS handler whose connections refuse non-public addresses.

    ``allow_private_hosts`` switches the handler back to the stock connection
    class, so the framework's documented override drops the guard instead of
    re-plumbing an injected transport.
    """

    def __init__(self, *, allow_private_hosts: bool = False, context: Any = None, check_hostname: bool | None = None):
        super().__init__(context=context, check_hostname=check_hostname)
        self._allow_private_hosts = allow_private_hosts

    def https_open(self, req):  # type: ignore[override]
        connection = http.client.HTTPSConnection if self._allow_private_hosts else _GuardedHTTPSConnection
        return self.do_open(connection, req, context=self._context)


def _normalize_secure_url(raw: str) -> str | None:
    """Returns the normalized HTTPS URL, or None when it is not a usable one."""
    parsed = urlparse(str(raw or "").strip())
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return None
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        return None
    return parsed._replace(scheme="https", fragment="").geturl()


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _utc_now() -> datetime:
    return datetime.now(UTC)


__all__ = [
    "JWKSValidatorOptions",
    "bootstrap_oidc_discovery",
    "new_jwks_validator",
]
