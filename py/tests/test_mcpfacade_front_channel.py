from __future__ import annotations

# ruff: noqa: S105, S106
import json
import secrets
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

from apptheory import (
    URL_MODE_PUBLIC_BASE_URL,
    JWKSValidatorOptions,
    FacadeConfig,
    RequireBearerTokenOptions,
    create_app,
    insufficient_scope_www_authenticate,
    new_jwks_validator,
    protected_resource_www_authenticate,
    register_mcp_facade,
)
from apptheory import mcpfacade as facade_module
from apptheory.mcproutes import DEFAULT_CALLBACK_PATH, EndpointPath
from apptheory.oauth import pkce_challenge_s256
from apptheory.oauth.autheory import AutheoryProviderOptions, _default_http_transport, new_autheory_provider
from apptheory.oauth.fake_provider import FakeUpstreamProvider, RefreshStage
from apptheory.oauth.provider import CodeExchangeRequest, TokenSet
from apptheory.oauth.store import (
    UTC_NOW_LOCK_TTL_SECONDS,
    BrokerRevokedError,
    BrokerVersionConflictError,
    ClientRecord,
    MemoryAuthorizationCodeStore,
    MemoryClientStore,
    MemoryRateLimitStore,
    MemoryRouteRefreshBrokerStore,
    MemoryTransactionStore,
    STATUS_REVOKED,
    Stores,
    hash_key,
)
from apptheory.request import Request
from apptheory.response import Response

FRONT_TEST_BASE_URL = "https://mcp.example.com"
FRONT_TEST_UPSTREAM_ISS = "https://id.example.com"
FRONT_TEST_CLIENT_ID = "facade-client-1"
FRONT_TEST_UPSTREAM_CODE = "upstream-authorization-code"
FRONT_TEST_REFRESH_TOKEN = "upstream-refresh-token-value"
FRONT_TEST_CLIENT_STATE = "client-state-1"
FRONT_TEST_REDIRECT_URI = "https://client.example/callback"
FRONT_TEST_RESOURCE = FRONT_TEST_BASE_URL + "/acme/mcp"
FRONT_TEST_VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU"
FRONT_TEST_WRONG_VERIFIER = "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890"
FRONT_TEST_TIMEOUT_SECONDS = 10.0

# The refresh grant's own upstream material. The fake serves these only for
# grant_type=refresh_token, so a refresh that returned upstream material instead
# of a framework handle is distinguishable from the code exchange, and a response
# that leaked either value is observable.
FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN = "upstream-refresh-token-rotated"
FRONT_TEST_REFRESH_ACCESS_TOKEN = "upstream-rotated-access-token"
FRONT_TEST_REFRESH_ID_TOKEN = "upstream-id-token-must-not-surface"
FRONT_TEST_ROTATED_UPSTREAM_SCOPE = "mcp:tools"

# ---------------------------------------------------------------------------
# Shared conformance fixture (the same table the Go and TypeScript loaders read)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"
FIXTURE_NAME = "facade-conformance.v1.json"

REDIRECT_MATCH_GROUP = "redirect_match"

# The number of redirect_match rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
REDIRECT_MATCH_CASE_COUNT = 11

FORM_PARSE_GROUP = "form_parse"

# The number of form_parse rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
FORM_PARSE_CASE_COUNT = 11

AUTHORIZE_PROVIDER_FAILURE_GROUP = "authorize_provider_failure"

# The number of authorize_provider_failure rows the shared table must carry; a
# change to the table must also be a deliberate edit in the Go and TypeScript
# loaders, so no runtime can silently execute a smaller table.
AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT = 2

METHOD_STATUS_GROUP = "method_status"

# The number of method_status rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
METHOD_STATUS_CASE_COUNT = 10

DCR_GROUP = "dcr"

# The number of dcr rows the shared table must carry; a change to the table must
# also be a deliberate edit in the Go, TypeScript, and Python loaders, so no
# runtime can silently execute a smaller table.
DCR_CASE_COUNT = 12

# The number of requests a dcr row sends when it carries no explicit repeat.
DCR_DEFAULT_REPEAT = 1

# The bytes the serialized pad member adds around its "a" run: `,"pad":"` plus
# `"}`.
DCR_PAD_FRAME_OVERHEAD = len(',"pad":"') + len('"}')

BOUND_ROUTE_GROUP = "bound_route"

# The number of bound_route rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
BOUND_ROUTE_CASE_COUNT = 5

# A client id no bound_route row ever registers, so a refusal row can present the
# very same request for an unknown client and prove the two refusals are
# byte-identical (THREAT_MODEL cross-cutting: no oracle).
BOUND_ROUTE_UNKNOWN_CLIENT_ID = "bound-route-unknown-client"

# The redirect URI every bound_route client registers and presents.
BOUND_ROUTE_REDIRECT_URI = FRONT_TEST_REDIRECT_URI

REFRESH_GROUP = "refresh"

# The number of refresh rows the shared table must carry; a change to the table
# must also be a deliberate edit in the Go, TypeScript, and Python loaders, so no
# runtime can silently execute a smaller table.
REFRESH_CASE_COUNT = 19

# A second registered public client, used to prove that a handle minted for one
# client is refused for another with the same invalid_grant an unknown handle
# gets.
REFRESH_TEST_OTHER_CLIENT_ID = "facade-client-2"

# The resource the harness's authorize leg binds.
REFRESH_TEST_BOUND_RESOURCE = FRONT_TEST_BASE_URL + "/acme/mcp"


def _load_fixture() -> dict:
    with (FIXTURE_DIR / FIXTURE_NAME).open("r", encoding="utf-8") as handle:
        return json.load(handle)


class _ManualClock:
    """A deterministic clock one set of reference stores shares."""

    def __init__(self, start: datetime) -> None:
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now = self._now + timedelta(seconds=seconds)


class _LoopbackTransport:
    """Injects the framework's bounded default fetch against the loopback fake.

    The adapter only ever sees the https URLs the upstream advertises; this
    documented injected-transport seam downgrades them to the plain-HTTP fake
    server.
    """

    def __init__(self, provider: FakeUpstreamProvider) -> None:
        self._provider = provider

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, dict[str, str], bytes]:
        return _default_http_transport(
            method,
            self._provider.localize(url),
            headers,
            body,
            timeout=FRONT_TEST_TIMEOUT_SECONDS,
            allow_private_hosts=True,
        )


class _RecordingBrokerStore:
    """Decorates the reference broker store and records every handle it is
    seeded with, so a test can observe the record a callback opened without the
    front channel having to expose it.
    """

    def __init__(self, inner: MemoryRouteRefreshBrokerStore) -> None:
        self._inner = inner
        self._lock = threading.Lock()
        self._handles: list[str] = []

    def put(self, record) -> None:
        with self._lock:
            self._handles.append(record.handle_hash)
        self._inner.put(record)

    def handle_hashes(self) -> list[str]:
        with self._lock:
            return list(self._handles)

    def get(self, handle_hash: str):
        return self._inner.get(handle_hash)

    def acquire_lock(self, handle_hash: str, lock_owner: str, expected_version: int):
        return self._inner.acquire_lock(handle_hash, lock_owner, expected_version)

    def compare_and_swap(self, record, expected_version: int):
        return self._inner.compare_and_swap(record, expected_version)

    def revoke(self, handle_hash: str):
        return self._inner.revoke(handle_hash)

    def route_refresh_broker_handle_ttl_seconds(self) -> float:
        return self._inner.route_refresh_broker_handle_ttl_seconds()

    def list_family(self, family_hash: str):
        return self._inner.list_family(family_hash)

    def revoke_family(self, family_hash: str):
        return self._inner.revoke_family(family_hash)

    def create_family(self, root):
        with self._lock:
            self._handles.append(root.handle_hash)
        return self._inner.create_family(root)

    def rotate_family(self, rotation):
        return self._inner.rotate_family(rotation)


def _mint_claims(issued_at: float) -> dict:
    return {
        "issuer": FRONT_TEST_UPSTREAM_ISS,
        "audience": FRONT_TEST_RESOURCE,
        "authorized_party": FRONT_TEST_CLIENT_ID,
        "subject": "user-1",
        "scope": "mcp:tools",
        "expires_in": 900,
        "issued_at": issued_at,
    }


class _MintingProvider:
    """Wraps the real Autheory adapter.

    Every leg is the adapter over the fake provider's loopback HTTP except
    ``exchange_code``, which first runs the adapter's real server-side exchange
    (so the upstream form and client are genuinely presented and recorded) and
    then returns a token set whose access token the fake signs, so the facade's
    JWKS validation of the exchanged token is exercised against a real
    signature.
    """

    def __init__(
        self,
        adapter,
        fake: FakeUpstreamProvider,
        issued_at: float,
        fail_authorization_url: bool = False,
    ) -> None:
        self._adapter = adapter
        self._fake = fake
        self._issued_at = issued_at
        self._fail_authorization_url = fail_authorization_url

    def discovery(self):
        return self._adapter.discovery()

    def authorization_url(self, req):
        if self._fail_authorization_url:
            raise RuntimeError("minting provider: authorization URL unavailable")
        return self._adapter.authorization_url(req)

    def exchange_code(self, req: CodeExchangeRequest) -> TokenSet:
        self._adapter.exchange_code(req)
        return TokenSet(
            access_token=self.mint_access_token(),
            refresh_token=FRONT_TEST_REFRESH_TOKEN,
            token_type="Bearer",
            expires_in=900,
            scope="mcp:tools",
        )

    def refresh(self, req):
        return self._adapter.refresh(req)

    def validate_access_token(self, token: str, expected):
        return self._adapter.validate_access_token(token, expected)

    def mint_access_token(self) -> str:
        return self._fake.mint_access_token(**_mint_claims(self._issued_at))


class _FrontChannelHarness:
    def __init__(
        self,
        test: unittest.TestCase,
        provider_options: Any = None,
        issuer_mode: str = "route",
        registration_endpoint_url: str | None = None,
        provider_hints: Any = None,
        fail_authorization_url: bool = False,
        transport_posture: str = "iam",
        require_bearer_token_for: Any = None,
        mcp_handler: Any = None,
        invocations: dict | None = None,
        route_refresh_events: Any = None,
        route_refresh_policy: Any = None,
    ) -> None:
        self._test = test
        self.clock = _ManualClock(datetime(2026, 1, 1, tzinfo=UTC))
        fake_options: dict[str, Any] = {
            "issuer": FRONT_TEST_UPSTREAM_ISS,
            "token_body": {
                "access_token": "placeholder-upstream-access-token",
                "token_type": "Bearer",
                "expires_in": 900,
                "refresh_token": FRONT_TEST_REFRESH_TOKEN,
                "scope": "mcp:tools",
            },
            # The refresh grant gets its own response, so a facade that returned
            # upstream refresh material or an id_token instead of a framework
            # handle is observable in the body as well as in the call counts.
            "refresh_token_body": {
                "access_token": FRONT_TEST_REFRESH_ACCESS_TOKEN,
                "token_type": "Bearer",
                "expires_in": 900,
                "refresh_token": FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
                "scope": FRONT_TEST_ROTATED_UPSTREAM_SCOPE,
                "id_token": FRONT_TEST_REFRESH_ID_TOKEN,
            },
        }
        if provider_options is not None:
            provider_options(fake_options)
        self.fake = FakeUpstreamProvider(**fake_options)
        self.fake.start()
        test.addCleanup(self.fake.stop)

        adapter = new_autheory_provider(
            AutheoryProviderOptions(
                issuer=FRONT_TEST_UPSTREAM_ISS,
                client_id=FRONT_TEST_CLIENT_ID,
                http_get=_LoopbackTransport(self.fake),
                allow_private_hosts=True,
                http_timeout_seconds=FRONT_TEST_TIMEOUT_SECONDS,
            )
        )
        self.issued_at = time.time()
        self.provider = _MintingProvider(adapter, self.fake, self.issued_at, fail_authorization_url)
        self.broker = _RecordingBrokerStore(MemoryRouteRefreshBrokerStore(now=self.clock.now))
        self.stores = Stores(
            transaction=MemoryTransactionStore(now=self.clock.now),
            authorization_code=MemoryAuthorizationCodeStore(now=self.clock.now),
            client=MemoryClientStore(now=self.clock.now),
            route_refresh_broker=self.broker,
            rate_limit=MemoryRateLimitStore(now=self.clock.now),
        )
        self.kind = "namespace"
        self.endpoint = EndpointPath(kind=self.kind, client_namespace="acme")

        self.bearer_validator = None
        base_mcp_handler = mcp_handler or (
            lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)
        )

        def _counting_mcp_handler(ctx) -> Response:
            if invocations is not None:
                invocations["count"] += 1
            return base_mcp_handler(ctx)

        config = FacadeConfig(
            issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
            jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
            issuer_mode=issuer_mode,
            registration_endpoint_url=registration_endpoint_url or "",
            url_mode=URL_MODE_PUBLIC_BASE_URL,
            public_base_url=FRONT_TEST_BASE_URL,
            transport_posture=transport_posture,
            scopes={
                "namespace": ["mcp:tools"],
                "partner_namespace": ["mcp:tools"],
                "agent": ["mcp:tools"],
                "partner_agent": ["mcp:tools"],
            },
            mcp_handler=_counting_mcp_handler,
            provider=self.provider,
            stores=self.stores,
            upstream_client_id=FRONT_TEST_CLIENT_ID,
            upstream_issuer=FRONT_TEST_UPSTREAM_ISS,
            provider_hints=provider_hints,
            route_refresh_policy=route_refresh_policy
            or facade_module.RouteRefreshPolicy(
                handle_ttl_seconds=900,
                reuse_rate_ceiling=facade_module.MIN_REFRESH_REUSE_RATE_CEILING,
            ),
            route_refresh_events=route_refresh_events,
        )
        if require_bearer_token_for is not None:
            bearer_options = require_bearer_token_for(self.fake)
            config.require_bearer_token = bearer_options
            self.bearer_validator = bearer_options.claims_validator
        self.stores.client.put(
            ClientRecord(
                client_id_hash=hash_key(FRONT_TEST_CLIENT_ID),
                client_id=FRONT_TEST_CLIENT_ID,
                redirect_uris=[FRONT_TEST_REDIRECT_URI],
                token_endpoint_auth_method="none",
            )
        )

        # The injected clock is the same deterministic instant the stores observe,
        # so grace windows, record lifetimes, and rotation timestamps all move
        # together when a test advances the clock.
        self.app = create_app(clock=self.clock)
        register_mcp_facade(self.app, config)

    # -- requests ------------------------------------------------------------

    def serve(
        self,
        method: str,
        path: str,
        query: dict | None = None,
        body: bytes = b"",
        headers: dict | None = None,
    ) -> Response:
        return self.app.serve(
            Request(
                method=method,
                path=path,
                headers=dict(headers or {}),
                query=query or {},
                body=body,
                is_base64=False,
            )
        )

    def authorize(self, mutate=None) -> Response:
        query: dict[str, list[str]] = {
            "client_id": [FRONT_TEST_CLIENT_ID],
            "redirect_uri": [FRONT_TEST_REDIRECT_URI],
            "response_type": ["code"],
            "code_challenge": [pkce_challenge_s256(FRONT_TEST_VERIFIER)],
            "code_challenge_method": ["S256"],
            "state": [FRONT_TEST_CLIENT_STATE],
            "resource": [FRONT_TEST_RESOURCE],
        }
        if mutate is not None:
            mutate(query)
        return self.serve("GET", self.endpoint.oauth_authorize_path(), query)

    def authorize_and_callback(self) -> tuple[Response, str]:
        authorize_response = self.authorize()
        self._test.assertEqual(302, authorize_response.status)
        upstream_state = _location_query(authorize_response).get("state", "")

        callback = self.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {
                "code": [FRONT_TEST_UPSTREAM_CODE],
                "state": [upstream_state],
                "iss": [FRONT_TEST_UPSTREAM_ISS],
            },
        )
        self._test.assertEqual(302, callback.status)
        code = _location_query(callback).get("code", "")
        self._test.assertTrue(code)
        return callback, code

    def token(self, form: dict[str, list[str]]) -> Response:
        return self.serve("POST", self.endpoint.oauth_token_path(), None, urlencode(form, doseq=True).encode())

    def register(self, body: bytes) -> Response:
        return self.serve("POST", self.endpoint.oauth_register_path(), None, body)

    def mint_access_token(self) -> str:
        return self.provider.mint_access_token()


