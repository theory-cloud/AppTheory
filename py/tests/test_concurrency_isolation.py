from __future__ import annotations

import base64
import datetime as dt
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory.aws_http as aws_http  # noqa: E402
import apptheory.mcpfacade as mcpfacade  # noqa: E402
from apptheory.app import App  # noqa: E402
from apptheory.context import Context  # noqa: E402
from apptheory.errors import AppTheoryError  # noqa: E402
from apptheory.logger import get_logger, set_logger  # noqa: E402
from apptheory.logging_profile import (  # noqa: E402
    LOGGING_PROFILE_CLOUDWATCH_JSON,
    ProfileLogger,
    default_logging_profile,
)
from apptheory.mcp import (  # noqa: E402
    MCP_HEADER_PROTOCOL_VERSION,
    MCP_HEADER_SESSION_ID,
    MCP_PROTOCOL_VERSION,
    McpSession,
    McpTask,
    McpTaskListRequest,
    McpTaskLookup,
    McpTaskRecord,
    MemoryMcpSessionStore,
    MemoryMcpStreamStore,
    MemoryMcpTaskStore,
    create_mcp_server,
)
from apptheory.microvm.model import MicroVMSessionRecord  # noqa: E402
from apptheory.microvm.registry import (  # noqa: E402
    create_memory_microvm_session_registry,
)
from apptheory.oauth import OAuthBearerError  # noqa: E402
from apptheory.oauth.autheory import (  # noqa: E402
    AutheoryProvider,
    AutheoryProviderOptions,
    new_autheory_provider,
)
from apptheory.oauth.fake_provider import (  # noqa: E402
    FakeUpstreamProvider,
    generate_rsa_key,
    shared_rsa_key,
)
from apptheory.oauth.jwks import JWKSValidatorOptions, new_jwks_validator  # noqa: E402
from apptheory.oauth.provider import ProviderError, TokenExpectations  # noqa: E402
from apptheory.request import Request  # noqa: E402
from apptheory.response import Response  # noqa: E402
from apptheory.secure_types import SecurePrincipal  # noqa: E402

# This file proves the multi-concurrency isolation invariant for the Python
# runtime: AWS Lambda Web Functions serve many requests in one execution
# environment, so every request must observe only its own request context,
# identity, correlation id, logger binding, headers and response state, while
# the state that is intentionally process-wide (clients, compiled routes, warm
# caches keyed by immutable inputs) stays shared AND stays correct when
# requests overlap.
#
# The Python runtime's concurrency model is threads. Every entry point is
# synchronous and bridges awaitables with ``asyncio.run``, which refuses to run
# inside a live event loop, so two overlapping requests are two threads in one
# interpreter, never two asyncio tasks. Each test therefore releases its
# workers from a ``threading.Barrier`` and, where the defect is a narrow
# window, shrinks ``sys.setswitchinterval`` so the interleaving is reproducible
# rather than lucky.
#
# Two shapes of defect are covered. A *check-then-act that spans a call* is
# reproducible on any CPython, because the interpreter can switch threads at a
# call boundary; that is what the create/fetch/lazy-init tests exercise. A
# *structure mutated while another thread iterates it* is reproducible too,
# because iteration is a Python-level frame with switch points; that is what
# the stream-store and JWKS tests exercise. A read-modify-write with no call
# inside it is not reliably pre-empted by CPython's GIL, so no test here claims
# that shape as a fault: those items are classified by contract in the audit
# and pinned by an overlap test instead.

_DEFAULT_SWITCH_INTERVAL = sys.getswitchinterval()
_SETTLE_SECONDS = 0.05

# A front-door parameter value that satisfies the parameter grammar the
# framework enforces before it will serve a cached secret.
_FRONT_DOOR_SECRET_VALUE = "mu" + "A" * 46


