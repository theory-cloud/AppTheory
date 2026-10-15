from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from apptheory.oauth.autheory import (
    AutheoryProviderOptions as Options,
)
from apptheory.oauth.autheory import (
    _authorized_party_from_token,
    _default_http_transport,
    new_autheory_provider,
)
from apptheory.oauth.fake_provider import FakeUpstreamProvider, new_static_test_provider
from apptheory.oauth.provider import (
    AuthorizationRequest,
    CodeExchangeRequest,
    ProviderError,
    RefreshRequest,
    TokenExpectations,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"
FIXTURE_NAME = "facade-provider-conformance.v1.json"

DEFAULT_ISSUER = "https://auth.example.test"
DEFAULT_TIMEOUT_SECONDS = 10.0

EXPECTED_OPERATIONS = {
    "discovery",
    "authorization_url",
    "exchange_code",
    "refresh",
    "validate_access_token",
    "second_adapter",
}

ERROR_HTTP_STATUS = {
    "upstream_error": 502,
    "temporarily_unavailable": 503,
    "invalid_grant": 400,
    "invalid_request": 400,
    "reauth_required": 400,
}


def _load_fixture(name: str) -> dict[str, Any]:
    with (FIXTURE_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def _unsigned_token(claims: dict[str, Any]) -> str:
    """A synthetic compact JWS carrying ``claims``; only its payload is read."""

    def segment(value: dict[str, Any]) -> str:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(encoded).decode("ascii").rstrip("=")

    return f"{segment({'alg': 'RS256'})}.{segment(claims)}.signature"


class _LoopbackTransport:
    """Injects the framework's bounded default fetch against loopback.

    The adapter only ever sees the https URLs the upstream advertises; this
    documented injected-transport seam downgrades them to the plain-HTTP fake
    server, so the deadline, response cap, redirect refusal, and host-guard
    override under test are the framework transport's own.
    """

    def __init__(self, provider: FakeUpstreamProvider, timeout: float) -> None:
        self._provider = provider
        self._timeout = timeout

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, dict[str, str], bytes]:
        return _default_http_transport(
            method,
            self._provider.localize(url),
            headers,
            body,
            timeout=self._timeout,
            allow_private_hosts=True,
        )


class ProviderConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture(FIXTURE_NAME)

    def _start_upstream(self, case: dict[str, Any]) -> FakeUpstreamProvider:
        upstream = case.get("upstream", {})
        provider = FakeUpstreamProvider(
            issuer=upstream.get("issuer", DEFAULT_ISSUER),
            discovery_issuer=upstream.get("discovery_issuer"),
            redirect_to=upstream.get("redirect_to", ""),
            token_status=upstream.get("token_status", 200),
            token_body=upstream.get("token_body"),
            token_body_bytes=upstream.get("token_body_bytes", 0),
            token_body_padding_bytes=upstream.get("token_body_padding_bytes", 0),
            token_delay_seconds=upstream.get("token_delay_seconds", 0.0),
        )
        provider.start()
        self.addCleanup(provider.stop)
        return provider

    def _adapter(self, case: dict[str, Any], provider: FakeUpstreamProvider) -> Any:
        timeout = float(case.get("fetch_timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
        return new_autheory_provider(
            Options(
                issuer=case.get("upstream", {}).get("issuer", DEFAULT_ISSUER),
                http_get=_LoopbackTransport(provider, timeout),
                allow_private_hosts=True,
                http_timeout_seconds=timeout,
            )
        )

    def test_fixture_table_is_complete(self) -> None:
        cases = self.fixture["cases"]
        self.assertEqual(len(cases), 27)
        self.assertEqual({case["operation"] for case in cases}, EXPECTED_OPERATIONS)
        self.assertTrue(self.fixture["autheory"]["resource_parameter_required_at_authorize"])

    def test_fixture_cases(self) -> None:
        cases = self.fixture["cases"]
        executed = 0
        for case in cases:
            with self.subTest(case=case["id"]):
                self._run_case(case)
                executed += 1
        print(f"provider conformance: {executed} cases run")
        self.assertEqual(executed, 27)

    # -- dispatch ------------------------------------------------------------

    def _run_case(self, case: dict[str, Any]) -> None:
        operation = case["operation"]
        if operation == "second_adapter":
            provider = new_static_test_provider()
            self.assertEqual(provider.discovery().issuer, case["expect"]["issuer"])
            return
        upstream = self._start_upstream(case)
        adapter = self._adapter(case, upstream)
        handlers = {
            "discovery": self._run_discovery,
            "authorization_url": self._run_authorization_url,
            "exchange_code": self._run_exchange_code,
            "refresh": self._run_refresh,
            "validate_access_token": self._run_validate_access_token,
        }
        handlers[operation](case, upstream, adapter)

    # -- operations ----------------------------------------------------------

    def _run_discovery(self, case: dict[str, Any], upstream: FakeUpstreamProvider, adapter: Any) -> None:
        expect = case["expect"]
        if expect["outcome"] != "ok":
            with self.assertRaises(ProviderError) as caught:
                adapter.discovery()
            self._assert_error(caught.exception, expect)
            if case["id"].endswith("non_https_fails_closed"):
                self.assertEqual(upstream.request_count, 0, "a non-https issuer must never be fetched")
            return
        metadata = adapter.discovery()
        self.assertEqual(metadata.issuer, expect["issuer"])
        self.assertEqual(metadata.code_challenge_methods_supported, expect["code_challenge_methods_supported"])
        self.assertEqual(
            metadata.authorization_response_iss_parameter_supported,
            expect["authorization_response_iss_parameter_supported"],
        )
        self.assertEqual(metadata.resource_parameter_supported, expect["resource_parameter_supported"])
        # Discovery is cached: a second call performs no further fetch.
        fetched = upstream.request_count
        self.assertEqual(adapter.discovery().issuer, expect["issuer"])
        self.assertEqual(upstream.request_count, fetched)

    def _run_authorization_url(self, case: dict[str, Any], upstream: FakeUpstreamProvider, adapter: Any) -> None:
        expect = case["expect"]
        request = AuthorizationRequest(**case["request"])
        if expect["outcome"] != "ok":
            with self.assertRaises(ProviderError) as caught:
                adapter.authorization_url(request)
            self._assert_error(caught.exception, expect)
            return
        url = adapter.authorization_url(request)
        parsed = urlsplit(url)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(url.split("?")[0], upstream.authorization_endpoint)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        for key, value in expect["query"].items():
            self.assertEqual(query.get(key), value, f"authorize query {key}")
        # Hints travel through as opaque provider hints.
        for key, value in (case["request"].get("hints") or {}).items():
            self.assertEqual(query.get(key), value)

    def _run_exchange_code(self, case: dict[str, Any], upstream: FakeUpstreamProvider, adapter: Any) -> None:
        expect = case["expect"]
        request = CodeExchangeRequest(**case["request"])
        if expect["outcome"] != "ok":
            with self.assertRaises(ProviderError) as caught:
                adapter.exchange_code(request)
            self._assert_error(caught.exception, expect)
            return
        token_set = adapter.exchange_code(request)
        self.assertEqual(token_set.access_token, expect["access_token"])
        self.assertEqual(token_set.refresh_token, expect["refresh_token"])
        self.assertEqual(token_set.id_token, expect["id_token"])
        self.assertEqual(token_set.token_type, expect["token_type"])
        self.assertEqual(token_set.expires_in, expect["expires_in"])
        self.assertEqual(upstream.last_token_form.get("code"), case["request"]["code"])

    def _run_refresh(self, case: dict[str, Any], upstream: FakeUpstreamProvider, adapter: Any) -> None:
        expect = case["expect"]
        request = RefreshRequest(**case["request"])
        if expect["outcome"] != "ok":
            with self.assertRaises(ProviderError) as caught:
                adapter.refresh(request)
            self._assert_error(caught.exception, expect)
            return
        token_set = adapter.refresh(request)
        self.assertEqual(token_set.access_token, expect["access_token"])
        self.assertEqual(token_set.refresh_token, expect["refresh_token"])
        # The upstream leg presents the client that owns the recorded material.
        self.assertEqual(upstream.last_client_id, expect["upstream_client_id"])

    def _run_validate_access_token(self, case: dict[str, Any], upstream: FakeUpstreamProvider, adapter: Any) -> None:
        spec = case["token"]
        token = upstream.mint_access_token(
            issuer=spec.get("iss"),
            audience=spec["aud"],
            authorized_party=spec.get("azp", ""),
            subject=spec.get("sub", "user-1"),
            scope=spec.get("scope", ""),
            expires_in=spec.get("expires_in", 900),
            tamper_signature=spec.get("tamper_signature", False),
        )
        expected = TokenExpectations(**case["expectations"])
        expect = case["expect"]
        if expect["outcome"] != "ok":
            with self.assertRaises(ProviderError) as caught:
                adapter.validate_access_token(token, expected)
            self._assert_error(caught.exception, expect)
            return
        claims = adapter.validate_access_token(token, expected)
        self.assertEqual(claims.subject, expect["subject"])
        self.assertEqual(claims.audience, expect["audience"])
        self.assertEqual(claims.scopes, expect["scopes"])
        self.assertEqual(claims.authorized_party, expect["authorized_party"])
        self.assertIsNotNone(claims.expires_at)

    # -- assertions ----------------------------------------------------------

    def _assert_error(self, error: ProviderError, expect: dict[str, Any]) -> None:
        self.assertEqual(error.error_class, expect["error_class"])
        self.assertEqual(error.http_status, ERROR_HTTP_STATUS[expect["error_class"]])
        for marker in expect.get("message_excludes", []):
            self.assertNotIn(marker, str(error))


class ProviderNeutralityTests(unittest.TestCase):
    def test_second_adapter_is_a_distinct_spi_implementation(self) -> None:
        first = new_static_test_provider()
        second = new_static_test_provider()
        self.assertEqual(first.discovery().issuer, "https://second-provider.example.test")
        self.assertEqual(second.discovery().issuer, first.discovery().issuer)
        self.assertNotEqual(first.discovery().issuer, DEFAULT_ISSUER)


class AutheoryAdapterBehaviourTests(unittest.TestCase):
    def _provider(self, **options: Any) -> Any:
        issuer = str(options.pop("issuer", DEFAULT_ISSUER))
        return new_autheory_provider(Options(issuer=issuer, allow_private_hosts=True, **options))

    def _loopback_provider(self) -> Any:
        upstream = FakeUpstreamProvider(issuer=DEFAULT_ISSUER)
        upstream.start()
        self.addCleanup(upstream.stop)
        return new_autheory_provider(
            Options(
                issuer=DEFAULT_ISSUER,
                http_get=_LoopbackTransport(upstream, DEFAULT_TIMEOUT_SECONDS),
                allow_private_hosts=True,
                http_timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
            )
        )

    def _authorize_request(self, **overrides: Any) -> AuthorizationRequest:
        fields: dict[str, Any] = {
            "upstream_client_id": "facade-client",
            "callback_url": "https://mcp.example.test/_oauth/mcp/callback",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
            "state": "facade-upstream-state",
            "resource": "https://mcp.example.test/mcp",
        }
        fields.update(overrides)
        return AuthorizationRequest(**fields)

    def test_authorization_url_refuses_a_non_s256_method(self) -> None:
        provider = self._provider()
        with self.assertRaises(ProviderError) as caught:
            provider.authorization_url(
                AuthorizationRequest(
                    upstream_client_id="facade-client",
                    callback_url="https://mcp.example.test/callback",
                    code_challenge="challenge",
                    code_challenge_method="plain",
                    state="state",
                    resource="https://mcp.example.test/mcp",
                )
            )
        self.assertEqual(caught.exception.error_class, "invalid_request")

    def test_authorization_url_refuses_a_hint_colliding_with_a_reserved_parameter(self) -> None:
        # A hint name that collides, case-insensitively and after trimming, with
        # a parameter the adapter owns is refused rather than allowed to override
        # or duplicate it. The required parameter never silently wins: the call
        # fails closed with invalid_request, which is a behaviour change from the
        # previous required-wins reading.
        provider = self._loopback_provider()
        for hint in (
            "response_type",
            "client_id",
            "Client_ID",
            " redirect_uri ",
            "code_challenge",
            "CODE_CHALLENGE_METHOD",
            "State",
            "resource",
            # scope is reserved even when the request carries no scopes, so a
            # hint can never introduce one.
            "scope",
        ):
            with self.subTest(hint=hint):
                with self.assertRaises(ProviderError) as caught:
                    provider.authorization_url(self._authorize_request(hints={hint: "attacker-value"}))
                self.assertEqual(caught.exception.error_class, "invalid_request")
                self.assertEqual(caught.exception.op, "authorization_url")

    def test_authorization_url_refuses_a_colliding_hint_before_any_upstream_call(self) -> None:
        # The refusal is a pre-flight check: it runs before the endpoint is
        # resolved, so the invalid_request class never reaches the upstream. The
        # spy transport proves no discovery fetch happened, and the provider is
        # asked to have cached no metadata either.
        calls: list[str] = []

        def spy_transport(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, dict[str, str], bytes]:
            calls.append(url)
            raise AssertionError("a refused authorize request must not reach the upstream")

        provider = new_autheory_provider(
            Options(issuer=DEFAULT_ISSUER, http_get=spy_transport, allow_private_hosts=True)
        )
        for hint in ("client_id", "State"):
            with self.subTest(hint=hint):
                with self.assertRaises(ProviderError) as caught:
                    provider.authorization_url(self._authorize_request(hints={hint: "attacker-value"}))
                self.assertEqual(caught.exception.error_class, "invalid_request")
        self.assertEqual(calls, [])
        self.assertIsNone(provider._metadata)

    def test_authorization_url_forwards_a_non_colliding_hint_verbatim(self) -> None:
        provider = self._loopback_provider()
        url = provider.authorization_url(
            self._authorize_request(scopes=["mcp:tools"], hints={"account_id": "acct_hint", "prompt": "login"})
        )
        query = dict(parse_qsl(urlsplit(url).query, keep_blank_values=True))
        self.assertEqual(query["account_id"], "acct_hint")
        self.assertEqual(query["prompt"], "login")
        # The required parameters are untouched by the forwarded hints.
        self.assertEqual(query["client_id"], "facade-client")
        self.assertEqual(query["state"], "facade-upstream-state")
        self.assertEqual(query["scope"], "mcp:tools")

    def test_exchange_code_refuses_an_empty_verifier_before_any_upstream_call(self) -> None:
        provider = self._provider()
        with self.assertRaises(ProviderError) as caught:
            provider.exchange_code(CodeExchangeRequest(code="code", upstream_client_id="facade-client"))
        self.assertEqual(caught.exception.error_class, "invalid_request")

    def test_refresh_refuses_empty_material(self) -> None:
        provider = self._provider()
        with self.assertRaises(ProviderError) as caught:
            provider.refresh(RefreshRequest(refresh_material="", upstream_client_id="facade-client"))
        self.assertEqual(caught.exception.error_class, "invalid_request")

    def test_discovery_fails_closed_on_a_non_https_issuer(self) -> None:
        provider = self._provider(issuer="http://auth.example.test")
        with self.assertRaises(ProviderError) as caught:
            provider.discovery()
        self.assertEqual(caught.exception.error_class, "upstream_error")

    def test_authorized_party_extraction_refuses_a_non_string_azp(self) -> None:
        # An absent azp falls back to client_id, and a string azp is reported as
        # it stands once trimmed.
        self.assertEqual(_authorized_party_from_token(_unsigned_token({"client_id": "client-1"})), "client-1")
        self.assertEqual(_authorized_party_from_token(_unsigned_token({"azp": " client-1 "})), "client-1")

        # A present azp that is not a string is a malformed claim rather than an
        # absent one: it is attributed to no party instead of standing in as the
        # client_id the same token carries, which is how the Go adapter's claim
        # decode reads the same token.
        for azp in (123, ["client-1"], {"value": "client-1"}):
            with self.subTest(azp=azp):
                self.assertEqual(
                    _authorized_party_from_token(_unsigned_token({"azp": azp, "client_id": "client-1"})),
                    "",
                )

    def test_a_non_string_azp_is_rejected_before_any_party_is_attributed(self) -> None:
        upstream = FakeUpstreamProvider(issuer=DEFAULT_ISSUER)
        upstream.start()
        self.addCleanup(upstream.stop)
        adapter = new_autheory_provider(
            Options(
                issuer=DEFAULT_ISSUER,
                http_get=_LoopbackTransport(upstream, DEFAULT_TIMEOUT_SECONDS),
                allow_private_hosts=True,
                http_timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
            )
        )
        audience = "https://mcp.example.test/mcp"
        expectations = TokenExpectations(expected_issuer=DEFAULT_ISSUER, expected_audience=audience)

        # The controls: a string azp is attributed, and an absent azp falls back
        # to client_id, so the rejection below cannot come from a token that
        # carries no party at all. No authorized-party allow-list is configured,
        # so the type rule is what refuses the last token.
        control = upstream.mint_access_token(audience=audience, authorized_party="client-1")
        self.assertEqual(adapter.validate_access_token(control, expectations).authorized_party, "client-1")
        fallback = upstream.mint_access_token(audience=audience, extra={"client_id": "client-1"})
        self.assertEqual(adapter.validate_access_token(fallback, expectations).authorized_party, "client-1")

        # The fail-open case: azp is the JSON number 123 while client_id is a
        # string. A present azp that is not a string is a malformed claim, not an
        # absent one, so it is refused instead of standing in as the client_id.
        malformed = upstream.mint_access_token(
            audience=audience,
            extra={"azp": 123, "client_id": "client-1"},
        )
        with self.assertRaises(ProviderError) as caught:
            adapter.validate_access_token(malformed, expectations)
        self.assertEqual(caught.exception.error_class, "upstream_error")

    def test_provider_error_messages_are_fixed_and_carry_no_upstream_body(self) -> None:
        message = "UPSTREAM-SECRET-MARKER"
        error = ProviderError("invalid_grant", "exchange_code")
        self.assertNotIn(message, str(error))
        self.assertEqual(error.error_class, "invalid_grant")
        self.assertEqual(error.http_status, 400)
        with self.assertRaises(ValueError):
            ProviderError("not_a_class", "op")


if __name__ == "__main__":
    unittest.main()