def _location(response: Response) -> str:
    values = response.headers.get("location") or []
    return str(values[0]) if values else ""


def _location_query(response: Response) -> dict[str, str]:
    location = _location(response)
    if not location:
        return {}
    return dict(parse_qsl(urlsplit(location).query, keep_blank_values=True))


def _scan(response: Response) -> str:
    scanned = _location(response) + "\n"
    for values in response.headers.values():
        scanned += "\n".join(str(value) for value in values) + "\n"
    return scanned + response.body.decode("utf-8", "replace")


def _broker_handle_hash(response: Response) -> str:
    payload = json.loads(response.body.decode("utf-8"))
    refresh_token = str(payload.get("refresh_token") or "")
    if not refresh_token:
        raise AssertionError("token response must carry a refresh handle")
    return hash_key(refresh_token)


class FrontChannelAuthorizeTests(unittest.TestCase):
    def test_authorize_redirects_upstream_with_the_facades_own_material(self) -> None:
        # DESIGN section 8.1 / journey step 5 / T4.
        harness = _FrontChannelHarness(self)
        response = harness.authorize()
        self.assertEqual(302, response.status)

        location = _location(response)
        self.assertTrue(location.startswith(FRONT_TEST_UPSTREAM_ISS + "/"), location)
        query = _location_query(response)
        self.assertEqual(FRONT_TEST_CLIENT_ID, query.get("client_id"))
        self.assertEqual(FRONT_TEST_BASE_URL + "/_oauth/mcp/callback", query.get("redirect_uri"))
        self.assertEqual("S256", query.get("code_challenge_method"))
        self.assertTrue(query.get("code_challenge"))
        self.assertEqual(FRONT_TEST_RESOURCE, query.get("resource"))
        self.assertNotEqual(FRONT_TEST_CLIENT_STATE, query.get("state"))
        self.assertTrue(query.get("state"))

    def test_authorize_rejects_unknown_client_and_redirect_without_redirect(self) -> None:
        # T1: both pre-redirect-URI failures render a 400 error page.
        harness = _FrontChannelHarness(self)

        unknown = harness.authorize(lambda query: query.__setitem__("client_id", ["unknown-client"]))
        self.assertEqual(400, unknown.status)
        self.assertEqual("", _location(unknown))
        self.assertIn('"error":"invalid_client"', unknown.body.decode())

        unmatched = harness.authorize(lambda query: query.__setitem__("redirect_uri", ["https://evil.example/cb"]))
        self.assertEqual(400, unmatched.status)
        self.assertEqual("", _location(unmatched))

    def test_authorize_requires_fresh_s256_pkce(self) -> None:
        # T3: an absent challenge and a plain challenge are both refused by a
        # redirect, because the redirect URI has already been validated.
        harness = _FrontChannelHarness(self)

        def drop_challenge(query: dict) -> None:
            query.pop("code_challenge", None)
            query.pop("code_challenge_method", None)

        missing = harness.authorize(drop_challenge)
        self.assertEqual(302, missing.status)
        self.assertEqual("invalid_request", _location_query(missing).get("error"))

        def plain_challenge(query: dict) -> None:
            query["code_challenge"] = ["plain-challenge-value"]
            query["code_challenge_method"] = ["plain"]

        plain = harness.authorize(plain_challenge)
        self.assertEqual(302, plain.status)
        self.assertEqual("invalid_request", _location_query(plain).get("error"))

    def test_authorize_rejects_wrong_resource(self) -> None:
        # T7: a resource that is not the route resource is refused before any
        # upstream call.
        harness = _FrontChannelHarness(self)
        response = harness.authorize(lambda query: query.__setitem__("resource", [FRONT_TEST_BASE_URL + "/other/mcp"]))
        self.assertEqual(302, response.status)
        self.assertEqual("invalid_target", _location_query(response).get("error"))


class FrontChannelRedirectMatchConformanceTests(unittest.TestCase):
    """Pins the RFC 8252 section 7.3 loopback redirect rule to the shared
    cross-runtime table through the real ``/authorize`` handler: an accepted row
    reaches the upstream redirect (302), and a refused row renders the
    pre-redirect 400 error page with no ``Location``, so the open-redirect
    defense is proven end to end rather than against the matcher alone.
    """

    def test_authorize_enforces_the_shared_redirect_match_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == REDIRECT_MATCH_GROUP]
        self.assertEqual(REDIRECT_MATCH_CASE_COUNT, len(rows))

        harness = _FrontChannelHarness(self)
        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                client_id = "redirect-match-" + row["id"]
                harness.stores.client.put(
                    ClientRecord(
                        client_id_hash=hash_key(client_id),
                        client_id=client_id,
                        redirect_uris=list(row["registered"]),
                        token_endpoint_auth_method="none",
                    )
                )

                def select(
                    query: dict,
                    _client_id: str = client_id,
                    _requested: str = row["requested"],
                ) -> None:
                    query["client_id"] = [_client_id]
                    query["redirect_uri"] = [_requested]

                response = harness.authorize(select)
                context = f"registered {row['registered']!r}, requested {row['requested']!r}"
                if row["expect"] == "accept":
                    self.assertEqual(302, response.status, context)
                elif row["expect"] == "reject":
                    self.assertEqual(400, response.status, context)
                    self.assertEqual("", _location(response), context)
                else:
                    self.fail(f"unknown expect {row['expect']!r}")
                executed += 1
        print(f"redirect match conformance: {executed} cases run")
        self.assertEqual(REDIRECT_MATCH_CASE_COUNT, executed)


def _form_parse_body(row: dict) -> bytes:
    """Build the raw /token body a form_parse row presents: the literal body, or
    body_prefix padded with "a" out to exactly total_bytes."""
    total = row.get("total_bytes")
    if not total:
        return str(row.get("body") or "").encode("utf-8")
    prefix = str(row.get("body_prefix") or "").encode("utf-8")
    return prefix + b"a" * (int(total) - len(prefix))


class FrontChannelFormParseConformanceTests(unittest.TestCase):
    """Pins the one bounded, strict ``/token`` request-body rule to the shared
    cross-runtime table through the real token handler: Go's ``url.ParseQuery``
    is the reference, so a ``;`` separator or a malformed percent escape fails
    the whole body (``invalid_request``), a repeated key keeps its first
    occurrence, and a raw body strictly larger than the 16384-byte framework
    bound fails closed before any parse.
    """

    def test_token_enforces_the_shared_form_parse_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == FORM_PARSE_GROUP]
        self.assertEqual(FORM_PARSE_CASE_COUNT, len(rows))

        harness = _FrontChannelHarness(self)
        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                response = harness.serve("POST", harness.endpoint.oauth_token_path(), None, _form_parse_body(row))
                self.assertEqual(400, response.status, row["id"])
                payload = json.loads(response.body.decode("utf-8"))
                self.assertEqual(row["expect_error"], payload.get("error"), row["id"])
                executed += 1
        print(f"form parse conformance: {executed} cases run")
        self.assertEqual(FORM_PARSE_CASE_COUNT, executed)


class FrontChannelAuthorizeProviderFailureConformanceTests(unittest.TestCase):
    """Pins the authorize leg's provider-call failure class to the shared
    cross-runtime table through the real ``/authorize`` handler: a failing
    provider AuthorizationURL builder and a failing app-supplied providerHints
    each render the gateway-class 502 ``upstream_error`` error page with no
    ``Location``, so the provider-call failure class is the same 502 as the
    callback's rather than the facade's own 400 vocabulary.
    """

    def test_authorize_enforces_the_shared_provider_failure_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == AUTHORIZE_PROVIDER_FAILURE_GROUP]
        self.assertEqual(AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):

                def provider_hints(_ctx, _fail: str = row["fail"]) -> dict[str, str]:
                    if _fail == "provider_hints":
                        raise RuntimeError("provider hints unavailable")
                    return {}

                harness = _FrontChannelHarness(
                    self,
                    provider_hints=provider_hints,
                    fail_authorization_url=row["fail"] == "authorization_url",
                )
                response = harness.authorize()
                context = f"fail {row['fail']!r}"
                self.assertEqual(row["expect_status"], response.status, context)
                if row.get("expect_no_location"):
                    self.assertEqual("", _location(response), context)
                body = response.body.decode("utf-8", "replace")
                for want in row["expect_body_has"]:
                    self.assertIn(want, body, context)
                executed += 1
        print(f"authorize provider failure conformance: {executed} cases run")
        self.assertEqual(AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT, executed)


def _allow_methods(response: Response) -> list[str]:
    """Returns the sorted methods the response's ``allow`` header lists, or an
    empty list when the header is absent or empty."""
    values = response.headers.get("allow") or []
    if not values:
        return []
    return sorted(part.strip() for part in str(values[0]).split(",") if part.strip())


def _method_status_route_path(endpoint: EndpointPath, key: str) -> str:
    """Resolves a method_status row's route key to the concrete path the facade
    mounts, deriving every mounted path from the framework's route-algebra helpers
    rather than a hard-coded string. ``unmounted_token`` and ``unknown`` are
    deliberately not mounted: the first is a bare MCP path with a trailing
    segment, and the second is a path no kind's pattern can match."""
    if key == "mcp":
        return endpoint.mcp_path()
    if key == "token":
        return endpoint.oauth_token_path()
    if key == "authorize":
        return endpoint.oauth_authorize_path()
    if key == "callback":
        return DEFAULT_CALLBACK_PATH
    if key == "discovery_canonical":
        return endpoint.oauth_authorization_server_path()
    if key == "discovery_suffix":
        return endpoint.oauth_authorization_server_suffix_path()
    if key == "protected_resource":
        return endpoint.protected_resource_path()
    if key == "unmounted_token":
        return endpoint.mcp_path() + "/token"
    if key == "unknown":
        return "/unknown/mcp/path"
    raise AssertionError(f"unknown method_status route key {key!r}")


class FrontChannelMethodStatusConformanceTests(unittest.TestCase):
    """Pins the route-model method-mismatch contract to the shared cross-runtime
    table through the real mounted app: a mounted path with an unsupported method
    answers 405 with an ``allow`` header listing the permitted methods, and a path
    that is not mounted at all answers 404 with no ``allow`` header.
    """

    def test_method_status_enforces_the_shared_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == METHOD_STATUS_GROUP]
        self.assertEqual(METHOD_STATUS_CASE_COUNT, len(rows))

        harness = _FrontChannelHarness(self)
        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                path = _method_status_route_path(harness.endpoint, row["route"])
                response = harness.serve(row["method"], path)
                context = f"route {row['route']!r} method {row['method']!r}"
                self.assertEqual(row["expect_status"], response.status, context)
                self.assertEqual(list(row["expect_allow"]), _allow_methods(response), context)
                if row["expect_status"] == 404:
                    self.assertNotIn("allow", {name.lower() for name in response.headers}, context)
                executed += 1
        print(f"method status conformance: {executed} cases run")
        self.assertEqual(METHOD_STATUS_CASE_COUNT, executed)


def _dcr_request_body(row: dict) -> bytes:
    """Build the raw /register body a dcr row presents: the row's request as
    compact JSON, or that object with one ignored ``pad`` member appended so the
    serialized body is exactly ``pad_to_bytes`` bytes long.
    """
    compact = json.dumps(row.get("request") or {}, separators=(",", ":")).encode("utf-8")
    total = int(row.get("pad_to_bytes") or 0)
    if total == 0:
        return compact
    if not compact.endswith(b"}") or len(compact) < 2:
        raise AssertionError(f"row {row['id']!r} must serialize to a JSON object")
    padding = total - (len(compact) - 1) - DCR_PAD_FRAME_OVERHEAD
    if padding < 1:
        raise AssertionError(f"row {row['id']!r} cannot pad to {total} bytes")
    body = compact[:-1] + b',"pad":"' + b"a" * padding + b'"}'
    if len(body) != total:
        raise AssertionError(f"row {row['id']!r} must present exactly {total} body bytes")
    return body