def _run_concurrently(worker: Any, concurrency: int) -> list[Any]:
    """Runs ``worker(index)`` on ``concurrency`` threads released together."""
    results: list[Any] = [None] * concurrency
    errors: list[BaseException] = []
    start = threading.Barrier(concurrency)

    def run(index: int) -> None:
        try:
            start.wait()
            results[index] = worker(index)
        except BaseException as exc:  # noqa: BLE001 - re-raised on the test thread
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(index,)) for index in range(concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    if errors:
        raise errors[0]
    return results


class _RaceProne:
    """Makes a narrow interleaving reproducible instead of lucky.

    ``sys.setswitchinterval`` bounds how long a thread holds the GIL, so the
    smallest legal value lets the interpreter pre-empt at every switch point
    rather than once a millisecond.
    """

    def __enter__(self) -> None:
        sys.setswitchinterval(1e-6)

    def __exit__(self, *_exc: Any) -> None:
        sys.setswitchinterval(_DEFAULT_SWITCH_INTERVAL)


class _SlowClock:
    """A clock whose read yields the interpreter, widening a critical window."""

    def __init__(self, delay: float) -> None:
        self._delay = delay

    def now(self) -> dt.datetime:
        time.sleep(self._delay)
        return _fixed_clock()


def _fixed_clock() -> dt.datetime:
    return dt.datetime(2026, 11, 26, 12, 0, 0, tzinfo=dt.UTC)


def _profile_config() -> dict[str, Any]:
    """A logging profile that emits the request identity on every line.

    The profile owns the emitted field set, so the identity fields are mapped
    explicitly; the message carries the request's own label because that is the
    one field the encoder never rewrites.
    """
    config = default_logging_profile(LOGGING_PROFILE_CLOUDWATCH_JSON)
    config["enrichment"] = {"context": {"request_id": "request.request_id", "tenant_id": "request.tenant_id"}}
    config["required_fields"] = ["timestamp", "level", "message"]
    return config


def _request(path: str, *, headers: dict[str, str] | None = None) -> Request:
    return Request(method="GET", path=path, headers=dict(headers or {}))


def _header_value(headers: Any, name: str) -> str:
    """Reads one header the way the runtime stores it (multi-value or scalar)."""
    value = (headers or {}).get(name)
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else ""
    return str(value or "")


def _request_id_of(response: Response) -> str:
    return _header_value(response.headers, "x-request-id")


class _EchoApp:
    """An App whose routes reflect the request-scoped state they were handed.

    Every worker parks on a barrier *inside* the handler, so all N requests are
    live at once and any state that leaked between them is observable in the
    responses rather than only in a lucky scheduling order.
    """

    def __init__(self, concurrency: int) -> None:
        self.barrier = threading.Barrier(concurrency)
        self.app = App()
        self.app.use(self._middleware)
        self.app.get("/echo", self._handler)
        self.app.get("/fail", self._fail)
        self.app.get("/early", self._early)

    def _middleware(self, ctx: Context, next_handler: Any) -> Response:
        # Middleware state is request state: a value written here must be the
        # value this request's handler reads, never a neighbour's.
        ctx._values["tenant_marker"] = f"mw-{_header(ctx, 'x-tenant')}"
        response = next_handler(ctx)
        headers = dict(response.headers or {})
        headers["x-mw-tenant"] = str(ctx._values["tenant_marker"])
        response.headers = headers
        return response

    def _park(self) -> None:
        # A barrier that breaks means the pipeline serialized the requests,
        # which would hide exactly the defect this file exists to catch.
        self.barrier.wait(timeout=10)

    def _handler(self, ctx: Context) -> Response:
        request_id = ctx.request_id
        marker = str(ctx._values.get("tenant_marker", ""))
        self._park()
        # Read again *after* every other request entered the handler: nothing
        # this request owns may have moved.
        if ctx.request_id != request_id:
            raise AssertionError(f"request id moved: {request_id!r} -> {ctx.request_id!r}")
        if str(ctx._values.get("tenant_marker", "")) != marker:
            raise AssertionError("middleware state moved between requests")
        payload = {
            "request_id": request_id,
            "tenant": _header(ctx, "x-tenant"),
            "trace": _header(ctx, "x-trace"),
            "echo": _header(ctx, "x-echo"),
            "marker": marker,
        }
        return Response(
            status=200,
            headers={"x-request-id": request_id},
            cookies=[],
            body=json.dumps(payload, sort_keys=True).encode("utf-8"),
            is_base64=False,
        )

    def _fail(self, ctx: Context) -> Response:
        request_id = ctx.request_id
        self._park()
        raise AppTheoryError(code="app.boom", message=f"failed {request_id}", status_code=500)

    def _early(self, ctx: Context) -> Response:
        self._park()
        return Response(status=204, headers={"x-request-id": ctx.request_id}, cookies=[], body=b"", is_base64=False)


def _header(ctx: Context, name: str) -> str:
    return ctx.request.headers.get(name, [""])[0]


class TestRequestScopedIsolation(unittest.TestCase):
    """R1 PER_REQUEST items: nothing a request owns may be visible to another."""

    def test_http_pipeline_isolates_overlapping_requests(self) -> None:
        concurrency = 8
        echo = _EchoApp(concurrency)

        def worker(index: int) -> dict[str, Any]:
            response = echo.app.serve(
                _request(
                    "/echo",
                    headers={
                        "x-tenant": f"tenant-{index}",
                        "x-trace": f"trace-{index}",
                        "x-echo": f"echo-{index}",
                    },
                )
            )
            self.assertEqual(response.status, 200)
            payload = json.loads(response.body)
            self.assertEqual(_request_id_of(response), payload["request_id"])
            return payload

        results = _run_concurrently(worker, concurrency)
        self.assertEqual(
            len({result["request_id"] for result in results}),
            concurrency,
            "two overlapping requests shared one request id",
        )
        for index, result in enumerate(results):
            self.assertEqual(result["tenant"], f"tenant-{index}")
            self.assertEqual(result["trace"], f"trace-{index}")
            self.assertEqual(result["echo"], f"echo-{index}")
            self.assertEqual(result["marker"], f"mw-tenant-{index}")

    def test_overlapping_failures_keep_their_own_identity(self) -> None:
        concurrency = 6
        echo = _EchoApp(concurrency)

        def worker(index: int) -> Any:
            return echo.app.serve(_request("/fail", headers={"x-tenant": f"tenant-{index}"})), index

        outcomes = _run_concurrently(worker, concurrency)
        request_ids: set[str] = set()
        for response, _index in outcomes:
            self.assertEqual(response.status, 500)
            payload = json.loads(response.body)["error"]
            self.assertEqual(payload["code"], "app.boom")
            # The handler raised with the request id it observed and the
            # envelope carries that same id: neither was swapped under load.
            self.assertEqual(payload["message"], f"failed {payload['request_id']}")
            request_ids.add(str(payload["request_id"]))
        self.assertEqual(len(request_ids), concurrency, "overlapping failures shared one request id")

    def test_overlapping_early_returns_keep_their_own_response_state(self) -> None:
        concurrency = 6
        echo = _EchoApp(concurrency)

        def worker(index: int) -> Any:
            return echo.app.serve(_request("/early", headers={"x-tenant": f"tenant-{index}"})), index

        outcomes = _run_concurrently(worker, concurrency)
        self.assertEqual(len({_request_id_of(response) for response, _ in outcomes}), concurrency)
        for response, index in outcomes:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.body, b"")
            self.assertEqual(_header_value(response.headers, "x-mw-tenant"), f"mw-tenant-{index}")


