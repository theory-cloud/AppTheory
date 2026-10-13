from __future__ import annotations

# ruff: noqa: S106
import datetime as dt
import unittest

from apptheory import (
    App,
    BearerTokenRecord,
    BearerTokenValidationOptions,
    RequireBearerTokenOptions,
    assert_bearer_token_reaches_transport_handler,
    assert_credential_free_transport_denied,
    assert_insufficient_scope_transport_denied,
    counting_transport_handler,
    create_app,
    new_memory_bearer_token_validator,
    register_mcp_facade,
)
from apptheory.request import Request
from apptheory.response import Response

RESOURCE_METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"
REMEDIATION_SCOPES = ["namespace:use"]
NOW = dt.datetime.fromtimestamp(1_700_000_000, tz=dt.UTC)


def _bearer_options() -> RequireBearerTokenOptions:
    return RequireBearerTokenOptions(
        resource_metadata_url=RESOURCE_METADATA_URL,
        claims_validator=new_memory_bearer_token_validator(
            [BearerTokenRecord(token="valid-token", subject="acme", audience="https://mcp.example.com")]
        ),
    )


def _scope_starved_options() -> RequireBearerTokenOptions:
    return RequireBearerTokenOptions(
        resource_metadata_url=RESOURCE_METADATA_URL,
        claims_validator=new_memory_bearer_token_validator(
            [
                BearerTokenRecord(
                    token="scope-miss",
                    subject="acme",
                    audience="https://mcp.example.com",
                    scopes=["mcp:read"],
                    expires_at=NOW + dt.timedelta(hours=1),
                )
            ],
            BearerTokenValidationOptions(
                required_scopes_func=lambda _ctx: REMEDIATION_SCOPES,
                now=lambda: NOW,
            ),
        ),
        required_scopes_func=lambda _ctx: REMEDIATION_SCOPES,
    )


def _probe(app: App, path: str = "/acme/mcp") -> Response:
    return app.serve(Request(method="POST", path=path, headers={}, query={}, body=b"", is_base64=False))


class McpFacadeTests(unittest.TestCase):
    def test_runtime_bearer_denies_credential_free_transport_and_admits_a_valid_token(self) -> None:
        app = create_app()
        handler = counting_transport_handler()
        registration = register_mcp_facade(
            app,
            ["/acme/mcp"],
            handler,
            transport_posture="runtime-bearer",
            require_bearer_token=_bearer_options(),
        )
        self.assertEqual(registration.transport_posture, "runtime-bearer")
        self.assertEqual(registration.transport_paths, ["/acme/mcp"])

        assert_credential_free_transport_denied(app, "POST", "/acme/mcp", RESOURCE_METADATA_URL, handler)
        self.assertEqual(handler.invocations, 0)
        assert_bearer_token_reaches_transport_handler(app, "POST", "/acme/mcp", "valid-token", handler)
        self.assertEqual(handler.invocations, 1)

    def test_runtime_bearer_emits_the_insufficient_scope_challenge(self) -> None:
        app = create_app()
        handler = counting_transport_handler()
        register_mcp_facade(
            app,
            ["/acme/mcp"],
            handler,
            transport_posture="runtime-bearer",
            require_bearer_token=_scope_starved_options(),
        )

        assert_insufficient_scope_transport_denied(
            app, "POST", "/acme/mcp", "scope-miss", RESOURCE_METADATA_URL, REMEDIATION_SCOPES, handler
        )
        self.assertEqual(handler.invocations, 0)

    def test_default_posture_is_iam(self) -> None:
        app = create_app()
        handler = counting_transport_handler()
        registration = register_mcp_facade(app, ["/acme/mcp"], handler)
        self.assertEqual(registration.transport_posture, "iam")
        # The M1 skeleton relies on the gateway authorizer for iam, so the
        # runtime registers the handler directly.
        self.assertEqual(_probe(app).status, 204)
        self.assertEqual(handler.invocations, 1)

    def test_registration_fails_closed_before_any_route_is_added(self) -> None:
        cases: list[tuple[str, dict[str, object], str]] = [
            (
                "runtime-bearer without a bearer assertion",
                {"transport_posture": "runtime-bearer"},
                "transport_posture runtime-bearer requires require_bearer_token",
            ),
            (
                "iam with a bearer assertion",
                {"transport_posture": "iam", "require_bearer_token": _bearer_options()},
                "require_bearer_token is only valid with transport_posture runtime-bearer",
            ),
            (
                "jwt with a bearer assertion",
                {"transport_posture": "jwt", "require_bearer_token": _bearer_options()},
                "require_bearer_token is only valid with transport_posture runtime-bearer",
            ),
            (
                "none-public with a bearer assertion",
                {"transport_posture": "none-public", "require_bearer_token": _bearer_options()},
                "transport_posture none-public cannot be combined with require_bearer_token",
            ),
            (
                "unknown posture",
                {"transport_posture": "unauthenticated"},
                "must be one of iam, jwt, runtime-bearer, none-public",
            ),
        ]
        for name, kwargs, message in cases:
            with self.subTest(name=name):
                app = create_app()
                handler = counting_transport_handler()
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(app, ["/acme/mcp"], handler, **kwargs)
                self.assertIn(message, str(raised.exception))
                self.assertEqual(_probe(app).status, 404)
                self.assertEqual(handler.invocations, 0)

    def test_mcp_paths_are_validated_before_any_route_is_added(self) -> None:
        app = create_app()
        handler = counting_transport_handler()
        for mcp_paths in ([], [""], ["relative/mcp"], [42]):
            with self.subTest(mcp_paths=mcp_paths):
                with self.assertRaises(ValueError):
                    register_mcp_facade(app, mcp_paths, handler, transport_posture="none-public")
        self.assertEqual(handler.invocations, 0)