class FrontChannelDCRConformanceTests(unittest.TestCase):
    """Pins the RFC 7591 registration rule to the shared cross-runtime table
    through the real mounted ``POST .../register`` handler: every row runs
    against a fresh harness, so the per-route registration bucket is
    deterministic and the rate-limited row's eleventh attempt is the first
    refusal. A 201 row must also have persisted the client it minted, bound to
    the advertising route the table's authorize handler computes.
    """

    def test_register_enforces_the_shared_dcr_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == DCR_GROUP]
        self.assertEqual(DCR_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                harness = _FrontChannelHarness(self)
                body = _dcr_request_body(row)

                repeat = int(row.get("repeat") or 0)
                if repeat < 1:
                    repeat = DCR_DEFAULT_REPEAT
                response = harness.register(body)
                for _attempt in range(repeat - 1):
                    response = harness.register(body)

                self.assertEqual(row["expect_status"], response.status, f"row {row['id']} body {body!r}")

                scanned = response.body.decode("utf-8", "replace")
                payload = json.loads(scanned)
                for token in row["expect_body_has"]:
                    self.assertIn(token, scanned, row["id"])
                for token in row["expect_body_absent"]:
                    self.assertNotIn(token, scanned, row["id"])
                if row["expect_no_store"]:
                    self.assertEqual(["no-store"], response.headers.get("cache-control"), row["id"])
                    self.assertEqual(["no-cache"], response.headers.get("pragma"), row["id"])
                if row.get("expect_header"):
                    values = response.headers.get(row["expect_header"]) or []
                    self.assertTrue(values, row["id"])
                    retry_after = int(str(values[0]))
                    self.assertGreaterEqual(retry_after, 1, row["id"])
                if row["expect_status"] == 201:
                    self._assert_registered_client(harness, row, payload)
                executed += 1
        print(f"dcr conformance: {executed} cases run")
        self.assertEqual(DCR_CASE_COUNT, executed)

    def _assert_registered_client(self, harness: _FrontChannelHarness, row: dict, payload: dict) -> None:
        """Prove a 201 row persisted the client it minted: the id resolves in the
        client store, the record claims the public auth method and the validated
        redirect URIs, and its bound route is the advertising route of the
        endpoint kind, derived from the route algebra rather than a literal.
        """
        client_id = str(payload.get("client_id") or "")
        self.assertTrue(client_id, row["id"])
        # The minted id is 32 random bytes, so it is 43 base64url characters:
        # the 22-character floor is the 128-bit minimum of DESIGN section 8.3.
        self.assertGreaterEqual(len(client_id), 22, row["id"])
        self.assertIn("client_id_issued_at", payload, row["id"])

        record = harness.stores.client.get(hash_key(client_id))
        self.assertIsNotNone(record, row["id"])
        self.assertEqual("none", record.token_endpoint_auth_method, row["id"])
        self.assertEqual(list(row["request"]["redirect_uris"]), record.redirect_uris, row["id"])
        self.assertEqual(FRONT_TEST_BASE_URL + harness.endpoint.mcp_path(), record.bound_route, row["id"])


def _bound_route_endpoint(key: str) -> EndpointPath:
    """Resolves a bound_route row's route key to the endpoint the loader serves
    it at, so every mounted path is derived from the framework's route algebra
    rather than a hard-coded string. ``namespace`` is the harness's own route;
    ``agent`` is a different mounted route whose advertising resource genuinely
    differs, so a bound-route comparison cannot pass by coinciding on one path.
    """
    if key == "namespace":
        return EndpointPath(kind="namespace", client_namespace="acme")
    if key == "agent":
        return EndpointPath(kind="agent", client_namespace="acme", agent_id="agent-1")
    raise AssertionError(f"unknown bound_route route key {key!r}")


def _bound_route_resource(endpoint: EndpointPath) -> str:
    """The advertising route resource of an endpoint, derived as the facade does."""
    return FRONT_TEST_BASE_URL + endpoint.mcp_path()


def _bound_route_authorize_query(endpoint: EndpointPath, client_id: str) -> dict[str, list[str]]:
    """The valid authorize request the rows present, carrying the presented
    route's own advertising resource."""
    return {
        "client_id": [client_id],
        "redirect_uri": [BOUND_ROUTE_REDIRECT_URI],
        "response_type": ["code"],
        "code_challenge": [pkce_challenge_s256(FRONT_TEST_VERIFIER)],
        "code_challenge_method": ["S256"],
        "state": [FRONT_TEST_CLIENT_STATE],
        "resource": [_bound_route_resource(endpoint)],
    }


def _bound_route_token_form(client_id: str, code: str) -> dict[str, list[str]]:
    """The code-exchange form the rows present."""
    return {
        "grant_type": ["authorization_code"],
        "code": [code],
        "code_verifier": [FRONT_TEST_VERIFIER],
        "redirect_uri": [BOUND_ROUTE_REDIRECT_URI],
        "client_id": [client_id],
    }


def _bound_route_register(harness: _FrontChannelHarness, endpoint: EndpointPath) -> str:
    """Registers one client through the real ``POST .../register`` handler at the
    row's registered route and returns the server-assigned id."""
    body = json.dumps({"redirect_uris": [BOUND_ROUTE_REDIRECT_URI]}, separators=(",", ":")).encode("utf-8")
    response = harness.serve("POST", endpoint.oauth_register_path(), None, body)
    if response.status != 201:
        raise AssertionError(f"bound_route registration must succeed, got {response.status}")
    client_id = str(json.loads(response.body.decode("utf-8")).get("client_id") or "")
    if not client_id:
        raise AssertionError("bound_route registration must mint a client id")
    return client_id


def _bound_route_mint_code(harness: _FrontChannelHarness, endpoint: EndpointPath, client_id: str) -> str:
    """Completes authorize plus callback at the registered route and returns the
    facade code, so a token row has a genuinely redeemable code minted for the
    client it presents."""
    authorize_response = harness.serve(
        "GET", endpoint.oauth_authorize_path(), _bound_route_authorize_query(endpoint, client_id)
    )
    if authorize_response.status != 302:
        raise AssertionError(
            f"bound_route authorize at the registered route must redirect, got {authorize_response.status}"
        )
    callback = harness.serve(
        "GET",
        DEFAULT_CALLBACK_PATH,
        {
            "code": [FRONT_TEST_UPSTREAM_CODE],
            "state": [_location_query(authorize_response).get("state", "")],
            "iss": [FRONT_TEST_UPSTREAM_ISS],
        },
    )
    if callback.status != 302:
        raise AssertionError(f"bound_route callback must redirect, got {callback.status}")
    code = _location_query(callback).get("code", "")
    if not code:
        raise AssertionError("bound_route callback must mint a facade code")
    return code


METADATA_REGISTRATION_GROUP = "metadata_registration"

# The number of metadata_registration rows the shared table must carry; a change
# to the table must also be a deliberate edit in the Go and TypeScript loaders, so
# no runtime can silently execute a smaller table.
METADATA_REGISTRATION_CASE_COUNT = 6

# The single route the group resolves, so a row exercises only the mount shape and
# the issuer mode.
METADATA_REGISTRATION_ENDPOINT = EndpointPath(kind="namespace", client_namespace="acme")


def _metadata_registration_app(test: unittest.TestCase, row: dict) -> Any:
    """Mount the facade a metadata_registration row asks for.

    The front-channel field set is attached only for the rows that request it, so
    the mounted ``/register`` route and the advertised member move together.
    """
    if row["front_channel"]:
        return _FrontChannelHarness(
            test,
            issuer_mode=row["issuer_mode"],
            registration_endpoint_url=row.get("registration_endpoint_url"),
        ).app

    config = FacadeConfig(
        issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
        jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
        issuer_mode=row["issuer_mode"],
        registration_endpoint_url=row.get("registration_endpoint_url") or "",
        url_mode=URL_MODE_PUBLIC_BASE_URL,
        public_base_url=FRONT_TEST_BASE_URL,
        transport_posture="iam",
        scopes={
            "namespace": ["mcp:tools"],
            "partner_namespace": ["mcp:tools"],
            "agent": ["mcp:tools"],
            "partner_agent": ["mcp:tools"],
        },
        mcp_handler=lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
    )
    if row.get("register_handler"):
        config.register_handler = lambda _kind: (
            lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False)
        )
    app = create_app(tier="p0")
    register_mcp_facade(app, config)
    return app


def _metadata_registration_document(app: Any) -> dict:
    response = app.serve(
        Request(
            method="GET",
            path=METADATA_REGISTRATION_ENDPOINT.oauth_authorization_server_path(),
            query={},
            body=b"",
            is_base64=False,
        )
    )
    if response.status != 200:
        raise AssertionError(f"discovery must answer 200, got {response.status}")
    return json.loads(response.body.decode("utf-8"))


class FrontChannelMetadataRegistrationTests(unittest.TestCase):
    """Pins the advertised ``registration_endpoint`` to the mounted ``/register``
    route through the real facade: the routed RFC 8414 document carries the member
    exactly while the front channel or an explicit register handler mounts that
    route, so a facade that mounts none never advertises a URL that 404s.
    """

    def test_metadata_advertises_registration_exactly_while_the_route_is_mounted(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == METADATA_REGISTRATION_GROUP]
        self.assertEqual(METADATA_REGISTRATION_CASE_COUNT, len(rows))

        register_path = METADATA_REGISTRATION_ENDPOINT.oauth_register_path()

        executed = 0
        for row in rows:
            executed += 1
            with self.subTest(case=row["id"]):
                document = _metadata_registration_document(_metadata_registration_app(self, row))
                expect = row["expect"]
                if expect == "absent":
                    self.assertNotIn(
                        "registration_endpoint",
                        document,
                        f"row {row['id']} must omit registration_endpoint; the /register route is not mounted",
                    )
                elif expect == "configured":
                    self.assertEqual(row["registration_endpoint_url"], document["registration_endpoint"])
                elif expect == "issuer_derived":
                    self.assertEqual(FRONT_TEST_BASE_URL + "/acme/mcp/register", document["registration_endpoint"])
                elif expect == "route_derived":
                    self.assertEqual(FRONT_TEST_BASE_URL + register_path, document["registration_endpoint"])
                else:
                    raise AssertionError(f"unknown expect {expect!r}")

        self.assertEqual(METADATA_REGISTRATION_CASE_COUNT, executed)
        print(f"metadata registration conformance: {executed} cases run")


class FrontChannelBoundRouteConformanceTests(unittest.TestCase):
    """Pins the registration route binding to the shared cross-runtime table
    through the real mounted handlers: a client registered through
    ``POST .../register`` is accepted only at the advertising route it registered
    at and is refused at any other mounted route with the same non-oracle
    invalid_client response an unknown client gets, while a pre-registered client
    whose record carries no bound route stays valid at every route.
    """

    def test_bound_route_enforces_the_shared_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == BOUND_ROUTE_GROUP]
        self.assertEqual(BOUND_ROUTE_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                harness = _FrontChannelHarness(self)
                registered = _bound_route_endpoint(row["registered_at"])
                presented = _bound_route_endpoint(row["presented_at"])
                context = f"row {row['id']}"

                client_id = FRONT_TEST_CLIENT_ID
                if row["client"] == "dcr":
                    client_id = _bound_route_register(harness, registered)
                elif row["client"] != "pre_registered":
                    raise AssertionError(f"unknown bound_route client {row['client']!r}")

                if row["stage"] == "authorize":
                    path = presented.oauth_authorize_path()
                    response = harness.serve("GET", path, _bound_route_authorize_query(presented, client_id))
                    unknown = harness.serve(
                        "GET", path, _bound_route_authorize_query(presented, BOUND_ROUTE_UNKNOWN_CLIENT_ID)
                    )
                elif row["stage"] == "token":
                    path = presented.oauth_token_path()
                    code = _bound_route_mint_code(harness, registered, client_id)
                    response = harness.serve(
                        "POST", path, None, urlencode(_bound_route_token_form(client_id, code), doseq=True).encode()
                    )
                    unknown = harness.serve(
                        "POST",
                        path,
                        None,
                        urlencode(_bound_route_token_form(BOUND_ROUTE_UNKNOWN_CLIENT_ID, code), doseq=True).encode(),
                    )
                else:
                    raise AssertionError(f"unknown bound_route stage {row['stage']!r}")

                self.assertEqual(row["expect_status"], response.status, context)
                if row["expect_status"] == 200:
                    self.assertIn('"access_token"', response.body.decode("utf-8"), context)
                if row["expect_status"] == 302:
                    self.assertTrue(_location(response), f"{context} must redirect")
                if row["expect_status"] != 400:
                    executed += 1
                    continue
                # A refusal is the same non-oracle invalid_client response an unknown
                # client gets at this very route: byte-identical body, no redirect,
                # and no mention of any route the client might have registered at.
                self.assertEqual(400, unknown.status, f"{context} unknown-client control")
                self.assertEqual(
                    unknown.body.decode("utf-8"),
                    response.body.decode("utf-8"),
                    f"{context} must be byte-identical to the unknown-client refusal",
                )
                self.assertEqual("", _location(response), f"{context} must not redirect")
                self.assertIn('"error":"invalid_client"', response.body.decode("utf-8"), context)
                self.assertNotIn("route", response.body.decode("utf-8"), f"{context} must not name a route")
                executed += 1
        print(f"bound route conformance: {executed} cases run")
        self.assertEqual(BOUND_ROUTE_CASE_COUNT, executed)


class FrontChannelCallbackTests(unittest.TestCase):
    def test_callback_completes_the_journey_and_hides_upstream_material(self) -> None:
        # journey step 6 / T6 / T10.
        harness = _FrontChannelHarness(self)
        callback, _code = harness.authorize_and_callback()
        self.assertEqual(FRONT_TEST_RESOURCE, _location_query(callback).get("iss"))
        self.assertEqual(FRONT_TEST_CLIENT_STATE, _location_query(callback).get("state"))

        scanned = _scan(callback)
        self.assertNotIn(FRONT_TEST_UPSTREAM_CODE, scanned)
        self.assertNotIn(FRONT_TEST_REFRESH_TOKEN, scanned)
        self.assertNotIn("id_token", scanned)
        self.assertEqual(1, harness.fake.token_calls)

    def test_callback_rejects_iss_mismatch_before_consuming_or_exchanging(self) -> None:
        # T4 and DESIGN section 8.2.
        harness = _FrontChannelHarness(self)
        state = _location_query(harness.authorize()).get("state", "")

        mismatch = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": [FRONT_TEST_UPSTREAM_CODE], "state": [state], "iss": ["https://evil.example"]},
        )
        self.assertEqual(400, mismatch.status)
        self.assertEqual("", _location(mismatch))
        self.assertEqual(0, harness.fake.token_calls)

        # The transaction was not consumed: the same state still completes.
        retry = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": [FRONT_TEST_UPSTREAM_CODE], "state": [state], "iss": [FRONT_TEST_UPSTREAM_ISS]},
        )
        self.assertEqual(302, retry.status)
        self.assertTrue(_location_query(retry).get("code"))

    def test_callback_rejects_absent_iss(self) -> None:
        # T4: an absent iss is rejected in the same class, before consume.
        harness = _FrontChannelHarness(self)
        state = _location_query(harness.authorize()).get("state", "")

        response = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": [FRONT_TEST_UPSTREAM_CODE], "state": [state]},
        )
        self.assertEqual(400, response.status)
        self.assertEqual("", _location(response))
        self.assertEqual(0, harness.fake.token_calls)

    def test_callback_rejects_forged_and_replayed_state(self) -> None:
        # T10: a forged state is refused, and a consumed state is terminal.
        harness = _FrontChannelHarness(self)

        forged = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": ["attacker-code"], "state": ["attacker-state"], "iss": [FRONT_TEST_UPSTREAM_ISS]},
        )
        self.assertEqual(400, forged.status)
        self.assertEqual("", _location(forged))
        self.assertEqual(0, harness.fake.token_calls)

        state = _location_query(harness.authorize()).get("state", "")
        first = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": [FRONT_TEST_UPSTREAM_CODE], "state": [state], "iss": [FRONT_TEST_UPSTREAM_ISS]},
        )
        self.assertEqual(302, first.status)
        self.assertEqual(1, harness.fake.token_calls)

        replayed = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {"code": ["c"], "state": [state], "iss": [FRONT_TEST_UPSTREAM_ISS]},
        )
        self.assertEqual(400, replayed.status)
        self.assertEqual("", _location(replayed))
        self.assertEqual(1, harness.fake.token_calls)


