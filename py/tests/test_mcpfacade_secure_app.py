"""SecureApp seam for the MCP OAuth facade (``register_mcp_facade_secure``).

The Go suite in ``runtime/mcpfacade`` and the TypeScript suite in ``ts/test``
read the same ``secure_app_mount`` table: the authority table the SecureApp
registrar declares, the requests a really-mounted SecureApp still refuses or
serves under the application's own principal authority, and the equality of the
two registrars' route inventories.
"""

from __future__ import annotations

import json
import unittest
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlencode

from test_mcpfacade_front_channel import (
    FRONT_TEST_BASE_URL,
    FRONT_TEST_CLIENT_ID,
    FRONT_TEST_REDIRECT_URI,
    FRONT_TEST_REFRESH_ACCESS_TOKEN,
    FRONT_TEST_RESOURCE,
    FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
    FRONT_TEST_UPSTREAM_CODE,
    FRONT_TEST_UPSTREAM_ISS,
    FRONT_TEST_VERIFIER,
    JOURNEY_METADATA_URL,
    _FrontChannelHarness,
    _header,
    _journey_bearer_options,
    _journey_transport_token,
    _location_query,
)

from apptheory import (
    URL_MODE_PUBLIC_BASE_URL,
    FacadeConfig,
    PolicyDecision,
    PrincipalKind,
    RequireBearerTokenOptions,
    RootDiscoveryConfig,
    SecureApp,
    SecurePrincipal,
    assert_bearer_token_reaches_transport_handler_secure_app,
    assert_credential_free_transport_denied_secure_app,
    assert_insufficient_scope_transport_denied_secure_app,
    authenticated,
    counting_transport_handler,
    create_app,
    insufficient_scope_www_authenticate,
    protected_resource_www_authenticate,
    register_mcp_facade,
    register_mcp_facade_secure,
)
from apptheory import mcpfacade as facade_module
from apptheory.context import Context
from apptheory.mcproutes import EndpointPath
from apptheory.oauth.store import hash_key
from apptheory.request import Request
from apptheory.response import Response
from apptheory.secure_types import SecureRoute

# ---------------------------------------------------------------------------
# Shared SecureApp-mount table (the same table the Go and TypeScript loaders read)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade" / "facade-conformance.v1.json"

SECURE_APP_MOUNT_GROUP = "secure_app_mount"

# The number of secure_app_mount rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
SECURE_APP_MOUNT_CASE_COUNT = 41

POSTURE_SCENARIO = "posture"
REQUEST_SCENARIO = "request"
INVENTORY_PARITY_SCENARIO = "inventory_parity"

# The four endpoint families every mounted facade covers, in contract order, so
# routes[0] is the namespace family.
ENDPOINT_KINDS = ("namespace", "partner_namespace", "agent", "partner_agent")

# The namespace route the request rows and the TMS journey drive, derived from the
# route algebra rather than a hard-coded path.
ROUTE = EndpointPath(kind="namespace", client_namespace="acme")

# The application's own authority, which the facade must neither replace nor
# bypass: a request carries its session in this header and the resolver answers
# only for the exact value.
SESSION_HEADER = "x-tms-session"
SESSION_VALUE = "valid"
PRINCIPAL_IDENTITY = "tms-operator"
PRINCIPAL_SCOPE = "mcp:tools"

NON_FACADE_PATH = "/internal/audit"
UNDECLARED_PATH = "/internal/undeclared"

# The upstream access token the fake serves for a refresh grant, so a rotated
# response is distinguishable from the code exchange's token.
ROTATED_UPSTREAM_ACCESS_TOKEN = FRONT_TEST_REFRESH_ACCESS_TOKEN

# The RFC 7591 body the register row presents.
DCR_BODY = json.dumps(
    {"redirect_uris": [FRONT_TEST_REDIRECT_URI], "token_endpoint_auth_method": "none"},
    separators=(",", ":"),
).encode("utf-8")


def _load_fixture() -> dict:
    with FIXTURE_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _no_content(_ctx: Context) -> Response:
    return Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)


def _mcp_ok(_ctx: Context) -> Response:
    return Response(status=200, headers={}, cookies=[], body=b"mcp-ok", is_base64=False)


def _mcp_body() -> bytes:
    return b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'


def _bearer(token: str) -> dict[str, list[str]]:
    return {"authorization": [f"Bearer {token}"]}


def _form(values: dict[str, str]) -> bytes:
    return urlencode(values).encode("utf-8")


def _header_text(headers: dict | None, name: str) -> str:
    needle = str(name or "").strip().lower()
    for key, value in dict(headers or {}).items():
        if str(key).strip().lower() != needle:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        return str(values[0]) if values else ""
    return ""


