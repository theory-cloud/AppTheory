"""Test-support fake upstream OAuth provider for the MCP auth facade.

Dependency-free: a real loopback HTTP server (stdlib ``http.server``) plus pure
Python RSA. It signs real RS256 compact JWS access tokens with ``pow(...)``, so
the adapter's validator exercises a genuine signature path rather than a stub.

TEST SUPPORT ONLY. Nothing here is imported by the runtime, no key material is
committed, and the generated keys are throwaway in-process values.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import http.server
import json
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from apptheory.oauth.provider import (
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

DEFAULT_ISSUER = "https://auth.example.test"
DISCOVERY_PATH = "/.well-known/oauth-authorization-server"
JWKS_PATH = "/.well-known/jwks.json"
TOKEN_PATH = "/token"  # noqa: S105 - a URL route, not a credential
AUTHORIZE_PATH = "/oauth/authorize"
REGISTER_PATH = "/register"

_SMALL_PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_CHUNK_BYTES = 64 * 1024

# Pure-Python key generation is the slow part of the fake; one throwaway key per
# bit size is enough for a test run, so every fake instance shares it.
_KEY_CACHE: dict[int, tuple[int, int, int]] = {}
_KEY_LOCK = threading.Lock()


def shared_rsa_key(bits: int = 2048) -> tuple[int, int, int]:
    """Returns a cached throwaway RSA key for ``bits`` (generated on first use)."""
    with _KEY_LOCK:
        if bits not in _KEY_CACHE:
            _KEY_CACHE[bits] = generate_rsa_key(bits)
        return _KEY_CACHE[bits]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def is_probable_prime(value: int) -> bool:
    if value < 2:
        return False
    for prime in _SMALL_PRIMES:
        if value % prime == 0:
            return value == prime
    remaining = value - 1
    rounds = 0
    while remaining % 2 == 0:
        remaining //= 2
        rounds += 1
    for _ in range(32):
        witness = pow(secrets.randbelow(value - 3) + 2, remaining, value)
        if witness in (1, value - 1):
            continue
        for _ in range(rounds - 1):
            witness = witness * witness % value
            if witness == value - 1:
                break
        else:
            return False
    return True


def generate_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if is_probable_prime(candidate):
            return candidate


def generate_rsa_key(bits: int = 2048) -> tuple[int, int, int]:
    """Generates a throwaway RSA key: ``(modulus, exponent, private_exponent)``."""
    exponent = 65537
    while True:
        prime_one = generate_prime(bits // 2)
        prime_two = generate_prime(bits // 2)
        if prime_one == prime_two:
            continue
        modulus = prime_one * prime_two
        if modulus.bit_length() != bits:
            continue
        phi = (prime_one - 1) * (prime_two - 1)
        if phi % exponent == 0:
            continue
        return modulus, exponent, pow(exponent, -1, phi)


def sign_rs256(message: bytes, key: tuple[int, int, int]) -> bytes:
    """RSASSA-PKCS1-v1_5 SHA-256 signing (RFC 8017 §8.2.1) via ``pow``."""
    modulus, _exponent, private_exponent = key
    key_size = (modulus.bit_length() + 7) // 8
    digest_info = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(bytes(message)).digest()
    encoded = b"\x00\x01" + b"\xff" * (key_size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(encoded, "big"), private_exponent, modulus).to_bytes(key_size, "big")


def jwk_entry(kid: str, key: tuple[int, int, int]) -> dict[str, str]:
    modulus, exponent, _private = key
    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": b64url(modulus.to_bytes((modulus.bit_length() + 7) // 8, "big")),
        "e": b64url(exponent.to_bytes((exponent.bit_length() + 7) // 8, "big")),
    }


class _FakeUpstreamHandler(http.server.BaseHTTPRequestHandler):
    """Serves discovery, JWKS, and ``/token`` for the owning fake provider."""

    protocol_version = "HTTP/1.1"

    @property
    def provider(self) -> FakeUpstreamProvider:
        return self.server.provider  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        provider = self.provider
        provider.request_count += 1
        path = urlsplit(self.path).path
        if path == DISCOVERY_PATH:
            if provider.redirect_to:
                self._send(302, b"", {"location": provider.redirect_to})
                return
            self._send_json(200, provider.discovery_document())
            return
        if path == JWKS_PATH:
            self._send_json(200, provider.jwks_document())
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        provider = self.provider
        provider.request_count += 1
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        if urlsplit(self.path).path != TOKEN_PATH:
            self._send_json(404, {"error": "not_found"})
            return
        form = dict(parse_qsl(raw.decode("utf-8", "replace"), keep_blank_values=True))
        provider.last_token_form = form
        provider.last_client_id = form.get("client_id", "")
        provider.token_calls += 1
        if provider.token_delay_seconds > 0:
            time.sleep(provider.token_delay_seconds)
        if provider.token_body_bytes > 0:
            self._send_stream(provider.token_status, provider.token_body_bytes)
            return
        if provider.token_body_padding_bytes > 0:
            self._send_json(
                provider.token_status,
                {
                    "access_token": "a" * provider.token_body_padding_bytes,
                    "token_type": "Bearer",
                    "expires_in": 900,
                },
            )
            return
        payload = provider.token_body
        if payload is None:
            payload = {"access_token": "fake-access-token", "token_type": "Bearer", "expires_in": 900}
        self._send_json(provider.token_status, payload)

    def log_message(self, *args: Any) -> None:
        return

    def _send_json(self, status: int, document: dict[str, Any]) -> None:
        body = json.dumps(document, separators=(",", ":")).encode("utf-8")
        self._send(status, body, {"content-type": "application/json"})

    def _send_stream(self, status: int, size: int) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(size))
        self.end_headers()
        chunk = b"x" * _CHUNK_BYTES
        remaining = size
        try:
            while remaining > 0:
                piece = chunk[: min(_CHUNK_BYTES, remaining)]
                self.wfile.write(piece)
                remaining -= len(piece)
            self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True

    def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            if body:
                self.wfile.write(body)
                self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True


class FakeUpstreamProvider:
    """A real loopback upstream serving discovery, JWKS, and ``/token``."""

    def __init__(
        self,
        *,
        issuer: str = DEFAULT_ISSUER,
        discovery_issuer: str | None = None,
        redirect_to: str = "",
        token_status: int = 200,
        token_body: dict[str, Any] | None = None,
        token_body_bytes: int = 0,
        token_body_padding_bytes: int = 0,
        token_delay_seconds: float = 0.0,
        kid: str = "fake-rs256-1",
        key_bits: int = 2048,
        key: tuple[int, int, int] | None = None,
    ) -> None:
        self.issuer = str(issuer).rstrip("/")
        self.discovery_issuer = str(discovery_issuer).rstrip("/") if discovery_issuer else self.issuer
        self.redirect_to = str(redirect_to or "")
        self.token_status = int(token_status)
        self.token_body = token_body
        self.token_body_bytes = int(token_body_bytes)
        self.token_body_padding_bytes = int(token_body_padding_bytes)
        self.token_delay_seconds = float(token_delay_seconds)
        self.kid = kid
        self.key = key if key is not None else shared_rsa_key(key_bits)

        self.request_count = 0
        self.token_calls = 0
        self.last_token_form: dict[str, str] = {}
        self.last_client_id = ""

        self._server: http.server.ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- endpoints -----------------------------------------------------------

    @property
    def authorization_endpoint(self) -> str:
        return self.issuer + AUTHORIZE_PATH

    @property
    def token_endpoint(self) -> str:
        return self.issuer + TOKEN_PATH

    @property
    def jwks_uri(self) -> str:
        return self.issuer + JWKS_PATH

    @property
    def registration_endpoint(self) -> str:
        return self.issuer + REGISTER_PATH

    def discovery_document(self) -> dict[str, Any]:
        return {
            "issuer": self.discovery_issuer,
            "authorization_endpoint": self.authorization_endpoint,
            "token_endpoint": self.token_endpoint,
            "jwks_uri": self.jwks_uri,
            "registration_endpoint": self.registration_endpoint,
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "authorization_response_iss_parameter_supported": True,
            "resource_parameter_supported": True,
        }

    def jwks_document(self) -> dict[str, Any]:
        return {"keys": [jwk_entry(self.kid, self.key)]}

    # -- tokens --------------------------------------------------------------

    def mint_access_token(
        self,
        *,
        issuer: str | None = None,
        audience: str,
        authorized_party: str = "",
        subject: str = "user-1",
        scope: str = "",
        expires_in: int = 900,
        issued_at: float | None = None,
        extra: dict[str, Any] | None = None,
        tamper_signature: bool = False,
    ) -> str:
        claims: dict[str, Any] = {
            "iss": issuer or self.discovery_issuer,
            "aud": audience,
            "sub": subject,
            "scope": scope,
            "iat": int(issued_at if issued_at is not None else time.time()),
        }
        if authorized_party:
            claims["azp"] = authorized_party
        claims["exp"] = claims["iat"] + int(expires_in)
        claims.update(extra or {})
        header = {"alg": "RS256", "kid": self.kid}
        header_segment = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        payload_segment = b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
        signature = sign_rs256(f"{header_segment}.{payload_segment}".encode("ascii"), self.key)
        if tamper_signature:
            flipped = bytearray(signature)
            flipped[len(flipped) // 2] ^= 0x40
            signature = bytes(flipped)
        return f"{header_segment}.{payload_segment}.{b64url(signature)}"

    # -- server lifecycle ----------------------------------------------------

    def start(self) -> FakeUpstreamProvider:
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeUpstreamHandler)
        self._server.daemon_threads = True
        # A handler may still be sleeping (the slow-upstream row); the server
        # must not wait for it on close, and the serve loop must poll promptly.
        self._server.block_on_close = False
        self._server.provider = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()
        return self

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("fake upstream is not running")
        return int(self._server.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def localize(self, url: str) -> str:
        """Rewrites a URL's origin to this loopback server, preserving path/query."""
        parsed = urlsplit(url)
        base = urlsplit(self.base_url)
        return urlunsplit((base.scheme, base.netloc, parsed.path, parsed.query, parsed.fragment))

    def stop(self) -> None:
        if self._server is not None:
            with contextlib.suppress(OSError):
                self._server.shutdown()
            with contextlib.suppress(OSError):
                self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._server = None
        self._thread = None

    def __enter__(self) -> FakeUpstreamProvider:
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.stop()