class FrontChannelTokenTests(unittest.TestCase):
    def test_token_code_exchange_returns_the_opaque_handle_and_the_unmodified_token(self) -> None:
        # journey step 7 / T6.
        harness = _FrontChannelHarness(self)
        _callback, code = harness.authorize_and_callback()
        minted = harness.mint_access_token()

        response = harness.token(
            {
                "grant_type": ["authorization_code"],
                "code": [code],
                "code_verifier": [FRONT_TEST_VERIFIER],
                "redirect_uri": [FRONT_TEST_REDIRECT_URI],
                "client_id": [FRONT_TEST_CLIENT_ID],
            }
        )
        self.assertEqual(200, response.status)
        body = response.body.decode()
        self.assertIn('"access_token":"' + minted + '"', body)
        self.assertIn('"refresh_token":"', body)
        self.assertNotIn(FRONT_TEST_REFRESH_TOKEN, body)
        self.assertNotIn("id_token", body)
        self.assertIn('"token_type":"Bearer"', body)

    def test_token_replay_revokes_the_broker_record(self) -> None:
        # T2 / R1.
        harness = _FrontChannelHarness(self)
        _callback, code = harness.authorize_and_callback()
        form = {
            "grant_type": ["authorization_code"],
            "code": [code],
            "code_verifier": [FRONT_TEST_VERIFIER],
            "redirect_uri": [FRONT_TEST_REDIRECT_URI],
            "client_id": [FRONT_TEST_CLIENT_ID],
        }
        first = harness.token(form)
        self.assertEqual(200, first.status)

        handle_hash = _broker_handle_hash(first)

        replay = harness.token(form)
        self.assertEqual(400, replay.status)
        self.assertIn('"error":"invalid_grant"', replay.body.decode())

        record = harness.stores.route_refresh_broker.get(handle_hash)
        self.assertIsNotNone(record)
        self.assertEqual("revoked", record.status)

    def test_token_rejects_wrong_verifier_and_unknown_code(self) -> None:
        # T3/T2: the response is not an oracle.
        harness = _FrontChannelHarness(self)
        _callback, code = harness.authorize_and_callback()

        wrong = harness.token(
            {
                "grant_type": ["authorization_code"],
                "code": [code],
                "code_verifier": [FRONT_TEST_WRONG_VERIFIER],
                "redirect_uri": [FRONT_TEST_REDIRECT_URI],
                "client_id": [FRONT_TEST_CLIENT_ID],
            }
        )
        self.assertEqual(400, wrong.status)
        self.assertIn('"error":"invalid_grant"', wrong.body.decode())

        unknown = harness.token(
            {
                "grant_type": ["authorization_code"],
                "code": ["never-minted-code"],
                "code_verifier": [FRONT_TEST_VERIFIER],
                "redirect_uri": [FRONT_TEST_REDIRECT_URI],
                "client_id": [FRONT_TEST_CLIENT_ID],
            }
        )
        self.assertEqual(400, unknown.status)
        self.assertEqual(wrong.body, unknown.body)

    def test_token_rejects_code_issued_to_another_client(self) -> None:
        harness = _FrontChannelHarness(self)
        harness.stores.client.put(
            ClientRecord(
                client_id_hash=hash_key("other-client"),
                client_id="other-client",
                redirect_uris=[FRONT_TEST_REDIRECT_URI],
                token_endpoint_auth_method="none",
            )
        )
        _callback, code = harness.authorize_and_callback()

        response = harness.token(
            {
                "grant_type": ["authorization_code"],
                "code": [code],
                "code_verifier": [FRONT_TEST_VERIFIER],
                "redirect_uri": [FRONT_TEST_REDIRECT_URI],
                "client_id": ["other-client"],
            }
        )
        self.assertEqual(400, response.status)
        self.assertIn('"error":"invalid_grant"', response.body.decode())

    def test_token_refuses_an_unsupported_grant(self) -> None:
        # The dispatch boundary the refresh grant did not move: a grant type the
        # facade does not serve is still refused with unsupported_grant_type. The
        # refresh grant itself is covered by the refresh tests below.
        harness = _FrontChannelHarness(self)
        response = harness.token(
            {
                "grant_type": ["client_credentials"],
                "client_id": [FRONT_TEST_CLIENT_ID],
            }
        )
        self.assertEqual(400, response.status)
        self.assertIn('"error":"unsupported_grant_type"', response.body.decode())

    def test_code_expiry_burns_then_replays(self) -> None:
        # T2/R1: the first consume of an expired code burns it and returns
        # invalid_grant, and the later consume is a replay that revokes.
        harness = _FrontChannelHarness(self)
        _callback, code = harness.authorize_and_callback()
        form = {
            "grant_type": ["authorization_code"],
            "code": [code],
            "code_verifier": [FRONT_TEST_VERIFIER],
            "redirect_uri": [FRONT_TEST_REDIRECT_URI],
            "client_id": [FRONT_TEST_CLIENT_ID],
        }
        harness.clock.advance(120)

        expired = harness.token(form)
        self.assertEqual(400, expired.status)
        self.assertIn('"error":"invalid_grant"', expired.body.decode())

        handles = harness.broker.handle_hashes()
        self.assertEqual(1, len(handles))

        replay = harness.token(form)
        self.assertEqual(400, replay.status)
        record = harness.stores.route_refresh_broker.get(handles[0])
        self.assertIsNotNone(record)
        self.assertEqual("revoked", record.status)

    def test_concurrent_code_redemption_has_exactly_one_winner(self) -> None:
        # T2 under concurrency.
        harness = _FrontChannelHarness(self)
        _callback, code = harness.authorize_and_callback()
        form = urlencode(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": FRONT_TEST_VERIFIER,
                "redirect_uri": FRONT_TEST_REDIRECT_URI,
                "client_id": FRONT_TEST_CLIENT_ID,
            }
        ).encode()

        callers = 8
        statuses: list[int | None] = [None] * callers
        barrier = threading.Barrier(callers)

        def redeem(index: int) -> None:
            barrier.wait()
            statuses[index] = harness.serve("POST", harness.endpoint.oauth_token_path(), None, form).status

        threads = [threading.Thread(target=redeem, args=(index,)) for index in range(callers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        winners = sum(1 for status in statuses if status == 200)
        self.assertEqual(1, winners)
        for status in statuses:
            self.assertIn(status, (200, 400))

        handles = harness.broker.handle_hashes()
        self.assertEqual(1, len(handles))
        record = harness.stores.route_refresh_broker.get(handles[0])
        self.assertIsNotNone(record)
        self.assertEqual("revoked", record.status)


# ---------------------------------------------------------------------------
# Brokered refresh grant (the Go suite in runtime/mcpfacade/refresh_test.go)
# ---------------------------------------------------------------------------


def _refresh_code_form(code: str) -> dict[str, list[str]]:
    """The authorization_code exchange form the harness's authorize leg pins."""
    return {
        "grant_type": ["authorization_code"],
        "code": [code],
        "code_verifier": [FRONT_TEST_VERIFIER],
        "redirect_uri": [FRONT_TEST_REDIRECT_URI],
        "client_id": [FRONT_TEST_CLIENT_ID],
    }


def _refresh_form(handle: str) -> dict[str, list[str]]:
    """A refresh grant form for one handle presented by the harness's own client."""
    return {
        "grant_type": ["refresh_token"],
        "refresh_token": [handle],
        "client_id": [FRONT_TEST_CLIENT_ID],
    }


def _refresh_form_value(handle: str, name: str, value: str) -> dict[str, list[str]]:
    """_refresh_form with one extra member set, so a row or a case can present a
    scope or a resource beside the handle."""
    form = _refresh_form(handle)
    form[name] = [value]
    return form


def _token_response_handle(response: Response) -> str:
    """The framework handle a token response handed the client."""
    handle = str(json.loads(response.body.decode("utf-8")).get("refresh_token") or "")
    if not handle:
        raise AssertionError("token response must carry a refresh handle")
    return handle


def _token_response_access_token(response: Response) -> str:
    """The access token a token response returned."""
    token = str(json.loads(response.body.decode("utf-8")).get("access_token") or "")
    if not token:
        raise AssertionError("token response must carry an access token")
    return token


def _exchange_the_code(harness: _FrontChannelHarness) -> tuple[Response, str]:
    """Completes authorize, callback, and the code exchange, and returns the token
    response plus the redeemed facade code, so a refresh test starts from a
    genuinely minted handle."""
    _callback, code = harness.authorize_and_callback()
    response = harness.token(_refresh_code_form(code))
    if response.status != 200:
        raise AssertionError(f"the code exchange must succeed, got {response.status} {response.body!r}")
    return response, code


def _minted_refresh_handle(harness: _FrontChannelHarness) -> str:
    """Runs the journey through the code exchange and returns the handle it minted."""
    exchange, _code = _exchange_the_code(harness)
    return _token_response_handle(exchange)


def _broker_record(harness: _FrontChannelHarness, handle: str):
    """The broker record a handle is keyed by."""
    record = harness.stores.route_refresh_broker.get(hash_key(handle))
    if record is None:
        raise AssertionError(f"no broker record for handle {handle!r}")
    return record



def _rewrite_broker_record(harness: _FrontChannelHarness, handle: str, mutate) -> None:
    record = harness.stores.route_refresh_broker.get(hash_key(handle))
    assert record is not None
    mutate(record)
    harness.broker.put(record)

def _unknown_handle() -> str:
    return secrets.token_urlsafe(32)


def _register_other_client(harness: _FrontChannelHarness) -> None:
    """Registers the second public client the other-client cases present."""
    harness.stores.client.put(
        ClientRecord(
            client_id_hash=hash_key(REFRESH_TEST_OTHER_CLIENT_ID),
            client_id=REFRESH_TEST_OTHER_CLIENT_ID,
            redirect_uris=[FRONT_TEST_REDIRECT_URI],
            token_endpoint_auth_method="none",
        )
    )


def _refresh_at_another_route(harness: _FrontChannelHarness, handle: str) -> Response:
    """Presents a refresh form at a mounted route other than the one the handle
    was minted for, derived from the framework's route algebra rather than a
    hard-coded path."""
    other_route = _bound_route_endpoint("agent")
    return harness.serve(
        "POST",
        other_route.oauth_token_path(),
        None,
        urlencode(_refresh_form(handle), doseq=True).encode(),
    )


class RefreshGrantDefaultsTests(unittest.TestCase):
    """Pins the brokered refresh framework defaults of operator ruling R3, so a
    change to any of them is a deliberate edit here rather than a silent behavior
    change. It also pins the two relationships the numbers have to satisfy: the
    coalesce wait cap must stay below the broker lock TTL (a waiter can never
    outlive and steal the lock it waits for), and the grace window must stay above
    that cap (a waiter that gives up inside the window still replays the
    successor on its next attempt).
    """

    def test_refresh_grant_defaults_are_pinned(self) -> None:
        self.assertEqual(60, facade_module.ROUTE_REFRESH_MIN_HANDLE_TTL_SECONDS)
        self.assertEqual(2592000, facade_module.ROUTE_REFRESH_MAX_HANDLE_TTL_SECONDS)
        self.assertEqual(120, facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS)
        self.assertEqual(120, facade_module.MAX_REFRESH_GRACE_WINDOW_SECONDS)
        self.assertEqual(9, facade_module.MIN_REFRESH_REUSE_RATE_CEILING)
        self.assertEqual(120, facade_module.MAX_REFRESH_REUSE_RATE_CEILING)
        self.assertEqual(3600, facade_module.REFRESH_REUSE_RATE_WINDOW_SECONDS)
        self.assertEqual("route_refresh_reuse_depth1", facade_module.REFRESH_REUSE_RATE_OPERATION)
        self.assertEqual(1, facade_module.REFRESH_CHAIN_ROOT_GENERATION)
        self.assertEqual(3.0, facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS)
        self.assertEqual(0.05, facade_module._REFRESH_COALESCE_POLL_INTERVAL_SECONDS)
        self.assertEqual(512, facade_module._FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES)
        self.assertEqual(8, facade_module._REFRESH_REVOKE_CHAIN_LIMIT)
        self.assertEqual(1, facade_module._REFRESH_RETRY_AFTER_SECONDS)
        self.assertEqual(15, UTC_NOW_LOCK_TTL_SECONDS)
        self.assertLess(facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS, float(UTC_NOW_LOCK_TTL_SECONDS))
        self.assertGreaterEqual(
            facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS,
            facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS,
        )


class RefreshGrantTests(unittest.TestCase):
    """Pins the brokered refresh grant (DESIGN section 8.4 mechanic 4, operator
    rulings R1-R4) against the real mounted token handler: single-flight rotation,
    the bounded grace replay, reuse revocation, the route, scope, and resource
    bindings, and the typed refusals."""

    def test_refresh_rotates_the_handle_and_hides_upstream_material(self) -> None:
        harness = _FrontChannelHarness(self)
        first = _minted_refresh_handle(harness)

        response = harness.token(_refresh_form(first))
        self.assertEqual(200, response.status, response.body)
        body = response.body.decode("utf-8")
        self.assertIn('"access_token":"' + FRONT_TEST_REFRESH_ACCESS_TOKEN + '"', body)
        self.assertIn('"token_type":"Bearer"', body)
        self.assertIn('"scope":"' + FRONT_TEST_ROTATED_UPSTREAM_SCOPE + '"', body)
        self.assertNotIn(FRONT_TEST_REFRESH_TOKEN, body)
        self.assertNotIn(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN, body)
        self.assertNotIn(FRONT_TEST_REFRESH_ID_TOKEN, body)
        self.assertNotIn("id_token", body)

        second = _token_response_handle(response)
        self.assertNotEqual(first, second)

        successor = _broker_record(harness, second)
        self.assertEqual(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN, successor.encrypted_upstream_refresh_token)
        self.assertEqual(
            hash_key(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN), successor.upstream_refresh_token_hash
        )
        self.assertEqual("issued", successor.status)
        self.assertEqual(hash_key(FRONT_TEST_CLIENT_ID), successor.client_id_hash)
        self.assertEqual(FRONT_TEST_CLIENT_ID, successor.upstream_client_id)
        self.assertEqual(REFRESH_TEST_BOUND_RESOURCE, successor.canonical_resource)

        presented = _broker_record(harness, first)
        self.assertEqual("active", presented.status)
        self.assertEqual(response.body.decode("utf-8"), presented.encrypted_grace_refresh_response)
        self.assertEqual(
            harness.clock.now() + timedelta(seconds=facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS),
            presented.grace_expires_at,
        )
        self.assertEqual("", presented.refresh_lock_owner)
        self.assertIsNone(presented.refresh_lock_expires_at)
        self.assertEqual(facade_module.REFRESH_CHAIN_ROOT_GENERATION, presented.chain_generation)
        self.assertEqual(hash_key(first), presented.family_hash)
        self.assertEqual(facade_module.REFRESH_CHAIN_ROOT_GENERATION + 1, successor.chain_generation)
        self.assertEqual(hash_key(first), successor.family_hash)

    def test_refresh_makes_exactly_one_upstream_call_per_rotation(self) -> None:
        # The single-flight upstream contract: the code exchange makes one token
        # call, and each rotation makes exactly one more, presenting the recorded
        # upstream material and the facade's own upstream client — never the
        # framework handle.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        self.assertEqual(1, harness.fake.token_calls)
        self.assertEqual(0, harness.fake.refresh_calls)

        first = harness.token(_refresh_form(handle))
        self.assertEqual(200, first.status)
        self.assertEqual(2, harness.fake.token_calls)
        self.assertEqual(1, harness.fake.refresh_calls)

        second = harness.token(_refresh_form(_token_response_handle(first)))
        self.assertEqual(200, second.status)
        self.assertEqual(3, harness.fake.token_calls)
        self.assertEqual(2, harness.fake.refresh_calls)

        presented = harness.fake.last_refresh_form
        self.assertEqual(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN, presented.get("refresh_token"))
        self.assertEqual(FRONT_TEST_CLIENT_ID, presented.get("client_id"))

        # A grace replay makes no upstream call at all, so the count above is the
        # rotation count and not a call count.
        self.assertEqual(200, harness.token(_refresh_form(handle)).status)
        self.assertEqual(3, harness.fake.token_calls)
        self.assertEqual(2, harness.fake.refresh_calls)

    def test_refresh_replays_the_same_successor_within_the_grace_window(self) -> None:
        # The idempotent lost-response path: presenting the rotated handle again
        # from the same client returns the identical status, headers, and body
        # bytes, with no second upstream call, right up to the end of the window.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)

        first = harness.token(_refresh_form(handle))
        self.assertEqual(200, first.status)

        replayed = harness.token(_refresh_form(handle))
        self.assertEqual(first.status, replayed.status)
        self.assertEqual(first.body, replayed.body)
        self.assertEqual(first.headers["content-type"], replayed.headers["content-type"])
        self.assertEqual(first.headers["cache-control"], replayed.headers["cache-control"])
        self.assertEqual(first.headers["pragma"], replayed.headers["pragma"])
        self.assertEqual(1, harness.fake.refresh_calls)

        harness.clock.advance(30 - 1)
        just_inside = harness.token(_refresh_form(handle))
        self.assertEqual(200, just_inside.status)
        self.assertEqual(first.body, just_inside.body)
        self.assertEqual(1, harness.fake.refresh_calls)



    def test_refresh_refusals_are_one_invalid_grant_body(self) -> None:
        # The no-oracle rule: an unknown handle, a revoked handle, a handle
        # presented by another registered client, and a handle presented at
        # another route are one byte-identical invalid_grant response.
        unknown_harness = _FrontChannelHarness(self)
        unknown = unknown_harness.token(_refresh_form(_unknown_handle()))
        self.assertEqual(400, unknown.status)

        revoked_harness = _FrontChannelHarness(self)
        revoked_handle = _minted_refresh_handle(revoked_harness)
        revoked_harness.stores.route_refresh_broker.revoke(hash_key(revoked_handle))
        revoked = revoked_harness.token(_refresh_form(revoked_handle))
        self.assertEqual(400, revoked.status)

        other_harness = _FrontChannelHarness(self)
        other_handle = _minted_refresh_handle(other_harness)
        _register_other_client(other_harness)
        other_form = _refresh_form(other_handle)
        other_form["client_id"] = [REFRESH_TEST_OTHER_CLIENT_ID]
        other = other_harness.token(other_form)
        self.assertEqual(400, other.status)

        for index, response in enumerate((unknown, revoked, other)):
            self.assertEqual(400, response.status, f"refusal {index}")
            self.assertIn('"error":"invalid_grant"', response.body.decode("utf-8"), f"refusal {index}")
            self.assertEqual(unknown.body, response.body, f"refusal {index} must be byte-identical")

    def test_refresh_refuses_a_handle_at_another_route(self) -> None:
        # The route binding of the broker record (DESIGN section 7: the record
        # binds the resource) against the real handlers, and proof that closing it
        # does not open a handle-existence oracle: a handle minted at one route and
        # presented at another route's token endpoint is refused with the SAME
        # byte-identical invalid_grant an unknown handle gets, while the very same
        # handle is still redeemable at the route it was minted for, and the
        # tracked upstream refresh count proves the wrong-route attempt never
        # reached the upstream.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)

        unknown_response = harness.token(_refresh_form(_unknown_handle()))
        self.assertEqual(400, unknown_response.status)

        before = harness.fake.refresh_calls
        wrong_route = _refresh_at_another_route(harness, handle)
        self.assertEqual(400, wrong_route.status)
        self.assertIn('"error":"invalid_grant"', wrong_route.body.decode("utf-8"))
        self.assertEqual(
            unknown_response.body.decode("utf-8"),
            wrong_route.body.decode("utf-8"),
            "a wrong-route handle must be the byte-identical unknown-handle refusal",
        )
        self.assertEqual(before, harness.fake.refresh_calls, "a wrong-route handle must not reach the upstream")

        own_route = harness.token(_refresh_form(handle))
        self.assertEqual(200, own_route.status)
        self.assertEqual(
            before + 1,
            harness.fake.refresh_calls,
            "the same handle must still be redeemable at the route it was minted for",
        )

    def test_refresh_binds_scope_and_resource(self) -> None:
        # Ruling R4: an absent scope or resource takes the recorded value, an
        # exactly equal one is accepted, a subset (which the empty member
        # expresses, because the granted set has one member) and a wider set are
        # invalid_scope, and a mismatched resource is invalid_target.
        def set_scope(form: dict[str, list[str]], value: str) -> None:
            form["scope"] = [value]

        def set_resource(form: dict[str, list[str]], value: str) -> None:
            form["resource"] = [value]

        def exact_scope_and_resource(form: dict[str, list[str]]) -> None:
            set_scope(form, FRONT_TEST_ROTATED_UPSTREAM_SCOPE)
            set_resource(form, REFRESH_TEST_BOUND_RESOURCE)

        cases: tuple[tuple[str, str, Any], ...] = (
            (
                "absent_scope_and_resource_take_the_granted_values",
                "",
                lambda form: None,
            ),
            ("exact_scope_and_resource_are_accepted", "", exact_scope_and_resource),
            ("subset_scope_is_refused", "invalid_scope", lambda form: set_scope(form, "")),
            (
                "wider_scope_is_refused",
                "invalid_scope",
                lambda form: set_scope(form, FRONT_TEST_ROTATED_UPSTREAM_SCOPE + " extra:scope"),
            ),
            (
                "mismatched_resource_is_refused",
                "invalid_target",
                lambda form: set_resource(form, FRONT_TEST_BASE_URL + "/other/mcp"),
            ),
        )

        for name, want_error, mutate in cases:
            with self.subTest(case=name):
                harness = _FrontChannelHarness(self)
                handle = _minted_refresh_handle(harness)
                form = _refresh_form(handle)
                mutate(form)

                response = harness.token(form)
                if not want_error:
                    self.assertEqual(200, response.status, response.body)
                    self.assertIn('"access_token":"' + FRONT_TEST_REFRESH_ACCESS_TOKEN + '"', response.body.decode())
                    self.assertEqual(1, harness.fake.refresh_calls)
                    continue
                self.assertEqual(400, response.status, response.body)
                self.assertIn('"error":"' + want_error + '"', response.body.decode("utf-8"))
                # A refused request never reached the upstream, and the handle was
                # not rotated by it.
                self.assertEqual(0, harness.fake.refresh_calls)
                self.assertEqual("issued", _broker_record(harness, handle).status)

    def test_refresh_present_but_empty_scope_is_refused(self) -> None:
        # Presence, not emptiness, is what triggers ruling R4's check: the empty
        # member is the empty scope set, and a wider-or-subset-accepting mode is
        # deliberately not built.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        response = harness.token(_refresh_form_value(handle, "scope", ""))
        self.assertEqual(400, response.status)
        self.assertIn('"error":"invalid_scope"', response.body.decode("utf-8"))
        self.assertEqual(0, harness.fake.refresh_calls)

    def test_refresh_bounds_the_presented_handle(self) -> None:
        # The bound and the validation order of ruling R1: a missing, blank, or
        # oversized handle is invalid_request before the client is even
        # identified, while a well-formed handle with no client id is the client
        # check's own invalid_client.
        harness = _FrontChannelHarness(self)
        oversized = "a" * (facade_module._FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES + 1)

        too_long = harness.token(_refresh_form(oversized))
        self.assertEqual(400, too_long.status)
        self.assertIn('"error":"invalid_request"', too_long.body.decode("utf-8"))

        missing = harness.token({"grant_type": ["refresh_token"], "client_id": [FRONT_TEST_CLIENT_ID]})
        self.assertEqual(400, missing.status)
        self.assertEqual(too_long.body, missing.body)

        blank = harness.token(_refresh_form(""))
        self.assertEqual(400, blank.status)
        self.assertEqual(too_long.body, blank.body)

        # The bound is checked before the client lookup, so an oversized handle
        # with no client at all is still invalid_request ...
        no_client = harness.token({"grant_type": ["refresh_token"], "refresh_token": [oversized]})
        self.assertEqual(400, no_client.status)
        self.assertIn('"error":"invalid_request"', no_client.body.decode("utf-8"))

        # ... while a well-formed handle and no client is the client refusal.
        unidentified = harness.token({"grant_type": ["refresh_token"], "refresh_token": ["a" * 43]})
        self.assertEqual(400, unidentified.status)
        self.assertIn('"error":"invalid_client"', unidentified.body.decode("utf-8"))

        self.assertEqual(0, harness.fake.refresh_calls)

    def test_refresh_replayed_code_revokes_the_handle(self) -> None:
        # Journey step 9.1 / T2 against the refresh grant: once the authorization
        # code is replayed, the broker record the code minted is revoked, so the
        # handle it had already rotated into the client's hands is refused.
        harness = _FrontChannelHarness(self)
        exchange, code = _exchange_the_code(harness)
        handle = _token_response_handle(exchange)

        rotated = harness.token(_refresh_form(handle))
        self.assertEqual(200, rotated.status)

        replay = harness.token(_refresh_code_form(code))
        self.assertEqual(400, replay.status)
        self.assertIn('"error":"invalid_grant"', replay.body.decode("utf-8"))

        self.assertEqual("revoked", _broker_record(harness, handle).status)

        after = harness.token(_refresh_form(handle))
        self.assertEqual(400, after.status)
        self.assertIn('"error":"invalid_grant"', after.body.decode("utf-8"))
        self.assertEqual(1, harness.fake.refresh_calls)

    def test_refresh_concurrent_callers_receive_one_successor(self) -> None:
        # Single-flight under concurrency: sixteen simultaneous presentations of
        # one handle produce exactly one upstream refresh call, and every caller
        # receives the same successor body bytes — the winner's response or the
        # grace replay of it.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        form = urlencode(_refresh_form(handle), doseq=True).encode()

        callers = 16
        statuses: list[int | None] = [None] * callers
        bodies: list[bytes] = [b""] * callers
        barrier = threading.Barrier(callers)

        def present(index: int) -> None:
            barrier.wait()
            response = harness.serve("POST", harness.endpoint.oauth_token_path(), None, form)
            statuses[index] = response.status
            bodies[index] = response.body

        threads = [threading.Thread(target=present, args=(index,)) for index in range(callers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(1, harness.fake.refresh_calls)
        for index in range(callers):
            self.assertEqual(200, statuses[index], f"caller {index} body {bodies[index]!r}")
            self.assertEqual(bodies[0], bodies[index], f"caller {index} must receive the winner's successor body")
        self.assertIn('"access_token":"' + FRONT_TEST_REFRESH_ACCESS_TOKEN + '"', bodies[0].decode("utf-8"))
        # The successor handle the callers were all served is a framework handle,
        # not the handle they presented.
        winner = Response(status=200, headers={}, cookies=[], body=bodies[0], is_base64=False)
        self.assertNotEqual(handle, _token_response_handle(winner))


    def test_refresh_lock_contention_answers_retryable(self) -> None:
        # The coalesce wait cap: a caller that cannot take a lock another caller
        # holds answers 503 temporarily_unavailable with a Retry-After, makes no
        # upstream call, and waits the whole cap first. This test takes about
        # three seconds, because the cap is real elapsed time and the point is that
        # the caller waits it rather than sampling less than it.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        record = _broker_record(harness, handle)
        locked = harness.stores.route_refresh_broker.acquire_lock(hash_key(handle), "test-holder", record.version)
        self.assertEqual("refreshing", locked.status)

        start = time.monotonic()
        response = harness.token(_refresh_form(handle))
        elapsed = time.monotonic() - start

        self.assertEqual(503, response.status)
        self.assertIn('"error":"temporarily_unavailable"', response.body.decode("utf-8"))
        values = response.headers.get("retry-after") or []
        self.assertTrue(values)
        self.assertGreaterEqual(int(str(values[0])), 1)
        self.assertGreaterEqual(elapsed, facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS)
        self.assertLess(elapsed, facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS + 30)
        self.assertEqual(0, harness.fake.refresh_calls)

        # The caller that holds the lock is untouched by the waiter.
        self.assertEqual("test-holder", _broker_record(harness, handle).refresh_lock_owner)

    def test_refresh_version_conflict_retry_yields(self) -> None:
        # ADV-1146-3: a lock acquisition that fails with a version conflict is
        # retried until the coalesce cap, and every retry waits one poll interval
        # first. A store that keeps returning a stale version would otherwise
        # re-poll in a tight spin for the whole cap; with the 50 ms poll interval
        # the loop takes about cap/interval ~= 60 iterations over three seconds, so
        # a bounded iteration count and the measured gap between attempts prove the
        # wait rather than a spin. Removing the poll sleep makes the count jump by
        # orders of magnitude and the gaps vanish, so the assertions are the
        # mutation tripwire. The exact interval value is asserted directly by
        # RefreshGrantDefaultsTests.
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)

        attempts: list[float] = []

        def conflict(*_args: Any) -> Any:
            attempts.append(time.monotonic())
            raise BrokerVersionConflictError()

        harness.broker.acquire_lock = conflict

        start = time.monotonic()
        response = harness.token(_refresh_form(handle))
        elapsed = time.monotonic() - start

        self.assertEqual(503, response.status)
        self.assertIn('"error":"temporarily_unavailable"', response.body.decode("utf-8"))
        self.assertGreaterEqual(elapsed, facade_module._REFRESH_COALESCE_WAIT_CAP_SECONDS)
        self.assertEqual(0, harness.fake.refresh_calls)

        # cap/interval = 3.0 / 0.05 = 60. A spin (no poll sleep) reaches this
        # count in microseconds and would be orders of magnitude larger, so the
        # upper bound is the mutation tripwire; the lower bound is only a sanity
        # check that the loop re-polled repeatedly.
        self.assertGreaterEqual(len(attempts), 5)
        self.assertLessEqual(len(attempts), 100)
        gaps = [later - earlier for earlier, later in zip(attempts, attempts[1:])]
        self.assertTrue(gaps)
        for gap in gaps:
            self.assertGreaterEqual(gap, facade_module._REFRESH_COALESCE_POLL_INTERVAL_SECONDS)


    def test_refresh_transient_upstream_failure_keeps_the_handle(self) -> None:
        # A transient provider failure: the facade answers 503
        # temporarily_unavailable with a Retry-After, releases the lock and
        # restores the record's status, and does not revoke the grant, so the very
        # next attempt reaches the upstream again and rotates.
        harness = _FrontChannelHarness(self, _transient_failure_provider_options)
        handle = _minted_refresh_handle(harness)

        failed = harness.token(_refresh_form(handle))
        self.assertEqual(503, failed.status)
        self.assertIn('"error":"temporarily_unavailable"', failed.body.decode("utf-8"))
        self.assertEqual(["1"], failed.headers.get("retry-after"))
        self.assertEqual(1, harness.fake.refresh_calls)

        released = _broker_record(harness, handle)
        self.assertEqual("issued", released.status)
        self.assertEqual("", released.refresh_lock_owner)
        self.assertIsNone(released.refresh_lock_expires_at)

        recovered = harness.token(_refresh_form(handle))
        self.assertEqual(200, recovered.status)
        self.assertIn('"access_token":"' + FRONT_TEST_REFRESH_ACCESS_TOKEN + '"', recovered.body.decode("utf-8"))
        self.assertNotEqual(handle, _token_response_handle(recovered))
        self.assertEqual(2, harness.fake.refresh_calls)
        self.assertEqual("active", _broker_record(harness, handle).status)

    def test_refresh_responses_never_carry_upstream_material(self) -> None:
        # Scans every response and every client-presented form of a whole refresh
        # journey against the upstream material the fake served: the upstream
        # refresh tokens, the upstream id_token, the PKCE verifier, the upstream
        # code, and the client state never appear anywhere, the upstream access
        # tokens appear only in the responses that deliberately return them to
        # their owner, and the facade code appears only in the callback that
        # delivers it.
        harness = _FrontChannelHarness(self)

        authorize = harness.authorize()
        self.assertEqual(302, authorize.status)
        callback = harness.serve(
            "GET",
            DEFAULT_CALLBACK_PATH,
            {
                "code": [FRONT_TEST_UPSTREAM_CODE],
                "state": [_location_query(authorize).get("state", "")],
                "iss": [FRONT_TEST_UPSTREAM_ISS],
            },
        )
        self.assertEqual(302, callback.status)
        code = _location_query(callback).get("code", "")
        self.assertTrue(code)

        exchange_form = _refresh_code_form(code)
        exchange = harness.token(exchange_form)
        self.assertEqual(200, exchange.status)
        handle = _token_response_handle(exchange)

        rotated = harness.token(_refresh_form(handle))
        self.assertEqual(200, rotated.status)
        grace = harness.token(_refresh_form(handle))
        scope_refused = harness.token(
            _refresh_form_value(handle, "scope", FRONT_TEST_ROTATED_UPSTREAM_SCOPE + " extra:scope")
        )
        resource_refused = harness.token(
            _refresh_form_value(handle, "resource", FRONT_TEST_BASE_URL + "/other/mcp")
        )
        oversized = harness.token(
            _refresh_form("a" * (facade_module._FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES + 1))
        )

        # The two access tokens the design delivers, and the only responses
        # allowed to carry each one.
        exchanged_token = _token_response_access_token(exchange)
        rotated_token = _token_response_access_token(rotated)
        delivered = {
            exchanged_token: {"code_exchange"},
            rotated_token: {"refresh", "grace_replay"},
        }

        responses = (
            ("authorize", authorize, False, False),
            ("callback", callback, True, True),
            ("code_exchange", exchange, False, False),
            ("refresh", rotated, False, False),
            ("grace_replay", grace, False, False),
            ("scope_refused", scope_refused, False, False),
            ("resource_refused", resource_refused, False, False),
            ("oversized_handle", oversized, False, False),
        )

        upstream_secrets = (
            FRONT_TEST_REFRESH_TOKEN,
            FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
            FRONT_TEST_REFRESH_ID_TOKEN,
            "id_token",
            FRONT_TEST_VERIFIER,
            FRONT_TEST_UPSTREAM_CODE,
        )
        for name, response, code_ok, state_ok in responses:
            scanned = _scan(response)
            for secret in upstream_secrets:
                self.assertNotIn(secret, scanned, f"{name} response must not carry {secret!r}")
            # The client's own state is returned to it by the callback that
            # receives it and by nothing else.
            if not state_ok:
                self.assertNotIn(FRONT_TEST_CLIENT_STATE, scanned, f"{name} response must not carry the client state")
            if not code_ok:
                self.assertNotIn(code, scanned, f"{name} response must not carry the facade code")
            for token, names in delivered.items():
                if name in names:
                    continue
                self.assertNotIn(
                    token, scanned, f"{name} response must not carry an access token delivered elsewhere"
                )
        self.assertIn(exchanged_token, _scan(exchange))
        self.assertIn(rotated_token, _scan(rotated))
        self.assertIn(rotated_token, _scan(grace))

        # The client-presented forms carry the framework handle and nothing
        # upstream.
        forms = (
            exchange_form,
            _refresh_form(handle),
            _refresh_form(_token_response_handle(rotated)),
        )
        for form in forms:
            encoded = urlencode(form, doseq=True)
            self.assertNotIn(FRONT_TEST_REFRESH_TOKEN, encoded)
            self.assertNotIn(FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN, encoded)
            self.assertNotIn(FRONT_TEST_REFRESH_ID_TOKEN, encoded)
            self.assertNotIn(FRONT_TEST_REFRESH_ACCESS_TOKEN, encoded)

        # Positive control: the one form that must carry the upstream material —
        # the facade's own upstream refresh call — does, with the facade's own
        # upstream client, and never the framework handle the client presented.
        upstream_form = harness.fake.last_refresh_form
        self.assertEqual(FRONT_TEST_REFRESH_TOKEN, upstream_form.get("refresh_token"))
        self.assertEqual(FRONT_TEST_CLIENT_ID, upstream_form.get("client_id"))
        self.assertNotEqual(handle, upstream_form.get("refresh_token"))


class _EventRecorder:
    """Captures the route refresh telemetry the facade emits."""

    def __init__(self) -> None:
        self.events: list[facade_module.RouteRefreshEvent] = []

    def __call__(self, event: facade_module.RouteRefreshEvent) -> None:
        self.events.append(event)

    def find(self, event_class: str, outcome: str = "") -> facade_module.RouteRefreshEvent | None:
        for event in self.events:
            if event.event_class == event_class and (outcome == "" or event.outcome == outcome):
                return event
        return None

    def require(self, event_class: str, outcome: str = "") -> facade_module.RouteRefreshEvent:
        event = self.find(event_class, outcome)
        if event is None:
            raise AssertionError(f"no {event_class!r} event with outcome {outcome!r} in {self.events!r}")
        return event


def _policy_test_config(
    harness: _FrontChannelHarness,
    policy: Any,
    *,
    provider: Any = ...,
) -> FacadeConfig:
    """Builds the harness's front-channel config with a different policy, so a
    registration test can exercise the policy's fail-closed validation."""
    resolved_provider = harness.provider if provider is ... else provider
    return FacadeConfig(
        issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
        jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
        issuer_mode="route",
        url_mode=URL_MODE_PUBLIC_BASE_URL,
        public_base_url=FRONT_TEST_BASE_URL,
        transport_posture="iam",
        scopes={
            "namespace": ["mcp:tools"],
            "partner_namespace": ["mcp:tools"],
            "agent": ["mcp:tools"],
            "partner_agent": ["mcp:tools"],
        },
        mcp_handler=lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
        provider=resolved_provider,
        stores=harness.stores,
        upstream_client_id=FRONT_TEST_CLIENT_ID,
        upstream_issuer=FRONT_TEST_UPSTREAM_ISS,
        route_refresh_policy=policy,
    )


class RouteRefreshPolicyValidationTests(unittest.TestCase):
    """The policy is required whenever the front channel is configured and every
    out-of-range value is a registration error, never a silent fallback."""

    def test_policy_is_required(self) -> None:
        harness = _FrontChannelHarness(self)
        for policy in (
            None,
            facade_module.RouteRefreshPolicy(0, facade_module.MIN_REFRESH_REUSE_RATE_CEILING),
            facade_module.RouteRefreshPolicy(-60, facade_module.MIN_REFRESH_REUSE_RATE_CEILING),
            facade_module.RouteRefreshPolicy(900.0, facade_module.MIN_REFRESH_REUSE_RATE_CEILING),  # type: ignore[arg-type]
        ):
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(
                        create_app(),
                        _policy_test_config(harness, policy),
                    )
                self.assertIn("route refresh policy handle TTL is required and must be positive", str(raised.exception))

    def test_policy_ranges_fail_closed(self) -> None:
        harness = _FrontChannelHarness(self)
        cases: tuple[tuple[Any, str], ...] = (
            (
                facade_module.RouteRefreshPolicy(
                    facade_module.ROUTE_REFRESH_MIN_HANDLE_TTL_SECONDS - 1,
                    facade_module.MIN_REFRESH_REUSE_RATE_CEILING,
                ),
                "must be within [",
            ),
            (
                facade_module.RouteRefreshPolicy(
                    facade_module.ROUTE_REFRESH_MAX_HANDLE_TTL_SECONDS + 1,
                    facade_module.MIN_REFRESH_REUSE_RATE_CEILING,
                ),
                "must be within [",
            ),
            (
                facade_module.RouteRefreshPolicy(900, facade_module.MIN_REFRESH_REUSE_RATE_CEILING, -1),
                "grace window",
            ),
            (
                facade_module.RouteRefreshPolicy(
                    900,
                    facade_module.MIN_REFRESH_REUSE_RATE_CEILING,
                    facade_module.MAX_REFRESH_GRACE_WINDOW_SECONDS + 1,
                ),
                "grace window",
            ),
            (facade_module.RouteRefreshPolicy(900, 0), "reuse rate ceiling is required"),
            (
                facade_module.RouteRefreshPolicy(900, facade_module.MIN_REFRESH_REUSE_RATE_CEILING - 1),
                "must be within [",
            ),
            (
                facade_module.RouteRefreshPolicy(900, facade_module.MAX_REFRESH_REUSE_RATE_CEILING + 1),
                "must be within [",
            ),
        )
        for policy, want in cases:
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError) as raised:
                    register_mcp_facade(create_app(), _policy_test_config(harness, policy))
                self.assertIn(want, str(raised.exception))

    def test_policy_defaults_and_accepts_the_grace_window(self) -> None:
        harness = _FrontChannelHarness(self)
        default = facade_module._normalize_front_channel(
            _policy_test_config(harness, facade_module.RouteRefreshPolicy(900, 9))
        )
        self.assertIsNotNone(default)
        self.assertEqual(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS, default.policy.grace_window_seconds)
        explicit = facade_module._normalize_front_channel(
            _policy_test_config(harness, facade_module.RouteRefreshPolicy(900, 9, 45))
        )
        self.assertIsNotNone(explicit)
        self.assertEqual(45, explicit.policy.grace_window_seconds)

    def test_policy_must_match_a_store_that_reports_its_ttl(self) -> None:
        harness = _FrontChannelHarness(self)
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(
                create_app(),
                _policy_test_config(harness, facade_module.RouteRefreshPolicy(3600, 9)),
            )
        self.assertIn("does not match the broker store's local lifetime", str(raised.exception))

    def test_policy_and_hook_without_provider_are_refused(self) -> None:
        policy_config = FacadeConfig(
            issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
            jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
            url_mode=URL_MODE_PUBLIC_BASE_URL,
            public_base_url=FRONT_TEST_BASE_URL,
            mcp_handler=lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
            scopes={
                "namespace": ["mcp:tools"],
                "partner_namespace": ["mcp:tools"],
                "agent": ["mcp:tools"],
                "partner_agent": ["mcp:tools"],
            },
            route_refresh_policy=facade_module.RouteRefreshPolicy(900, 9),
        )
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(), policy_config)
        self.assertIn("RouteRefreshPolicy", str(raised.exception))
        self.assertIn("without Provider", str(raised.exception))

        hook_config = FacadeConfig(
            issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
            jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
            url_mode=URL_MODE_PUBLIC_BASE_URL,
            public_base_url=FRONT_TEST_BASE_URL,
            mcp_handler=lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
            scopes={
                "namespace": ["mcp:tools"],
                "partner_namespace": ["mcp:tools"],
                "agent": ["mcp:tools"],
                "partner_agent": ["mcp:tools"],
            },
            route_refresh_events=lambda _event: None,
        )
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(), hook_config)
        self.assertIn("RouteRefreshEvents", str(raised.exception))
        self.assertIn("without Provider", str(raised.exception))


