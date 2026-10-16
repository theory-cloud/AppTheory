from __future__ import annotations

# ruff: noqa: S106
import json
import unittest
from pathlib import Path

from apptheory import (
    CONTRACT_VERSION,
    ISSUER_MODE_FAMILY,
    ISSUER_MODE_ROUTE,
    URL_MODE_PUBLIC_BASE_URL,
    URL_MODE_REQUEST_HOST,
    BearerTokenRecord,
    FacadeCapabilities,
    FacadeConfig,
    RootDiscoveryConfig,
    Stores,
    create_app,
    default_capabilities,
    register_mcp_facade,
    supported_issuer_modes,
)
from apptheory.mcpfacade import (
    METADATA_VARY_HEADER,
    TRANSPORT_POSTURES,
    _absolute_url_for_path,
    _metadata_request_failure,
    _MetadataRequestError,
    _normalize_allowed_hostname,
    _normalize_public_base_url,
    _RouteRegistration,
    _validate_route_registrations,
    normalize_request_origin,
)
from apptheory.mcproutes import (
    DEFAULT_CALLBACK_PATH,
    EndpointPath,
    authorization_server_path_for_resource_path,
    supported_endpoint_templates,
    supported_oauth_discovery_templates,
    supported_oauth_facade_templates,
)
from apptheory.oauth import RequireBearerTokenOptions, new_memory_bearer_token_validator
from apptheory.oauth.provider import (
    AuthorizationRequest,
    CodeExchangeRequest,
    ProviderMetadata,
    RefreshRequest,
    TokenClaims,
    TokenExpectations,
    TokenSet,
)
from apptheory.oauth.store import (
    MemoryAuthorizationCodeStore,
    MemoryClientStore,
    MemoryRateLimitStore,
    MemoryRouteRefreshBrokerStore,
    MemoryTransactionStore,
)
from apptheory.request import Request
from apptheory.response import Response, text

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ALGEBRA_FIXTURES = _REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-route-algebra"
_AUTH_FACADE_FIXTURES = _REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"

_EXPECTATIONS_PATH = _ALGEBRA_FIXTURES / "expectations.json"
_ROUTE_INVENTORY_PATH = _ALGEBRA_FIXTURES / "facade-route-inventory.json"
_TRANSPORT_POSTURE_PATH = _AUTH_FACADE_FIXTURES / "facade-transport-posture.v1.json"
_ROUTE_MODEL_PATH = _AUTH_FACADE_FIXTURES / "facade-route-model.v1.json"

_RESOURCE_METADATA_URL = "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp"

_TEST_ENDPOINTS: tuple[EndpointPath, ...] = (
    EndpointPath(kind="namespace", client_namespace="acme"),
    EndpointPath(kind="partner_namespace", client_namespace="acme", partner_id="reseller"),
    EndpointPath(kind="agent", client_namespace="acme", agent_id="helper"),
    EndpointPath(kind="partner_agent", client_namespace="acme", partner_id="reseller", agent_id="helper"),
)


def _no_content(_ctx) -> Response:
    return Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)


def _callback(_ctx) -> Response:
    return text(200, "callback")


def _kind_handler_factory(prefix: str):
    def factory(kind: str):
        def handler(_ctx) -> Response:
            return text(200, f"{prefix}:{kind}")

        return handler

    return factory


def _valid_config(mode: str) -> FacadeConfig:
    config = FacadeConfig(
        issuer_url="https://issuer.example.com/",
        jwks_uri="https://issuer.example.com/jwks.json?set=active",
        url_mode=mode,
        public_base_url="https://front.example.com/",
        scopes={
            "namespace": ["namespace:use"],
            "partner_namespace": ["partner_namespace:use"],
            "agent": ["agent:use"],
            "partner_agent": ["partner_agent:use"],
        },
        mcp_handler=_no_content,
        transport_posture="iam",
    )
    if mode == URL_MODE_REQUEST_HOST:
        config.public_base_url = ""
        config.allowed_hostnames = ["direct.example.com", "api.example.com"]
    return config


def _valid_root_discovery_config() -> RootDiscoveryConfig:
    return RootDiscoveryConfig(
        issuer_url="https://accounts.example.com",
        authorization_endpoint_url="https://accounts.example.com/authorize",
        token_endpoint_url="https://accounts.example.com/token",
        registration_endpoint_url="https://accounts.example.com/register",
        jwks_uri="https://accounts.example.com/.well-known/jwks.json",
        scopes=["openid", "offline_access", "mcp:tools"],
    )


def _request(method: str, path: str, headers: dict[str, list[str]] | None = None) -> Request:
    return Request(method=method, path=path, headers=dict(headers or {}), query={}, body=b"", is_base64=False)


def _serve(app, method: str, path: str, headers: dict[str, list[str]] | None = None) -> Response:
    return app.serve(_request(method, path, headers))


def _bearer_options() -> RequireBearerTokenOptions:
    return RequireBearerTokenOptions(
        resource_metadata_url=_RESOURCE_METADATA_URL,
        claims_validator=new_memory_bearer_token_validator(
            [BearerTokenRecord(token="valid-token", subject="acme", audience="https://front.example.com")]
        ),
    )


class McpFacadeContractSurfaceTests(unittest.TestCase):
    def test_registers_complete_contract_surface(self) -> None:
        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.authorize_handler = _kind_handler_factory("authorize")
        config.token_handler = _kind_handler_factory("token")
        config.register_handler = _kind_handler_factory("register")
        config.callback_handler = _callback

        inventory = register_mcp_facade(app, config)
        self.assertEqual(CONTRACT_VERSION, inventory.contract_version)
        self.assertEqual(ISSUER_MODE_FAMILY, inventory.issuer_mode)
        self.assertEqual(DEFAULT_CALLBACK_PATH, inventory.callback_pattern)
        self.assertEqual(4, len(inventory.routes))

        endpoints = supported_endpoint_templates()
        facades = supported_oauth_facade_templates()
        discovery = supported_oauth_discovery_templates()
        for index, route in enumerate(inventory.routes):
            self.assertEqual(endpoints[index]["kind"], route.kind)
            self.assertEqual(endpoints[index]["mcp_pattern"], route.mcp_pattern)
            self.assertEqual(["POST", "GET", "DELETE"], route.mcp_methods)
            self.assertEqual(endpoints[index]["protected_resource_path"], route.protected_resource_pattern)
            self.assertEqual(discovery[index]["canonical_pattern"], route.discovery_canonical_pattern)
            self.assertEqual(discovery[index]["suffix_pattern"], route.discovery_suffix_pattern)
            self.assertEqual(facades[index]["authorize_pattern"], route.authorize_pattern)
            self.assertEqual(facades[index]["token_pattern"], route.token_pattern)
            self.assertEqual(facades[index]["register_pattern"], route.register_pattern)
            self.assertTrue(route.authorization_routes_attached)

        # Literal spots keep this test independent of an accidentally reduced algebra enumeration.
        self.assertEqual("/{client_namespace}/mcp", inventory.routes[0].mcp_pattern)
        self.assertEqual(
            "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/mcp",
            inventory.routes[1].protected_resource_pattern,
        )
        self.assertEqual(
            "/{client_namespace}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server",
            inventory.routes[2].discovery_suffix_pattern,
        )
        self.assertEqual(
            "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/token",
            inventory.routes[3].token_pattern,
        )

        for endpoint in _TEST_ENDPOINTS:
            mcp_path = endpoint.mcp_path()
            for method in ("POST", "GET", "DELETE"):
                response = _serve(app, method, mcp_path)
                self.assertEqual(204, response.status, f"{method} {mcp_path}: {response.body!r}")

            self.assertEqual(200, _serve(app, "GET", endpoint.protected_resource_path()).status)
            self.assertEqual(200, _serve(app, "GET", endpoint.oauth_authorization_server_path()).status)
            self.assertEqual(200, _serve(app, "GET", endpoint.oauth_authorization_server_suffix_path()).status)

            authorize = _serve(app, "GET", endpoint.oauth_authorize_path())
            self.assertEqual(200, authorize.status)
            self.assertEqual(f"authorize:{endpoint.kind}", authorize.body.decode())
            token = _serve(app, "POST", endpoint.oauth_token_path())
            self.assertEqual(200, token.status)
            self.assertEqual(f"token:{endpoint.kind}", token.body.decode())
            register = _serve(app, "POST", endpoint.oauth_register_path())
            self.assertEqual(200, register.status)
            self.assertEqual(f"register:{endpoint.kind}", register.body.decode())

        callback = _serve(app, "GET", DEFAULT_CALLBACK_PATH)
        self.assertEqual(200, callback.status)
        self.assertEqual("callback", callback.body.decode())

    def test_inventory_matches_shared_construct_fixture(self) -> None:
        fixture = json.loads(_ROUTE_INVENTORY_PATH.read_text(encoding="utf-8"))

        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.authorize_handler = _kind_handler_factory("authorize")
        config.token_handler = _kind_handler_factory("token")
        inventory = register_mcp_facade(app, config)

        actual = {
            "contract_version": inventory.contract_version,
            "routes": [
                {
                    "kind": route.kind,
                    "mcp_pattern": route.mcp_pattern,
                    "mcp_methods": route.mcp_methods,
                    "protected_resource_pattern": route.protected_resource_pattern,
                    "discovery_canonical_pattern": route.discovery_canonical_pattern,
                    "discovery_suffix_pattern": route.discovery_suffix_pattern,
                    "authorize_pattern": route.authorize_pattern,
                    "token_pattern": route.token_pattern,
                    "register_pattern": route.register_pattern,
                    "authorization_routes_attached": route.authorization_routes_attached,
                }
                for route in inventory.routes
            ],
            "root_authorization_server_pattern": inventory.root_authorization_server_pattern,
            "root_authorization_server_attached": inventory.root_authorization_server_attached,
            "callback_pattern": inventory.callback_pattern,
            "issuer_mode": inventory.issuer_mode,
        }
        self.assertEqual(fixture, actual)


