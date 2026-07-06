from __future__ import annotations

# ruff: noqa: S106
import datetime as dt
import unittest

from apptheory import (
    ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
    ERR_INVALID_AUTHORIZATION_HEADER,
    ERR_INVALID_BEARER_TOKEN,
    AuthorizationServerMetadata,
    BearerTokenRecord,
    BearerTokenValidationOptions,
    DynamicClientRegistrationPolicy,
    DynamicClientRegistrationRequest,
    DynamicClientRegistrationResponse,
    OAuthBearerError,
    ProtectedResourceMetadata,
    RequireBearerTokenOptions,
    authorization_server_metadata_handler,
    bearer_token_claims_from_context,
    bearer_token_from_headers,
    canonical_resource_url,
    canonicalize_issuer_url,
    claude_dynamic_client_registration_policy,
    new_authorization_server_metadata,
    new_memory_bearer_token_validator,
    new_pkce_code_verifier,
    new_protected_resource_metadata,
    pkce_challenge_s256,
    pkce_verify_s256,
    protected_resource_metadata_handler,
    protected_resource_www_authenticate,
    require_bearer_token_middleware,
    resource_metadata_url_from_mcp_endpoint,
    rfc9728_resource_metadata_url,
    validate_dynamic_client_registration_request,
    validate_pkce_code_verifier,
)
from apptheory.context import Context
from apptheory.request import Request
from apptheory.response import Response


def _ctx(headers: dict[str, list[str]] | None = None) -> Context:
    return Context(
        request=Request(method="GET", path="/mcp", headers=headers or {}, query={}, body=b"", is_base64=False)
    )


