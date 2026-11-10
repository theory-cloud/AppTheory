from __future__ import annotations

# ruff: noqa: S106
import json
import unittest

from apptheory import (
    FacadeConfig,
    FrontDoorVerification,
    create_app,
    register_mcp_facade,
    supported_endpoint_templates,
)
from apptheory.oauth import RequireBearerTokenOptions
from apptheory.request import Request
from apptheory.response import Response

# FRONTED origin posture (#1258): the runtime verifies the declared front-door
# header on every derived route, fails registration when the posture is declared
# without the verification, and refuses a direct-origin request.

FRONT_DOOR_SECRET = "front-door-secret-0123456789-abcdefghi"
RESOURCE_METADATA_URL = "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp"


def base_config() -> FacadeConfig:
    scopes = {template["kind"]: ["namespace:use"] for template in supported_endpoint_templates()}
    return FacadeConfig(
        issuer_url="https://issuer.example.com/",
        jwks_uri="https://issuer.example.com/jwks.json?set=active",
        url_mode="public_base_url",
        public_base_url="https://front.example.com/",
        scopes=scopes,
        mcp_handler=lambda _ctx: _no_content(),
        transport_posture="runtime-bearer",
        require_bearer_token=RequireBearerTokenOptions(
            resource_metadata_url=RESOURCE_METADATA_URL,
            validator=lambda _ctx, _token: None,
        ),
    )


def _no_content() -> Response:
    return Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)


def fronted_config() -> FacadeConfig:
    config = base_config()
    config.origin_reachability = "fronted"
    config.front_door_verification = FrontDoorVerification(
        header_name="x-front-door",
        secret_value=FRONT_DOOR_SECRET,
    )
    return config


def serve(app, method: str, path: str, headers: dict[str, list[str]] | None = None) -> Response:
    return app.serve(
        Request(method=method, path=path, headers=dict(headers or {}), query={}, body=b"", is_base64=False)
    )


FRONT_DOOR_HEADERS = {
    "x-front-door": [FRONT_DOOR_SECRET],
    "authorization": ["Bearer admitted-token"],
}


class FrontDoorRegistrationTests(unittest.TestCase):
    def test_front_door_verification_fails_registration_closed(self) -> None:
        cases = [
            (
                "fronted without verification",
                {"origin_reachability": "fronted", "front_door_verification": None},
                "OriginReachability fronted requires FrontDoorVerification",
            ),
            (
                "verification without fronted",
                {
                    "front_door_verification": FrontDoorVerification(
                        header_name="x-front-door", secret_value=FRONT_DOOR_SECRET
                    )
                },
                "FrontDoorVerification is only valid with OriginReachability fronted",
            ),
            (
                "verification with disabled",
                {
                    "origin_reachability": "disabled",
                    "front_door_verification": FrontDoorVerification(
                        header_name="x-front-door", secret_value=FRONT_DOOR_SECRET
                    ),
                },
                "FrontDoorVerification is only valid with OriginReachability fronted",
            ),
            (
                "unknown posture",
                {"origin_reachability": "asserted"},
                "OriginReachability must be disabled, locked, or fronted",
            ),
            (
                "header name alphabet",
                {
                    "origin_reachability": "fronted",
                    "front_door_verification": FrontDoorVerification(
                        header_name="x front door", secret_value=FRONT_DOOR_SECRET
                    ),
                },
                "FrontDoorVerification header name must be 1 to 64 characters of [A-Za-z0-9-]",
            ),
            (
                "reserved header name",
                {
                    "origin_reachability": "fronted",
                    "front_door_verification": FrontDoorVerification(
                        header_name="Authorization", secret_value=FRONT_DOOR_SECRET
                    ),
                },
                "must be a request header the front door can set",
            ),
            (
                "platform header name",
                {
                    "origin_reachability": "fronted",
                    "front_door_verification": FrontDoorVerification(
                        header_name="x-amzn-trace-id", secret_value=FRONT_DOOR_SECRET
                    ),
                },
                "must be a request header the front door can set",
            ),
            (
                "secret alphabet",
                {
                    "origin_reachability": "fronted",
                    "front_door_verification": FrontDoorVerification(
                        header_name="x-front-door", secret_value="short"
                    ),
                },
                "FrontDoorVerification secret value must be 32 to 128 characters of [A-Za-z0-9._~-]",
            ),
        ]
        for name, overrides, message in cases:
            with self.subTest(name=name):
                config = base_config()
                for key, value in overrides.items():
                    setattr(config, key, value)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn(message, str(raised.exception))

    def test_disabled_and_locked_stay_registration_valid(self) -> None:
        for posture in ("", "disabled", "locked"):
            with self.subTest(posture=posture):
                config = base_config()
                config.origin_reachability = posture
                register_mcp_facade(create_app(tier="p0"), config)


class FrontDoorRequestTests(unittest.TestCase):
    def test_front_door_verification_refuses_direct_origin_requests(self) -> None:
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, fronted_config())
        route = inventory.routes[0]

        self.assertEqual(serve(app, "POST", route.mcp_pattern, FRONT_DOOR_HEADERS).status, 204)
        for method in ("POST", "GET", "DELETE"):
            denied = serve(app, method, route.mcp_pattern)
            self.assertEqual(denied.status, 403, f"{method} {route.mcp_pattern} is refused")
            body = json.loads(bytes(denied.body).decode("utf-8"))
            self.assertEqual(body["error"]["code"], "app.forbidden")

        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, {"x-front-door": ["b" * len(FRONT_DOOR_SECRET)]}).status,
            403,
        )
        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, {"x-front-door": [FRONT_DOOR_SECRET[:-1]]}).status,
            403,
        )

        # OAuth facade documents are part of the same inventory.
        self.assertEqual(serve(app, "GET", route.protected_resource_pattern).status, 403)
        self.assertEqual(serve(app, "GET", route.discovery_canonical_pattern).status, 403)
        self.assertEqual(serve(app, "GET", route.discovery_suffix_pattern).status, 403)
        self.assertEqual(
            serve(app, "GET", route.protected_resource_pattern, FRONT_DOOR_HEADERS).status,
            200,
        )

    def test_front_door_guard_runs_before_the_bearer_guard(self) -> None:
        config = fronted_config()
        config.require_bearer_token = RequireBearerTokenOptions(resource_metadata_url=RESOURCE_METADATA_URL)
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, config)
        route = inventory.routes[0]

        self.assertEqual(serve(app, "POST", route.mcp_pattern).status, 403)
        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, {"x-front-door": [FRONT_DOOR_SECRET]}).status,
            401,
        )


if __name__ == "__main__":
    unittest.main()
