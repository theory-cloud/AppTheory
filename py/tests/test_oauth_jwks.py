from __future__ import annotations

import base64
import contextlib
import datetime as dt
import hashlib
import hmac
import inspect
import json
import secrets
import socket
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from apptheory import (
    ERR_BEARER_TOKEN_EXPIRED,
    ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
    ERR_BEARER_TOKEN_INVALID_AUDIENCE,
    ERR_INVALID_BEARER_TOKEN,
    ERR_INVALID_URL,
    JWKSValidatorOptions,
    OAuthBearerError,
    bootstrap_oidc_discovery,
    canonical_resource_url,
    new_jwks_validator,
    protected_resource_www_authenticate,
    resource_indicator_matches,
    resource_metadata_url_from_mcp_endpoint,
)
from apptheory.context import Context
from apptheory.oauth import jwks
from apptheory.oauth.jwks import _rsa_pkcs1_v15_sha256_verify
from apptheory.request import Request

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"

ISSUER = "https://auth.example.test"
JWKS_URI = "https://auth.example.test/.well-known/jwks.json"
DISCOVERY_URL = "https://auth.example.test/.well-known/openid-configuration"
AUDIENCE = "https://mcp.example.com/acme/mcp"
NOW = dt.datetime(2026, 10, 12, 12, 0, 0, tzinfo=dt.UTC)
CACHE_TTL_SECONDS = 60
REFRESH_COOLDOWN_SECONDS = 1

# RFC 7515 Appendix A.2 example key (public members only) and JWS. Published
# test vector, not a secret; it pins the RSASSA-PKCS1-v1_5 encoding exactly.
RFC7515_A2_MODULUS = (
    "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgN"
    "MsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtd"
    "VMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ"
)
RFC7515_A2_SIGNATURE = (
    "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZ"
    "cAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-e"
    "OkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw"
)
RFC7515_A2_SIGNING_INPUT = (
    b"eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFt"
    b"cGxlLmNvbS9pc19yb290Ijp0cnVlfQ"
)

_KEY_CACHE: dict[str, tuple[int, int, int]] = {}
_SMALL_PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)

_JWKS_REASON_CODES = {
    "algorithm_not_allowed": ERR_INVALID_BEARER_TOKEN,
    "issuer_mismatch": ERR_INVALID_BEARER_TOKEN,
    "audience_mismatch": ERR_BEARER_TOKEN_INVALID_AUDIENCE,
    "expired": ERR_BEARER_TOKEN_EXPIRED,
    "unknown_kid": ERR_INVALID_BEARER_TOKEN,
}

_DISCOVERY_REASON_CODES = {
    "issuer_mismatch": ERR_INVALID_URL,
    "non_https": ERR_INVALID_URL,
    "cross_origin_redirect": ERR_INVALID_BEARER_TOKEN,
    "missing_jwks_uri": ERR_INVALID_URL,
}