class RouteRefreshTelemetryTests(unittest.TestCase):
    """Pins the route refresh telemetry taxonomy and its schema redaction."""


    def test_telemetry_expiry_is_distinguishable_from_absence(self) -> None:
        recorder = _EventRecorder()
        harness = _FrontChannelHarness(self, route_refresh_events=recorder)
        handle = _minted_refresh_handle(harness)

        harness.clock.advance(900 + 1)
        expired = harness.token(_refresh_form(handle))
        self.assertEqual(400, expired.status)
        absent = harness.token(_refresh_form(_unknown_handle()))
        self.assertEqual(400, absent.status)
        self.assertEqual(expired.body, absent.body, "the client body must not distinguish expiry from absence")

        expired_signal = [
            event for event in recorder.events if event.reason == facade_module.ROUTE_REFRESH_REASON_RECORD_EXPIRED
        ]
        absent_signal = [
            event for event in recorder.events if event.reason == facade_module.ROUTE_REFRESH_REASON_RECORD_ABSENT
        ]
        self.assertEqual(1, len(expired_signal))
        self.assertEqual(facade_module.ROUTE_REFRESH_EXPIRY_SIGNAL_EXPIRED, expired_signal[0].expiry_signal)
        self.assertEqual(1, len(absent_signal))
        self.assertEqual(facade_module.ROUTE_REFRESH_EXPIRY_SIGNAL_ABSENT, absent_signal[0].expiry_signal)

    def test_telemetry_attributes_an_upstream_rejection(self) -> None:
        recorder = _EventRecorder()
        harness = _FrontChannelHarness(self, _terminal_failure_provider_options, route_refresh_events=recorder)
        handle = _minted_refresh_handle(harness)
        response = harness.token(_refresh_form(handle))
        self.assertEqual(400, response.status)

        event = recorder.require(facade_module.ROUTE_REFRESH_EVENT_UPSTREAM_REAUTH_REQUIRED)
        self.assertEqual("invalid_grant", event.upstream_class)
        self.assertEqual(facade_module.ROUTE_REFRESH_REASON_UPSTREAM_REJECTED, event.reason)
        self.assertEqual("revoked", event.status_to)

    def test_a_raising_hook_never_fails_a_refresh(self) -> None:
        def raising_hook(_event: facade_module.RouteRefreshEvent) -> None:
            raise RuntimeError("telemetry sink is down")

        harness = _FrontChannelHarness(self, route_refresh_events=raising_hook)
        handle = _minted_refresh_handle(harness)
        response = harness.token(_refresh_form(handle))
        self.assertEqual(200, response.status)
        self.assertIn('"access_token":"' + FRONT_TEST_REFRESH_ACCESS_TOKEN + '"', response.body.decode("utf-8"))


