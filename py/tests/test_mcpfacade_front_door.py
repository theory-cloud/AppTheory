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

    def test_front_door_secret_refuses_trailing_newline(self) -> None:
        # Python's `$` matches before a trailing newline; the secret anchor must
        # stay \Z so registration accepts exactly the construct/Go/TS alphabet.
        config = base_config()
        config.origin_reachability = "fronted"
        config.front_door_verification = FrontDoorVerification(
            header_name="x-front-door", secret_value=f"{FRONT_DOOR_SECRET}\n"
        )
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn(
            "FrontDoorVerification secret value must be 32 to 128 characters of [A-Za-z0-9._~-]",
            str(raised.exception),
        )

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


# Parameter form: the value lives in a well-known, stage-qualified parameter, is
# read lazily in the request path, cached, and refreshed on a mismatch or after
# the TTL, so a rotation takes effect without a redeploy. An unreadable
# parameter fails closed.

FRONT_DOOR_PARAMETER = "/theorycloud/apptheory/test/fronted/origin-token"


class _StubReader:
    def __init__(self, value: str = "", error: Exception | None = None) -> None:
        self.value = value
        self.error = error
        self.calls = 0
        self.params: list[str] = []

    def __call__(self, parameter_name: str) -> str:
        self.calls += 1
        self.params.append(parameter_name)
        if self.error is not None:
            raise self.error
        return self.value


def parameter_config(reader: _StubReader, **overrides: object) -> FacadeConfig:
    config = base_config()
    config.origin_reachability = "fronted"
    config.front_door_verification = FrontDoorVerification(
        header_name="x-front-door",
        secret_parameter_name=FRONT_DOOR_PARAMETER,
    )
    config.front_door_secret_reader = reader
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def front_door_headers_for(secret: str) -> dict[str, list[str]]:
    return {"x-front-door": [secret], "authorization": ["Bearer admitted-token"]}


ROTATED_SECRET = "rotated-front-door-secret-0123456789-abcdef"


class FrontDoorParameterRegistrationTests(unittest.TestCase):
    def test_parameter_form_fails_registration_closed(self) -> None:
        cases: list[tuple[str, dict[str, object], str]] = [
            (
                "both secret forms",
                {"secret_value": FRONT_DOOR_SECRET},
                "requires exactly one of secret_value and secret_parameter_name",
            ),
            (
                "neither secret form",
                {"secret_parameter_name": None},
                "requires exactly one of secret_value and secret_parameter_name",
            ),
            (
                "name without a leading slash",
                {"secret_parameter_name": "theorycloud/apptheory/fronted"},
                "must be a fully qualified SSM parameter name",
            ),
            (
                "name with a colon",
                {"secret_parameter_name": "/theorycloud/apptheory:fronted"},
                "must be a fully qualified SSM parameter name",
            ),
            (
                "name with an empty segment",
                {"secret_parameter_name": "/theorycloud//fronted"},
                "must be a fully qualified SSM parameter name",
            ),
            (
                "name with a trailing slash",
                {"secret_parameter_name": "/theorycloud/apptheory/"},
                "must be a fully qualified SSM parameter name",
            ),
            (
                "reserved aws hierarchy",
                {"secret_parameter_name": "/aws/apptheory/fronted"},
                "must not use the reserved aws or ssm hierarchy",
            ),
            (
                "reserved ssm hierarchy",
                {"secret_parameter_name": "/SSM/apptheory/fronted"},
                "must not use the reserved aws or ssm hierarchy",
            ),
            (
                "too many levels",
                {"secret_parameter_name": "/" + "/".join(f"l{index}" for index in range(16))},
                "must have between one and fifteen hierarchy levels",
            ),
            (
                "longer than 1011 characters",
                {"secret_parameter_name": "/" + "a" * 1011},
                "must be a fully qualified SSM parameter name",
            ),
        ]
        for name, overrides, message in cases:
            with self.subTest(name=name):
                reader = _StubReader(FRONT_DOOR_SECRET)
                config = parameter_config(reader)
                for key, value in overrides.items():
                    setattr(config.front_door_verification, key, value)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn(message, str(raised.exception))
                self.assertEqual(reader.calls, 0, "registration never reads the parameter")

    def test_ttl_is_bounded(self) -> None:
        for ttl in (0.0, -1.0, 3601.0, float("inf")):
            with self.subTest(ttl=ttl):
                reader = _StubReader(FRONT_DOOR_SECRET)
                config = parameter_config(reader, front_door_secret_ttl_seconds=ttl)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn("front_door_secret_ttl_seconds must be greater than zero", str(raised.exception))

    def test_default_ttl_constants_are_bounded(self) -> None:
        from apptheory import DEFAULT_FRONT_DOOR_SECRET_TTL_SECONDS, MAX_FRONT_DOOR_SECRET_TTL_SECONDS

        self.assertEqual(DEFAULT_FRONT_DOOR_SECRET_TTL_SECONDS, 300.0)
        self.assertEqual(MAX_FRONT_DOOR_SECRET_TTL_SECONDS, 3600.0)