class TestSharedStateStaysCorrect(unittest.TestCase):
    """R1 UNSAFE_SHARED items: shared state must survive overlap intact."""

    def test_memory_stream_store_never_loses_or_reorders_events_under_overlap(self) -> None:
        # The store is process-wide by protocol (one session per MCP client),
        # so append and subscribe really do run on different request threads.
        # Eviction is what makes the window observable: trimming moves the
        # front of the event list while a subscriber is iterating it.
        store = MemoryMcpStreamStore(max_events_per_session=4, max_session_bytes=1 << 30)
        stream_id = store.create("session-1")
        concurrency = 8
        per_worker = 120
        observations: list[list[int]] = []
        observations_lock = threading.Lock()

        def worker(index: int) -> None:
            if index == 0:
                for _ in range(per_worker):
                    events = store.subscribe("session-1", stream_id)
                    with observations_lock:
                        observations.append([int(event.id) for event in events])
                return
            for turn in range(per_worker):
                store.append("session-1", stream_id, f"{index}:{turn}".encode())

        with _RaceProne():
            _run_concurrently(worker, concurrency)

        for ids in observations:
            # Eviction only ever removes from the front, so a snapshot may
            # start anywhere but must never skip an id, reorder, or repeat one.
            self.assertEqual(ids, sorted(ids), f"subscription reordered: {ids}")
            self.assertEqual(ids, list(range(ids[0], ids[-1] + 1)) if ids else [], f"subscription lost an event: {ids}")
        retained = store.subscribe("session-1", stream_id)
        self.assertLessEqual(len(retained), 4, "the retention bound was exceeded")
        self.assertEqual([int(event.id) for event in retained], sorted(int(event.id) for event in retained))

    def test_memory_task_store_records_every_concurrent_create(self) -> None:
        # ``create`` reads the session, decides, and only then stores it back.
        # Holding that window open with a slow clock is what makes the defect
        # observable regardless of scheduler luck: without a lock every worker
        # writes into its own private dictionary and only the last one survives.
        store = MemoryMcpTaskStore(clock=_SlowClock(_SETTLE_SECONDS))
        concurrency = 8

        def worker(index: int) -> None:
            store.create(
                McpTaskRecord(session_id="session-1", method="tools/call", task=McpTask(task_id=f"task-{index}"))
            )

        _run_concurrently(worker, concurrency)

        listed = store.list(McpTaskListRequest(session_id="session-1", limit=100))
        self.assertEqual(len(listed.tasks), concurrency, "a concurrently created task was lost")
        self.assertEqual(
            sorted(task.task_id for task in listed.tasks),
            [f"task-{index}" for index in range(concurrency)],
        )

    def test_memory_task_store_cancel_stays_terminal_under_overlap(self) -> None:
        store = MemoryMcpTaskStore()
        store.create(McpTaskRecord(session_id="session-1", method="tools/call", task=McpTask(task_id="task-1")))
        concurrency = 8

        def worker(_index: int) -> str:
            try:
                store.cancel(McpTaskLookup(session_id="session-1", task_id="task-1"))
                return "canceled"
            except Exception as exc:  # noqa: BLE001 - the outcome is the assertion
                return type(exc).__name__

        with _RaceProne():
            results = _run_concurrently(worker, concurrency)

        # Exactly one worker may cancel; every other worker must observe the
        # terminal record rather than cancel it a second time.
        self.assertEqual(results.count("canceled"), 1, f"cancellation was not terminal: {results}")
        final = store.get(McpTaskLookup(session_id="session-1", task_id="task-1"))
        self.assertEqual(final.task.status, "canceled")

    def test_jwks_validator_survives_concurrent_validation(self) -> None:
        issuer = "https://auth.example.test"
        now = _fixed_clock()
        fetches: list[str] = []
        fetches_lock = threading.Lock()

        def http_get(url: str) -> tuple[int, dict[str, str], bytes]:
            with fetches_lock:
                fetches.append(url)
            document = {
                "keys": [{"kty": "RSA", "kid": f"published-{index}", "n": "AQAB", "e": "AQAB"} for index in range(8)]
            }
            return 200, {"content-type": "application/json"}, json.dumps(document).encode()

        validator = new_jwks_validator(
            JWKSValidatorOptions(
                issuer=issuer,
                jwks_uri=f"{issuer}/.well-known/jwks.json",
                http_get=http_get,
                now=lambda: now,
                refresh_cooldown_seconds=0,
                max_key_entries=4,
                max_window_entries=4,
                max_unknown_kid_fetches=10_000,
            )
        )
        ctx = Context(request=_request("/"))
        concurrency = 16
        unexpected: list[str] = []
        unexpected_lock = threading.Lock()

        def worker(index: int) -> None:
            for turn in range(20):
                try:
                    validator(ctx, _unsigned_token(kid=f"kid-{index}-{turn}", issuer=issuer, now=now))
                except Exception as exc:  # noqa: BLE001 - an unknown kid fails closed on purpose
                    name = type(exc).__name__
                    if name not in {"OAuthBearerError"}:
                        with unexpected_lock:
                            unexpected.append(f"{name}: {exc}")

        with _RaceProne():
            _run_concurrently(worker, concurrency)

        self.assertEqual(
            unexpected,
            [],
            "concurrent bearer validation corrupted the shared JWKS cache instead of failing closed",
        )

    def test_front_door_ssm_client_is_created_once_under_overlap(self) -> None:
        calls: list[str] = []
        calls_lock = threading.Lock()

        class _FakeSsm:
            pass

        def client(service: str) -> Any:
            with calls_lock:
                calls.append(service)
            time.sleep(_SETTLE_SECONDS)
            return _FakeSsm()

        fake_boto3 = mock.MagicMock()
        fake_boto3.client.side_effect = client
        with (
            mock.patch.dict(sys.modules, {"boto3": fake_boto3}),
            mock.patch.object(mcpfacade, "_front_door_ssm_client_instance", None),
        ):
            clients = _run_concurrently(lambda _index: mcpfacade._front_door_ssm_client(), 8)
        self.assertEqual(len({id(value) for value in clients}), 1, "two SSM clients were created")
        self.assertEqual(len(calls), 1, "boto3.client ran more than once")

    def test_stream_spill_store_creates_one_object_store_under_overlap(self) -> None:
        from apptheory import mcp as mcp_module

        created: list[str] = []
        created_lock = threading.Lock()

        def factory() -> Any:
            with created_lock:
                created.append("created")
            time.sleep(_SETTLE_SECONDS)
            return object()

        spill = mcp_module._S3McpStreamSpillStore("bucket-1")
        with mock.patch("apptheory.objectstore.create_s3_object_store", side_effect=factory):
            _run_concurrently(lambda _index: spill._object_store(), 8)
        self.assertEqual(len(created), 1, "the spill object store was created more than once")

    def test_autheory_discovery_is_fetched_once_under_overlap(self) -> None:
        issuer = "https://auth.example.test"
        calls: list[str] = []
        calls_lock = threading.Lock()

        def transport(
            method: str, url: str, headers: dict[str, str], body: bytes | None
        ) -> tuple[int, dict[str, str], bytes]:
            del method, headers, body
            with calls_lock:
                calls.append(url)
            time.sleep(_SETTLE_SECONDS)
            document = {
                "issuer": issuer,
                "authorization_endpoint": f"{issuer}/authorize",
                "token_endpoint": f"{issuer}/token",
                "jwks_uri": f"{issuer}/.well-known/jwks.json",
                "code_challenge_methods_supported": ["S256"],
            }
            return 200, {"content-type": "application/json"}, json.dumps(document).encode()

        provider = AutheoryProvider(
            AutheoryProviderOptions(
                issuer=issuer,
                discovery_url=f"{issuer}/.well-known/oauth-authorization-server",
                http_get=transport,
                allow_private_hosts=True,
            )
        )
        metadata = _run_concurrently(lambda _index: provider.discovery(), 8)
        self.assertEqual(len(calls), 1, "discovery was fetched once per concurrent caller")
        self.assertEqual(len({id(item) for item in metadata}), 1, "callers observed different metadata objects")