@dataclass(slots=True)
class StaticTestProviderOptions:
    """Options for the provider-neutrality adapter."""

    issuer: str = "https://second-provider.example.test"
    client_id: str = "second-facade-client"


@dataclass(slots=True)
class StaticTestProvider:
    """A tiny second adapter that implements the same SPI.

    It proves provider-neutrality: the facade's SPI is not shaped around
    Autheory. It performs no network I/O and serves discovery from constants.
    """

    options: StaticTestProviderOptions = field(default_factory=StaticTestProviderOptions)

    def discovery(self) -> ProviderMetadata:
        issuer = str(self.options.issuer or "").rstrip("/")
        return ProviderMetadata(
            issuer=issuer,
            authorization_endpoint=f"{issuer}/oauth/authorize",
            token_endpoint=f"{issuer}/token",
            jwks_uri=f"{issuer}/.well-known/jwks.json",
            code_challenge_methods_supported=["S256"],
            authorization_response_iss_parameter_supported=True,
            resource_parameter_supported=True,
        )

    def authorization_url(self, req: AuthorizationRequest) -> str:
        raise ProviderError(ERROR_UPSTREAM, "authorization_url")

    def exchange_code(self, req: CodeExchangeRequest) -> TokenSet:
        raise ProviderError(ERROR_UPSTREAM, "exchange_code")

    def refresh(self, req: RefreshRequest) -> TokenSet:
        raise ProviderError(ERROR_UPSTREAM, "refresh")

    def validate_access_token(self, token: str, expected: TokenExpectations) -> TokenClaims:
        raise ProviderError(ERROR_UPSTREAM, "validate_access_token")


def new_static_test_provider(
    options: StaticTestProviderOptions | None = None,
) -> StaticTestProvider:
    return StaticTestProvider(options or StaticTestProviderOptions())


__all__ = [
    "FakeUpstreamProvider",
    "StaticTestProvider",
    "StaticTestProviderOptions",
    "b64url",
    "generate_rsa_key",
    "jwk_entry",
    "new_static_test_provider",
    "shared_rsa_key",
    "sign_rs256",
]