class RouteRefreshDepthOneTests(unittest.TestCase):
    """Pins the beyond-grace depth-1 serve: once per handle, budgeted per
    family, and revoked by family (not by the bounded walk) on theft."""







def _terminal_failure_provider_options(options: dict[str, Any]) -> None:
    """Stages the fake upstream a terminal refresh rejection."""
    options["refresh_token_status"] = 400
    options["refresh_token_body"] = {"error": "invalid_grant"}


def _transient_failure_provider_options(options: dict[str, Any]) -> None:
    """Stages the fake upstream one transient refresh failure that clears."""
    options["refresh_token_stages"] = [RefreshStage(status=503, body={"error": "temporarily_unavailable"})]


def _refresh_provider_options(scenario: str) -> Any:
    """The fake-upstream mutator a shared refresh row's scenario needs. Only the
    two upstream-failure scenarios need anything but the default fake."""
    if scenario == "upstream_terminal_failure":
        return _terminal_failure_provider_options
    if scenario == "upstream_transient_failure":
        return _transient_failure_provider_options
    return None


def _refresh_scenario_response(  # noqa: C901 - one branch per shared-table scenario
    test: unittest.TestCase,
    harness: _FrontChannelHarness,
    scenario: str,
) -> Response:
    """Performs the common setup and then the row's scenario, returning the
    response the row's expectation applies to."""
    exchange, code = _exchange_the_code(harness)
    handle = _token_response_handle(exchange)

    if scenario == "happy_rotation":
        return harness.token(_refresh_form(handle))
    if scenario == "reuse_within_grace_returns_same_tokens":
        first = harness.token(_refresh_form(handle))
        test.assertEqual(200, first.status)
        replayed = harness.token(_refresh_form(handle))
        test.assertEqual(first.body, replayed.body, "the grace replay must be byte-identical")
        return replayed
    if scenario == "beyond_grace_first_presentation_revokes_family_without_tokens":
        test.assertEqual(200, harness.token(_refresh_form(handle)).status)
        harness.clock.advance(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS + 1)
        return harness.token(_refresh_form(handle))
    if scenario == "beyond_grace_repeated_presentation_is_invalid_grant":
        test.assertEqual(200, harness.token(_refresh_form(handle)).status)
        harness.clock.advance(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS + 1)
        test.assertEqual(400, harness.token(_refresh_form(handle)).status)
        return harness.token(_refresh_form(handle))
    if scenario == "reuse_after_nine_rotations_revokes_whole_family":
        current = handle
        for _index in range(9):
            rotated = harness.token(_refresh_form(current))
            test.assertEqual(200, rotated.status)
            current = _token_response_handle(rotated)
        harness.clock.advance(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS + 1)
        test.assertEqual(400, harness.token(_refresh_form(handle)).status)
        return harness.token(_refresh_form(current))
    if scenario == "legacy_lineage_refused_without_tokens":
        def _legacy(record):
            record.family_hash = ""
            record.chain_generation = 0
        _rewrite_broker_record(harness, handle, _legacy)
        return harness.token(_refresh_form(handle))
    if scenario == "missing_family_state_fails_closed":
        def _missing(record):
            record.family_hash = "missing-family-state"
            record.chain_generation = 2
        _rewrite_broker_record(harness, handle, _missing)
        return harness.token(_refresh_form(handle))
    if scenario == "unknown_handle":
        return harness.token(_refresh_form(_unknown_handle()))
    if scenario == "other_client_handle":
        _register_other_client(harness)
        form = _refresh_form(handle)
        form["client_id"] = [REFRESH_TEST_OTHER_CLIENT_ID]
        return harness.token(form)
    if scenario == "handle_at_another_route_refused":
        return _refresh_at_another_route(harness, handle)
    if scenario == "scope_subset_refused":
        return harness.token(_refresh_form_value(handle, "scope", ""))
    if scenario == "scope_exact_accepted":
        return harness.token(_refresh_form_value(handle, "scope", FRONT_TEST_ROTATED_UPSTREAM_SCOPE))
    if scenario == "resource_mismatch_refused":
        return harness.token(_refresh_form_value(handle, "resource", FRONT_TEST_BASE_URL + "/other/mcp"))
    if scenario == "resource_exact_accepted":
        return harness.token(_refresh_form_value(handle, "resource", REFRESH_TEST_BOUND_RESOURCE))
    if scenario == "oversized_handle_refused":
        return harness.token(_refresh_form("a" * (facade_module._FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES + 1)))
    if scenario == "missing_handle_refused":
        return harness.token({"grant_type": ["refresh_token"], "client_id": [FRONT_TEST_CLIENT_ID]})
    if scenario == "replayed_code_revokes_handle":
        test.assertEqual(200, harness.token(_refresh_form(handle)).status)
        test.assertEqual(400, harness.token(_refresh_code_form(code)).status)
        return harness.token(_refresh_form(handle))
    if scenario in ("upstream_terminal_failure", "upstream_transient_failure"):
        return harness.token(_refresh_form(handle))
    raise AssertionError(f"unknown refresh scenario {scenario!r}")