class TestSafeSharedState(unittest.TestCase):
    """R1 SAFE_SHARED items: intentionally shared, and correct under overlap."""

    def test_process_logger_binding_is_request_scoped(self) -> None:
        lines: list[dict[str, Any]] = []
        lines_lock = threading.Lock()

        def writer(line: str) -> None:
            with lines_lock:
                lines.append(json.loads(line))

        profile = ProfileLogger(_profile_config(), writer=writer, clock=_fixed_clock)
        previous = get_logger()
        set_logger(profile)
        try:
            concurrency = 8

            def worker(index: int) -> None:
                bound = get_logger()
                self.assertIs(bound, profile, "the process logger must stay one object")
                scoped = bound.with_request_id(f"req-{index}").with_tenant_id(f"tenant-{index}")
                for turn in range(20):
                    scoped.info(f"line {index} {turn}")
                # Binding must not have moved the shared logger's own identity.
                self.assertEqual(get_logger()._request_id, "")
                self.assertEqual(get_logger()._tenant_id, "")

            _run_concurrently(worker, concurrency)
        finally:
            set_logger(previous)

        self.assertEqual(len(lines), 8 * 20)
        for entry in lines:
            index = entry["message"].split()[1]
            self.assertEqual(entry["request_id"], f"req-{index}")
            self.assertEqual(entry["tenant_id"], f"tenant-{index}")

    def test_profile_logger_retains_every_entry_under_overlap(self) -> None:
        written: list[dict[str, Any]] = []
        written_lock = threading.Lock()

        def writer(line: str) -> None:
            with written_lock:
                written.append(json.loads(line))

        profile = ProfileLogger(_profile_config(), writer=writer, clock=_fixed_clock)
        concurrency = 8
        per_worker = 200

        def worker(index: int) -> None:
            scoped = profile.with_request_id(f"req-{index}")
            for turn in range(per_worker):
                scoped.info(f"line {index} {turn}")

        with _RaceProne():
            _run_concurrently(worker, concurrency)

        total = concurrency * per_worker
        stats = profile.get_stats()
        self.assertEqual(stats["entries_logged"], total, "the retained-log counter lost updates")
        self.assertEqual(len(written), total)
        entries = profile.entries()
        # The process-scoped ring keeps the most recent 1024 lines and stays
        # bounded; every retained line still names the request that wrote it.
        self.assertEqual(len(entries), 1024)
        self.assertEqual(stats["entries_dropped"], total - 1024)
        for entry in entries:
            self.assertEqual(entry["request_id"], f"req-{entry['message'].split()[1]}")

    def test_memory_session_store_keeps_sessions_apart_under_overlap(self) -> None:
        store = MemoryMcpSessionStore(max_sessions=64)
        concurrency = 8
        _run_concurrently(
            lambda index: store.put(McpSession(id=f"session-{index}", principal=f"principal-{index}")),
            concurrency,
        )

        def worker(_index: int) -> Any:
            return [store.get(f"session-{other}").principal for other in range(concurrency)]

        results = _run_concurrently(worker, concurrency)
        for principals in results:
            self.assertEqual(principals, [f"principal-{other}" for other in range(concurrency)])

    def test_front_door_secret_cache_reads_once_under_overlap(self) -> None:
        calls: list[str] = []
        calls_lock = threading.Lock()

        def read(name: str) -> str:
            with calls_lock:
                calls.append(name)
            time.sleep(0.02)
            return _FRONT_DOOR_SECRET_VALUE

        cache = mcpfacade._FrontDoorSecretCache(read, "parameter-1", 60.0)
        values = _run_concurrently(lambda _index: cache.secret(force=False), 8)
        self.assertEqual(len(calls), 1, "concurrent readers did not coalesce onto one read")
        self.assertEqual(set(values), {_FRONT_DOOR_SECRET_VALUE})

    def test_drain_worker_registry_is_readable_during_overlap(self) -> None:
        counts = _run_concurrently(lambda _index: aws_http._live_streaming_body_drain_workers(), 8)
        self.assertEqual(set(counts), {0})

    def test_shared_rsa_key_returns_one_keypair_under_overlap(self) -> None:
        keys = _run_concurrently(lambda _index: shared_rsa_key(512), 8)
        self.assertEqual(len(set(keys)), 1, "the shared key cache produced two keypairs")


_MICROVM_NOW = 1_764_216_000.0
_MICROVM_EXPIRES_AT = 4_102_444_800.0