# ---------------------------------------------------------------------------
# The SecureApp world one row drives
# ---------------------------------------------------------------------------


class _Invocations:
    """What one mounted SecureApp actually reached.

    Every facade refusal happens behind the transport, so a refusal is only
    proven by the counts it did *not* move: a handler that never ran, a principal
    resolver that was never consulted, a policy hook that was never asked.
    """

    def __init__(self) -> None:
        self.handler = 0
        self.resolver = 0
        self.policy = 0
        self.non_facade = 0


def _secure_config(
    harness: _FrontChannelHarness | None,
    *,
    transport_posture: str,
    front_channel: bool,
    issuer_mode: str = "route",
    root_authorization_server: bool = False,
    mcp_handler=_no_content,
) -> FacadeConfig:
    """Build the facade config one row mounts on a SecureApp.

    A front-channel row carries the same field set the sibling front-channel test
    module's config builder supplies, spelled inline here so the SecureApp and
    plain-App suites drive the same fake upstream, the same five stores, the same
    clock, and the same real JWKS validator.
    """
    if front_channel and harness is None:
        raise AssertionError("a front-channel config needs the front-channel world")
    config = FacadeConfig(
        issuer_url=FRONT_TEST_BASE_URL + ROUTE.mcp_path(),
        jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
        issuer_mode=issuer_mode,
        url_mode=URL_MODE_PUBLIC_BASE_URL,
        public_base_url=FRONT_TEST_BASE_URL,
        transport_posture=transport_posture,
        scopes={kind: ["mcp:tools"] for kind in ENDPOINT_KINDS},
        mcp_handler=mcp_handler,
    )
    if front_channel and harness is not None:
        config.provider = harness.provider
        config.stores = harness.stores
        config.upstream_client_id = FRONT_TEST_CLIENT_ID
        config.upstream_issuer = FRONT_TEST_UPSTREAM_ISS
    if transport_posture == "runtime-bearer":
        # The posture rows only inspect the inventory, so they never present a
        # token; the request rows present a genuinely signed one and mount the
        # real validator built from the fake upstream's key set.
        config.require_bearer_token = (
            _journey_bearer_options(harness.fake) if harness is not None else RequireBearerTokenOptions()
        )
    if root_authorization_server:
        config.root_authorization_server = RootDiscoveryConfig(
            issuer_url=FRONT_TEST_UPSTREAM_ISS,
            authorization_endpoint_url=FRONT_TEST_UPSTREAM_ISS + "/authorize",
            token_endpoint_url=FRONT_TEST_UPSTREAM_ISS + "/token",
            registration_endpoint_url=FRONT_TEST_UPSTREAM_ISS + "/register",
            jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
            scopes=["mcp:tools"],
        )
    return config


def _counted_handler(base, invocations: _Invocations):
    def handler(ctx: Context) -> Response:
        invocations.handler += 1
        return base(ctx)

    return handler


def _counted_resolver(invocations: _Invocations):
    """The application's own principal resolver: it answers only for a request
    that presents the exact session header value, and counts every consultation.
    """

    def resolver(ctx: Context) -> SecurePrincipal | None:
        invocations.resolver += 1
        if _header_text(ctx.request.headers, SESSION_HEADER) != SESSION_VALUE:
            return None
        return SecurePrincipal(
            identity=PRINCIPAL_IDENTITY,
            scopes=[PRINCIPAL_SCOPE],
            kind=PrincipalKind.EXTERNAL,
        )

    return resolver


def _counted_policy(invocations: _Invocations, denial_code: str | None = None):
    """The application's own policy hook: it allows everything and counts every
    decision, so a route that never reached it is observable. A row that names a
    denial code gets a hook that answers with that code instead, so a row can pin
    a facade route against the policy hook's own denial rather than the transport
    gate's.
    """

    def policy(_ctx: Context) -> PolicyDecision | None:
        invocations.policy += 1
        if denial_code is None:
            return None
        return PolicyDecision(code=denial_code, message="")

    return policy


def _counted_non_facade(invocations: _Invocations):
    def handler(_ctx: Context) -> Response:
        invocations.non_facade += 1
        return Response(status=200, headers={}, cookies=[], body=b"audit-ok", is_base64=False)

    return handler


def _mount_secure(
    config: FacadeConfig,
    *,
    invocations: _Invocations | None = None,
    mcp_handler=_no_content,
    tier: str = "p0",
    clock=None,
    with_non_facade_route: bool = False,
    policy_denial_code: str | None = None,
) -> tuple[SecureApp, facade_module.RouteInventory]:
    """Mount the facade on a fresh SecureApp and, when asked, give that same app
    the application's own resolver, policy hook, and non-facade route, so the two
    route families provably share one app.
    """
    counts = invocations if invocations is not None else _Invocations()
    secure = SecureApp(
        tier=tier,
        clock=clock,
        principal_resolver=_counted_resolver(counts) if with_non_facade_route else None,
        policy_hook=_counted_policy(counts, policy_denial_code) if with_non_facade_route else None,
    )
    inventory = register_mcp_facade_secure(secure, config)
    if with_non_facade_route:
        secure.get(NON_FACADE_PATH, _counted_non_facade(counts), authenticated())
    return secure, inventory