class McpFacadeMetadataDocumentTests(unittest.TestCase):
    def test_app_owned_authorize_routed_metadata_omits_rfc9207_iss_parameter_support(self) -> None:
        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.root_authorization_server = _valid_root_discovery_config()
        # The application-owned authorize/token pair: provider stays unset, so
        # the facade has no front channel and cannot prove `iss` is sent on the
        # client callback.
        config.authorize_handler = _kind_handler_factory("authorize")
        config.token_handler = _kind_handler_factory("token")
        inventory = register_mcp_facade(app, config)
        self.assertTrue(inventory.root_authorization_server_attached)

        for route in inventory.routes:
            with self.subTest(kind=route.kind):
                self.assertTrue(route.authorization_routes_attached)
                # The app-owned authorize route really is mounted and served by
                # the application, so the omission below is the app-owned
                # surface's disposition and not a missing route.
                authorize = _serve(app, "GET", route.authorize_pattern)
                self.assertEqual(200, authorize.status)
                self.assertEqual(f"authorize:{route.kind}", authorize.body.decode())

                for path in (route.discovery_canonical_pattern, route.discovery_suffix_pattern):
                    with self.subTest(path=path):
                        response = _serve(app, "GET", path)
                        self.assertEqual(200, response.status)
                        self.assertNotIn(
                            "authorization_response_iss_parameter_supported",
                            response.body.decode(),
                        )

        # Root discovery describes the upstream authorization server, so it does
        # not claim `iss` support either.
        root = _serve(app, "GET", inventory.root_authorization_server_pattern)
        self.assertEqual(200, root.status)
        self.assertNotIn("authorization_response_iss_parameter_supported", root.body.decode())

    def test_shared_fixture_pins_routed_document_bytes_per_kind_and_mode(self) -> None:
        documents = json.loads(_EXPECTATIONS_PATH.read_text(encoding="utf-8"))["documents"]
        self.assertEqual(10, len(documents))

        request_host_headers = {"host": ["direct.example.com"], "x-forwarded-proto": ["https"]}
        for row in documents:
            with self.subTest(name=row["name"]):
                app = create_app(tier="p0")
                config = _valid_config(row["mode"])
                if row.get("jwks_uri") is not None:
                    config.jwks_uri = row["jwks_uri"]
                if row.get("scopes") is not None:
                    config.scopes = {**config.scopes, row["kind"]: row["scopes"]}
                register_mcp_facade(app, config)
                headers = request_host_headers if row["mode"] == URL_MODE_REQUEST_HOST else None

                protected = _serve(app, "GET", row["protected_resource_path"], headers)
                self.assertEqual(200, protected.status)
                self.assertEqual(row["protected_resource_document"], protected.body.decode())

                canonical = _serve(app, "GET", row["authorization_server_path"], headers)
                self.assertEqual(200, canonical.status)
                self.assertEqual(row["authorization_server_document"], canonical.body.decode())

                suffix = _serve(app, "GET", row["authorization_server_suffix_path"], headers)
                self.assertEqual(200, suffix.status)
                self.assertEqual(row["authorization_server_document"], suffix.body.decode())

    def test_advertised_urls_match_the_shared_normalization_rows(self) -> None:
        rows = json.loads(_EXPECTATIONS_PATH.read_text(encoding="utf-8"))["url_normalization"]
        self.assertEqual(66, len(rows))

        for row in rows:
            with self.subTest(name=row["name"]):
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                if row["issuer"]:
                    config.issuer_url = row["input"]
                else:
                    config.jwks_uri = row["input"]
                    config.registration_endpoint_url = row["input"]
                # The registration URL is advertised only while the register
                # route is mounted, so the row's expected endpoint is observable.
                config.register_handler = _kind_handler_factory("register")

                if row.get("reject"):
                    with self.assertRaises(ValueError):
                        register_mcp_facade(create_app(tier="p0"), config)
                    continue

                app = create_app(tier="p0")
                register_mcp_facade(app, config)
                document = json.loads(
                    _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp").body.decode()
                )
                if row["issuer"]:
                    self.assertEqual(row["expect"], document["issuer"])
                    # The registration endpoint derives from the normalized issuer.
                    self.assertEqual(f"{row['expect']}/register", document["registration_endpoint"])
                else:
                    self.assertEqual(row["expect"], document["jwks_uri"])
                    self.assertEqual(row["expect"], document["registration_endpoint"])

    def test_registration_rejections_match_the_shared_rejection_rows(self) -> None:
        rows = json.loads(_EXPECTATIONS_PATH.read_text(encoding="utf-8"))["rejection_rows"]
        self.assertEqual(51, len(rows))

        for row in rows:
            with self.subTest(name=row["name"]):
                mode = URL_MODE_REQUEST_HOST if row["kind"] == "allowed_hostname" else URL_MODE_PUBLIC_BASE_URL
                config = _valid_config(mode)
                if row["kind"] == "allowed_hostname":
                    config.allowed_hostnames = [row["input"]]
                elif row["kind"] == "issuer":
                    config.issuer_url = row["input"]
                elif row["kind"] == "registration":
                    # The registration endpoint option normalizes through the
                    # same non-issuer rule, so a row pins the endpoint itself.
                    config.registration_endpoint_url = row["input"]
                elif row["kind"] == "scope":
                    # A lone surrogate cannot be JSON text, so the row names the
                    # malformed code point and the runner builds the ill-formed value.
                    self.assertEqual("lone_surrogate", row["input_malformed"])
                    config.scopes = dict(config.scopes)
                    config.scopes["namespace"] = [row["input_prefix"] + "\ud800" + row["input_suffix"]]
                else:
                    config.jwks_uri = row["input"]
                    config.registration_endpoint_url = row["input"]

                if row.get("reject"):
                    with self.assertRaises(ValueError):
                        register_mcp_facade(create_app(tier="p0"), config)
                    continue

                app = create_app(tier="p0")
                register_mcp_facade(app, config)
                if row["kind"] == "allowed_hostname":
                    response = _serve(
                        app,
                        "GET",
                        "/.well-known/oauth-protected-resource/acme/mcp",
                        {"host": [row["input"]], "x-forwarded-proto": ["https"]},
                    )
                    self.assertEqual(200, response.status)
                    self.assertEqual(
                        f"https://{row['accept']['value']}/acme/mcp",
                        json.loads(response.body.decode())["resource"],
                    )
                else:
                    document = json.loads(
                        _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp").body.decode()
                    )
                    if row["kind"] == "issuer":
                        self.assertEqual(row["accept"]["value"], document["issuer"])
                    else:
                        self.assertEqual(row["accept"]["value"], document["jwks_uri"])

    def test_request_host_allowlist_canonicalizes_the_request_authority(self) -> None:
        rows = json.loads(_EXPECTATIONS_PATH.read_text(encoding="utf-8"))["request_host_allowlist"]
        self.assertEqual(6, len(rows))

        for row in rows:
            with self.subTest(name=row["name"]):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_REQUEST_HOST)
                config.allowed_hostnames = list(row["allowed_hostnames"])
                register_mcp_facade(app, config)
                response = _serve(
                    app,
                    "GET",
                    "/.well-known/oauth-protected-resource/acme/mcp",
                    {"host": [row["request_host"]], "x-forwarded-proto": ["https"]},
                )
                self.assertEqual(row["expect_status"], response.status, row["name"])
                if row["expect_status"] != 200:
                    self.assertEqual(b'{"error":"invalid_request_host"}', response.body, row["name"])
                    continue
                self.assertEqual(
                    row["expect_resource"],
                    json.loads(response.body.decode())["resource"],
                    row["name"],
                )

    def test_every_metadata_response_is_no_store_and_varies_on_origin_headers(self) -> None:
        for mode in (URL_MODE_PUBLIC_BASE_URL, URL_MODE_REQUEST_HOST):
            with self.subTest(mode=mode):
                app = create_app(tier="p0")
                config = _valid_config(mode)
                config.root_authorization_server = _valid_root_discovery_config()
                register_mcp_facade(app, config)
                headers = (
                    {"host": ["direct.example.com"], "x-forwarded-proto": ["https"]}
                    if mode == URL_MODE_REQUEST_HOST
                    else None
                )
                for endpoint in _TEST_ENDPOINTS:
                    for path in (
                        endpoint.protected_resource_path(),
                        endpoint.oauth_authorization_server_path(),
                        endpoint.oauth_authorization_server_suffix_path(),
                    ):
                        response = _serve(app, "GET", path, headers)
                        self.assertEqual(200, response.status)
                        _assert_metadata_headers(self, response)

                root = _serve(app, "GET", authorization_server_path_for_resource_path("/"), headers)
                self.assertEqual(200, root.status)
                _assert_metadata_headers(self, root)

    def test_request_host_mode_uses_normalized_request_headers(self) -> None:
        app = create_app(tier="p0")
        register_mcp_facade(app, _valid_config(URL_MODE_REQUEST_HOST))

        response = _serve(
            app,
            "GET",
            "/.well-known/oauth-protected-resource/acme/mcp",
            {"host": ["Direct.Example.com.:443"], "x-forwarded-proto": ["https"]},
        )
        self.assertEqual(200, response.status)
        self.assertEqual(
            '{"resource":"https://direct.example.com/acme/mcp","authorization_servers":["https://issuer.example.com"],'
            '"jwks_uri":"https://issuer.example.com/jwks.json?set=active","scopes_supported":["namespace:use"]}',
            response.body.decode(),
        )

    def test_request_host_mode_fails_closed_for_spoofed_higher_precedence_hosts(self) -> None:
        cases = {
            "x forwarded host": {
                "host": ["direct.example.com"],
                "x-forwarded-host": ["evil.example"],
                "x-forwarded-proto": ["https"],
            },
            "x apptheory original host": {
                "host": ["direct.example.com"],
                "x-apptheory-original-host": ["evil.example"],
                "x-forwarded-proto": ["https"],
            },
            "x facetheory original host": {
                "host": ["direct.example.com"],
                "x-facetheory-original-host": ["evil.example"],
                "x-forwarded-proto": ["https"],
            },
            "forwarded host": {
                "host": ["direct.example.com"],
                "forwarded": ["for=192.0.2.1;host=evil.example;proto=https"],
            },
        }
        for name, headers in cases.items():
            with self.subTest(name=name):
                app = create_app(tier="p0")
                register_mcp_facade(app, _valid_config(URL_MODE_REQUEST_HOST))
                response = _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp", headers)
                self.assertEqual(400, response.status)
                self.assertEqual(b'{"error":"invalid_request_host"}', response.body)
                _assert_metadata_headers(self, response)

    def test_request_host_mode_allows_only_normalized_allowlist_matches(self) -> None:
        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_REQUEST_HOST)
        config.allowed_hostnames = ["DIRECT.EXAMPLE.COM.:443", "edge.example.com"]
        register_mcp_facade(app, config)

        legit = _serve(
            app,
            "GET",
            "/.well-known/oauth-protected-resource/acme/mcp",
            {"host": ["direct.example.com:443"], "x-forwarded-proto": ["https"]},
        )
        self.assertEqual(200, legit.status)
        self.assertIn('"resource":"https://direct.example.com/acme/mcp"', legit.body.decode())

        forwarded = _serve(
            app,
            "GET",
            "/.well-known/oauth-protected-resource/acme/mcp",
            {
                "host": ["direct.example.com"],
                "x-forwarded-host": ["EDGE.EXAMPLE.COM.:443"],
                "x-forwarded-proto": ["https"],
            },
        )
        self.assertEqual(200, forwarded.status)
        self.assertIn('"resource":"https://edge.example.com/acme/mcp"', forwarded.body.decode())

        wrong_port = _serve(
            app,
            "GET",
            "/.well-known/oauth-protected-resource/acme/mcp",
            {"host": ["edge.example.com:8443"], "x-forwarded-proto": ["https"]},
        )
        self.assertEqual(400, wrong_port.status)
        self.assertEqual(b'{"error":"invalid_request_host"}', wrong_port.body)

    def test_wildcard_style_allowlist_entries_register_as_literal_keys(self) -> None:
        reject_cases = {
            "bare wildcard": ("*", "tenant.example.com"),
            "wildcard prefix": ("*.example.com", "tenant.example.com"),
            "comma list": ("a.example,b.example", "a.example"),
        }
        for name, (allowed, request_host) in reject_cases.items():
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_REQUEST_HOST)
                config.allowed_hostnames = [allowed]
                register_mcp_facade(app, config)
                response = _serve(
                    app,
                    "GET",
                    "/.well-known/oauth-protected-resource/acme/mcp",
                    {"host": [request_host], "x-forwarded-proto": ["https"]},
                )
                self.assertEqual(400, response.status)
                self.assertEqual(b'{"error":"invalid_request_host"}', response.body)

        literal_cases = {
            "host case variant": {"host": ["*.EXAMPLE.COM"], "x-forwarded-proto": ["https"]},
            "forwarded host trailing dot variant": {
                "host": ["not-allowlisted.example.com"],
                "x-forwarded-host": ["*.example.com."],
                "x-forwarded-proto": ["https"],
            },
            "forwarded header default port variant": {
                "host": ["not-allowlisted.example.com"],
                "forwarded": ["for=192.0.2.1;host=*.EXAMPLE.COM.:443;proto=https"],
            },
            "apptheory original host trailing dot variant": {
                "host": ["not-allowlisted.example.com"],
                "x-apptheory-original-host": ["*.EXAMPLE.COM."],
                "x-forwarded-proto": ["https"],
            },
            "facetheory original host default port variant": {
                "host": ["not-allowlisted.example.com"],
                "x-facetheory-original-host": ["*.EXAMPLE.COM.:443"],
                "x-forwarded-proto": ["https"],
            },
        }
        for name, headers in literal_cases.items():
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_REQUEST_HOST)
                config.allowed_hostnames = ["*.example.com"]
                register_mcp_facade(app, config)
                response = _serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp", headers)
                self.assertEqual(200, response.status)
                self.assertIn('"resource":"https://*.example.com/acme/mcp"', response.body.decode())

    def test_allowed_hostname_default_port_normalization_is_scheme_agnostic(self) -> None:
        for raw in ("edge.example.com:80", "edge.example.com:443"):
            with self.subTest(raw=raw):
                self.assertEqual("edge.example.com", _normalize_allowed_hostname(raw))

    def test_ipv6_allowed_hostname_canonicalization_keeps_brackets(self) -> None:
        self.assertEqual("[::1]", _normalize_allowed_hostname("[::1]"))
        self.assertEqual("[::1]:8443", _normalize_allowed_hostname("[::1]:8443"))

    def test_scopes_capabilities_and_registration_endpoint_are_application_owned(self) -> None:
        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.scopes["agent"] = [" custom:read ", "custom:read", "custom:write"]
        config.capabilities = FacadeCapabilities(
            response_types=[" device_code ", "device_code"],
            grant_types=["urn:custom:grant"],
            token_endpoint_auth_methods=["client_secret_post"],
            code_challenge_methods=["plain"],
        )
        config.registration_endpoint_url = "https://accounts.example.com/custom-register"
        # The configured endpoint is advertised only while the register route is
        # mounted, so this config mounts a register handler.
        config.register_handler = _kind_handler_factory("register")
        register_mcp_facade(app, config)

        protected = _serve(app, "GET", "/.well-known/oauth-protected-resource/acme/agents/helper/mcp")
        self.assertIn('"scopes_supported":["custom:read","custom:write"]', protected.body.decode())

        discovery = _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/agents/helper/mcp")
        self.assertEqual(
            '{"issuer":"https://issuer.example.com",'
            '"authorization_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/authorize",'
            '"token_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/token",'
            '"registration_endpoint":"https://accounts.example.com/custom-register",'
            '"jwks_uri":"https://issuer.example.com/jwks.json?set=active",'
            '"response_types_supported":["device_code"],'
            '"grant_types_supported":["urn:custom:grant"],'
            '"token_endpoint_auth_methods_supported":["client_secret_post"],'
            '"code_challenge_methods_supported":["plain"],'
            '"scopes_supported":["custom:read","custom:write"]}',
            discovery.body.decode(),
        )