def _load_fixture(name: str) -> dict[str, Any]:
    with (FIXTURE_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _test_key(name: str, bits: int = 1024) -> tuple[int, int, int]:
    if name not in _KEY_CACHE:
        _KEY_CACHE[name] = _generate_rsa_key(bits)
    return _KEY_CACHE[name]


def _is_probable_prime(value: int) -> bool:
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


def _generate_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if _is_probable_prime(candidate):
            return candidate


def _generate_rsa_key(bits: int = 1024) -> tuple[int, int, int]:
    """Generates a throwaway RSA key in-test; no key material is committed."""
    exponent = 65537
    while True:
        prime_one = _generate_prime(bits // 2)
        prime_two = _generate_prime(bits // 2)
        if prime_one == prime_two:
            continue
        modulus = prime_one * prime_two
        if modulus.bit_length() != bits:
            continue
        phi = (prime_one - 1) * (prime_two - 1)
        if phi % exponent == 0:
            continue
        return modulus, exponent, pow(exponent, -1, phi)


def _sign_rs256(signing_input: bytes, key: tuple[int, int, int]) -> bytes:
    modulus, _exponent, private_exponent = key
    key_size = (modulus.bit_length() + 7) // 8
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(signing_input).digest()
    encoded = b"\x00\x01" + b"\xff" * (key_size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(encoded, "big"), private_exponent, modulus).to_bytes(key_size, "big")


def _jwk(kid: str, key: tuple[int, int, int]) -> dict[str, str]:
    modulus, exponent, _private = key
    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": _b64url(modulus.to_bytes((modulus.bit_length() + 7) // 8, "big")),
        "e": _b64url(exponent.to_bytes((exponent.bit_length() + 7) // 8, "big")),
    }


def _jwks(*entries: dict[str, str]) -> dict[str, Any]:
    return {"keys": [entry for entry in entries if entry]}


def _jwt(key: tuple[int, int, int], kid: str, claims: dict[str, Any], algorithm: str = "RS256") -> str:
    header = _b64url(json.dumps({"alg": algorithm, "kid": kid}, separators=(",", ":")).encode("utf-8"))
    payload = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header}.{payload}".encode("ascii")
    if algorithm == "none":
        signature = b""
    elif algorithm.startswith("HS"):
        macro = key[0].to_bytes((key[0].bit_length() + 7) // 8, "big")
        signature = hmac.new(macro, signing_input, hashlib.sha256).digest()
    else:
        signature = _sign_rs256(signing_input, key)
    return f"{header}.{payload}.{_b64url(signature)}"


def _claims(
    *,
    issuer: Any = ISSUER,
    audience: Any = AUDIENCE,
    scope: str = "mcp:read",
    expires_in: int = 3600,
    issued_at: dt.datetime = NOW,
    **extra: Any,
) -> dict[str, Any]:
    claims = {
        "iss": issuer,
        "aud": audience,
        "sub": "user-1",
        "client_id": "client-1",
        "scope": scope,
        "iat": int(issued_at.timestamp()),
        "exp": int(issued_at.timestamp()) + expires_in,
    }
    claims.update(extra)
    return claims


def _ctx(path: str = "/acme/mcp") -> Context:
    return Context(request=Request(method="POST", path=path, headers={}, query={}, body=b"", is_base64=False))


class _Clock:
    def __init__(self, value: dt.datetime) -> None:
        self.value = value

    def __call__(self) -> dt.datetime:
        return self.value

    def advance(self, seconds: int) -> None:
        self.value += dt.timedelta(seconds=seconds)


class _CountingTransport:
    """Injectable http_get fake: no network egress, every fetch is counted."""

    def __init__(self) -> None:
        self._queues: dict[str, list[tuple[int, dict[str, str], bytes]]] = {}
        self.calls: list[str] = []

    def push_json(self, url: str, document: Any) -> None:
        body = json.dumps(document, separators=(",", ":")).encode("utf-8")
        self._queues.setdefault(url, []).append((200, {"content-type": "application/json"}, body))

    def push_raw(self, url: str, status: int, headers: dict[str, str], body: bytes) -> None:
        self._queues.setdefault(url, []).append((status, headers, body))

    def __call__(self, url: str) -> tuple[int, dict[str, str], bytes]:
        self.calls.append(url)
        queue = self._queues.get(url)
        if not queue:
            raise AssertionError(f"unexpected fetch: {url}")
        return queue[0] if len(queue) == 1 else queue.pop(0)

    @property
    def fetch_count(self) -> int:
        return len(self.calls)


@dataclass(slots=True)
class _Outcome:
    accepted: bool
    fetch_count: int
    error_code: str = ""


def _validate(validator: Any, token: str, ctx: Context | None = None) -> tuple[bool, str]:
    try:
        validator(ctx or _ctx(), token)
    except OAuthBearerError as exc:
        return False, exc.oauth_code
    return True, ""


def _new_env(
    transport: _CountingTransport,
    clock: _Clock,
    *,
    issuer: str = ISSUER,
    jwks_uri: str = JWKS_URI,
    discovery_url: str = "",
    **options: Any,
):
    return new_jwks_validator(
        JWKSValidatorOptions(
            issuer=issuer,
            jwks_uri=jwks_uri,
            discovery_url=discovery_url,
            http_get=transport,
            now=clock,
            cache_ttl_seconds=CACHE_TTL_SECONDS,
            refresh_cooldown_seconds=REFRESH_COOLDOWN_SECONDS,
            **options,
        )
    )


class Rs256KnownAnswerTests(unittest.TestCase):
    def test_rfc7515_a2_vector_verifies_and_a_single_flipped_bit_is_rejected(self) -> None:
        modulus = int.from_bytes(_b64url_decode(RFC7515_A2_MODULUS), "big")
        signature = _b64url_decode(RFC7515_A2_SIGNATURE)
        self.assertTrue(_rsa_pkcs1_v15_sha256_verify(RFC7515_A2_SIGNING_INPUT, signature, modulus, 65537))
        flipped = bytearray(signature)
        flipped[0] ^= 0x01
        self.assertFalse(_rsa_pkcs1_v15_sha256_verify(RFC7515_A2_SIGNING_INPUT, bytes(flipped), modulus, 65537))
        self.assertFalse(_rsa_pkcs1_v15_sha256_verify(RFC7515_A2_SIGNING_INPUT + b"x", signature, modulus, 65537))

    def test_key_generated_in_test_signs_and_verifies_with_a_flipped_bit_rejected(self) -> None:
        key = _test_key("known-answer", bits=2048)
        message = b"apptheory.jwks.known-answer"
        signature = _sign_rs256(message, key)
        self.assertTrue(_rsa_pkcs1_v15_sha256_verify(message, signature, key[0], key[1]))
        for index in (0, len(signature) // 2, len(signature) - 1):
            flipped = bytearray(signature)
            flipped[index] ^= 0x80
            with self.subTest(index=index):
                self.assertFalse(_rsa_pkcs1_v15_sha256_verify(message, bytes(flipped), key[0], key[1]))
        other = _test_key("known-answer-other")
        self.assertFalse(_rsa_pkcs1_v15_sha256_verify(message, signature, other[0], other[1]))

    def test_verifier_refuses_short_and_out_of_range_signatures(self) -> None:
        key = _test_key("known-answer-short")
        message = b"apptheory.jwks.known-answer"
        signature = _sign_rs256(message, key)
        self.assertFalse(_rsa_pkcs1_v15_sha256_verify(message, signature[:-1], key[0], key[1]))
        oversized = key[0].to_bytes((key[0].bit_length() + 7) // 8, "big")
        self.assertFalse(_rsa_pkcs1_v15_sha256_verify(message, oversized, key[0], key[1]))


class JwksValidatorFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture("jwks-validator.v1.json")
        cls.max_refresh_per_kid = cls.fixture["defaults"]["max_refresh_per_kid"]

    def _env(self, **options: Any):
        transport = _CountingTransport()
        clock = _Clock(NOW)
        options.setdefault("max_refresh_per_kid", self.max_refresh_per_kid)
        return _new_env(transport, clock, **options), transport, clock

    def test_algorithm_allow_list_and_defaults_are_pinned(self) -> None:
        self.assertEqual(self.fixture["algorithm"]["allowed"], ["RS256"])
        self.assertTrue(self.fixture["algorithm"]["rejected"])
        self.assertEqual(self.max_refresh_per_kid, 1)
        key = _test_key("alg-main")
        for algorithm in self.fixture["algorithm"]["rejected"]:
            with self.subTest(algorithm=algorithm):
                validator, transport, _clock = self._env()
                transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
                token = _jwt(key, "k1", _claims(), algorithm=algorithm)
                accepted, code = _validate(validator, token)
                self.assertFalse(accepted)
                self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

    def test_shared_fetch_timeout_default_is_pinned(self) -> None:
        self.assertEqual(self.fixture["defaults"]["fetch_timeout_seconds"], jwks.HTTP_TIMEOUT_SECONDS)
        self.assertEqual(jwks.HTTP_TIMEOUT_SECONDS, 10)
        self.assertEqual(
            inspect.signature(jwks.bootstrap_oidc_discovery).parameters["timeout_seconds"].default,
            jwks.HTTP_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            inspect.signature(jwks._default_http_get).parameters["timeout"].default,
            jwks.HTTP_TIMEOUT_SECONDS,
        )

    def test_bounded_state_defaults_are_pinned(self) -> None:
        defaults = self.fixture["defaults"]
        self.assertEqual(defaults["max_kid_length"], jwks.DEFAULT_MAX_KID_LENGTH)
        self.assertEqual(defaults["max_window_entries"], jwks.DEFAULT_MAX_WINDOW_ENTRIES)
        self.assertEqual(defaults["max_key_entries"], jwks.DEFAULT_MAX_KEY_ENTRIES)
        self.assertEqual(defaults["max_unknown_kid_fetches"], jwks.DEFAULT_MAX_UNKNOWN_KID_FETCHES)
        self.assertEqual(defaults["unknown_kid_fetch_window_seconds"], jwks.DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS)
        self.assertEqual(jwks.DEFAULT_MAX_KID_LENGTH, 256)
        self.assertEqual(jwks.DEFAULT_MAX_WINDOW_ENTRIES, 1024)
        self.assertEqual(jwks.DEFAULT_MAX_KEY_ENTRIES, 128)
        self.assertEqual(jwks.DEFAULT_MAX_UNKNOWN_KID_FETCHES, 32)
        self.assertEqual(jwks.DEFAULT_UNKNOWN_KID_FETCH_WINDOW_SECONDS, 60)

    def test_fixture_cases(self) -> None:
        scenarios = {
            "alg-none-rejected": self._case_alg_none_rejected,
            "hs256-rejected": self._case_hs256_rejected,
            "unknown-kid-triggers-one-refresh": self._case_unknown_kid_triggers_one_refresh,
            "unknown-kid-refresh-is-bounded": self._case_unknown_kid_refresh_is_bounded,
            "expired-key-refresh": self._case_expired_key_refresh,
            "issuer-mismatch-rejected": self._case_issuer_mismatch_rejected,
            "audience-mismatch-rejected": self._case_audience_mismatch_rejected,
            "expired-token-rejected": self._case_expired_token_rejected,
            "oversized-kid-refused-without-a-fetch": self._case_oversized_kid_refused,
            "distinct-attacker-kids-are-globally-bounded": self._case_distinct_attacker_kids_are_bounded,
            "evicted-kid-window-allows-one-refetch": self._case_evicted_kid_window_allows_refetch,
        }
        cases = self.fixture["cases"]
        self.assertTrue(cases)
        # Bidirectional, like the Go and TypeScript loaders: dropping a fixture
        # row would otherwise shrink coverage silently. This is what makes a
        # dropped shared row fail Python alone.
        self.assertEqual(
            set(scenarios),
            {case["name"] for case in cases},
            "every fixture case needs exactly one scenario and no scenario may be unused",
        )
        executed = 0
        for case in cases:
            name = case["name"]
            with self.subTest(case=name):
                scenario = scenarios.get(name)
                self.assertIsNotNone(scenario, f"no scenario implementation for fixture case {name}")
                outcome = scenario()
                executed += 1
                self.assertEqual(outcome.accepted, case["expect"] == "accepted")
                if "jwks_fetches" in case:
                    self.assertEqual(outcome.fetch_count, case["jwks_fetches"])
                if case.get("bounded_refresh"):
                    self.assertLessEqual(outcome.fetch_count, case["jwks_fetches"])
                if case.get("bounded_global_fetch_budget"):
                    self.assertEqual(outcome.fetch_count, self.fixture["defaults"]["max_unknown_kid_fetches"])
                if "reason" in case:
                    expected_code = _JWKS_REASON_CODES.get(case["reason"])
                    self.assertIsNotNone(expected_code, f"unmapped fixture reason {case['reason']}")
                    self.assertEqual(outcome.error_code, expected_code)
        self.assertEqual(executed, len(cases))

    def _case_alg_none_rejected(self) -> _Outcome:
        key = _test_key("alg-none")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        token = _jwt(key, "k1", _claims(), algorithm="none")
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_hs256_rejected(self) -> _Outcome:
        key = _test_key("alg-hs256")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        token = _jwt(key, "k1", _claims(), algorithm="HS256")
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_unknown_kid_triggers_one_refresh(self) -> _Outcome:
        published = _test_key("refresh-published")
        late = _test_key("refresh-late")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("published", published)))
        transport.push_json(JWKS_URI, _jwks(_jwk("published", published), _jwk("late", late)))
        token = _jwt(late, "late", _claims())
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_unknown_kid_refresh_is_bounded(self) -> _Outcome:
        published = _test_key("bounded-published")
        never = _test_key("bounded-never")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("published", published)))
        token = _jwt(never, "never-published", _claims())
        first, first_code = _validate(validator, token)
        second, second_code = _validate(validator, token)
        return _Outcome(
            accepted=first or second,
            fetch_count=transport.fetch_count,
            error_code=second_code or first_code,
        )

    def _case_expired_key_refresh(self) -> _Outcome:
        rotated = _test_key("rotated-old")
        replacement = _test_key("rotated-new")
        validator, transport, clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("rotating", rotated)))
        transport.push_json(JWKS_URI, _jwks(_jwk("rotating", replacement)))
        first, _first_code = _validate(validator, _jwt(rotated, "rotating", _claims()))
        clock.advance(CACHE_TTL_SECONDS + 1)
        second, second_code = _validate(validator, _jwt(replacement, "rotating", _claims(issued_at=clock.value)))
        error_code = "" if second else second_code
        return _Outcome(accepted=first and second, fetch_count=transport.fetch_count, error_code=error_code)

    def _case_issuer_mismatch_rejected(self) -> _Outcome:
        key = _test_key("issuer-mismatch")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        token = _jwt(key, "k1", _claims(issuer="https://other.example.test"))
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_audience_mismatch_rejected(self) -> _Outcome:
        key = _test_key("audience-mismatch")
        validator, transport, _clock = self._env(required_audience=AUDIENCE)
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        token = _jwt(key, "k1", _claims(audience="https://other.example.com/mcp"))
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_expired_token_rejected(self) -> _Outcome:
        key = _test_key("expired-token")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        token = _jwt(key, "k1", _claims(expires_in=-120))
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_oversized_kid_refused(self) -> _Outcome:
        key = _test_key("oversized-kid")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        oversized = "k" * (self.fixture["defaults"]["max_kid_length"] + 1)
        token = _jwt(key, oversized, _claims())
        accepted, code = _validate(validator, token)
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_distinct_attacker_kids_are_bounded(self) -> _Outcome:
        key = _test_key("attack-budget")
        validator, transport, _clock = self._env()
        transport.push_json(JWKS_URI, _jwks(_jwk("published", key)))
        code = ""
        accepted = False
        for index in range(200):
            accepted, code = _validate(validator, _jwt(key, f"attacker-kid-{index}", _claims()))
            if accepted:
                break
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)

    def _case_evicted_kid_window_allows_refetch(self) -> _Outcome:
        key = _test_key("evicted-window")
        validator, transport, _clock = self._env(max_window_entries=1)
        transport.push_json(JWKS_URI, _jwks(_jwk("published", key)))
        code = ""
        accepted = False
        for kid in ("kid-a", "kid-b", "kid-a"):
            accepted, code = _validate(validator, _jwt(key, kid, _claims()))
            if accepted:
                break
        return _Outcome(accepted=accepted, fetch_count=transport.fetch_count, error_code=code)


class DiscoveryBootstrapFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture("discovery-bootstrap.v1.json")

    def test_security_flags_are_pinned(self) -> None:
        security = self.fixture["security"]
        self.assertTrue(security["https_only"])
        self.assertTrue(security["issuer_must_match_discovery_document"])
        self.assertEqual(security["cross_origin_redirect"], "rejected")
        self.assertTrue(security["endpoints_pinned_to_verified_issuer"])

    def test_host_guard_table_classifies_every_shared_address(self) -> None:
        guard = self.fixture["host_guard"]
        self.assertEqual(guard["default"], "reject any endpoint host that is not a public address")
        rows = guard["addresses"]
        self.assertTrue(rows, "the shared host-guard table must not be empty")
        for row in rows:
            with self.subTest(address=row["address"]):
                self.assertEqual(jwks.classify_host_address(row["address"]), row["class"])
                self.assertEqual(jwks.is_public_host_address(row["address"]), row["public"])
        # A name is never an address literal, and an unparsed address is never
        # treated as public.
        self.assertEqual(jwks.classify_host_address("localhost"), "invalid")
        self.assertFalse(jwks.is_public_host_address("localhost"))
        self.assertFalse(jwks.is_public_host_address("mcp.example.test"))

    def test_fixture_cases(self) -> None:
        scenarios = {
            "same-origin-https-accepted": self._case_same_origin_accepted,
            "issuer-mismatch-rejected": self._case_issuer_mismatch,
            "non-https-rejected": self._case_non_https,
            "cross-origin-redirect-rejected": self._case_cross_origin_redirect,
            "missing-jwks-uri-rejected": self._case_missing_jwks_uri,
        }
        cases = self.fixture["cases"]
        self.assertTrue(cases)
        # Bidirectional, like the Go and TypeScript loaders: a dropped shared row
        # must fail Python alone rather than silently shrinking coverage.
        self.assertEqual(
            set(scenarios),
            {case["name"] for case in cases},
            "every fixture case needs exactly one scenario and no scenario may be unused",
        )
        executed = 0
        for case in cases:
            name = case["name"]
            with self.subTest(case=name):
                scenario = scenarios.get(name)
                self.assertIsNotNone(scenario, f"no scenario implementation for fixture case {name}")
                accepted, code = scenario()
                executed += 1
                self.assertEqual(accepted, case["expect"] == "accepted")
                if "reason" in case:
                    self.assertEqual(code, _DISCOVERY_REASON_CODES[case["reason"]])
        self.assertEqual(executed, len(cases))

    def _case_same_origin_accepted(self) -> tuple[bool, str]:
        transport = _CountingTransport()
        transport.push_json(DISCOVERY_URL, {"issuer": ISSUER, "jwks_uri": JWKS_URI})
        try:
            jwks_uri = bootstrap_oidc_discovery(DISCOVERY_URL, ISSUER, transport)
        except OAuthBearerError as exc:
            return False, exc.oauth_code
        self.assertEqual(jwks_uri, JWKS_URI)
        self.assertEqual(transport.calls, [DISCOVERY_URL])
        return True, ""

    def _case_issuer_mismatch(self) -> tuple[bool, str]:
        transport = _CountingTransport()
        transport.push_json(DISCOVERY_URL, {"issuer": "https://other.example.test", "jwks_uri": JWKS_URI})
        try:
            bootstrap_oidc_discovery(DISCOVERY_URL, ISSUER, transport)
        except OAuthBearerError as exc:
            return False, exc.oauth_code
        return True, ""

    def _case_non_https(self) -> tuple[bool, str]:
        transport = _CountingTransport()
        try:
            bootstrap_oidc_discovery("http://auth.example.test/.well-known/openid-configuration", ISSUER, transport)
        except OAuthBearerError as exc:
            self.assertEqual(transport.fetch_count, 0)
            return False, exc.oauth_code
        return True, ""

    def _case_cross_origin_redirect(self) -> tuple[bool, str]:
        transport = _CountingTransport()
        transport.push_raw(DISCOVERY_URL, 302, {"location": "https://evil.example.test/openid-configuration"}, b"")
        try:
            bootstrap_oidc_discovery(DISCOVERY_URL, ISSUER, transport)
        except OAuthBearerError as exc:
            return False, exc.oauth_code
        return True, ""

    def _case_missing_jwks_uri(self) -> tuple[bool, str]:
        transport = _CountingTransport()
        transport.push_json(DISCOVERY_URL, {"issuer": ISSUER})
        try:
            bootstrap_oidc_discovery(DISCOVERY_URL, ISSUER, transport)
        except OAuthBearerError as exc:
            return False, exc.oauth_code
        return True, ""


class RouteChallengeFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture("route-challenge.v1.json")

    def test_resource_indicator_rows(self) -> None:
        rows = self.fixture["resource_indicator"]
        self.assertTrue(rows["accept"])
        self.assertTrue(rows["reject"])
        for row in rows["accept"]:
            with self.subTest(row=row):
                self.assertTrue(resource_indicator_matches(row["route_resource"], row["requested"]))
                self.assertEqual(
                    canonical_resource_url(row["requested"]),
                    canonical_resource_url(row["route_resource"]),
                )
        for row in rows["reject"]:
            with self.subTest(row=row):
                self.assertFalse(resource_indicator_matches(row["route_resource"], row["requested"]))
                self.assertNotEqual(
                    canonical_resource_url(row["requested"]),
                    canonical_resource_url(row["route_resource"]),
                )

    def test_route_derived_example_challenge(self) -> None:
        example = self.fixture["route_derived"]["example"]
        self.assertEqual(example["route"], "/acme/mcp")
        self.assertEqual(
            resource_metadata_url_from_mcp_endpoint(example["resource"]),
            example["resource_metadata_url"],
        )
        self.assertEqual(
            protected_resource_www_authenticate(example["resource_metadata_url"]),
            example["challenge"],
        )


class JwksValidatorBehaviourTests(unittest.TestCase):
    def test_route_derived_audience_and_scopes_are_resolved_from_the_context(self) -> None:
        key = _test_key("route-derived")
        transport = _CountingTransport()
        clock = _Clock(NOW)
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        validator = _new_env(
            transport,
            clock,
            required_audience=lambda ctx: AUDIENCE if ctx.request.path == "/acme/mcp" else "",
            required_scopes=lambda ctx: ["mcp:read", "mcp:tools"] if ctx.request.path == "/acme/mcp" else ["mcp:tools"],
        )
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims(scope="mcp:read mcp:tools")))
        self.assertTrue(accepted)
        rejected, code = _validate(validator, _jwt(key, "k1", _claims(scope="mcp:read")), _ctx("/other/mcp"))
        self.assertFalse(rejected)
        self.assertEqual(code, ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE)

    def test_audience_matches_any_single_entry_and_requires_an_exact_entry(self) -> None:
        key = _test_key("audience-shapes")
        validator, _transport, _clock = self._env_with_key(key, required_audience=AUDIENCE)
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims(audience=[AUDIENCE])))
        self.assertTrue(accepted)
        accepted, _code = _validate(
            validator, _jwt(key, "k1", _claims(audience=[AUDIENCE, "https://other.example.com"]))
        )
        self.assertTrue(accepted)
        for audience in (
            "https://other.example.com",
            ["https://other.example.com"],
            ["https://a.example.com", "https://b.example.com"],
        ):
            with self.subTest(audience=audience):
                rejected, code = _validate(validator, _jwt(key, "k1", _claims(audience=audience)))
                self.assertFalse(rejected)
                self.assertEqual(code, ERR_BEARER_TOKEN_INVALID_AUDIENCE)

    def test_azp_allow_list_uses_client_id_fallback_and_never_wildcards(self) -> None:
        key = _test_key("azp")
        validator, _transport, _clock = self._env_with_key(key, allowed_azp=["client-1"])
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertTrue(accepted, "an allow-listed client_id is the azp fallback")
        rejected, code = _validate(validator, _jwt(key, "k1", _claims(azp="client-9")))
        self.assertFalse(rejected)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

        # A present but blank azp never falls back to an allow-listed client_id.
        blank, blank_code = _validate(validator, _jwt(key, "k1", _claims(azp=" ")))
        self.assertFalse(blank, "a blank azp must not fall back to client_id")
        self.assertEqual(blank_code, ERR_INVALID_BEARER_TOKEN)

        # A padded azp still normalizes to its allow-list entry.
        padded, _code = _validate(validator, _jwt(key, "k1", _claims(azp=" client-1 ")))
        self.assertTrue(padded, "a padded azp normalizes to its allow-list entry")

        # A token that carries neither azp nor client_id is refused under a
        # configured allow-list: absent must never read as "no check".
        neither, neither_code = _validate(validator, _jwt(key, "k1", _claims(azp=None, client_id=None)))
        self.assertFalse(neither, "a token with neither azp nor client_id is refused")
        self.assertEqual(neither_code, ERR_INVALID_BEARER_TOKEN)

        wildcard, _transport, _clock = self._env_with_key(key, allowed_azp=["*"])
        accepted, _code = _validate(wildcard, _jwt(key, "k1", _claims(azp="client-1")))
        self.assertFalse(accepted)
        self.assertTrue(_validate(wildcard, _jwt(key, "k1", _claims(azp="*")))[0])

    def test_clock_skew_allows_a_just_expired_token_and_a_not_yet_valid_token(self) -> None:
        key = _test_key("skew")
        validator, _transport, _clock = self._env_with_key(key, clock_skew_seconds=120)
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims(expires_in=-60)))
        self.assertTrue(accepted)
        not_yet_valid, code = _validate(
            validator,
            _jwt(key, "k1", _claims(expires_in=3600, nbf=int(NOW.timestamp()) + 600)),
        )
        self.assertFalse(not_yet_valid)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

    def test_discovery_bootstrap_resolves_the_jwks_uri_lazily(self) -> None:
        key = _test_key("discovery")
        transport = _CountingTransport()
        clock = _Clock(NOW)
        transport.push_json(DISCOVERY_URL, {"issuer": ISSUER, "jwks_uri": JWKS_URI})
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        validator = _new_env(transport, clock, jwks_uri="", discovery_url=DISCOVERY_URL)
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertTrue(accepted)
        self.assertEqual(transport.calls, [DISCOVERY_URL, JWKS_URI])

    def test_construction_fails_closed_on_unusable_options(self) -> None:
        for options in (
            JWKSValidatorOptions(issuer=ISSUER),
            JWKSValidatorOptions(issuer=ISSUER, jwks_uri="http://auth.example.test/jwks.json"),
            JWKSValidatorOptions(
                issuer=ISSUER, discovery_url="http://auth.example.test/.well-known/openid-configuration"
            ),
            JWKSValidatorOptions(issuer="not-a-url", jwks_uri=JWKS_URI),
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                new_jwks_validator(options)

    def test_http_hygiene_rejects_oversized_and_malformed_responses(self) -> None:
        key = _test_key("hygiene")
        oversized = _CountingTransport()
        oversized.push_raw(JWKS_URI, 200, {"content-type": "application/json"}, b"x" * ((1 << 20) + 1))
        validator = _new_env(oversized, _Clock(NOW))
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertFalse(accepted)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

        malformed = _CountingTransport()
        malformed.push_raw(JWKS_URI, 200, {"content-type": "application/json"}, b"not json")
        validator = _new_env(malformed, _Clock(NOW))
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertFalse(accepted)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

        failing = _CountingTransport()

        def boom(_url: str) -> tuple[int, dict[str, str], bytes]:
            raise OSError("connection refused")

        validator = new_jwks_validator(
            JWKSValidatorOptions(issuer=ISSUER, jwks_uri=JWKS_URI, http_get=boom, now=_Clock(NOW))
        )
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertFalse(accepted)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)
        self.assertEqual(failing.fetch_count, 0)

    def test_jwks_entries_with_mismatched_use_alg_or_type_are_ignored(self) -> None:
        key = _test_key("inconsistent")
        entry = _jwk("k1", key)
        mismatched = _CountingTransport()
        mismatched.push_json(
            JWKS_URI, _jwks({**entry, "use": "enc"}, {**entry, "alg": "RS512"}, {**entry, "kty": "EC"})
        )
        validator = _new_env(mismatched, _Clock(NOW))
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertFalse(accepted)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

        mixed = _CountingTransport()
        mixed.push_json(JWKS_URI, _jwks({**entry, "use": "enc"}, entry))
        validator = _new_env(mixed, _Clock(NOW))
        accepted, _code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertTrue(accepted)

    def test_malformed_tokens_are_refused(self) -> None:
        key = _test_key("malformed")
        validator, transport, _clock = self._env_with_key(key)
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        valid = _jwt(key, "k1", _claims())
        cases = {
            "two segments": ".".join(valid.split(".")[:2]),
            "four segments": valid + ".extra",
            "bad base64": f"!!!!.{valid.split('.')[1]}.{valid.split('.')[2]}",
            "missing kid": _jwt(key, "", _claims()),
            "not json header": f"{_b64url(b'[]')}.{valid.split('.')[1]}.{valid.split('.')[2]}",
        }
        for name, token in cases.items():
            with self.subTest(name=name):
                accepted, code = _validate(validator, token)
                self.assertFalse(accepted)
                self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

    def _env_with_key(self, key: tuple[int, int, int], **options: Any):
        transport = _CountingTransport()
        clock = _Clock(NOW)
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        validator = _new_env(transport, clock, **options)
        return validator, transport, clock

    def _raw_validator(self, transport: _CountingTransport, clock: _Clock, **options: Any) -> Any:
        """Builds the module-level validator directly so its bounded state is
        observable; the public factory only returns the bound ``validate``."""
        options.setdefault("max_refresh_per_kid", 1)
        return jwks._JWKSValidator(
            JWKSValidatorOptions(
                issuer=ISSUER,
                jwks_uri=JWKS_URI,
                http_get=transport,
                now=clock,
                cache_ttl_seconds=CACHE_TTL_SECONDS,
                refresh_cooldown_seconds=REFRESH_COOLDOWN_SECONDS,
                **options,
            ),
            ISSUER,
            JWKS_URI,
            "",
            set(),
        )

    def test_key_cache_is_bounded_and_evicts_the_earliest_expiring_entries(self) -> None:
        key = _test_key("cache-bound")
        transport = _CountingTransport()
        clock = _Clock(NOW)
        transport.push_json(JWKS_URI, _jwks(*[_jwk(f"doc-key-{index}", key) for index in range(16)]))
        validator = self._raw_validator(transport, clock, max_key_entries=4)

        accepted, _code = _validate(validator.validate, _jwt(key, "doc-key-0", _claims()))
        self.assertFalse(accepted, "the first document key must be evicted by the cache bound")
        self.assertLessEqual(len(validator._keys), 4)
        self.assertEqual(transport.fetch_count, 2)

        accepted, _code = _validate(validator.validate, _jwt(key, "doc-key-15", _claims()))
        self.assertTrue(accepted, "the last document key must survive the cache bound")
        self.assertLessEqual(len(validator._keys), 4)
        self.assertEqual(transport.fetch_count, 2, "the retained key must be served from the cache")

    def test_kid_window_map_is_bounded(self) -> None:
        key = _test_key("window-bound")
        transport = _CountingTransport()
        clock = _Clock(NOW)
        transport.push_json(JWKS_URI, _jwks(_jwk("published", key)))
        validator = self._raw_validator(transport, clock, max_window_entries=4)

        for index in range(20):
            _validate(validator.validate, _jwt(key, f"missing-kid-{index}", _claims()))
        self.assertEqual(len(validator._windows), 4)