def _microvm_record(
    session_id: str,
    *,
    tenant_id: str = "tenant-a",
    namespace: str = "ns-a",
    auth_subject: str = "subject-a",
) -> MicroVMSessionRecord:
    return MicroVMSessionRecord(
        tenant_id=tenant_id,
        namespace=namespace,
        session_id=session_id,
        state="running",
        desired_state="running",
        image_ref="img",
        controller_id="controller-1",
        created_at=_MICROVM_NOW,
        updated_at=_MICROVM_NOW,
        expires_at=_MICROVM_EXPIRES_AT,
        generation=1,
        last_command_id="command-1",
        auth_subject=auth_subject,
        network_connector_ref="network-connector-1",
        provider_id="aws",
        provider_microvm_id=session_id,
        provider_state="running",
        aws_lifecycle_state="running",
        last_observed_at=_MICROVM_NOW,
        last_action="create",
    )


class TestMicrovmSessionRegistryStaysCorrect(unittest.TestCase):
    """The microvm session registry is a process-wide store, like the MCP stores.

    ``MemoryMicroVMSessionRegistry`` is constructed once per execution
    environment and shared by every request that drives a micro:vm session, so
    its ``put``/``get``/``delete``/``list`` run on different request threads.
    ``list`` walks the record maps twice and derives the canonical-precedence
    set in between, which is exactly the *structure mutated while another thread
    iterates it* shape the audit classifies as reproducible: without a lock the
    iteration aborts with ``RuntimeError: dictionary changed size during
    iteration`` and the request fails instead of listing its sessions.
    """

    def test_microvm_session_registry_survives_concurrent_put_delete_list(self) -> None:
        registry = create_memory_microvm_session_registry()
        stable = [f"stable-{index:03d}" for index in range(64)]
        for session_id in stable:
            registry.put(_microvm_record(session_id))

        writers = 2
        churn_turns = 120
        # Writer ``turn`` deletes the record it wrote three turns earlier, so the
        # surviving set is exactly churn_turns minus the deleted targets.
        deleted_turns = {turn - 3 for turn in range(3, churn_turns) if turn % 3 == 0}
        deleted_per_writer = len(deleted_turns)
        list_input = {"tenant_id": "tenant-a", "namespace": "ns-a", "auth_subject": "subject-a"}
        listings: list[list[str]] = []
        listings_lock = threading.Lock()

        def worker(index: int) -> None:
            if index < writers:
                for turn in range(churn_turns):
                    registry.put(_microvm_record(f"churn-{index}-{turn:03d}"))
                    if turn >= 3 and turn % 3 == 0:
                        registry.delete(
                            {
                                "tenant_id": "tenant-a",
                                "namespace": "ns-a",
                                "session_id": f"churn-{index}-{turn - 3:03d}",
                            }
                        )
                return
            if index < writers + 2:
                for _ in range(churn_turns):
                    session_ids = [session.session_id for session in registry.list(dict(list_input))]
                    with listings_lock:
                        listings.append(session_ids)
                return
            for turn in range(churn_turns):
                session_id = stable[turn % len(stable)]
                record = registry.get(("tenant-a", "ns-a", session_id))
                if record.session_id != session_id:
                    raise AssertionError(f"registry returned {record.session_id!r} for {session_id!r}")

        with _RaceProne():
            _run_concurrently(worker, writers + 4)

        for session_ids in listings:
            self.assertEqual(session_ids, sorted(session_ids), f"listing reordered: {session_ids[:8]}")
            self.assertEqual(
                len(set(session_ids)),
                len(session_ids),
                "a listing returned the same session twice",
            )

        expected = set(stable)
        for writer in range(writers):
            expected.update(
                f"churn-{writer}-{turn:03d}" for turn in range(churn_turns) if turn not in deleted_turns
            )
        listed = [session.session_id for session in registry.list(dict(list_input))]
        self.assertEqual(listed, sorted(expected), "a concurrent put or delete was lost")
        self.assertEqual(
            len(expected),
            len(stable) + writers * (churn_turns - deleted_per_writer),
        )

    def test_microvm_session_registry_keeps_tenants_apart_under_overlap(self) -> None:
        registry = create_memory_microvm_session_registry()
        tenants = ("tenant-a", "tenant-b", "tenant-c")
        per_tenant = 24
        for tenant in tenants:
            for index in range(per_tenant):
                registry.put(
                    _microvm_record(
                        f"{tenant}-{index:03d}",
                        tenant_id=tenant,
                        auth_subject=f"subject-{tenant}",
                    )
                )

        def worker(index: int) -> list[str]:
            tenant = tenants[index % len(tenants)]
            touched = f"{tenant}-{index % per_tenant:03d}"
            for turn in range(60):
                sessions = registry.list(
                    {"tenant_id": tenant, "namespace": "ns-a", "auth_subject": f"subject-{tenant}"}
                )
                for session in sessions:
                    if session.tenant_id != tenant:
                        raise AssertionError(f"tenant {tenant} listed tenant {session.tenant_id}")
                registry.put(_microvm_record(touched, tenant_id=tenant, auth_subject=f"subject-{tenant}"))
                registry.get((tenant, "ns-a", touched))
                if turn % 10 == 0:
                    registry.delete({"tenant_id": tenant, "namespace": "ns-a", "session_id": touched})
            return [session.session_id for session in registry.list({"tenant_id": tenant, "namespace": "ns-a", "auth_subject": f"subject-{tenant}"})]

        with _RaceProne():
            results = _run_concurrently(worker, 6)

        for index, session_ids in enumerate(results):
            tenant = tenants[index % len(tenants)]
            self.assertEqual(session_ids, sorted(session_ids))
            self.assertTrue(
                all(session_id.startswith(f"{tenant}-") for session_id in session_ids),
                f"{tenant} listed another tenant's session: {session_ids}",
            )


_OAUTH_AUDIENCE = "https://mcp.example.test/acme/mcp"