class McpFacadeRootDiscoveryTests(unittest.TestCase):
    def test_root_discovery_is_opt_in_and_static(self) -> None:
        root_path = authorization_server_path_for_resource_path("/")

        without_root = create_app(tier="p0")
        inventory = register_mcp_facade(without_root, _valid_config(URL_MODE_PUBLIC_BASE_URL))
        self.assertFalse(inventory.root_authorization_server_attached)
        self.assertEqual(root_path, inventory.root_authorization_server_pattern)
        self.assertEqual(404, _serve(without_root, "GET", root_path).status)

        with_root = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.root_authorization_server = _valid_root_discovery_config()
        inventory = register_mcp_facade(with_root, config)
        self.assertTrue(inventory.root_authorization_server_attached)
        response = _serve(with_root, "GET", inventory.root_authorization_server_pattern)
        self.assertEqual(200, response.status)
        self.assertEqual(
            '{"issuer":"https://accounts.example.com",'
            '"authorization_endpoint":"https://accounts.example.com/authorize",'
            '"token_endpoint":"https://accounts.example.com/token",'
            '"registration_endpoint":"https://accounts.example.com/register",'
            '"jwks_uri":"https://accounts.example.com/.well-known/jwks.json",'
            '"response_types_supported":["code"],'
            '"grant_types_supported":["authorization_code","refresh_token"],'
            '"token_endpoint_auth_methods_supported":["none"],'
            '"code_challenge_methods_supported":["S256"],'
            '"scopes_supported":["openid","offline_access","mcp:tools"]}',
            response.body.decode(),
        )

        # Root is separate from the four-kind canonical/suffix loop.
        self.assertEqual(4, len(inventory.routes))
        for route in inventory.routes:
            self.assertNotEqual(inventory.root_authorization_server_pattern, route.discovery_canonical_pattern)
            self.assertNotEqual(inventory.root_authorization_server_pattern, route.discovery_suffix_pattern)

    def test_root_discovery_rejects_every_unsafe_url_field(self) -> None:
        root_path = authorization_server_path_for_resource_path("/")
        cases = {
            "issuer query": ("issuer_url", "https://accounts.example.com?tenant=acme"),
            "authorization endpoint scheme": ("authorization_endpoint_url", "javascript:alert(1)"),
            "token endpoint host": ("token_endpoint_url", "https:///token"),
            "registration endpoint userinfo": (
                "registration_endpoint_url",
                "https://operator@accounts.example.com/register",
            ),
            "JWKS fragment": ("jwks_uri", "https://accounts.example.com/.well-known/jwks.json#active"),
        }
        for name, (attribute, value) in cases.items():
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                config.root_authorization_server = _valid_root_discovery_config()
                setattr(config.root_authorization_server, attribute, value)
                with self.assertRaises(ValueError):
                    register_mcp_facade(app, config)
                self.assertEqual(404, _serve(app, "POST", "/acme/mcp").status)
                self.assertEqual(404, _serve(app, "GET", root_path).status)

    def test_incomplete_root_discovery_is_rejected(self) -> None:
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.root_authorization_server = _valid_root_discovery_config()
        config.root_authorization_server.token_endpoint_url = ""
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn("root discovery token endpoint URL", str(raised.exception))

        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.root_authorization_server = _valid_root_discovery_config()
        config.root_authorization_server.scopes = []
        with self.assertRaises(ValueError):
            register_mcp_facade(create_app(tier="p0"), config)