class OAuthRuntimeTests(unittest.TestCase):
    def test_protected_resource_metadata_and_challenge_are_deterministic(self) -> None:
        metadata = new_protected_resource_metadata("https://mcp.example.com/mcp", ["https://auth.example.com"])
        metadata.scopes_supported = ["mcp:read"]
        metadata.bearer_methods_supported = ["header"]
        self.assertEqual(
            metadata.to_json(),
            {
                "resource": "https://mcp.example.com/mcp",
                "authorization_servers": ["https://auth.example.com"],
                "scopes_supported": ["mcp:read"],
                "bearer_methods_supported": ["header"],
            },
        )
        self.assertEqual(
            resource_metadata_url_from_mcp_endpoint("https://mcp.example.com/mcp"),
            "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        )
        self.assertEqual(
            protected_resource_www_authenticate("https://mcp.example.com/.well-known/oauth-protected-resource/mcp"),
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
        )
        self.assertEqual(protected_resource_www_authenticate(""), "Bearer")
        self.assertIsNone(rfc9728_resource_metadata_url("/mcp"))
        self.assertEqual(canonical_resource_url(" https://mcp.example.com/mcp/ "), "https://mcp.example.com/mcp")
        self.assertEqual(canonicalize_issuer_url("https://auth.example.com/"), "https://auth.example.com")
        self.assertIsNone(canonicalize_issuer_url("auth.example.com"))
        self.assertEqual(
            ProtectedResourceMetadata(
                resource="https://mcp.example.com/mcp",
                authorization_servers=["https://auth.example.com"],
                jwks_uri="https://mcp.example.com/jwks.json",
            ).to_json(),
            {
                "resource": "https://mcp.example.com/mcp",
                "authorization_servers": ["https://auth.example.com"],
                "jwks_uri": "https://mcp.example.com/jwks.json",
            },
        )
        metadata_response = protected_resource_metadata_handler(metadata)(_ctx())
        self.assertEqual(metadata_response.status, 200)
        with self.assertRaises(ValueError):
            new_protected_resource_metadata("/mcp", ["https://auth.example.com"])
        with self.assertRaises(ValueError):
            new_protected_resource_metadata("https://mcp.example.com/mcp", ["/auth"])

    def test_authorization_server_metadata_is_canonical(self) -> None:
        metadata = new_authorization_server_metadata("https://auth.example.com/")
        self.assertEqual(
            metadata.to_json(),
            {
                "issuer": "https://auth.example.com",
                "authorization_endpoint": "https://auth.example.com/authorize",
                "token_endpoint": "https://auth.example.com/token",
                "registration_endpoint": "https://auth.example.com/register",
                "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"],
            },
        )
        populated = AuthorizationServerMetadata(
            issuer="https://auth.example.com",
            scopes_supported=["mcp:read"],
            subject_types_supported=["public"],
            id_token_signing_alg_values_supported=["RS256"],
        )
        self.assertEqual(populated.to_json()["scopes_supported"], ["mcp:read"])
        self.assertEqual(populated.to_json()["subject_types_supported"], ["public"])
        self.assertEqual(populated.to_json()["id_token_signing_alg_values_supported"], ["RS256"])
        response = authorization_server_metadata_handler(metadata)(_ctx())
        self.assertEqual(response.status, 200)
        with self.assertRaises(ValueError):
            new_authorization_server_metadata("not-a-url")

    def test_bearer_middleware_distinguishes_unauthorized_and_forbidden(self) -> None:
        validator = new_memory_bearer_token_validator(
            [
                BearerTokenRecord(
                    token="valid",
                    subject="user-1",
                    audience="https://mcp.example.com/mcp",
                    scopes=["mcp:read"],
                    expires_at=dt.datetime.fromtimestamp(1_700_003_600, tz=dt.UTC),
                ),
                BearerTokenRecord(
                    token="scope-miss",
                    subject="user-1",
                    audience="https://mcp.example.com/mcp",
                    scopes=["mcp:write"],
                    expires_at=dt.datetime.fromtimestamp(1_700_003_600, tz=dt.UTC),
                ),
            ],
            BearerTokenValidationOptions(
                required_audience="https://mcp.example.com/mcp",
                required_scopes=["mcp:read"],
                now=lambda: dt.datetime.fromtimestamp(1_700_000_000, tz=dt.UTC),
            ),
        )
        mw = require_bearer_token_middleware(
            RequireBearerTokenOptions(resource_metadata_url="https://mcp.example.com/pr", claims_validator=validator)
        )
        missing = mw(_ctx(), lambda _ctx: self.fail("next should not run"))
        self.assertEqual(missing.status, 401)
        forbidden = mw(_ctx({"authorization": ["Bearer scope-miss"]}), lambda _ctx: self.fail("next should not run"))
        self.assertEqual(forbidden.status, 403)
        with self.assertRaises(OAuthBearerError) as raised:
            validator(_ctx(), "scope-miss")
        self.assertEqual(raised.exception.oauth_code, ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE)
        with self.assertRaises(OAuthBearerError) as raised:
            validator(_ctx(), "missing")
        self.assertEqual(raised.exception.oauth_code, ERR_INVALID_BEARER_TOKEN)
        accepted_ctx = _ctx({"authorization": ["Bearer valid"]})
        accepted = mw(
            accepted_ctx,
            lambda _ctx: Response(status=200, headers={}, cookies=[], body=b"", is_base64=False),
        )
        self.assertEqual(accepted.status, 200)
        self.assertEqual(bearer_token_claims_from_context(accepted_ctx).scopes, ["mcp:read"])

    def test_bearer_legacy_validator_and_scope_records_are_supported(self) -> None:
        with self.assertRaises(OAuthBearerError) as raised:
            bearer_token_from_headers({"authorization": ["Basic abc"]})
        self.assertEqual(raised.exception.oauth_code, ERR_INVALID_AUTHORIZATION_HEADER)
        validator = new_memory_bearer_token_validator(
            [
                BearerTokenRecord(token="", subject="ignored"),
                BearerTokenRecord(
                    token="scoped",
                    subject="user-2",
                    audience="https://mcp.example.com/mcp",
                    scope="mcp:read mcp:write",
                    expires_at=dt.datetime.fromtimestamp(1_700_003_600),
                ),
            ],
            BearerTokenValidationOptions(
                required_audience="https://mcp.example.com/mcp",
                required_scopes=["mcp:write"],
                now=lambda: dt.datetime.fromtimestamp(1_700_000_000),
            ),
        )
        claims = validator(_ctx(), "scoped")
        self.assertEqual(claims.scopes, ["mcp:read", "mcp:write"])
        legacy_calls: list[str] = []
        mw = require_bearer_token_middleware(
            RequireBearerTokenOptions(
                validator=lambda _ctx, token: legacy_calls.append(token),
            )
        )
        response = mw(
            _ctx({"authorization": ["Bearer legacy"]}),
            lambda _ctx: Response(status=202, headers={}, cookies=[], body=b"", is_base64=False),
        )
        self.assertEqual(response.status, 202)
        self.assertEqual(legacy_calls, ["legacy"])
        dict_ctx = _ctx()
        dict_ctx.set("oauth.bearer_claims", {"subject": "dict-user", "audience": "aud", "scopes": ["s1"]})
        self.assertEqual(bearer_token_claims_from_context(dict_ctx).subject, "dict-user")

    def test_dcr_policy_and_pkce_verifier_are_pinned(self) -> None:
        self.assertEqual(
            claude_dynamic_client_registration_policy().allowed_redirect_uris,
            [
                "https://claude.ai/api/mcp/auth_callback",
                "https://claude.com/api/mcp/auth_callback",
            ],
        )
        self.assertEqual(
            DynamicClientRegistrationResponse(
                client_id="client-1",
                client_secret="secret",
                client_id_issued_at=123,
                client_secret_expires_at=456,
            ).to_json(),
            {
                "client_id": "client-1",
                "client_secret": "secret",
                "client_id_issued_at": 123,
                "client_secret_expires_at": 456,
            },
        )
        validate_dynamic_client_registration_request(
            DynamicClientRegistrationRequest(
                redirect_uris=["https://claude.ai/api/mcp/auth_callback"],
                token_endpoint_auth_method="none",
                grant_types=["authorization_code", "refresh_token"],
                response_types=["code"],
            ),
            DynamicClientRegistrationPolicy(
                allowed_redirect_uris=["https://claude.ai/api/mcp/auth_callback"],
                require_public_client=True,
                require_refresh_token=True,
            ),
        )
        with self.assertRaises(ValueError):
            validate_dynamic_client_registration_request(
                {"redirect_uris": ["https://evil.example/callback"], "token_endpoint_auth_method": "none"},
                DynamicClientRegistrationPolicy(
                    allowed_redirect_uris=["https://claude.ai/api/mcp/auth_callback"],
                    require_public_client=True,
                ),
            )
        for payload in (
            {},
            {"redirect_uris": ["https://claude.ai/api/mcp/auth_callback"], "token_endpoint_auth_method": "secret"},
            {
                "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["refresh_token"],
            },
            {
                "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
            },
            {
                "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                "token_endpoint_auth_method": "none",
                "response_types": ["token"],
            },
        ):
            with self.assertRaises(ValueError):
                validate_dynamic_client_registration_request(
                    payload,
                    DynamicClientRegistrationPolicy(
                        allowed_redirect_uris=["https://claude.ai/api/mcp/auth_callback"],
                        require_public_client=True,
                        require_refresh_token=True,
                    ),
                )
        with self.assertRaises(ValueError):
            validate_dynamic_client_registration_request(None, DynamicClientRegistrationPolicy())
        verifier = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        self.assertEqual(pkce_challenge_s256(verifier), "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA")
        self.assertTrue(pkce_verify_s256(verifier, "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA"))
        self.assertGreaterEqual(len(new_pkce_code_verifier()), 43)
        with self.assertRaises(ValueError):
            validate_pkce_code_verifier("short")


if __name__ == "__main__":
    unittest.main()