class FetchTimeoutTests(unittest.TestCase):
    """The framework default transport must fail closed when an upstream hangs."""

    def setUp(self) -> None:
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(1)
        self._listener.settimeout(0.5)
        self._port = self._listener.getsockname()[1]
        self._connections: list[socket.socket] = []
        self._stop = threading.Event()
        self.addCleanup(self._shutdown)
        self._thread = threading.Thread(target=self._accept_until_stopped, daemon=True)
        self._thread.start()

    def _accept_until_stopped(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _address = self._listener.accept()
            except (TimeoutError, OSError):
                continue
            # Accept, then never respond: the peer's TLS handshake must time out.
            self._connections.append(connection)

    def _shutdown(self) -> None:
        self._stop.set()
        with contextlib.suppress(OSError):
            for connection in self._connections:
                connection.close()
        with contextlib.suppress(OSError):
            self._listener.close()
        self._thread.join(timeout=2.0)

    def test_hung_upstream_fails_closed_inside_the_bound(self) -> None:
        key = _test_key("hung-upstream")
        # The listener is on loopback, which the framework transport refuses by
        # default, so the loopback suite opts in to the documented override and
        # this test keeps exercising the fetch timeout rather than the guard.
        validator = new_jwks_validator(
            JWKSValidatorOptions(
                issuer=ISSUER,
                jwks_uri=f"https://127.0.0.1:{self._port}/jwks.json",
                http_timeout_seconds=0.2,
                allow_private_hosts=True,
            )
        )
        started = time.monotonic()
        with self.assertRaises(OAuthBearerError):
            validator(_ctx(), _jwt(key, "k1", _claims()))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 3.0, f"the transport timeout must fire, took {elapsed:.2f}s")

        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertFalse(accepted)
        self.assertEqual(code, ERR_INVALID_BEARER_TOKEN)

    def test_default_fetch_timeout_leaves_the_happy_path_intact(self) -> None:
        key = _test_key("default-timeout")
        transport = _CountingTransport()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        validator = _new_env(transport, _Clock(NOW))
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertTrue(accepted, code)