class _DocumentTransport:
    """Serves one fake upstream's discovery and JWKS documents.

    This is the network boundary only: the adapter, its caches, the validator
    and its signature check are the production ones.
    """

    def __init__(self, upstream: FakeUpstreamProvider) -> None:
        self._upstream = upstream
        self.fetches: list[str] = []
        self._lock = threading.Lock()

    def __call__(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, dict[str, str], bytes]:
        del method, headers, body
        with self._lock:
            self.fetches.append(url)
        if url == self._upstream.discovery_document()["issuer"] + "/.well-known/oauth-authorization-server":
            document = self._upstream.discovery_document()
        elif url == self._upstream.jwks_uri:
            document = self._upstream.jwks_document()
        else:
            return 404, {"content-type": "text/plain"}, b"not found"
        return 200, {"content-type": "application/json"}, json.dumps(document).encode()

    def count(self, suffix: str) -> int:
        with self._lock:
            return sum(1 for url in self.fetches if url.endswith(suffix))


class _StagedKeyPublication:
    """Serves one key set without the requested kid, then one with it.

    The first response is held for ``hold_seconds`` so every peer reaches the
    validator while that fetch is still open — the publication lag the shared
    fixture already lets a single request survive, arrived at by a burst.
    """

    def __init__(self, jwks_uri: str, first: dict[str, Any], later: dict[str, Any], hold_seconds: float) -> None:
        self._jwks_uri = jwks_uri
        self._first = first
        self._later = later
        self._hold = hold_seconds
        self._lock = threading.Lock()
        self.fetches = 0
        self.started = threading.Event()

    def __call__(self, url: str) -> tuple[int, dict[str, str], bytes]:
        if url != self._jwks_uri:
            return 404, {"content-type": "text/plain"}, b"not found"
        with self._lock:
            self.fetches += 1
            attempt = self.fetches
        if attempt == 1:
            self.started.set()
            time.sleep(self._hold)
            document = self._first
        else:
            document = self._later
        return 200, {"content-type": "application/json"}, json.dumps(document).encode()