class RefreshGrantConformanceTests(unittest.TestCase):
    """Pins the brokered refresh grant to the shared cross-runtime table through
    the real token handler. Every row runs against a fresh mounted app and starts
    from the same setup — authorize, callback, and the code exchange — so each row
    presents a genuinely minted route handle rather than a seeded record."""

    def test_refresh_enforces_the_shared_table(self) -> None:
        rows = [case for case in _load_fixture()["cases"] if case["group"] == REFRESH_GROUP]
        self.assertEqual(REFRESH_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            with self.subTest(case=row["id"]):
                harness = _FrontChannelHarness(self, _refresh_provider_options(row["scenario"]))
                response = _refresh_scenario_response(self, harness, row["scenario"])

                self.assertEqual(row["expect_status"], response.status, f"row {row['id']} body {response.body!r}")
                if row.get("expect_error"):
                    self.assertIn(
                        '"error":"' + row["expect_error"] + '"',
                        response.body.decode("utf-8"),
                        f"row {row['id']}",
                    )
                if row.get("expect_retry_after"):
                    values = response.headers.get("retry-after") or []
                    self.assertTrue(values, f"row {row['id']} must carry a Retry-After header")
                    self.assertGreaterEqual(int(str(values[0])), 1, f"row {row['id']}")
                scanned = _scan(response)
                for absent in row.get("expect_absent") or []:
                    self.assertNotIn(absent, scanned, f"row {row['id']} must not carry {absent!r}")
                executed += 1
        print(f"refresh conformance: {executed} cases run")
        self.assertEqual(REFRESH_CASE_COUNT, executed)


class FrontChannelNonePublicPostureTests(unittest.TestCase):
    def test_none_public_posture_rejects_the_front_channel_field_set(self) -> None:
        harness = _FrontChannelHarness(self)
        # Rebuild a minimal valid config whose posture is none-public.
        config = FacadeConfig(
            issuer_url=FRONT_TEST_BASE_URL + "/acme/mcp",
            jwks_uri=FRONT_TEST_UPSTREAM_ISS + "/.well-known/jwks.json",
            url_mode=URL_MODE_PUBLIC_BASE_URL,
            public_base_url=FRONT_TEST_BASE_URL,
            transport_posture="none-public",
            scopes={
                "namespace": ["mcp:tools"],
                "partner_namespace": ["mcp:tools"],
                "agent": ["mcp:tools"],
                "partner_agent": ["mcp:tools"],
            },
            mcp_handler=lambda _ctx: Response(status=204, headers={}, cookies=[], body=b"", is_base64=False),
            provider=harness.provider,
            stores=harness.stores,
            upstream_client_id=FRONT_TEST_CLIENT_ID,
            upstream_issuer=FRONT_TEST_UPSTREAM_ISS,
            route_refresh_policy=facade_module.RouteRefreshPolicy(
                handle_ttl_seconds=900,
                reuse_rate_ceiling=facade_module.MIN_REFRESH_REUSE_RATE_CEILING,
            ),
        )
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn("the front-channel field set must not be configured", str(raised.exception))


# ---------------------------------------------------------------------------
# Shared journey table (the same table the Go and TypeScript loaders read)
# ---------------------------------------------------------------------------

JOURNEY_FIXTURE_NAME = "facade-journey.v1.json"

JOURNEY_GROUP = "journey"

# The number of journey rows the shared table must carry; a change to the table
# must also be a deliberate edit in the Go and TypeScript loaders, so no runtime
# can silently execute a shorter journey.
JOURNEY_CASE_COUNT = 26

# The advertising resource of the namespace route the journey world describes.
JOURNEY_ROUTE_RESOURCE = FRONT_TEST_BASE_URL + "/acme/mcp"

# The route's RFC 9728 protected-resource metadata URL, named by every challenge.
JOURNEY_METADATA_URL = FRONT_TEST_BASE_URL + "/.well-known/oauth-protected-resource/acme/mcp"

# A route resource that is not the journey route's.
JOURNEY_WRONG_AUDIENCE = FRONT_TEST_BASE_URL + "/other/mcp"

# A client id no journey row registers.
JOURNEY_UNKNOWN_CLIENT_ID = "unknown-client"

# A verifier that does not hash to the challenge the authorize step presented.
JOURNEY_WRONG_VERIFIER = "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890"


def _load_journey_fixture() -> dict:
    with (FIXTURE_DIR / JOURNEY_FIXTURE_NAME).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _journey_bearer_options(fake: FakeUpstreamProvider) -> RequireBearerTokenOptions:
    """The real JWKS claims validator over the fake upstream's key set."""

    def http_get(url: str) -> tuple[int, dict[str, str], bytes]:
        return _default_http_transport(
            "GET",
            fake.localize(url),
            {},
            None,
            timeout=FRONT_TEST_TIMEOUT_SECONDS,
            allow_private_hosts=True,
        )

    validator = new_jwks_validator(
        JWKSValidatorOptions(
            issuer=FRONT_TEST_UPSTREAM_ISS,
            jwks_uri=fake.jwks_uri,
            http_get=http_get,
            allow_private_hosts=True,
            required_audience=JOURNEY_ROUTE_RESOURCE,
            required_scopes=["mcp:tools"],
        )
    )
    return RequireBearerTokenOptions(
        resource_metadata_url=JOURNEY_METADATA_URL,
        claims_validator=validator,
        required_scopes_func=lambda _ctx: ["mcp:tools"],
    )


def _journey_harness(test: unittest.TestCase) -> tuple[_FrontChannelHarness, dict]:
    """Starts the journey harness: the front-channel harness with the
    runtime-bearer transport posture, a real JWKS claims validator, and an MCP
    handler that answers 200 and counts its invocations.
    """
    invocations = {"count": 0}
    harness = _FrontChannelHarness(
        test,
        transport_posture="runtime-bearer",
        require_bearer_token_for=_journey_bearer_options,
        mcp_handler=lambda _ctx: Response(status=200, headers={}, cookies=[], body=b"mcp-ok", is_base64=False),
        invocations=invocations,
    )
    return harness, invocations


def _journey_token_form(code: str, verifier: str) -> dict[str, list[str]]:
    """The full RFC 6749 section 4.1.3 authorization_code grant the token rows present."""
    return {
        "grant_type": ["authorization_code"],
        "code": [code],
        "code_verifier": [verifier],
        "redirect_uri": [FRONT_TEST_REDIRECT_URI],
        "client_id": [FRONT_TEST_CLIENT_ID],
    }


def _journey_token_field(response: Response, field: str) -> str:
    payload = json.loads(response.body.decode("utf-8"))
    value = payload.get(field)
    if not isinstance(value, str) or not value:
        raise AssertionError(f"token response must carry a string {field}")
    return value


def _journey_transport_token(harness: _FrontChannelHarness, token: str) -> str:
    """Mints the token a transport row presents. The fault tokens are minted by
    the fake's own key, so only the pinned claim differs and the refusal cannot
    come from a bad signature.
    """

    def mint(audience: str, scope: str, expires_in: int) -> str:
        return harness.fake.mint_access_token(
            issuer=FRONT_TEST_UPSTREAM_ISS,
            audience=audience,
            authorized_party=FRONT_TEST_CLIENT_ID,
            subject="user-1",
            scope=scope,
            expires_in=expires_in,
        )

    if token == "wrong_audience":
        return mint(JOURNEY_WRONG_AUDIENCE, "mcp:tools", 900)
    if token == "expired":
        return mint(JOURNEY_ROUTE_RESOURCE, "mcp:tools", -60)
    if token == "insufficient_scope":
        return mint(JOURNEY_ROUTE_RESOURCE, "mcp:read", 900)
    raise AssertionError(f"unknown journey transport token {token!r}")


def _journey_session(test: unittest.TestCase, precondition: str) -> dict:
    """Starts a journey harness and applies the row's declared precondition.

    Each row is executable in isolation: a row that needs facade material names
    the precondition that mints it, so dropping or reordering rows cannot
    silently weaken a later row.
    """
    harness, invocations = _journey_harness(test)
    session: dict[str, Any] = {
        "harness": harness,
        "invocations": invocations,
        "upstream_state": "",
        "facade_code": "",
        "handle": "",
        "access_token": "",
    }
    if not precondition:
        return session

    mints_authorize = (
        precondition == "authorize"
        or precondition == "authorize_consumed"
        or precondition.startswith("authorize_callback")
    )
    if not mints_authorize:
        raise AssertionError(f"unknown journey precondition {precondition!r}")

    authorize_response = harness.authorize()
    test.assertEqual(302, authorize_response.status, precondition)
    session["upstream_state"] = _location_query(authorize_response).get("state", "")
    test.assertTrue(session["upstream_state"], precondition)
    if precondition == "authorize":
        return session

    callback = harness.serve(
        "GET",
        DEFAULT_CALLBACK_PATH,
        {
            "code": [FRONT_TEST_UPSTREAM_CODE],
            "state": [session["upstream_state"]],
            "iss": [FRONT_TEST_UPSTREAM_ISS],
        },
    )
    test.assertEqual(302, callback.status, precondition)
    session["facade_code"] = _location_query(callback).get("code", "")
    test.assertTrue(session["facade_code"], precondition)
    if precondition in ("authorize_consumed", "authorize_callback"):
        return session

    exchange = harness.token(_journey_token_form(session["facade_code"], FRONT_TEST_VERIFIER))
    test.assertEqual(200, exchange.status, precondition)
    session["access_token"] = _journey_token_field(exchange, "access_token")
    session["handle"] = _journey_token_field(exchange, "refresh_token")
    if precondition == "authorize_callback_exchange":
        return session

    replay = harness.token(_journey_token_form(session["facade_code"], FRONT_TEST_VERIFIER))
    test.assertEqual(400, replay.status, precondition)
    return session


def _header(response: Response, name: str) -> str | None:
    target = name.lower()
    for key, values in (response.headers or {}).items():
        if str(key).lower() == target:
            return str(values[0]) if values else None
    return None


class JourneyTableTests(unittest.TestCase):
    """Executes the shared minimal non-TMS consumer journey from the shared table."""

    def test_the_shared_journey_table_executes_every_step(self) -> None:
        document = _load_journey_fixture()
        rows = []
        for row in document.get("cases") or []:
            self.assertTrue(row.get("group"), f"case {row.get('id')} must carry a group")
            self.assertEqual(
                JOURNEY_GROUP,
                row.get("group"),
                f"case {row.get('id')} carries group {row.get('group')!r}; "
                f"the journey loader executes only {JOURNEY_GROUP!r}",
            )
            rows.append(row)
        self.assertEqual(JOURNEY_CASE_COUNT, len(rows))

        executed = 0
        for row in rows:
            executed += 1
            with self.subTest(row=row["id"]):
                stage = row["stage"]
                if stage == "transport":
                    self._transport(row)
                elif stage == "protected_resource":
                    self._metadata(row, authorization_server=False)
                elif stage == "authorization_server_metadata":
                    self._metadata(row, authorization_server=True)
                elif stage == "register":
                    self._register(row)
                elif stage == "authorize":
                    self._authorize(row)
                elif stage == "callback":
                    self._callback(row)
                elif stage == "token":
                    self._token(row)
                else:
                    self.fail(f"row {row['id']} carries unknown stage {stage!r}")
        self.assertEqual(JOURNEY_CASE_COUNT, executed)

    def _transport(self, row: dict) -> None:
        session = _journey_session(self, row.get("precondition", ""))
        harness = session["harness"]

        headers: dict[str, list[str]] = {}
        token = row["token"]
        if token == "none":
            pass
        elif token == "valid":
            self.assertTrue(session["access_token"], f"{row['id']} needs the precondition's exchange")
            headers["authorization"] = [f"Bearer {session['access_token']}"]
        elif token in ("wrong_audience", "expired", "insufficient_scope"):
            headers["authorization"] = [f"Bearer {_journey_transport_token(harness, token)}"]
        else:
            self.fail(f"row {row['id']} carries unknown token {token!r}")

        response = harness.serve(
            "POST",
            harness.endpoint.mcp_path(),
            None,
            b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            headers,
        )
        self.assertEqual(row["expect_status"], response.status, row["id"])

        challenge = _header(response, "www-authenticate")
        if row.get("expect_challenge_resource_metadata") is True:
            self.assertEqual(
                protected_resource_www_authenticate(JOURNEY_METADATA_URL),
                challenge,
                f"row {row['id']} must carry the RFC 9728 discovery challenge",
            )
        elif row.get("expect_challenge_error") is not None:
            self.assertEqual(
                insufficient_scope_www_authenticate(
                    [row.get("expect_challenge_scope", "")], JOURNEY_METADATA_URL
                ),
                challenge,
                f"row {row['id']} must carry the RFC 6750 insufficient_scope challenge",
            )
        else:
            self.assertIsNone(challenge, f"row {row['id']} must advertise no challenge")

        if row.get("expect_handler_invocations") is not None:
            self.assertEqual(
                row["expect_handler_invocations"],
                session["invocations"]["count"],
                f"row {row['id']} handler invocations",
            )

    def _metadata(self, row: dict, *, authorization_server: bool) -> None:
        session = _journey_session(self, row.get("precondition", ""))
        harness = session["harness"]
        path = (
            harness.endpoint.oauth_authorization_server_path()
            if authorization_server
            else harness.endpoint.protected_resource_path()
        )

        response = harness.serve("GET", path)
        self.assertEqual(row["expect_status"], response.status, row["id"])
        body = response.body.decode("utf-8")
        for expected in row.get("expect_body_has") or []:
            self.assertIn(expected, body, row["id"])
        if row.get("expect_no_store") is True:
            self.assertEqual("no-store", _header(response, "cache-control"), row["id"])

    def _register(self, row: dict) -> None:
        harness, _ = _journey_harness(self)
        path = harness.endpoint.oauth_register_path()

        body = b"" if row.get("request") is None else json.dumps(row["request"]).encode("utf-8")
        for attempt in range(int(row.get("prime_registrations") or 0)):
            primed = harness.serve(
                "POST", path, None, b'{"redirect_uris":["https://client.example/callback"]}'
            )
            self.assertEqual(201, primed.status, f"row {row['id']} priming attempt {attempt + 1}")

        response = harness.serve("POST", path, None, body)
        self.assertEqual(row["expect_status"], response.status, row["id"])

        scanned = response.body.decode("utf-8")
        for expected in row.get("expect_body_has") or []:
            self.assertIn(expected, scanned, row["id"])
        if row.get("expect_no_store") is True:
            self.assertEqual("no-store", _header(response, "cache-control"), row["id"])
            self.assertEqual("no-cache", _header(response, "pragma"), row["id"])
        if row.get("expect_retry_after") is True:
            value = _header(response, "retry-after")
            self.assertIsNotNone(value, f"row {row['id']} must carry a retry-after header")
            self.assertGreaterEqual(int(value or 0), 1, f"row {row['id']} must reach the same second")
        if row.get("expect_bound_route") is True:
            client_id = str(json.loads(scanned)["client_id"])
            self.assertTrue(client_id, f"row {row['id']} must mint a client id")
            record = harness.stores.client.get(hash_key(client_id))
            self.assertIsNotNone(record, f"row {row['id']} must persist the registered client")
            self.assertEqual(JOURNEY_ROUTE_RESOURCE, record.bound_route, row["id"])

    def _authorize(self, row: dict) -> None:
        session = _journey_session(self, row.get("precondition", ""))
        harness = session["harness"]

        client_id = JOURNEY_UNKNOWN_CLIENT_ID if row.get("client") == "unknown" else FRONT_TEST_CLIENT_ID
        query: dict[str, list[str]] = {
            "client_id": [client_id],
            "redirect_uri": [FRONT_TEST_REDIRECT_URI],
            "response_type": ["code"],
            "code_challenge": [pkce_challenge_s256(FRONT_TEST_VERIFIER)],
            "code_challenge_method": ["S256"],
            "state": [FRONT_TEST_CLIENT_STATE],
            "resource": [JOURNEY_ROUTE_RESOURCE],
        }
        if row.get("redirect_uri"):
            query["redirect_uri"] = [row["redirect_uri"]]
        for key in row.get("omit") or []:
            query.pop(key, None)
        for key, value in (row.get("set") or {}).items():
            query[key] = [value]

        response = harness.serve("GET", harness.endpoint.oauth_authorize_path(), query)
        self.assertEqual(row["expect_status"], response.status, row["id"])

        location = _location(response)
        if row.get("expect_no_location") is True:
            self.assertEqual("", location, f"row {row['id']} must not redirect")
        expected_error = row.get("expect_error")
        if expected_error is not None:
            in_body = f'"error":"{expected_error}"' in response.body.decode("utf-8")
            self.assertTrue(
                _location_query(response).get("error") == expected_error or in_body,
                f"row {row['id']} must answer error {expected_error}; location {location}",
            )
        if row.get("expect_location_host"):
            self.assertTrue(
                location.startswith(row["expect_location_host"] + "/"),
                f"row {row['id']} location {location} must be beneath {row['expect_location_host']}",
            )
        query_result = _location_query(response)
        for key in row.get("expect_location_query_has") or []:
            self.assertIn(key, query_result, f"row {row['id']} location must carry {key}")
        for key, value in (row.get("expect_location_query_equals") or {}).items():
            self.assertEqual(value, query_result.get(key), f"row {row['id']} location {key}")
        if row.get("expect_upstream_state_distinct") is True:
            upstream_state = query_result.get("state", "")
            self.assertTrue(upstream_state, f"row {row['id']} must mint an upstream state")
            self.assertNotEqual(
                FRONT_TEST_CLIENT_STATE,
                upstream_state,
                f"row {row['id']} must mint an upstream state distinct from the client's",
            )

    def _callback(self, row: dict) -> None:
        session = _journey_session(self, row.get("precondition", ""))
        harness = session["harness"]

        state = session["upstream_state"] if row.get("state") == "precondition" else str(row.get("state") or "")
        self.assertTrue(state, f"row {row['id']} needs the precondition's upstream state")
        code = FRONT_TEST_UPSTREAM_CODE if row.get("code") == "upstream" else str(row.get("code") or "")
        query: dict[str, list[str]] = {"code": [code], "state": [state]}
        if row.get("iss") is not None:
            query["iss"] = [row["iss"]]

        before = harness.fake.token_calls
        response = harness.serve("GET", DEFAULT_CALLBACK_PATH, query)

        self.assertEqual(row["expect_status"], response.status, row["id"])
        location = _location(response)
        if row.get("expect_no_location") is True:
            self.assertEqual("", location, f"row {row['id']} must not redirect")
        body = response.body.decode("utf-8")
        for expected in row.get("expect_body_has") or []:
            self.assertIn(expected, body, row["id"])
        if row.get("expect_location_host"):
            self.assertTrue(
                location.startswith(row["expect_location_host"] + "/"),
                f"row {row['id']} location {location} must be beneath {row['expect_location_host']}",
            )
        query_result = _location_query(response)
        for key in row.get("expect_location_query_has") or []:
            self.assertIn(key, query_result, f"row {row['id']} location must carry {key}")
        for key, value in (row.get("expect_location_query_equals") or {}).items():
            self.assertEqual(value, query_result.get(key), f"row {row['id']} location {key}")
        if (row.get("expect_absent_from_location") or []):
            leaked = _scan(response)
            for absent in row["expect_absent_from_location"]:
                self.assertNotIn(
                    absent, leaked, f"row {row['id']} must not leak {absent!r} anywhere in the response"
                )
        if row.get("expect_handler_invocations") is not None:
            self.assertEqual(
                row["expect_handler_invocations"],
                session["invocations"]["count"],
                f"row {row['id']} handler invocations",
            )
        if row.get("expect_upstream_exchange_attempted") is False:
            self.assertEqual(
                before, harness.fake.token_calls, f"row {row['id']} must attempt no upstream exchange"
            )
        if row.get("expect_transaction_consumed") is False:
            retry = harness.serve(
                "GET",
                DEFAULT_CALLBACK_PATH,
                {"code": [code], "state": [state], "iss": [FRONT_TEST_UPSTREAM_ISS]},
            )
            self.assertEqual(
                302,
                retry.status,
                f"row {row['id']} must leave the transaction unconsumed for a correct retry",
            )
            self.assertTrue(
                _location_query(retry).get("code", ""),
                f"row {row['id']} must complete on the retry",
            )
        if row.get("terminal") is True:
            self.assertEqual(400, response.status, f"row {row['id']}: a consumed state is terminal")
            self.assertEqual("", location, f"row {row['id']}: a consumed state must not redirect")
            self.assertEqual(
                before,
                harness.fake.token_calls,
                f"row {row['id']}: a consumed state must never re-exchange",
            )

    def _token(self, row: dict) -> None:
        session = _journey_session(self, row.get("precondition", ""))
        harness = session["harness"]

        mode = row["mode"]
        if mode == "exchange":
            response = harness.token(_journey_token_form(session["facade_code"], FRONT_TEST_VERIFIER))
        elif mode == "replay":
            response = harness.token(_journey_token_form(session["facade_code"], FRONT_TEST_VERIFIER))
        elif mode == "wrong_verifier":
            response = harness.token(_journey_token_form(session["facade_code"], JOURNEY_WRONG_VERIFIER))
        elif mode in ("refresh", "revoked_refresh"):
            self.assertTrue(session["handle"], f"row {row['id']} needs the precondition's handle")
            response = harness.token(
                {
                    "grant_type": ["refresh_token"],
                    "refresh_token": [session["handle"]],
                    "client_id": [FRONT_TEST_CLIENT_ID],
                }
            )
        else:
            self.fail(f"row {row['id']} carries unknown token mode {mode!r}")
            return

        self.assertEqual(row["expect_status"], response.status, row["id"])
        scanned = response.body.decode("utf-8")
        for expected in row.get("expect_body_has") or []:
            self.assertIn(expected, scanned, row["id"])
        for absent in row.get("expect_body_absent") or []:
            self.assertNotIn(absent, scanned, row["id"])
        if row.get("expect_error") is not None:
            self.assertIn(f'"error":"{row.get("expect_error")}"', scanned, row["id"])
        if row.get("expect_access_token_unchanged") is True:
            access_token = _journey_token_field(response, "access_token")
            if mode == "refresh":
                self.assertEqual(
                    FRONT_TEST_REFRESH_ACCESS_TOKEN,
                    access_token,
                    f"row {row['id']} must return the upstream refresh access token byte-for-byte",
                )
            else:
                self.assertIsNotNone(harness.bearer_validator, f"row {row['id']} needs the JWKS validator")
                harness.bearer_validator(None, access_token)
        if row.get("expect_refresh_handle_opaque") is True:
            handle = _journey_token_field(response, "refresh_token")
            self.assertNotEqual(
                FRONT_TEST_REFRESH_TOKEN,
                handle,
                f"row {row['id']} must not hand back the upstream refresh token",
            )
        if row.get("expect_rotated_handle") is True:
            handle = _journey_token_field(response, "refresh_token")
            self.assertNotEqual(handle, session["handle"], f"row {row['id']} must rotate the route handle")
        if row.get("expect_broker_revoked") is True:
            record = harness.stores.route_refresh_broker.get(hash_key(session["handle"]))
            self.assertIsNotNone(record, row["id"])
            self.assertEqual(STATUS_REVOKED, record.status, f"row {row['id']} must revoke the broker record")
        if row.get("expect_handler_invocations") is not None:
            self.assertEqual(
                row["expect_handler_invocations"],
                session["invocations"]["count"],
                f"row {row['id']} handler invocations",
            )


# ---------------------------------------------------------------------------
# Shared threat-controls table (the same table the Go and TypeScript checkers read)
# ---------------------------------------------------------------------------

THREAT_CONTROLS_FIXTURE_NAME = "facade-threat-controls.v1.json"

THREAT_CONTROLS_GROUP = "threat_controls"

# The number of threat rows the shared table must carry; a change to the table
# must also be a deliberate edit in the Go and TypeScript checkers, so no runtime
# can silently check fewer rows.
THREAT_CONTROLS_CASE_COUNT = 11

# The closed pin vocabulary: each source names a table in the corpus and the row
# shapes a pin is resolved in -- a cases[].id, a cases[].name, or a dotted key
# path.
THREAT_PIN_SOURCES: dict[str, dict[str, Any]] = {
    "journey": {"file": "facade-journey.v1.json", "by_case_id": True, "by_key": True},
    "conformance": {"file": "facade-conformance.v1.json", "by_case_id": True},
    "route_model": {"file": "facade-route-model.v1.json", "by_key": True},
    "transport_posture": {"file": "facade-transport-posture.v1.json", "by_key": True},
    "jwks_validator": {"file": "jwks-validator.v1.json", "by_case_name": True},
    "discovery_bootstrap": {"file": "discovery-bootstrap.v1.json", "by_case_name": True, "by_key": True},
    "provider_conformance": {"file": "facade-provider-conformance.v1.json", "by_case_id": True},
    "store_conformance": {"file": "facade-store-conformance.v1.json", "by_case_id": True},
    "route_challenge": {"file": "route-challenge.v1.json", "by_key": True},
}


def _load_threat_controls_fixture() -> dict:
    with (FIXTURE_DIR / THREAT_CONTROLS_FIXTURE_NAME).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_pinned_table(file_name: str) -> dict:
    """Loads one pin vocabulary table, located exactly as the journey and
    conformance loaders locate theirs.
    """

    with (FIXTURE_DIR / file_name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _threat_pin_resolves(source: dict, row: str, table: dict) -> bool:
    """Reports whether the pin's row is a real id, name, or key inside the table."""

    if source.get("by_case_id") or source.get("by_case_name"):
        for entry in table.get("cases") or []:
            if source.get("by_case_id") and entry.get("id") and entry.get("id") == row:
                return True
            if source.get("by_case_name") and entry.get("name") and entry.get("name") == row:
                return True
    if not source.get("by_key"):
        return False
    current: Any = table
    for part in row.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return current is not None


class ThreatControlsTableTests(unittest.TestCase):
    """Proves every threat row is pinned to a row that exists in the table it names."""

    def test_the_shared_threat_controls_table_pins_every_threat_row(self) -> None:
        document = _load_threat_controls_fixture()
        self.assertEqual("mcp.auth.facade.threat_controls", document["id"])
        self.assertEqual("conformance", document["kind"])
        self.assertTrue(document["status"], "the threat-controls table must carry a status")
        self.assertTrue(document["description"], "the threat-controls table must carry a description")

        tables: dict[str, dict] = {}

        def table_for(source_key: str) -> dict:
            if source_key not in tables:
                tables[source_key] = _load_pinned_table(THREAT_PIN_SOURCES[source_key]["file"])
            return tables[source_key]

        rows = []
        for row in document.get("cases") or []:
            self.assertTrue(row.get("group"), f"case {row.get('id')} must carry a group")
            self.assertEqual(
                THREAT_CONTROLS_GROUP,
                row.get("group"),
                f"case {row.get('id')} carries group {row.get('group')!r}; "
                f"the threat-controls checker reads only {THREAT_CONTROLS_GROUP!r}",
            )
            rows.append(row)
        self.assertEqual(THREAT_CONTROLS_CASE_COUNT, len(rows))

        checked = 0
        for row in rows:
            checked += 1
            with self.subTest(row=row["id"]):
                self.assertTrue(row.get("threat"), f"case {row['id']} must name the attack class")
                self.assertTrue(row.get("control"), f"case {row['id']} must name the framework control")
                self.assertTrue(
                    row.get("source_pins"),
                    f"case {row['id']} must preserve the pin strings it was lifted from",
                )
                if row.get("runtime_executable") is True:
                    self.assertTrue(
                        row.get("pins"),
                        f"case {row['id']} is runtime_executable but carries no fixture-backed pin",
                    )
                for pin in row.get("pins") or []:
                    source = THREAT_PIN_SOURCES.get(pin["source"])
                    self.assertIsNotNone(
                        source,
                        f"case {row['id']} pin source {pin['source']!r} is outside the closed pin vocabulary",
                    )
                    self.assertTrue(
                        _threat_pin_resolves(source, pin["row"], table_for(pin["source"])),
                        f"case {row['id']} pin {pin['source']}:{pin['row']} does not resolve inside {source['file']}",
                    )
        self.assertEqual(THREAT_CONTROLS_CASE_COUNT, checked)


if __name__ == "__main__":
    unittest.main()

class FrontChannelMetadataIssAdvertisementTests(unittest.TestCase):
    """Pins the RFC 9207 claim to the front channel's own behavior: the routed
    document advertises ``authorization_response_iss_parameter_supported`` and
    its issuer is byte-equal to the ``iss`` the client callback carries.
    """

    def test_routed_metadata_advertises_the_iss_it_sends(self) -> None:
        harness = _FrontChannelHarness(self)

        metadata = harness.serve("GET", harness.endpoint.oauth_authorization_server_path())
        self.assertEqual(200, metadata.status)
        document = json.loads(metadata.body.decode())
        self.assertIs(True, document["authorization_response_iss_parameter_supported"])
        self.assertTrue(document["issuer"])

        callback, _ = harness.authorize_and_callback()
        self.assertEqual(document["issuer"], _location_query(callback).get("iss"))


class M2RefreshRevocationTests(unittest.TestCase):
    """Pins the M2 removal of beyond-grace token serving and the family tombstone."""

    def test_first_beyond_grace_presentation_revokes_without_tokens(self) -> None:
        harness = _FrontChannelHarness(self)
        exchange, _code = _exchange_the_code(harness)
        handle = _token_response_handle(exchange)
        first_rotation = harness.token(_refresh_form(handle))
        self.assertEqual(200, first_rotation.status)
        successor = _token_response_handle(first_rotation)
        before = harness.fake.refresh_calls

        harness.clock.advance(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS + 1)
        refused = harness.token(_refresh_form(handle))
        self.assertEqual(400, refused.status)
        self.assertIn(b'"error":"invalid_grant"', refused.body)
        for absent in (b"access_token", b"refresh_token", b"id_token"):
            self.assertNotIn(absent, refused.body)
        self.assertEqual(before, harness.fake.refresh_calls, "reuse must not reach the upstream")

        for revoked in (handle, successor):
            with self.assertRaises(BrokerRevokedError):
                harness.stores.route_refresh_broker.get(hash_key(revoked))

        again = harness.token(_refresh_form(handle))
        self.assertEqual(400, again.status)
        self.assertEqual(refused.body, again.body)

    def test_legacy_record_fails_closed_without_an_upstream_call(self) -> None:
        harness = _FrontChannelHarness(self)
        exchange, _code = _exchange_the_code(harness)
        handle = _token_response_handle(exchange)
        before = harness.fake.refresh_calls

        def _legacy(record) -> None:
            record.family_hash = ""
            record.chain_generation = 0

        _rewrite_broker_record(harness, handle, _legacy)
        refused = harness.token(_refresh_form(handle))
        self.assertEqual(400, refused.status)
        self.assertIn(b'"error":"invalid_grant"', refused.body)
        self.assertEqual(before, harness.fake.refresh_calls)
        record = harness.stores.route_refresh_broker.get(hash_key(handle))
        self.assertEqual("", record.family_hash, "a legacy record must not be normalized")
        self.assertEqual(0, record.chain_generation)

    def test_more_than_eight_rotations_revoke_every_member(self) -> None:
        harness = _FrontChannelHarness(self)
        exchange, _code = _exchange_the_code(harness)
        current = _token_response_handle(exchange)
        handles = [current]
        for _index in range(11):
            rotated = harness.token(_refresh_form(current))
            self.assertEqual(200, rotated.status)
            current = _token_response_handle(rotated)
            handles.append(current)
        harness.clock.advance(facade_module.DEFAULT_REFRESH_GRACE_WINDOW_SECONDS + 1)
        reused = harness.token(_refresh_form(handles[0]))
        self.assertEqual(400, reused.status)
        for handle in handles:
            with self.assertRaises(BrokerRevokedError):
                harness.stores.route_refresh_broker.get(hash_key(handle))