GUARD_ISSUER = "https://issuer.example.test"


class HostGuardTransportTests(unittest.TestCase):
    """The framework's own transport must refuse non-public endpoints.

    Port 1 is closed, so nothing is ever served however far a call gets; each
    assertion therefore measures the guard, not a response.
    """

    def _guard_failure(self, jwks_uri: str, **options: Any) -> tuple[str, float]:
        key = _test_key("host-guard")
        validator = new_jwks_validator(
            JWKSValidatorOptions(
                issuer=GUARD_ISSUER,
                jwks_uri=jwks_uri,
                http_timeout_seconds=5.0,
                **options,
            )
        )
        started = time.monotonic()
        with self.assertRaises(OAuthBearerError) as caught:
            validator(_ctx(), _jwt(key, "k1", _claims(issuer=GUARD_ISSUER)))
        return str(caught.exception), time.monotonic() - started

    def test_default_transport_refuses_a_non_public_endpoint(self) -> None:
        for jwks_uri in (
            "https://127.0.0.1:1/jwks.json",
            "https://[::1]:1/jwks.json",
            "https://[::ffff:127.0.0.1]:1/jwks.json",
            "https://localhost:1/jwks.json",
        ):
            with self.subTest(jwks_uri=jwks_uri):
                message, elapsed = self._guard_failure(jwks_uri)
                self.assertIn("not a public address", message)
                self.assertLess(elapsed, 3.0, f"{jwks_uri} took {elapsed:.2f}s")

    def test_allow_private_hosts_drops_the_guard(self) -> None:
        for jwks_uri in ("https://127.0.0.1:1/jwks.json", "https://localhost:1/jwks.json"):
            with self.subTest(jwks_uri=jwks_uri):
                message, elapsed = self._guard_failure(jwks_uri, allow_private_hosts=True)
                self.assertNotIn("not a public address", message)
                self.assertLess(elapsed, 3.0, f"{jwks_uri} took {elapsed:.2f}s")

    def test_only_an_explicit_true_enables_the_override(self) -> None:
        message, _elapsed = self._guard_failure("https://127.0.0.1:1/jwks.json", allow_private_hosts="yes")
        self.assertIn("not a public address", message)

    def test_allow_private_hosts_leaves_the_injected_loopback_transport_validating(self) -> None:
        key = _test_key("guard-override")
        transport = _CountingTransport()
        transport.push_json(JWKS_URI, _jwks(_jwk("k1", key)))
        validator = _new_env(transport, _Clock(NOW), allow_private_hosts=True)
        accepted, code = _validate(validator, _jwt(key, "k1", _claims()))
        self.assertTrue(accepted, code)
        self.assertEqual(transport.fetch_count, 1)


if __name__ == "__main__":
    unittest.main()