class TestBearerValidationStaysAuthorized(unittest.TestCase):
    """SAN-3738-03: the repaired bearer path is pinned by its positive outcome.

    The failure-first rows prove the shared JWKS cache no longer corrupts under
    overlap, but an unknown key only shows that a request fails closed. These
    rows run the production adapter and validator on *valid* tokens at the same
    time: every request must stay authorized, the validator must be reused
    instead of rebuilt per caller, and two upstream keys must stay separated.
    """

    def _provider(self, upstream: FakeUpstreamProvider) -> tuple[AutheoryProvider, _DocumentTransport]:
        transport = _DocumentTransport(upstream)
        provider = new_autheory_provider(
            AutheoryProviderOptions(
                issuer=upstream.discovery_issuer,
                http_get=transport,
                allow_private_hosts=True,
            )
        )
        return provider, transport

    def test_valid_tokens_stay_authorized_under_overlap(self) -> None:
        upstream = FakeUpstreamProvider(issuer="https://auth-a.example.test", key_bits=512)
        provider, transport = self._provider(upstream)
        token = upstream.mint_access_token(audience=_OAUTH_AUDIENCE, subject="user-1", scope="namespace:use")
        expected = TokenExpectations(
            expected_issuer=upstream.discovery_issuer,
            expected_audience=_OAUTH_AUDIENCE,
            required_scopes=["namespace:use"],
        )

        with _RaceProne():
            claims = _run_concurrently(lambda _index: provider.validate_access_token(token, expected), 8)

        for result in claims:
            self.assertEqual(result.subject, "user-1")
            self.assertEqual(result.audience, _OAUTH_AUDIENCE)
            self.assertEqual(result.scopes, ["namespace:use"])
        self.assertEqual(transport.count("/.well-known/jwks.json"), 1, "a validator was rebuilt per caller")
        self.assertEqual(len(provider._validators), 1, "the adapter cached more than one validator")

        # The same adapter keeps serving after the overlap: reuse, not a one-off.
        again = provider.validate_access_token(token, expected)
        self.assertEqual(again.subject, "user-1")
        self.assertEqual(transport.count("/.well-known/jwks.json"), 1, "the cached validator refetched its key set")
        self.assertEqual(len(provider._validators), 1)

    def test_two_issuer_keys_stay_separated_under_overlap(self) -> None:
        upstream_a = FakeUpstreamProvider(issuer="https://auth-a.example.test", kid="kid-a", key_bits=512)
        upstream_b = FakeUpstreamProvider(
            issuer="https://auth-b.example.test",
            kid="kid-b",
            key=generate_rsa_key(512),
        )
        provider_a, transport_a = self._provider(upstream_a)
        provider_b, transport_b = self._provider(upstream_b)
        token_a = upstream_a.mint_access_token(audience=_OAUTH_AUDIENCE, subject="user-a", scope="namespace:use")
        token_b = upstream_b.mint_access_token(audience=_OAUTH_AUDIENCE, subject="user-b", scope="namespace:use")
        expected_a = TokenExpectations(
            expected_issuer=upstream_a.discovery_issuer,
            expected_audience=_OAUTH_AUDIENCE,
            required_scopes=["namespace:use"],
        )
        expected_b = TokenExpectations(
            expected_issuer=upstream_b.discovery_issuer,
            expected_audience=_OAUTH_AUDIENCE,
            required_scopes=["namespace:use"],
        )

        def worker(index: int) -> Any:
            for turn in range(12):
                if (index + turn) % 2 == 0:
                    result = provider_a.validate_access_token(token_a, expected_a)
                    if result.subject != "user-a":
                        raise AssertionError(f"issuer A authorized {result.subject!r}")
                else:
                    result = provider_b.validate_access_token(token_b, expected_b)
                    if result.subject != "user-b":
                        raise AssertionError(f"issuer B authorized {result.subject!r}")
            return None

        with _RaceProne():
            _run_concurrently(worker, 8)

        self.assertEqual(transport_a.count("/.well-known/jwks.json"), 1, "issuer A fetched its key set per caller")
        self.assertEqual(transport_b.count("/.well-known/jwks.json"), 1, "issuer B fetched its key set per caller")
        self.assertEqual(len(provider_a._validators), 1)
        self.assertEqual(len(provider_b._validators), 1)

        # Each issuer's key only verifies its own token: the caches did not mix.
        for provider, expected, token, other in (
            (provider_a, expected_a, token_b, "issuer B"),
            (provider_b, expected_b, token_a, "issuer A"),
        ):
            with self.assertRaises(ProviderError):
                provider.validate_access_token(token, expected)
            self.assertEqual(len(provider._validators), 1, f"{other}'s foreign token created a validator")

    def test_key_publication_retry_serves_every_overlapping_caller(self) -> None:
        """SAN-3738-04 parity: the permitted retry reaches every overlapping caller.

        The shared fixture already promises that one request is authorized when
        its signing key is published after the first key-set fetch. Run that
        same lag against a burst, because a Web Function never sees it alone.
        """
        issuer = "https://key-publication.example.test"
        published = FakeUpstreamProvider(issuer=issuer, kid="kid-published", key_bits=512)
        late = FakeUpstreamProvider(issuer=issuer, kid="kid-late", key=generate_rsa_key(512))
        transport = _StagedKeyPublication(
            late.jwks_uri,
            published.jwks_document(),
            late.jwks_document(),
            hold_seconds=0.2,
        )
        validator = new_jwks_validator(
            JWKSValidatorOptions(
                issuer=issuer,
                jwks_uri=late.jwks_uri,
                http_get=transport,
                allow_private_hosts=True,
                required_audience=_OAUTH_AUDIENCE,
                required_scopes=["namespace:use"],
                max_unknown_kid_fetches=4,
            )
        )
        ctx = Context(request=_request("/"))
        concurrency = 8
        tokens = [
            late.mint_access_token(audience=_OAUTH_AUDIENCE, subject=f"user-{index}", scope="namespace:use")
            for index in range(concurrency)
        ]

        with _RaceProne():
            claims = _run_concurrently(lambda index: validator(ctx, tokens[index]), concurrency)

        for index, claim in enumerate(claims):
            self.assertEqual(claim.subject, f"user-{index}", "an overlapping caller was refused a valid token")
        self.assertEqual(transport.fetches, 2, "the overlapping burst outspent the single request's retry")

        # The refusal controls are unchanged: an unpublished kid is refused
        # inside its per-kid bound, and an exhausted budget spends no fetch.
        stranger = FakeUpstreamProvider(
            issuer=issuer, kid="never-published", key=generate_rsa_key(512)
        ).mint_access_token(audience=_OAUTH_AUDIENCE, subject="stranger", scope="namespace:use")
        with self.assertRaises(OAuthBearerError):
            validator(ctx, stranger)
        after_stranger = transport.fetches
        self.assertLessEqual(after_stranger - 2, 2, "an unknown kid outspent its per-kid bound")
        with self.assertRaises(OAuthBearerError):
            validator(ctx, stranger)
        self.assertEqual(transport.fetches, after_stranger, "a repeat unknown kid inside the cooldown fetched again")
        other = FakeUpstreamProvider(
            issuer=issuer, kid="never-published-either", key=generate_rsa_key(512)
        ).mint_access_token(audience=_OAUTH_AUDIENCE, subject="other", scope="namespace:use")
        with self.assertRaises(OAuthBearerError):
            validator(ctx, other)
        self.assertEqual(transport.fetches, after_stranger, "an exhausted fetch budget still fetched")


    def test_mixed_key_window_serves_every_caller_it_admits(self) -> None:
        """SAN-3738-04 mixed-key parity: the window's outcome is its peers' outcome.

        The first key-set document carries only the already-published key, so a
        request for the late key opens its resolution window behind a fetch that
        cannot serve it and spends the retry the contract permits on the second
        document. Whichever request reaches the validator first, every caller it
        admits must reach the same outcome: authorized, on exactly two fetches.
        """
        issuer = "https://mixed-key-publication.example.test"
        published = FakeUpstreamProvider(
            issuer=issuer, kid="kid-already-published", key_bits=512
        )
        late = FakeUpstreamProvider(issuer=issuer, kid="kid-newly-published", key=generate_rsa_key(512))
        transport = _StagedKeyPublication(
            late.jwks_uri,
            published.jwks_document(),
            late.jwks_document(),
            hold_seconds=0.2,
        )
        validator = new_jwks_validator(
            JWKSValidatorOptions(
                issuer=issuer,
                jwks_uri=late.jwks_uri,
                http_get=transport,
                allow_private_hosts=True,
                required_audience=_OAUTH_AUDIENCE,
                required_scopes=["namespace:use"],
                max_unknown_kid_fetches=4,
            )
        )
        ctx = Context(request=_request("/"))
        expected = ["existing", *[f"fresh-{index}" for index in range(8)]]
        tokens = [
            published.mint_access_token(
                audience=_OAUTH_AUDIENCE, subject=expected[0], scope="namespace:use"
            ),
            *[
                late.mint_access_token(
                    audience=_OAUTH_AUDIENCE, subject=subject, scope="namespace:use"
                )
                for subject in expected[1:]
            ],
        ]

        with _RaceProne():
            claims = _run_concurrently(lambda index: validator(ctx, tokens[index]), len(tokens))

        for index, claim in enumerate(claims):
            self.assertEqual(
                claim.subject,
                expected[index],
                f"mixed-key caller {index} was refused or misattributed",
            )
        self.assertEqual(
            transport.fetches, 2, "the mixed-key burst outspent the single request's retry"
        )

        # A caller arriving after the windows settled is served from the cache.
        arrived_later = validator(
            ctx,
            late.mint_access_token(
                audience=_OAUTH_AUDIENCE, subject="arrived-later", scope="namespace:use"
            ),
        )
        self.assertEqual(arrived_later.subject, "arrived-later")
        self.assertEqual(transport.fetches, 2, "a cached key fetched again")


