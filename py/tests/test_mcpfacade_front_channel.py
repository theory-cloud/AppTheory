from __future__ import annotations

# ruff: noqa: S105, S106
import json
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

from apptheory import (
    URL_MODE_PUBLIC_BASE_URL,
    FacadeConfig,
    create_app,
    register_mcp_facade,
)
from apptheory.mcproutes import DEFAULT_CALLBACK_PATH, EndpointPath
from apptheory.oauth import pkce_challenge_s256
from apptheory.oauth.autheory import AutheoryProviderOptions, _default_http_transport, new_autheory_provider
from apptheory.oauth.fake_provider import FakeUpstreamProvider
from apptheory.oauth.provider import CodeExchangeRequest, TokenSet
from apptheory.oauth.store import (
    ClientRecord,
    MemoryAuthorizationCodeStore,
    MemoryClientStore,
    MemoryRateLimitStore,
    MemoryRouteRefreshBrokerStore,
    MemoryTransactionStore,
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

METHOD_STATUS_GROUP = "method_status"

# The number of method_status rows the shared table must carry; a change to the
# table must also be a deliberate edit in the Go and TypeScript loaders, so no
# runtime can silently execute a smaller table.
METHOD_STATUS_CASE_COUNT = 10

DCR_GROUP = "dcr"

# The number of dcr rows the shared table must carry; a change to the table must
# also be a deliberate edit in the Go, TypeScript, and Python loaders, so no
# runtime can silently execute a smaller table.
DCR_CASE_COUNT = 10

# The number of requests a dcr row sends when it carries no explicit repeat.
DCR_DEFAULT_REPEAT = 1

# The bytes the serialized pad member adds around its "a" run: `,"pad":"` plus
# `"}`.
DCR_PAD_FRAME_OVERHEAD = len(',"pad":"') + len('"}')


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

    def __init__(self, adapter, fake: FakeUpstreamProvider, issued_at: float) -> None:
        self._adapter = adapter
        self._fake = fake
        self._issued_at = issued_at

    def discovery(self):
        return self._adapter.discovery()

    def authorization_url(self, req):
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
    def __init__(self, test: unittest.TestCase) -> None:
        self._test = test
        self.clock = _ManualClock(datetime(2026, 1, 1, tzinfo=UTC))
        self.fake = FakeUpstreamProvider(
            issuer=FRONT_TEST_UPSTREAM_ISS,
            token_body={
                "access_token": "placeholder-upstream-access-token",
                "token_type": "Bearer",
                "expires_in": 900,
                "refresh_token": FRONT_TEST_REFRESH_TOKEN,
                "scope": "mcp:tools",
            },
        )
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
        self.provider = _MintingProvider(adapter, self.fake, self.issued_at)
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

        config = FacadeConfig(
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
            provider=self.provider,
            stores=self.stores,
            upstream_client_id=FRONT_TEST_CLIENT_ID,
            upstream_issuer=FRONT_TEST_UPSTREAM_ISS,
        )
        self.stores.client.put(
            ClientRecord(
                client_id_hash=hash_key(FRONT_TEST_CLIENT_ID),
                client_id=FRONT_TEST_CLIENT_ID,
                redirect_uris=[FRONT_TEST_REDIRECT_URI],
                token_endpoint_auth_method="none",
            )
        )

        self.app = create_app()
        register_mcp_facade(self.app, config)

    # -- requests ------------------------------------------------------------

    def serve(self, method: str, path: str, query: dict | None = None, body: bytes = b"") -> Response:
        return self.app.serve(Request(method=method, path=path, query=query or {}, body=body, is_base64=False))

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

    def test_token_refuses_refresh_grant_until_m3c(self) -> None:
        harness = _FrontChannelHarness(self)
        response = harness.token(
            {
                "grant_type": ["refresh_token"],
                "refresh_token": ["whatever-handle"],
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
        )
        with self.assertRaises(ValueError) as raised:
            register_mcp_facade(create_app(tier="p0"), config)
        self.assertIn("the front-channel field set must not be configured", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