class McpFacadeRouteModelTests(unittest.TestCase):
    def test_route_model_patterns_stage_global_worked_example_and_issuer_modes(self) -> None:
        fixture = json.loads(_ROUTE_MODEL_PATH.read_text(encoding="utf-8"))

        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.callback_handler = _callback
        inventory = register_mcp_facade(app, config)
        by_kind = {route.kind: route for route in inventory.routes}
        for pattern in fixture["patterns"]:
            with self.subTest(kind=pattern["kind"]):
                route = by_kind[pattern["kind"]]
                self.assertEqual(pattern["mcp_pattern"], route.mcp_pattern)
                self.assertEqual(pattern["protected_resource_pattern"], route.protected_resource_pattern)
                self.assertEqual(pattern["discovery_canonical_pattern"], route.discovery_canonical_pattern)
                self.assertEqual(pattern["discovery_suffix_pattern"], route.discovery_suffix_pattern)
                self.assertEqual(pattern["authorize_pattern"], route.authorize_pattern)
                self.assertEqual(pattern["token_pattern"], route.token_pattern)
                self.assertEqual(pattern["register_pattern"], route.register_pattern)

        stage_global = fixture["stage_global"]
        self.assertEqual(1, len(stage_global))
        self.assertEqual(stage_global[0]["pattern"], inventory.callback_pattern)
        self.assertEqual(200, _serve(app, "GET", stage_global[0]["pattern"]).status)

        self.assertEqual(sorted(fixture["issuer_modes"]), supported_issuer_modes())

        worked = fixture["worked_example"]
        resolved = worked["resolved"]
        example_app = create_app(tier="p0")
        example_config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        example_config.public_base_url = worked["public_base_url"]
        example_config.issuer_mode = worked["issuer_mode"]
        register_mcp_facade(example_app, example_config)

        namespace = EndpointPath(kind=worked["kind"], **worked["params"])
        protected = _serve(example_app, "GET", namespace.protected_resource_path())
        protected_document = json.loads(protected.body)
        self.assertEqual(resolved["resource"], protected_document["resource"])
        self.assertEqual(resolved["authorization_servers"], protected_document["authorization_servers"])
        self.assertEqual(
            resolved["protected_resource_metadata_url"],
            f"{worked['public_base_url']}{namespace.protected_resource_path()}",
        )

        discovery = _serve(example_app, "GET", namespace.oauth_authorization_server_path())
        discovery_document = json.loads(discovery.body)
        self.assertEqual(
            resolved["discovery_url"], f"{worked['public_base_url']}{namespace.oauth_authorization_server_path()}"
        )
        self.assertEqual(resolved["issuer"], discovery_document["issuer"])
        self.assertEqual(resolved["authorization_endpoint"], discovery_document["authorization_endpoint"])
        self.assertEqual(resolved["token_endpoint"], discovery_document["token_endpoint"])
        # The worked example mounts no register route, so the routed document
        # must omit registration_endpoint rather than advertise a URL that 404s.
        self.assertNotIn("registration_endpoint", discovery_document)

    def test_issuer_mode_route_derives_per_route_issuer_and_resource(self) -> None:
        app = create_app(tier="p0")
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.issuer_mode = ISSUER_MODE_ROUTE
        # The route-derived registration URL is advertised only while the
        # register route is mounted, so this config mounts a register handler.
        config.register_handler = _kind_handler_factory("register")
        inventory = register_mcp_facade(app, config)
        self.assertEqual(ISSUER_MODE_ROUTE, inventory.issuer_mode)

        route_url = "https://front.example.com/acme/mcp"
        protected = _serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp")
        self.assertEqual(200, protected.status)
        self.assertEqual(
            {
                "resource": route_url,
                "authorization_servers": [route_url],
                "jwks_uri": "https://issuer.example.com/jwks.json?set=active",
                "scopes_supported": ["namespace:use"],
            },
            json.loads(protected.body),
        )

        discovery = _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp")
        self.assertEqual(200, discovery.status)
        self.assertEqual(
            {
                "issuer": route_url,
                "authorization_endpoint": "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/authorize",
                "token_endpoint": "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/token",
                "registration_endpoint": "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/register",
                "jwks_uri": "https://issuer.example.com/jwks.json?set=active",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["namespace:use"],
            },
            json.loads(discovery.body),
        )

        family_app = create_app(tier="p0")
        family_inventory = register_mcp_facade(family_app, _valid_config(URL_MODE_PUBLIC_BASE_URL))
        self.assertEqual(ISSUER_MODE_FAMILY, family_inventory.issuer_mode)
        family_protected = _serve(family_app, "GET", "/.well-known/oauth-protected-resource/acme/mcp")
        self.assertIn('"authorization_servers":["https://issuer.example.com"]', family_protected.body.decode())

    def test_routed_metadata_advertises_registration_only_while_the_route_is_mounted(self) -> None:
        def advertised(config: FacadeConfig) -> str | None:
            app = create_app(tier="p0")
            register_mcp_facade(app, config)
            document = json.loads(_serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp").body.decode())
            return document.get("registration_endpoint")

        family = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        self.assertIsNone(advertised(family))
        family.register_handler = _kind_handler_factory("register")
        self.assertEqual("https://issuer.example.com/register", advertised(family))

        configured = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        configured.registration_endpoint_url = "https://accounts.example.com/custom-register"
        self.assertIsNone(advertised(configured))
        configured.register_handler = _kind_handler_factory("register")
        self.assertEqual("https://accounts.example.com/custom-register", advertised(configured))

        route = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        route.issuer_mode = ISSUER_MODE_ROUTE
        self.assertIsNone(advertised(route))
        route.register_handler = _kind_handler_factory("register")
        self.assertEqual(
            "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/register",
            advertised(route),
        )

    def test_issuer_mode_rejects_unknown_value(self) -> None:
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.issuer_mode = "tenant"
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn('IssuerMode "tenant" must be one of family, route', str(raised.exception))

    def test_upstream_callback_path_is_overridable_and_defaults_to_the_contract_default(self) -> None:
        default_app = create_app(tier="p0")
        default_config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        default_config.callback_handler = _callback
        default_inventory = register_mcp_facade(default_app, default_config)
        self.assertEqual(DEFAULT_CALLBACK_PATH, default_inventory.callback_pattern)
        self.assertEqual(200, _serve(default_app, "GET", DEFAULT_CALLBACK_PATH).status)

        custom_app = create_app(tier="p0")
        custom_config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        custom_config.upstream_callback_path = "/_oauth/callback"
        custom_config.callback_handler = _callback
        custom_inventory = register_mcp_facade(custom_app, custom_config)
        self.assertEqual("/_oauth/callback", custom_inventory.callback_pattern)
        self.assertEqual(200, _serve(custom_app, "GET", "/_oauth/callback").status)
        self.assertEqual(404, _serve(custom_app, "GET", DEFAULT_CALLBACK_PATH).status)


class McpFacadeFailClosedTests(unittest.TestCase):
    def test_missing_plug_points_leave_authorization_routes_unregistered(self) -> None:
        app = create_app(tier="p0")
        inventory = register_mcp_facade(app, _valid_config(URL_MODE_PUBLIC_BASE_URL))
        for route in inventory.routes:
            self.assertTrue(route.authorization_routes_attached)
        self.assertEqual(404, _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp/authorize").status)
        self.assertEqual(404, _serve(app, "POST", "/.well-known/oauth-authorization-server/acme/mcp/token").status)

    def test_malformed_and_unknown_paths_fail_closed(self) -> None:
        app = create_app(tier="p0")
        register_mcp_facade(app, _valid_config(URL_MODE_PUBLIC_BASE_URL))

        self.assertEqual(500, _serve(app, "POST", "/ /mcp").status)
        self.assertEqual(500, _serve(app, "GET", "/.well-known/oauth-protected-resource/ /mcp").status)
        self.assertEqual(500, _serve(app, "GET", "/.well-known/oauth-authorization-server/ /mcp").status)
        self.assertEqual(404, _serve(app, "GET", "/unknown/mcp/path").status)

        plug_app = create_app(tier="p0")
        plug_config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        plug_config.authorize_handler = _kind_handler_factory("authorize")
        plug_config.token_handler = _kind_handler_factory("token")
        register_mcp_facade(plug_app, plug_config)
        self.assertEqual(500, _serve(plug_app, "GET", "/.well-known/oauth-authorization-server/ /mcp/authorize").status)
        self.assertEqual(500, _serve(plug_app, "POST", "/.well-known/oauth-authorization-server/ /mcp/token").status)

        host_app = create_app(tier="p0")
        register_mcp_facade(host_app, _valid_config(URL_MODE_REQUEST_HOST))
        self.assertEqual(400, _serve(host_app, "GET", "/.well-known/oauth-protected-resource/acme/mcp").status)
        self.assertEqual(
            400,
            _serve(
                host_app,
                "GET",
                "/.well-known/oauth-authorization-server/acme/mcp",
                {"host": ["evil.example"], "x-forwarded-proto": ["http"]},
            ).status,
        )

    def test_register_mcp_facade_validates_configuration_before_registration(self) -> None:
        def _empty_capabilities() -> FacadeCapabilities:
            return FacadeCapabilities(grant_types=[])

        def _blank_capabilities() -> FacadeCapabilities:
            return FacadeCapabilities(response_types=[" "])

        def _nil_authorize(_kind: str):
            return None

        def _nil_token(_kind: str):
            return None

        cases: list[tuple[str, dict]] = [
            ("nil MCP handler", {"mcp_handler": None}),
            ("invalid issuer", {"issuer_url": "http://issuer.example.com"}),
            ("issuer query", {"issuer_url": "https://issuer.example.com/?tenant=acme"}),
            ("invalid JWKS", {"jwks_uri": "/jwks"}),
            ("invalid registration endpoint", {"registration_endpoint_url": "http://accounts.example.com/register"}),
            ("missing URL mode", {"url_mode": ""}),
            ("missing public base", {"public_base_url": ""}),
            ("public base query", {"public_base_url": "https://front.example.com/?bad=1"}),
            ("public base path", {"public_base_url": "https://front.example.com/base"}),
            ("public base with allowlist", {"allowed_hostnames": ["front.example.com"]}),
            ("request host with public base", {"url_mode": URL_MODE_REQUEST_HOST}),
            (
                "request host without allowlist",
                {"url_mode": URL_MODE_REQUEST_HOST, "public_base_url": "", "allowed_hostnames": []},
            ),
            (
                "request host invalid allowlist",
                {
                    "url_mode": URL_MODE_REQUEST_HOST,
                    "public_base_url": "",
                    "allowed_hostnames": ["https://front.example.com"],
                },
            ),
            ("empty scope", {"scopes[agent]": [" "]}),
            ("unknown scope kind", {"scopes[unknown]": ["scope"]}),
            ("empty capability override", {"capabilities": _empty_capabilities}),
            ("blank capability", {"capabilities": _blank_capabilities}),
            ("authorize only", {"authorize_handler": _kind_handler_factory("authorize")}),
            ("token only", {"token_handler": _kind_handler_factory("token")}),
            (
                "nil authorize result",
                {"authorize_handler": _nil_authorize, "token_handler": _kind_handler_factory("token")},
            ),
            (
                "nil token result",
                {"authorize_handler": _kind_handler_factory("authorize"), "token_handler": _nil_token},
            ),
            ("incomplete root discovery", {"root_token_endpoint_url": ""}),
            ("empty root scopes", {"root_scopes": []}),
        ]

        for name, mutation in cases:
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                _apply_mutation(config, mutation)
                with self.assertRaises(ValueError):
                    register_mcp_facade(app, config)
                self.assertEqual(404, _serve(app, "POST", "/acme/mcp").status)

        with self.subTest(name="missing scopes"):
            app = create_app(tier="p0")
            config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
            del config.scopes["agent"]
            with self.assertRaises(ValueError):
                register_mcp_facade(app, config)
            self.assertEqual(404, _serve(app, "POST", "/acme/mcp").status)

        with self.subTest(name="nil app"):
            with self.assertRaises(ValueError) as raised:
                register_mcp_facade(None, _valid_config(URL_MODE_PUBLIC_BASE_URL))
            self.assertIn("app is required", str(raised.exception))

    def test_request_host_and_public_base_mutual_exclusion_is_independently_pinned(self) -> None:
        config = _valid_config(URL_MODE_REQUEST_HOST)
        config.public_base_url = "https://front.example.com"
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn("request-host mode cannot also configure a public base URL", str(raised.exception))

    def test_public_base_url_path_constraint_is_explicit(self) -> None:
        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.public_base_url = "https://front.example.com/base"
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn("without a path", str(raised.exception))

    def test_invalid_derived_inventory_fails_before_target_registration(self) -> None:
        handler = _no_content
        registrations = [
            _RouteRegistration(method="GET", pattern="/duplicate", handler=handler, auth_required=False),
            _RouteRegistration(method="get", pattern="/duplicate", handler=handler, auth_required=False),
        ]
        with self.assertRaises(ValueError) as raised:
            _validate_route_registrations(registrations)
        self.assertIn("duplicate route inventory entry", str(raised.exception))

    def test_route_inventory_validation_uses_the_scratch_router(self) -> None:
        registrations = [
            _RouteRegistration(method="GET", pattern="/{proxy+}/not-last", handler=_no_content, auth_required=False)
        ]
        with self.assertRaises(ValueError) as raised:
            _validate_route_registrations(registrations)
        self.assertIn("invalid or duplicate route inventory entry", str(raised.exception))

    def test_registered_collision_returns_error(self) -> None:
        app = create_app(tier="p0")
        app.post("/{client_namespace}/mcp", _no_content)
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(app, _valid_config(URL_MODE_PUBLIC_BASE_URL))
        self.assertIn("register POST /{client_namespace}/mcp", str(raised.exception))
        self.assertEqual(405, _serve(app, "GET", "/acme/mcp").status)


class McpFacadeTransportPostureTests(unittest.TestCase):
    def test_transport_posture_fixture(self) -> None:
        fixture = json.loads(_TRANSPORT_POSTURE_PATH.read_text(encoding="utf-8"))
        postures = fixture["postures"]

        self.assertEqual(
            {"iam", "jwt", "runtime-bearer", "none-public"},
            set(postures),
        )
        for posture, row in postures.items():
            with self.subTest(posture=posture):
                expected_runtime_validation = posture == "runtime-bearer"
                expected_surface_attached = posture != "none-public"
                self.assertEqual(expected_runtime_validation, row["runtime_validation_required"])
                self.assertEqual(expected_surface_attached, row["oauth_surface_attached"])

                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                config.transport_posture = posture
                if posture == "runtime-bearer":
                    config.require_bearer_token = _bearer_options()
                inventory = register_mcp_facade(create_app(tier="p0"), config)
                for route in inventory.routes:
                    self.assertEqual(row["oauth_surface_attached"], route.authorization_routes_attached)

        credential_free = fixture["credential_free_behavior"]
        app = create_app()
        invocations = {"count": 0}

        def mcp_handler(_ctx) -> Response:
            invocations["count"] += 1
            return Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)

        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.transport_posture = "runtime-bearer"
        config.mcp_handler = mcp_handler
        config.require_bearer_token = _bearer_options()
        register_mcp_facade(app, config)

        response = _serve(app, "POST", "/acme/mcp")
        self.assertEqual(credential_free["status"], response.status)
        expected_challenge = credential_free["headers"]["www-authenticate"].replace(
            "<route protected-resource metadata URL>", _RESOURCE_METADATA_URL
        )
        self.assertEqual([expected_challenge], response.headers["www-authenticate"])
        self.assertEqual(credential_free["handler_invocations"], invocations["count"])

    def test_transport_routes_default_to_authenticated_posture(self) -> None:
        app = create_app()
        invocations = {"count": 0}

        def mcp_handler(_ctx) -> Response:
            invocations["count"] += 1
            return Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)

        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.mcp_handler = mcp_handler
        register_mcp_facade(app, config)

        for endpoint in _TEST_ENDPOINTS:
            mcp_path = endpoint.mcp_path()
            for method in ("POST", "GET", "DELETE"):
                response = _serve(app, method, mcp_path)
                self.assertEqual(401, response.status, f"{method} {mcp_path}: {response.body!r}")
        self.assertEqual(0, invocations["count"])

    def test_transport_routes_require_valid_bearer_token_when_configured(self) -> None:
        app = create_app()
        reached = {"count": 0}

        def mcp_handler(_ctx) -> Response:
            reached["count"] += 1
            return text(200, "mcp-ok")

        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.transport_posture = "runtime-bearer"
        config.mcp_handler = mcp_handler
        config.require_bearer_token = _bearer_options()
        register_mcp_facade(app, config)

        denied = _serve(app, "POST", "/acme/mcp")
        self.assertEqual(401, denied.status)
        self.assertEqual([f'Bearer resource_metadata="{_RESOURCE_METADATA_URL}"'], denied.headers["www-authenticate"])
        self.assertEqual(0, reached["count"])

        allowed = _serve(app, "POST", "/acme/mcp", {"authorization": ["Bearer valid-token"]})
        self.assertEqual(200, allowed.status)
        self.assertEqual("mcp-ok", allowed.body.decode())
        self.assertEqual(1, reached["count"])

    def test_none_public_posture_registers_no_oauth_surface(self) -> None:
        app = create_app()
        reached = {"count": 0}

        def mcp_handler(_ctx) -> Response:
            reached["count"] += 1
            return text(200, "mcp-ok")

        config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
        config.transport_posture = "none-public"
        config.mcp_handler = mcp_handler
        inventory = register_mcp_facade(app, config)
        for route in inventory.routes:
            self.assertFalse(route.authorization_routes_attached)

        response = _serve(app, "POST", "/acme/mcp")
        self.assertEqual(200, response.status)
        self.assertEqual("mcp-ok", response.body.decode())
        self.assertEqual(1, reached["count"])

        endpoint = _TEST_ENDPOINTS[0]
        self.assertEqual(404, _serve(app, "GET", endpoint.protected_resource_path()).status)
        self.assertEqual(404, _serve(app, "GET", endpoint.oauth_authorization_server_path()).status)
        self.assertEqual(404, _serve(app, "GET", endpoint.oauth_authorization_server_suffix_path()).status)
        self.assertEqual(404, _serve(app, "GET", endpoint.oauth_authorize_path()).status)
        self.assertEqual(404, _serve(app, "POST", endpoint.oauth_token_path()).status)
        self.assertEqual(404, _serve(app, "POST", endpoint.oauth_register_path()).status)
        self.assertEqual(404, _serve(app, "GET", DEFAULT_CALLBACK_PATH).status)

    def test_none_public_posture_rejects_oauth_surface_configuration(self) -> None:
        cases: list[tuple[str, dict, str]] = [
            (
                "authorize and token handlers",
                {
                    "authorize_handler": _kind_handler_factory("authorize"),
                    "token_handler": _kind_handler_factory("token"),
                },
                "none-public registers no OAuth surface; authorize/token handlers",
            ),
            (
                "register handler",
                {"register_handler": _kind_handler_factory("register")},
                "none-public registers no OAuth surface; RegisterHandler",
            ),
            (
                "callback handler",
                {"callback_handler": _callback},
                "none-public registers no OAuth surface; CallbackHandler",
            ),
            (
                "root authorization server",
                {"root_authorization_server": _valid_root_discovery_config},
                "none-public cannot enable RootAuthorizationServer",
            ),
        ]
        for name, mutation, message in cases:
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                config.transport_posture = "none-public"
                _apply_mutation(config, mutation)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(app, config)
                self.assertIn(message, str(raised.exception))
                self.assertEqual(404, _serve(app, "POST", "/acme/mcp").status)

    def test_transport_posture_fails_closed_before_any_route_is_registered(self) -> None:
        root_path = authorization_server_path_for_resource_path("/")
        cases: list[tuple[str, str, RequireBearerTokenOptions | None, str]] = [
            (
                "runtime bearer without require bearer token",
                "runtime-bearer",
                None,
                "TransportPosture runtime-bearer requires RequireBearerToken",
            ),
            (
                "iam with require bearer token",
                "iam",
                _bearer_options(),
                "RequireBearerToken is only valid with TransportPosture runtime-bearer",
            ),
            (
                "jwt with require bearer token",
                "jwt",
                _bearer_options(),
                "RequireBearerToken is only valid with TransportPosture runtime-bearer",
            ),
            (
                "none public with require bearer token",
                "none-public",
                _bearer_options(),
                "TransportPosture none-public cannot be combined with RequireBearerToken",
            ),
            (
                "unknown posture",
                "unauthenticated",
                None,
                'TransportPosture "unauthenticated" must be one of iam, jwt, runtime-bearer, none-public',
            ),
        ]
        for name, posture, bearer, message in cases:
            with self.subTest(name=name):
                app = create_app(tier="p0")
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                config.transport_posture = posture
                config.require_bearer_token = bearer
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(app, config)
                self.assertIn(message, str(raised.exception))

                for method in ("POST", "GET", "DELETE"):
                    self.assertEqual(404, _serve(app, method, "/acme/mcp").status)
                self.assertEqual(404, _serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp").status)
                self.assertEqual(404, _serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp").status)
                self.assertEqual(404, _serve(app, "GET", root_path).status)


class McpFacadeHelperTests(unittest.TestCase):
    def test_default_capabilities_are_the_golden_path(self) -> None:
        capabilities = default_capabilities()
        self.assertEqual(["code"], capabilities.response_types)
        self.assertEqual(["authorization_code", "refresh_token"], capabilities.grant_types)
        self.assertEqual(["none"], capabilities.token_endpoint_auth_methods)
        self.assertEqual(["S256"], capabilities.code_challenge_methods)

    def test_url_helpers_canonicalize_as_expected(self) -> None:
        self.assertEqual("http://localhost", _normalize_public_base_url("http://LOCALHOST:80/"))
        self.assertEqual("http://[::1]:8080", _normalize_public_base_url("http://[::1]:8080/"))
        self.assertIsNone(_normalize_public_base_url("http://example.com"))
        self.assertIsNone(_normalize_public_base_url("https://user@example.com"))
        self.assertIsNone(_normalize_public_base_url("https://example.com/path"))

        self.assertEqual("http://localhost", normalize_request_origin("http://LOCALHOST:80/"))
        self.assertEqual("http://[::1]:8080", normalize_request_origin("http://[::1]:8080/"))
        self.assertIsNone(normalize_request_origin("http://example.com"))
        self.assertIsNone(normalize_request_origin("https://user@example.com"))
        self.assertIsNone(normalize_request_origin("https://example.com/path"))

        self.assertEqual(
            "https://example.com/base/route", _absolute_url_for_path("https://example.com/base?discard=yes", "/route")
        )
        self.assertIsNone(_absolute_url_for_path("not-a-url", "/route"))
        self.assertIsNone(_absolute_url_for_path("https://example.com", "relative"))

    def test_absolute_url_for_path_re_encodes_the_decoded_host(self) -> None:
        # Go re-encodes the decoded host bytes and the decoded path.
        self.assertEqual(
            "https://Example.com:443/v1/x", _absolute_url_for_path("https://Example.com:443/v1/", "/x")
        )
        self.assertEqual("https://example.com/A/x", _absolute_url_for_path("https://example.com/%41", "/x"))
        self.assertEqual("https://example.com/a%20b/x", _absolute_url_for_path("https://example.com/a b", "/x"))
        self.assertEqual("https://example.com/a/x", _absolute_url_for_path("https://example.com/a?b=c", "/x"))
        self.assertEqual("https://caf%C3%A9.example/x", _absolute_url_for_path("https://caf%c3%a9.example", "/x"))

    def test_metadata_request_failures_preserve_type_and_render_400(self) -> None:
        self.assertIsNone(_metadata_request_failure(ValueError("internal failure")))

        request_error = _MetadataRequestError("request host is not allowlisted")
        self.assertEqual("AppTheoryMcpFacade: request host is not allowlisted", str(request_error))
        response = _metadata_request_failure(request_error)
        self.assertIsNotNone(response)
        self.assertEqual(400, response.status)
        self.assertEqual(b'{"error":"invalid_request_host"}', response.body)
        _assert_metadata_headers(self, response)

    def test_inventory_clone_is_defensive(self) -> None:
        first = register_mcp_facade(create_app(tier="p0"), _valid_config(URL_MODE_PUBLIC_BASE_URL))
        first.routes[0].mcp_methods[0] = "PATCH"

        second = register_mcp_facade(create_app(tier="p0"), _valid_config(URL_MODE_PUBLIC_BASE_URL))
        self.assertEqual(["POST", "GET", "DELETE"], second.routes[0].mcp_methods)
        self.assertEqual("PATCH", first.routes[0].mcp_methods[0])

        again = default_capabilities()
        self.assertEqual(["code"], again.response_types)

    def test_transport_postures_vocabulary(self) -> None:
        self.assertEqual(("iam", "jwt", "runtime-bearer", "none-public"), TRANSPORT_POSTURES)


class _StubProvider:
    """A no-op ``Provider`` used only to declare a front channel in config tests."""

    def discovery(self) -> ProviderMetadata:
        return ProviderMetadata(issuer="https://id.example.com")

    def authorization_url(self, req: AuthorizationRequest) -> str:
        return "https://id.example.com/authorize"

    def exchange_code(self, req: CodeExchangeRequest) -> TokenSet:
        return TokenSet(access_token="upstream", token_type="Bearer")

    def refresh(self, req: RefreshRequest) -> TokenSet:
        return TokenSet(access_token="upstream", token_type="Bearer")

    def validate_access_token(self, token: str, expected: TokenExpectations) -> TokenClaims:
        return TokenClaims(subject="subject")


def _reference_stores() -> Stores:
    return Stores(
        transaction=MemoryTransactionStore(),
        authorization_code=MemoryAuthorizationCodeStore(),
        client=MemoryClientStore(),
        route_refresh_broker=MemoryRouteRefreshBrokerStore(),
        rate_limit=MemoryRateLimitStore(),
    )


def _front_channel_config() -> FacadeConfig:
    """A complete, valid front-channel field set built on the reference stores."""
    config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
    config.provider = _StubProvider()
    config.stores = _reference_stores()
    config.upstream_client_id = "mcp_facade_client"
    config.upstream_issuer = "https://id.example.com"
    return config


class McpFacadeFrontChannelConfigTests(unittest.TestCase):
    def test_accepts_a_complete_set(self) -> None:
        register_mcp_facade(create_app(tier="p0"), _front_channel_config())

    def test_requires_every_field(self) -> None:
        def empty_client_id(config: FacadeConfig) -> None:
            config.upstream_client_id = ""

        def whitespace_client_id(config: FacadeConfig) -> None:
            config.upstream_client_id = "   "

        def empty_issuer(config: FacadeConfig) -> None:
            config.upstream_issuer = ""

        def non_https_issuer(config: FacadeConfig) -> None:
            config.upstream_issuer = "http://id.example.com"

        def issuer_with_query(config: FacadeConfig) -> None:
            config.upstream_issuer = "https://id.example.com?a=1"

        def empty_lifecycle_scope(config: FacadeConfig) -> None:
            config.lifecycle_scopes = ["offline_access", "  "]

        cases = (
            ("upstream client id", empty_client_id, "upstream client id"),
            ("upstream client id whitespace", whitespace_client_id, "upstream client id"),
            ("upstream issuer empty", empty_issuer, "upstream issuer"),
            ("upstream issuer not https", non_https_issuer, "upstream issuer"),
            ("upstream issuer with query", issuer_with_query, "upstream issuer"),
            ("empty lifecycle scope", empty_lifecycle_scope, "lifecycle scope"),
        )
        for name, mutate, want in cases:
            with self.subTest(name=name):
                config = _front_channel_config()
                mutate(config)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn(want, str(raised.exception))

    def test_requires_every_store(self) -> None:
        attributes = (
            ("transaction", "Transaction"),
            ("authorization_code", "AuthorizationCode"),
            ("client", "Client"),
            ("route_refresh_broker", "RouteRefreshBroker"),
            ("rate_limit", "RateLimit"),
        )
        for attribute, want in attributes:
            with self.subTest(store=attribute):
                config = _front_channel_config()
                setattr(config.stores, attribute, None)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn(want, str(raised.exception))
                self.assertIn("all five stores", str(raised.exception))

    def test_field_set_fails_closed_without_provider(self) -> None:
        def stores_field(config: FacadeConfig) -> None:
            config.stores = _reference_stores()

        def client_id_field(config: FacadeConfig) -> None:
            config.upstream_client_id = "mcp_x"

        def issuer_field(config: FacadeConfig) -> None:
            config.upstream_issuer = "https://id.example.com"

        def scopes_field(config: FacadeConfig) -> None:
            config.lifecycle_scopes = ["offline_access"]

        def hints_field(config: FacadeConfig) -> None:
            config.provider_hints = lambda _ctx: {"account_id": "acme"}

        cases = (
            ("stores", stores_field, "Stores"),
            ("upstream client id", client_id_field, "UpstreamClientID"),
            ("upstream issuer", issuer_field, "UpstreamIssuer"),
            ("lifecycle scopes", scopes_field, "LifecycleScopes"),
            ("provider hints", hints_field, "ProviderHints"),
        )
        for name, mutate, want in cases:
            with self.subTest(field=name):
                config = _valid_config(URL_MODE_PUBLIC_BASE_URL)
                mutate(config)
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(tier="p0"), config)
                self.assertIn(want, str(raised.exception))
                self.assertIn("without Provider", str(raised.exception))

    def test_rejects_application_owned_handler_factories(self) -> None:
        config = _front_channel_config()
        config.authorize_handler = _kind_handler_factory("authorize")
        config.token_handler = _kind_handler_factory("token")
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn(
            "AuthorizeHandler and TokenHandler must not be configured with a front channel", str(raised.exception)
        )

        callback_config = _front_channel_config()
        callback_config.callback_handler = _callback
        with self.assertRaises(ValueError) as callback_raised:
            register_mcp_facade(create_app(tier="p0"), callback_config)
        self.assertIn("CallbackHandler must not be configured with a front channel", str(callback_raised.exception))

    def test_lifecycle_scopes_are_validated_like_scopes(self) -> None:
        config = _front_channel_config()
        config.lifecycle_scopes = ["offline_access", "offline_access"]
        register_mcp_facade(create_app(tier="p0"), config)

        config = _front_channel_config()
        config.lifecycle_scopes = ["aaa"]
        register_mcp_facade(create_app(tier="p0"), config)

    def test_config_is_validated_before_any_route_is_registered(self) -> None:
        app = create_app(tier="p0")
        config = _front_channel_config()
        config.upstream_issuer = "http://id.example.com"
        with self.assertRaises(ValueError):
            register_mcp_facade(app, config)

        endpoint = EndpointPath(kind="namespace", client_namespace="acme")
        self.assertEqual(404, _serve(app, "GET", endpoint.protected_resource_path()).status)


def _assert_metadata_headers(test: unittest.TestCase, response: Response) -> None:
    test.assertEqual(["no-store"], response.headers["cache-control"])
    test.assertEqual([METADATA_VARY_HEADER], response.headers["vary"])


def _apply_mutation(config: FacadeConfig, mutation: dict) -> None:
    for key, value in mutation.items():
        if key == "scopes[agent]":
            config.scopes["agent"] = value
        elif key == "scopes[unknown]":
            config.scopes["unknown"] = value
        elif key == "root_token_endpoint_url":
            config.root_authorization_server = _valid_root_discovery_config()
            config.root_authorization_server.token_endpoint_url = value
        elif key == "root_scopes":
            config.root_authorization_server = _valid_root_discovery_config()
            config.root_authorization_server.scopes = value
        elif key == "root_authorization_server":
            config.root_authorization_server = value() if callable(value) else value
        elif key == "capabilities":
            config.capabilities = value() if callable(value) else value
        else:
            setattr(config, key, value)


if __name__ == "__main__":
    unittest.main()