def _serve(
    secure: SecureApp,
    method: str,
    path: str,
    query: dict | None = None,
    body: bytes = b"",
    headers: dict | None = None,
) -> Response:
    return secure.serve(
        Request(
            method=method,
            path=path,
            headers=dict(headers or {}),
            query=query or {},
            body=body,
            is_base64=False,
        )
    )


# ---------------------------------------------------------------------------
# Route resolution against the returned inventory
# ---------------------------------------------------------------------------


def _inventory_route_paths(inventory: facade_module.RouteInventory, key: str) -> list[str]:
    """Resolve a row's ``route`` name to the patterns the facade mounts for it.

    Each endpoint family has its own pattern, so a name resolves to every
    family's route (the first entry is the namespace family's, ``routes[0]``);
    the two stage-global routes resolve to the single path the inventory names.
    """
    per_family = {
        "transport": lambda route: route.mcp_pattern,
        "protected_resource": lambda route: route.protected_resource_pattern,
        "discovery_canonical": lambda route: route.discovery_canonical_pattern,
        "discovery_suffix": lambda route: route.discovery_suffix_pattern,
        "authorize": lambda route: route.authorize_pattern,
        "token": lambda route: route.token_pattern,
        "register": lambda route: route.register_pattern,
    }
    if key in per_family:
        return [per_family[key](route) for route in inventory.routes]
    if key == "callback":
        return [inventory.callback_pattern]
    if key == "root_authorization_server":
        return [inventory.root_authorization_server_pattern]
    raise AssertionError(f"unknown fixture route key {key!r}")


def _secure_route(secure: SecureApp, method: str, path: str) -> SecureRoute | None:
    for route in secure.routes():
        if route.method == method and route.path == path:
            return route
    return None


def _expected_secure_route_count(
    *,
    authorization_routes_attached: bool,
    oauth_surface: bool,
    register_route: bool,
    callback_route: bool,
    root_authorization_server: bool,
) -> int:
    """The exact number of posture-carrying routes one mount must declare.

    Derived from the facade's own mount rule rather than from the registrar, so a
    disagreement is a failure and an extra undeclared route cannot hide behind a
    subset check.
    """
    per_family = 3  # the MCP transport family: POST, GET, and DELETE
    if authorization_routes_attached:
        per_family += 3  # protected-resource metadata, canonical and suffix discovery
        if oauth_surface:
            per_family += 2  # authorize and token
        if register_route:
            per_family += 1  # RFC 7591 registration
    total = per_family * len(ENDPOINT_KINDS)
    if root_authorization_server:
        total += 1
    if callback_route:
        total += 1
    return total


def _expected_count_for_row(row: dict) -> int:
    attached = row["transport_posture"] != "none-public"
    front_channel = bool(row["front_channel"])
    return _expected_secure_route_count(
        authorization_routes_attached=attached,
        oauth_surface=attached and front_channel,
        register_route=attached and front_channel,
        callback_route=attached and front_channel,
        root_authorization_server=attached and bool(row.get("root_authorization_server")),
    )