class TestMcpToolInvocationStaysPerCall(unittest.TestCase):
    """SAN-3738-05: the MCP tool invocation contexts are pinned as per-call.

    ``McpToolContext`` and ``McpCallerAuth`` carry real per-call data — the
    session, the request id, and the caller's identity, tenant and scopes — and
    the ordinary, streaming and task routes each build their own. This row parks
    every route inside the tool at the same moment with distinct authenticated
    callers, so a value that lived on the server rather than on the call would
    surface as another caller's identity.
    """

    @staticmethod
    def _mcp_headers(session_id: str = "") -> dict[str, Any]:
        headers: dict[str, Any] = {
            "content-type": ["application/json"],
            "accept": ["application/json, text/event-stream"],
        }
        if session_id:
            headers[MCP_HEADER_SESSION_ID] = [session_id]
            headers[MCP_HEADER_PROTOCOL_VERSION] = [MCP_PROTOCOL_VERSION]
        return headers

    def _serve(
        self,
        handler: Any,
        caller: dict[str, Any],
        body: dict[str, Any],
        *,
        session_id: str = "",
    ) -> Response:
        ctx = Context(
            request=Request(
                method="POST",
                path="/mcp",
                headers=self._mcp_headers(session_id),
                body=json.dumps(body).encode("utf-8"),
                is_base64=False,
            ),
            auth_identity=caller["identity"],
            tenant_id=caller["tenant_id"],
            tenant_bound=True,
        )
        # The scopes reach the tool through the verified principal, exactly as
        # they do for an authenticated request.
        ctx._secure_principal = SecurePrincipal(identity=caller["identity"], scopes=list(caller["scopes"]))
        return handler(ctx)

    def test_overlapping_tool_calls_keep_their_own_invocation_context(self) -> None:
        server = create_mcp_server(
            "Concurrent tool MCP",
            "1",
            {"task_runtime": {"store": MemoryMcpTaskStore()}},
        )
        registry = server.registry()
        routes = ["ordinary", "ordinary", "streaming", "streaming", "task", "task"]
        inside = threading.Barrier(len(routes))

        def echo(context: Any) -> dict[str, Any]:
            payload = {
                "session_id": context.session_id,
                "request_id": context.request_id,
                "auth": None
                if context.auth is None
                else {
                    "auth_identity": context.auth.auth_identity,
                    "tenant_id": context.auth.tenant_id,
                    "scopes": list(context.auth.scopes),
                },
            }
            return {"content": [{"type": "text", "text": json.dumps(payload)}]}

        def parked(_args: Any, context: Any) -> dict[str, Any]:
            inside.wait(timeout=10)
            return echo(context)

        registry.register_tool({"name": "who", "inputSchema": {}}, parked)
        registry.register_streaming_tool(
            {"name": "stream-who", "inputSchema": {}},
            lambda _args, _emit, context: parked(_args, context),
        )
        registry.register_tool(
            {"name": "task-who", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            parked,
        )
        handler = server.handler()
        callers = [
            {
                "route": route,
                "index": index,
                "identity": f"user-{index}",
                "tenant_id": f"tenant-{index}",
                "scopes": [f"scope-{index}"],
                "tool": {"ordinary": "who", "streaming": "stream-who", "task": "task-who"}[route],
            }
            for index, route in enumerate(routes)
        ]
        for caller in callers:
            initialized = self._serve(
                handler,
                caller,
                {"jsonrpc": "2.0", "id": f"init-{caller['index']}", "method": "initialize"},
            )
            self.assertEqual(initialized.status, 200)
            caller["session_id"] = initialized.headers[MCP_HEADER_SESSION_ID][0]
        self.assertEqual(len({caller["session_id"] for caller in callers}), len(callers))

        answered: list[tuple[dict[str, Any], str, Response]] = []

        def call(caller: dict[str, Any]) -> None:
            request_id = f"req-{caller['index']}"
            params: dict[str, Any] = {"name": caller["tool"]}
            if caller["route"] == "task":
                params["task"] = {}
            answered.append(
                (
                    caller,
                    request_id,
                    self._serve(
                        handler,
                        caller,
                        {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": params},
                        session_id=caller["session_id"],
                    ),
                )
            )

        threads = [threading.Thread(target=call, args=(caller,)) for caller in callers]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(len(answered), len(callers))

        for caller, request_id, response in answered:
            self.assertEqual(response.status, 200)
            body: dict[str, Any] = {}
            if caller["route"] != "streaming":
                body = json.loads(response.body.decode("utf-8"))
            else:
                frames = [
                    line[len("data: ") :]
                    for line in response.body.decode("utf-8").splitlines()
                    if line.startswith("data: ")
                ]
                body = json.loads([frame for frame in frames if frame.strip()][-1])
            result = body["result"]
            own_request_id = request_id
            if caller["route"] == "task":
                own_request_id = result["task"]["taskId"]
                read_back = self._serve(
                    handler,
                    caller,
                    {
                        "jsonrpc": "2.0",
                        "id": f"result-{caller['index']}",
                        "method": "tasks/result",
                        "params": {"taskId": own_request_id},
                    },
                    session_id=caller["session_id"],
                )
                self.assertEqual(read_back.status, 200)
                result = json.loads(read_back.body.decode("utf-8"))["result"]
            else:
                self.assertEqual(body["id"], request_id, "the response answered a different request")
            echoed = json.loads(result["content"][0]["text"])
            self.assertEqual(echoed["session_id"], caller["session_id"], "a call saw another session")
            self.assertIsNotNone(echoed["auth"], "a call lost its caller identity")
            self.assertEqual(echoed["auth"]["auth_identity"], caller["identity"], "another identity")
            self.assertEqual(echoed["auth"]["tenant_id"], caller["tenant_id"], "another tenant")
            self.assertEqual(echoed["auth"]["scopes"], caller["scopes"], "another caller's scopes")
            self.assertEqual(echoed["request_id"], own_request_id, "the call lost its own request id")


def _unsigned_token(*, kid: str, issuer: str, now: dt.datetime) -> str:
    """Builds a well-formed RS256 token with an unverifiable signature.

    The validator checks the issuer before it looks up a key and only verifies
    the signature afterwards, so a token whose ``kid`` is unknown exercises the
    shared cache and then fails closed without any key material.
    """

    def encode(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    header = encode({"alg": "RS256", "kid": kid})
    claims = encode({"iss": issuer, "exp": int((now + dt.timedelta(hours=1)).timestamp()), "sub": "subject-1"})
    return f"{header}.{claims}.{encode({'signature': 'unverifiable'})}"


if __name__ == "__main__":
    unittest.main()