class FrontDoorParameterRequestTests(unittest.TestCase):
    def test_parameter_form_reads_lazily_and_refuses_direct_origin_requests(self) -> None:
        reader = _StubReader(FRONT_DOOR_SECRET)
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, parameter_config(reader))
        route = inventory.routes[0]
        self.assertEqual(reader.calls, 0, "registration performs no read")

        self.assertEqual(serve(app, "POST", route.mcp_pattern, front_door_headers_for(FRONT_DOOR_SECRET)).status, 204)
        self.assertEqual(reader.calls, 1)
        self.assertEqual(reader.params, [FRONT_DOOR_PARAMETER])

        self.assertEqual(serve(app, "POST", route.mcp_pattern).status, 403)
        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, {"x-front-door": ["b" * len(FRONT_DOOR_SECRET)]}).status,
            403,
        )
        self.assertEqual(serve(app, "GET", route.protected_resource_pattern).status, 403)

    def test_parameter_form_fails_closed_when_unreadable(self) -> None:
        cases = [
            ("read error", _StubReader("", error=RuntimeError("AccessDeniedException"))),
            ("empty value", _StubReader("")),
            ("value outside the alphabet", _StubReader("contains a space and is long enough")),
            ("value too short", _StubReader("short")),
        ]
        for name, reader in cases:
            with self.subTest(name=name):
                app = create_app(tier="p0")
                inventory = register_mcp_facade(app, parameter_config(reader))
                route = inventory.routes[0]
                self.assertEqual(
                    serve(app, "POST", route.mcp_pattern, front_door_headers_for(FRONT_DOOR_SECRET)).status,
                    403,
                )
                self.assertEqual(serve(app, "GET", route.protected_resource_pattern).status, 403)

    def test_parameter_form_refreshes_on_mismatch_bounded_by_the_floor(self) -> None:
        import time

        reader = _StubReader(FRONT_DOOR_SECRET)
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, parameter_config(reader, front_door_secret_ttl_seconds=3600.0))
        route = inventory.routes[0]

        self.assertEqual(serve(app, "POST", route.mcp_pattern, front_door_headers_for(FRONT_DOOR_SECRET)).status, 204)
        self.assertEqual(reader.calls, 1)

        time.sleep(1.05)
        reader.value = ROTATED_SECRET
        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, front_door_headers_for(ROTATED_SECRET)).status,
            204,
            "the first request after the floor carrying the rotated value is admitted",
        )
        self.assertEqual(reader.calls, 2, "a mismatch forces exactly one refresh")

        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, {"x-front-door": ["c" * len(ROTATED_SECRET)]}).status,
            403,
        )
        self.assertEqual(reader.calls, 2, "the refresh floor bounds forced reads")
        self.assertEqual(serve(app, "POST", route.mcp_pattern, front_door_headers_for(ROTATED_SECRET)).status, 204)

    def test_parameter_form_refreshes_after_the_ttl(self) -> None:
        import time

        reader = _StubReader(FRONT_DOOR_SECRET)
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, parameter_config(reader, front_door_secret_ttl_seconds=0.05))
        route = inventory.routes[0]

        self.assertEqual(serve(app, "POST", route.mcp_pattern, front_door_headers_for(FRONT_DOOR_SECRET)).status, 204)
        reader.value = ROTATED_SECRET
        time.sleep(0.08)

        self.assertEqual(serve(app, "POST", route.mcp_pattern, front_door_headers_for(ROTATED_SECRET)).status, 204)
        self.assertEqual(reader.calls, 2, "the TTL re-reads the parameter")
        self.assertEqual(
            serve(app, "POST", route.mcp_pattern, front_door_headers_for(FRONT_DOOR_SECRET)).status,
            403,
            "the rotated-out value is no longer accepted",
        )