class SecureAppMountConformanceTests(unittest.TestCase):
    """Executes every ``secure_app_mount`` row of the shared cross-runtime table
    against the real SecureApp registrar: the declared authority table, the
    requests a mounted SecureApp still refuses or serves, and the equality of the
    two registrars' inventories.
    """

    def test_secure_app_mount_enforces_the_shared_table(self) -> None:
        rows: list[dict] = [
            case for case in _load_fixture()["cases"] if case.get("group") == SECURE_APP_MOUNT_GROUP
        ]
        # The count is what pins the table: the filter already selects the group,
        # so a table that lost or gained a row fails here rather than shrinking.
        self.assertEqual(SECURE_APP_MOUNT_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                scenario = row["scenario"]
                if scenario == POSTURE_SCENARIO:
                    self._posture_row(row)
                elif scenario == REQUEST_SCENARIO:
                    self._request_row(row)
                elif scenario == INVENTORY_PARITY_SCENARIO:
                    self._inventory_parity_row(row)
                else:
                    self.fail(f"row {row['id']} carries unknown scenario {scenario!r}")
                executed += 1
        print(f"secure app mount conformance: {executed} cases run")
        self.assertEqual(SECURE_APP_MOUNT_CASE_COUNT, executed)

    # -- posture rows --------------------------------------------------------

    def _posture_row(self, row: dict) -> None:
        """Prove the authority table as data: the exact posture every facade route
        declares for the row's transport posture, the routes that posture never
        mounts, and the exact total, so no undeclared route can ride along.
        """
        posture = row["transport_posture"]
        front_channel = bool(row["front_channel"])
        harness = _FrontChannelHarness(self) if front_channel else None
        config = _secure_config(
            harness,
            transport_posture=posture,
            front_channel=front_channel,
            root_authorization_server=bool(row.get("root_authorization_server")),
        )
        secure, inventory = _mount_secure(config)

        context = f"route {row['route']!r} {row['method']} posture {posture!r}"
        for path in _inventory_route_paths(inventory, row["route"]):
            mounted = _secure_route(secure, row["method"], path)
            if row["expect_present"]:
                self.assertIsNotNone(mounted, f"{context} must mount {path}")
                self.assertEqual(row["expect_posture"], mounted.posture, f"{context} at {path}")
            else:
                self.assertIsNone(mounted, f"{context} must not mount {path}")

        expected = _expected_count_for_row(row)
        self.assertEqual(expected, len(secure.routes()), f"{context} must declare exactly {expected} routes")

    # -- request rows --------------------------------------------------------

    def _request_row(self, row: dict) -> None:
        """Drive the really-mounted SecureApp: every refusal must happen before the
        handler runs and, where the facade owns the route, before the
        application's resolver is even consulted.
        """
        invocations = _Invocations()
        harness = _FrontChannelHarness(self)
        config = _secure_config(
            harness,
            transport_posture=row["transport_posture"],
            front_channel=True,
            mcp_handler=_counted_handler(_no_content, invocations),
        )
        secure, _inventory = _mount_secure(
            config,
            invocations=invocations,
            tier="p2",
            clock=harness.clock,
            with_non_facade_route=True,
            policy_denial_code=(row["policy_hook_code"] if row.get("policy_hook") == "deny" else None),
        )

        request = row["request"]
        if request == "transport_credential_free":
            response = _serve(secure, "POST", ROUTE.mcp_path(), body=_mcp_body())
        elif request == "transport_insufficient_scope":
            token = _journey_transport_token(harness, "insufficient_scope")
            response = _serve(secure, "POST", ROUTE.mcp_path(), body=_mcp_body(), headers=_bearer(token))
        elif request == "transport_valid":
            response = _serve(
                secure, "POST", ROUTE.mcp_path(), body=_mcp_body(), headers=_bearer(harness.mint_access_token())
            )
        elif request == "protected_resource_metadata":
            response = _serve(secure, "GET", ROUTE.protected_resource_path())
        elif request == "register":
            response = _serve(secure, "POST", ROUTE.oauth_register_path(), body=DCR_BODY)
        elif request == "non_facade_anonymous":
            response = _serve(secure, "GET", NON_FACADE_PATH)
        elif request == "non_facade_resolved":
            response = _serve(secure, "GET", NON_FACADE_PATH, headers={SESSION_HEADER: [SESSION_VALUE]})
        elif request == "undeclared_anonymous":
            response = _serve(secure, "GET", UNDECLARED_PATH)
        else:
            self.fail(f"row {row['id']} carries unknown request {request!r}")
            return

        self.assertEqual(row["expect_status"], response.status, row["id"])
        challenge = _header(response, "www-authenticate")
        if row.get("expect_challenge_resource_metadata") is True:
            self.assertEqual(
                protected_resource_www_authenticate(JOURNEY_METADATA_URL),
                challenge,
                f"row {row['id']} must carry the RFC 9728 discovery challenge",
            )
        elif row.get("expect_challenge_resource_metadata") is False:
            self.assertNotIn(
                "resource_metadata",
                challenge or "",
                f"row {row['id']} must not advertise a protected-resource discovery URL",
            )
        expected_scope = row.get("expect_challenge_scope")
        if expected_scope is not None:
            self.assertEqual(
                insufficient_scope_www_authenticate([expected_scope], JOURNEY_METADATA_URL),
                challenge,
                f"row {row['id']} must carry the RFC 6750 insufficient_scope challenge",
            )
        if row.get("expect_handler_invocations") is not None:
            self.assertEqual(row["expect_handler_invocations"], invocations.handler, row["id"])
        if row.get("expect_resolver_invocations") is not None:
            self.assertEqual(row["expect_resolver_invocations"], invocations.resolver, row["id"])
        if row.get("expect_policy_hook_invocations") is not None:
            self.assertEqual(row["expect_policy_hook_invocations"], invocations.policy, row["id"])

    # -- inventory parity rows ----------------------------------------------

    def _inventory_parity_row(self, row: dict) -> None:
        """The SecureApp registrar returns the very inventory the plain-App
        registrar does, field for field, so mounting on a SecureApp cannot quietly
        change the facade's surface.
        """
        front_channel = bool(row["front_channel"])
        harness = _FrontChannelHarness(self) if front_channel else None
        config = _secure_config(
            harness,
            transport_posture=row["transport_posture"],
            front_channel=front_channel,
            issuer_mode=row["issuer_mode"],
            root_authorization_server=bool(row.get("root_authorization_server")),
        )

        plain_inventory = register_mcp_facade(create_app(tier="p0"), config)
        secure, secure_inventory = _mount_secure(config)

        self.assertTrue(plain_inventory.routes, f"row {row['id']} must mount a real inventory")
        if row["expect_equal"]:
            self.assertEqual(asdict(plain_inventory), asdict(secure_inventory), row["id"])
        else:
            self.assertNotEqual(asdict(plain_inventory), asdict(secure_inventory), row["id"])
        # The parity row also proves the SecureApp mount is real, not merely equal:
        # the closed-by-default app declares exactly the routes the shared
        # inventory describes, each with a declared posture.
        self.assertEqual(_expected_count_for_row(row), len(secure.routes()), row["id"])


class SecureAppMountFailClosedTests(unittest.TestCase):
    """The SecureApp stays closed by default: a rejected configuration adds no
    route at all, a registration that declares no auth posture is refused before
    any route reaches the caller's app, and a mount whose plan collides with a
    route the app already declares — first or later in the plan — fails without
    adding a single facade route.
    """

    def test_a_rejected_config_adds_no_route(self) -> None:
        secure = SecureApp(tier="p0")
        config = _secure_config(None, transport_posture="iam", front_channel=False)
        config.mcp_handler = None
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade_secure(secure, config)
        self.assertIn("MCP handler is required", str(raised.exception))
        self.assertEqual([], secure.routes())

    def test_a_posture_that_registers_no_oauth_surface_rejects_the_front_channel(self) -> None:
        harness = _FrontChannelHarness(self)
        secure = SecureApp(tier="p0")
        config = _secure_config(harness, transport_posture="none-public", front_channel=True)
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade_secure(secure, config)
        self.assertIn("the front-channel field set must not be configured", str(raised.exception))
        self.assertEqual([], secure.routes())

    def test_an_undeclared_posture_never_reaches_the_caller_app(self) -> None:
        # The refusal is the facade's own ``_declared_posture`` rule, evaluated
        # inside the secure preflight that runs before any route is installed.
        registrations = [
            facade_module._RouteRegistration(
                method="POST",
                pattern=ROUTE.mcp_path(),
                handler=_no_content,
                auth_required=False,
            )
        ]
        with self.assertRaises(ValueError) as raised:
            facade_module._preflight_secure_registrations(SecureApp(tier="p0"), registrations)
        self.assertIn("invalid or duplicate route inventory entry POST /acme/mcp", str(raised.exception))
        self.assertIn("declares no auth posture", str(raised.exception))

        # The same shape is refused before it mounts, so the caller's own app
        # never receives the posture-less route.
        secure = SecureApp(tier="p0")
        with self.assertRaises(ValueError) as raised_mount:
            facade_module._register_secure_routes(secure, registrations)
        self.assertIn("declares no auth posture", str(raised_mount.exception))
        self.assertEqual([], secure.routes())

    def test_a_second_mount_of_the_same_config_raises(self) -> None:
        config = _secure_config(None, transport_posture="iam", front_channel=False)
        secure = SecureApp(tier="p0")
        register_mcp_facade_secure(secure, config)
        mounted = len(secure.routes())
        self.assertGreater(mounted, 0)

        with self.assertRaises(ValueError) as raised:
            register_mcp_facade_secure(secure, config)
        self.assertIn("already registered on the secure app", str(raised.exception))
        self.assertEqual(mounted, len(secure.routes()))

    def test_secure_mount_rejects_a_non_first_collision_without_mounting_anything(self) -> None:
        """The all-or-nothing guarantee of the SecureApp registrar: when the
        application already owns the method+path of a LATER facade registration,
        the mount is refused before the first route reaches the app, so the app's
        route table is exactly what it was. A registrar that mounted as it went
        would leave the earlier facade routes behind, which the second-mount test
        above cannot see because its collision is the first entry of the plan.
        """
        config = _secure_config(None, transport_posture="iam", front_channel=False)
        normalized = facade_module._normalize_config(config)
        inventory = facade_module._build_inventory(normalized)
        registrations = facade_module._build_registrations(normalized, inventory)
        self.assertGreater(len(registrations), 4)

        # The application owns the fourth planned route, not the first, so a
        # mount-as-it-goes registrar would already have installed the first three.
        collision = registrations[3]
        self.assertEqual("GET", collision.method)

        secure = SecureApp(tier="p0")
        secure.get(collision.pattern, _no_content, authenticated())
        declared = secure.routes()
        self.assertEqual(1, len(declared))

        with self.assertRaises(ValueError) as raised:
            register_mcp_facade_secure(secure, config)
        self.assertIn("already registered on the secure app", str(raised.exception))
        self.assertEqual(declared, secure.routes())

    def test_secure_mount_rejects_a_cross_surface_collision_without_mounting_anything(self) -> None:
        """The all-or-nothing guarantee against a collision with a route the
        caller's app declares on a DIFFERENT surface. ``SecureApp.appsync_field``
        mounts ``GET /<field>`` for ``Query`` and ``Subscription`` and
        ``POST /<field>`` for ``Mutation`` on the SAME shared router the facade
        mounts on, and that router's duplicate check is surface-agnostic, so a
        preflight that compared only the ``http`` surface would miss the
        collision, let the mount start, and leave the facade routes that preceded
        it mounted.
        """
        config = _secure_config(None, transport_posture="iam", front_channel=False)
        normalized = facade_module._normalize_config(config)
        inventory = facade_module._build_inventory(normalized)
        registrations = facade_module._build_registrations(normalized, inventory)
        self.assertGreater(len(registrations), 4)

        # The collision is the fourth planned route, not the first, so a
        # mount-as-it-goes registrar would already have installed the first three.
        collision = registrations[3]
        self.assertEqual("GET", collision.method)
        self.assertTrue(collision.pattern.startswith("/"), collision.pattern)

        # A Query field is a GET on the shared router at "/"+field, so the field
        # name that collides with the planned path is that path without its slash.
        secure = SecureApp(tier="p0")
        secure.appsync_field("Query", collision.pattern[1:], _no_content, authenticated())
        declared = secure.routes()
        self.assertEqual(1, len(declared))
        self.assertEqual("appsync", declared[0].surface)
        collision_key = f"{declared[0].method} {declared[0].path}"

        with self.assertRaises(ValueError) as raised:
            register_mcp_facade_secure(secure, config)
        self.assertEqual(declared, secure.routes())
        self.assertIn("already registered on the secure app", str(raised.exception))
        self.assertIn(collision_key, str(raised.exception))


class SecureAppTmsJourneyTests(unittest.TestCase):
    """The complete TMS-topology journey over the SecureApp, through the really
    mounted handlers: a TMS app that keeps its own principal resolver, tier, and
    policy hook on every non-facade route while the facade owns the OAuth surface.
    """

    def test_tms_topology_journey_over_the_secure_app(self) -> None:
        invocations = _Invocations()
        harness = _FrontChannelHarness(self, mcp_handler=_mcp_ok)
        config = _secure_config(
            harness,
            transport_posture="runtime-bearer",
            front_channel=True,
            mcp_handler=_counted_handler(_mcp_ok, invocations),
        )
        secure, inventory = _mount_secure(
            config,
            invocations=invocations,
            tier="p2",
            clock=harness.clock,
            with_non_facade_route=True,
        )

        # 1. The client discovers the resource before it holds any token.
        metadata = _serve(secure, "GET", ROUTE.protected_resource_path())
        self.assertEqual(200, metadata.status)
        document = json.loads(metadata.body.decode("utf-8"))
        self.assertEqual(FRONT_TEST_RESOURCE, document["resource"])
        self.assertEqual([FRONT_TEST_RESOURCE], document["authorization_servers"])

        # 2. It registers itself (RFC 7591), bound to the route it will use.
        registration = _serve(secure, "POST", ROUTE.oauth_register_path(), body=DCR_BODY)
        self.assertEqual(201, registration.status)
        client_id = str(json.loads(registration.body.decode("utf-8"))["client_id"])
        self.assertTrue(client_id)
        record = harness.stores.client.get(hash_key(client_id))
        self.assertIsNotNone(record)
        self.assertEqual(FRONT_TEST_RESOURCE, record.bound_route)

        # 3. Authorize hands the browser to the upstream with the facade's own
        #    material, and the upstream callback completes the leg.
        authorize = _serve(
            secure,
            "GET",
            ROUTE.oauth_authorize_path(),
            {
                "client_id": [client_id],
                "redirect_uri": [FRONT_TEST_REDIRECT_URI],
                "response_type": ["code"],
                "code_challenge": [facade_module.pkce_challenge_s256(FRONT_TEST_VERIFIER)],
                "code_challenge_method": ["S256"],
                "state": ["tms-client-state"],
                "resource": [FRONT_TEST_RESOURCE],
            },
        )
        self.assertEqual(302, authorize.status)
        location = _header(authorize, "location") or ""
        self.assertTrue(location.startswith(FRONT_TEST_UPSTREAM_ISS + "/"), location)
        upstream = _location_query(authorize)
        self.assertEqual(FRONT_TEST_CLIENT_ID, upstream["client_id"])
        self.assertEqual("S256", upstream["code_challenge_method"])
        self.assertEqual(FRONT_TEST_RESOURCE, upstream["resource"])
        # The upstream is handed the facade's own callback, never the client's
        # redirect URI, and never the client's own state.
        self.assertEqual(FRONT_TEST_BASE_URL + "/_oauth/mcp/callback", upstream["redirect_uri"])
        self.assertNotEqual("tms-client-state", upstream["state"])

        callback = _serve(
            secure,
            "GET",
            inventory.callback_pattern,
            {
                "code": [FRONT_TEST_UPSTREAM_CODE],
                "state": [upstream["state"]],
                "iss": [FRONT_TEST_UPSTREAM_ISS],
            },
        )
        self.assertEqual(302, callback.status)
        # The callback returns the browser to the client's own registered redirect
        # URI with the client's state and a facade code, never the upstream code.
        callback_location = _header(callback, "location") or ""
        self.assertTrue(
            callback_location.startswith(FRONT_TEST_REDIRECT_URI),
            f"the callback must return the browser to the client's redirect URI: {callback_location!r}",
        )
        delivered = _location_query(callback)
        self.assertEqual("tms-client-state", delivered["state"])
        self.assertTrue(delivered["code"])
        self.assertNotEqual(FRONT_TEST_UPSTREAM_CODE, delivered["code"])

        # 4. The PKCE-bound exchange returns an opaque route handle instead of the
        #    upstream refresh material.
        exchange = _serve(
            secure,
            "POST",
            ROUTE.oauth_token_path(),
            body=_form(
                {
                    "grant_type": "authorization_code",
                    "code": delivered["code"],
                    "code_verifier": FRONT_TEST_VERIFIER,
                    "redirect_uri": FRONT_TEST_REDIRECT_URI,
                    "client_id": client_id,
                }
            ),
        )
        self.assertEqual(200, exchange.status)
        minted = json.loads(exchange.body.decode("utf-8"))
        access_token = str(minted["access_token"])
        handle = str(minted["refresh_token"])
        self.assertTrue(access_token)
        self.assertTrue(handle)
        self.assertNotIn("id_token", exchange.body.decode("utf-8"))

        # 5. The brokered refresh rotates the handle and still hides the upstream
        #    refresh token and any id_token.
        rotated = _serve(
            secure,
            "POST",
            ROUTE.oauth_token_path(),
            body=_form({"grant_type": "refresh_token", "refresh_token": handle, "client_id": client_id}),
        )
        self.assertEqual(200, rotated.status)
        successor = json.loads(rotated.body.decode("utf-8"))
        self.assertEqual(ROTATED_UPSTREAM_ACCESS_TOKEN, successor["access_token"])
        self.assertNotEqual(handle, successor["refresh_token"])
        scanned = rotated.body.decode("utf-8")
        self.assertNotIn(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN, scanned)
        self.assertNotIn("id_token", scanned)

        # 6. A bearer-authenticated MCP call reaches the MCP handler, without the
        #    application's own resolver being consulted for the facade route.
        before_resolver = invocations.resolver
        served = _serve(secure, "POST", ROUTE.mcp_path(), body=_mcp_body(), headers=_bearer(access_token))
        self.assertEqual(200, served.status)
        self.assertEqual(b"mcp-ok", served.body)
        self.assertEqual(1, invocations.handler)
        self.assertEqual(before_resolver, invocations.resolver)

        # 7. A credential-free call is refused with the RFC 9728 challenge and
        #    never reaches the handler.
        credential_free = _serve(secure, "POST", ROUTE.mcp_path(), body=_mcp_body())
        self.assertEqual(401, credential_free.status)
        self.assertEqual(
            protected_resource_www_authenticate(JOURNEY_METADATA_URL),
            _header(credential_free, "www-authenticate"),
        )
        self.assertEqual(1, invocations.handler)

        # 8. A token without the route's scope is refused with the RFC 6750
        #    insufficient_scope challenge naming the scope it lacks.
        insufficient = _serve(
            secure,
            "POST",
            ROUTE.mcp_path(),
            body=_mcp_body(),
            headers=_bearer(_journey_transport_token(harness, "insufficient_scope")),
        )
        self.assertEqual(403, insufficient.status)
        self.assertEqual(
            insufficient_scope_www_authenticate([PRINCIPAL_SCOPE], JOURNEY_METADATA_URL),
            _header(insufficient, "www-authenticate"),
        )
        self.assertEqual(1, invocations.handler)

        # 9. The application's own principal still governs its own route on the
        #    same app: anonymous is denied by the resolver, resolved is admitted.
        audit = _secure_route(secure, "GET", NON_FACADE_PATH)
        self.assertIsNotNone(audit)
        self.assertEqual("authenticated", audit.posture)
        before_resolver = invocations.resolver
        before_policy = invocations.policy

        anonymous = _serve(secure, "GET", NON_FACADE_PATH)
        self.assertEqual(401, anonymous.status)
        self.assertEqual(before_resolver + 1, invocations.resolver)
        self.assertEqual(before_policy + 1, invocations.policy)
        self.assertEqual(0, invocations.non_facade)

        resolved = _serve(secure, "GET", NON_FACADE_PATH, headers={SESSION_HEADER: [SESSION_VALUE]})
        self.assertEqual(200, resolved.status)
        self.assertEqual(b"audit-ok", resolved.body)
        self.assertEqual(1, invocations.non_facade)
        self.assertEqual(before_resolver + 2, invocations.resolver)

        # 10. A route the application never declares stays undeliverable.
        undeclared = _serve(secure, "GET", UNDECLARED_PATH)
        self.assertEqual(404, undeclared.status)
        self.assertEqual(before_resolver + 2, invocations.resolver)


class SecureAppConformanceKitTests(unittest.TestCase):
    """The consumer conformance kit's SecureApp variants assert the same three
    transport outcomes the plain-App kit asserts, and additionally prove that
    mounting the facade on a SecureApp leaves the application's own principal
    gate in force for every route the facade does not own.
    """

    def test_the_kit_denies_and_admits_on_the_closed_by_default_surface(self) -> None:
        invocations = _Invocations()
        handler = counting_transport_handler()
        harness = _FrontChannelHarness(self)
        config = _secure_config(
            harness,
            transport_posture="runtime-bearer",
            front_channel=False,
            mcp_handler=handler,
        )
        secure, _inventory = _mount_secure(
            config,
            invocations=invocations,
            tier="p2",
            clock=harness.clock,
            with_non_facade_route=True,
        )
        transport = ROUTE.mcp_path()

        assert_credential_free_transport_denied_secure_app(
            secure, "POST", transport, JOURNEY_METADATA_URL, handler
        )
        self.assertEqual(0, handler.invocations, "a denied transport request must not reach the MCP handler")

        assert_insufficient_scope_transport_denied_secure_app(
            secure,
            "POST",
            transport,
            _journey_transport_token(harness, "insufficient_scope"),
            JOURNEY_METADATA_URL,
            [PRINCIPAL_SCOPE],
            handler,
        )
        self.assertEqual(0, handler.invocations, "a scope denial must not reach the MCP handler")

        assert_bearer_token_reaches_transport_handler_secure_app(
            secure, "POST", transport, harness.mint_access_token(), handler
        )
        self.assertEqual(1, handler.invocations)

        # The facade's own transport route never consults the app resolver: its
        # authority is the RFC 9728 bearer validator, so the three calls above
        # add no resolver traffic.
        self.assertEqual(
            0, invocations.resolver, "the facade transport route must not consult the app resolver"
        )

        # The application's non-facade route still demands its own principal, and
        # the denial is the app's, not the facade's: no RFC 9728 challenge.
        anonymous = _serve(secure, "GET", NON_FACADE_PATH)
        self.assertEqual(401, anonymous.status)
        self.assertIsNone(_header(anonymous, "www-authenticate"))
        self.assertEqual(1, invocations.resolver, "the non-facade route must consult the app resolver")

        resolved = _serve(secure, "GET", NON_FACADE_PATH, headers={SESSION_HEADER: [SESSION_VALUE]})
        self.assertEqual(200, resolved.status)
        self.assertEqual(2, invocations.resolver)


if __name__ == "__main__":
    unittest.main()

class SecureAppMetadataIssAdvertisementTests(unittest.TestCase):
    """The SecureApp registrar serves the same RFC 9207 claim the plain-App
    registrar does when the framework owns the front channel: every routed
    authorization-server route the SecureApp mounts advertises ``iss`` support.
    """

    def test_secure_routed_metadata_advertises_rfc9207_iss_parameter_support(self) -> None:
        harness = _FrontChannelHarness(self)
        config = _secure_config(harness, transport_posture="iam", front_channel=True)
        secure, inventory = _mount_secure(config, clock=harness.clock)

        for route in inventory.routes:
            for path in (route.discovery_canonical_pattern, route.discovery_suffix_pattern):
                with self.subTest(path=path):
                    response = _serve(secure, "GET", path)
                    self.assertEqual(200, response.status)
                    self.assertIs(
                        True,
                        json.loads(response.body.decode())["authorization_response_iss_parameter_supported"],
                    )
