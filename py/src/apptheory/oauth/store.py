"""Store SPI for the MCP auth facade (DESIGN section 7).

Five stores, each with a reference in-memory implementation for tests and local
development. Consume-once and compare-and-swap are *required* operations, not
conventions: replay handling and single-flight refresh depend on them. Durable
implementations are application-owned; nothing upstream is ever persisted
unencrypted.

The methods are synchronous. A durable implementation is free to keep them
synchronous while performing I/O, and the facade's async surfaces await the
result of the call.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

UTC_NOW_TTL_TRANSACTION_SECONDS = 600
UTC_NOW_TTL_AUTHORIZATION_CODE_SECONDS = 60
UTC_NOW_TTL_ROUTE_REFRESH_BROKER_SECONDS = 900
UTC_NOW_TTL_RATE_LIMIT_WINDOW_SECONDS = 60
UTC_NOW_LOCK_TTL_SECONDS = 30

STATUS_ISSUED = "issued"
STATUS_ACTIVE = "active"
STATUS_REFRESHING = "refreshing"
STATUS_REAUTH_REQUIRED = "reauth_required"
STATUS_CONSUMED = "consumed"
STATUS_EXPIRED = "expired"
STATUS_REVOKED = "revoked"


class StoreError(Exception):
    """Base class for reference-store failures."""


class ClientVersionConflictError(StoreError):
    """The client record's compare-and-swap expected version was stale."""


class BrokerVersionConflictError(StoreError):
    """The broker record's compare-and-swap expected version was stale."""


class BrokerLockedError(StoreError):
    """The broker record already holds an unexpired refresh lock."""


class BrokerRevokedError(StoreError):
    """The broker record is revoked; it cannot be refreshed or locked."""


@dataclass(slots=True)
class TransactionRecord:
    """One in-flight front-channel authorize transaction (single-use)."""

    state_hash: str = ""
    client_id_hash: str = ""
    client_id: str = ""
    redirect_uri: str = ""
    code_challenge: str = ""
    code_challenge_method: str = ""
    client_state: str = ""
    encrypted_upstream_code_verifier: str = ""
    scopes: list[str] = field(default_factory=list)
    canonical_resource: str = ""
    endpoint_kind: str = ""
    client_namespace: str = ""
    partner_id: str = ""
    agent_id: str = ""
    status: str = STATUS_ISSUED
    expires_at: datetime | None = None
    version: int = 0


@dataclass(slots=True)
class AuthorizationCodeRecord:
    """A minted facade code. Retained after consume so replay is distinguishable."""

    code_hash: str = ""
    client_id_hash: str = ""
    client_id: str = ""
    redirect_uri: str = ""
    code_challenge: str = ""
    code_challenge_method: str = ""
    scopes: list[str] = field(default_factory=list)
    canonical_resource: str = ""
    endpoint_kind: str = ""
    client_namespace: str = ""
    partner_id: str = ""
    agent_id: str = ""
    route_refresh_handle_hash: str = ""
    encrypted_route_refresh_handle: str = ""
    encrypted_token_response: str = ""
    status: str = STATUS_ISSUED
    expires_at: datetime | None = None
    version: int = 0


@dataclass(slots=True)
class ClientRecord:
    """A registered client (DCR or adopted). Age-out policy, not TTL."""

    client_id_hash: str = ""
    client_id: str = ""
    redirect_uris: list[str] = field(default_factory=list)
    token_endpoint_auth_method: str = ""
    grant_types: list[str] = field(default_factory=list)
    response_types: list[str] = field(default_factory=list)
    bound_route: str = ""
    created_at: datetime | None = None
    version: int = 0


@dataclass(slots=True)
class RouteRefreshBrokerRecord:
    """The brokered refresh record; holds the encrypted upstream refresh token."""

    handle_hash: str = ""
    issuer: str = ""
    stage: str = ""
    canonical_resource: str = ""
    client_namespace: str = ""
    endpoint_kind: str = ""
    partner_id: str = ""
    agent_id: str = ""
    client_id_hash: str = ""
    subject_id_hash: str = ""
    scopes: list[str] = field(default_factory=list)
    scope_fingerprint: str = ""
    encrypted_upstream_refresh_token: str = ""
    upstream_refresh_token_hash: str = ""
    upstream_client_id: str = ""
    encrypted_grace_refresh_response: str = ""
    grace_expires_at: datetime | None = None
    status: str = STATUS_ACTIVE
    refresh_lock_owner: str = ""
    refresh_lock_expires_at: datetime | None = None
    version: int = 0


@dataclass(slots=True)
class RateLimitBucketKey:
    """A rate-limit bucket identity plus its per-window budget.

    ``identifier``, ``resource``, and ``operation`` name the bucket;
    ``limit`` and ``window_seconds`` are the caller's budget for that bucket,
    so one store serves buckets with different budgets.
    """

    identifier: str = ""
    resource: str = ""
    operation: str = ""
    limit: int = 0
    window_seconds: float = 0.0


@dataclass(slots=True)
class RateLimitResult:
    """The observable outcome of one atomic check-and-increment."""

    allowed: bool = False
    limit: int = 0
    count: int = 0
    remaining: int = 0
    retry_after_seconds: int = 0


@dataclass(slots=True)
class ConsumeResult:
    """A consumed code record plus whether it was already consumed."""

    record: AuthorizationCodeRecord = field(default_factory=AuthorizationCodeRecord)
    replayed: bool = False


class TransactionStore(Protocol):
    def put(self, record: TransactionRecord) -> None: ...

    def consume(self, state_hash: str) -> TransactionRecord | None: ...


class AuthorizationCodeStore(Protocol):
    def put(self, record: AuthorizationCodeRecord) -> None: ...

    def consume(self, code_hash: str) -> ConsumeResult | None: ...


class ClientStore(Protocol):
    def put(self, record: ClientRecord) -> ClientRecord: ...

    def get(self, client_id_hash: str) -> ClientRecord | None: ...

    def update(self, record: ClientRecord, expected_version: int) -> ClientRecord: ...


class RouteRefreshBrokerStore(Protocol):
    def get(self, handle_hash: str) -> RouteRefreshBrokerRecord | None: ...

    def acquire_lock(self, handle_hash: str, lock_owner: str, expected_version: int) -> RouteRefreshBrokerRecord: ...

    def compare_and_swap(self, record: RouteRefreshBrokerRecord, expected_version: int) -> RouteRefreshBrokerRecord: ...

    def revoke(self, handle_hash: str) -> RouteRefreshBrokerRecord | None: ...


class RouteRefreshBrokerSeeder(Protocol):
    """The optional create path a broker store needs to place a starting record.

    The broker SPI itself is Get/AcquireLock/CompareAndSwap/Revoke; the record is
    created by the facade's own write path, and a durable store implements this
    with whatever create path it already has.
    """

    def put(self, record: RouteRefreshBrokerRecord) -> None: ...


class RateLimitStore(Protocol):
    def check_and_increment(self, key: RateLimitBucketKey) -> RateLimitResult: ...


def _utc_now() -> datetime:
    return datetime.now(UTC)


class MemoryTransactionStore:
    """Single-use, TTL-bounded transaction store."""

    def __init__(
        self,
        now: Any = None,
        ttl: int | None = UTC_NOW_TTL_TRANSACTION_SECONDS,
    ) -> None:
        self._now = now or _utc_now
        self._ttl = ttl
        self._records: dict[str, TransactionRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: TransactionRecord) -> None:
        stored = replace(record)
        stored.status = STATUS_ISSUED
        stored.version = 1
        if stored.expires_at is None and self._ttl is not None:
            stored.expires_at = self._now() + timedelta(seconds=self._ttl)
        with self._lock:
            self._records[stored.state_hash] = stored

    def consume(self, state_hash: str) -> TransactionRecord | None:
        with self._lock:
            stored = self._records.pop(state_hash, None)
        if stored is None:
            return None
        if _is_expired(stored.expires_at, self._now()):
            return replace(stored, status=STATUS_EXPIRED)
        return replace(stored, status=STATUS_CONSUMED)


class MemoryAuthorizationCodeStore:
    """Single-use code store that retains the record so replay is distinguishable."""

    def __init__(
        self,
        now: Any = None,
        ttl: int | None = UTC_NOW_TTL_AUTHORIZATION_CODE_SECONDS,
    ) -> None:
        self._now = now or _utc_now
        self._ttl = ttl
        self._records: dict[str, AuthorizationCodeRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: AuthorizationCodeRecord) -> None:
        stored = replace(record)
        stored.status = STATUS_ISSUED
        stored.version = 1
        if stored.expires_at is None and self._ttl is not None:
            stored.expires_at = self._now() + timedelta(seconds=self._ttl)
        with self._lock:
            self._records[stored.code_hash] = stored

    def consume(self, code_hash: str) -> ConsumeResult | None:
        with self._lock:
            stored = self._records.get(code_hash)
            if stored is None:
                return None
            replayed = stored.status == STATUS_CONSUMED
            if not replayed:
                stored.status = STATUS_CONSUMED
                stored.version += 1
            snapshot = replace(stored)
        if _is_expired(snapshot.expires_at, self._now()):
            return ConsumeResult(record=replace(snapshot, status=STATUS_EXPIRED), replayed=replayed)
        return ConsumeResult(record=snapshot, replayed=replayed)


class MemoryClientStore:
    """Versioned client store; ``update`` is compare-and-swap on version."""

    def __init__(self, now: Any = None, ttl: int | None = None) -> None:
        self._now = now or _utc_now
        self._records: dict[str, ClientRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: ClientRecord) -> ClientRecord:
        stored = replace(record)
        stored.version = 1
        if stored.created_at is None:
            stored.created_at = self._now()
        with self._lock:
            self._records[stored.client_id_hash] = stored
        return replace(stored)

    def get(self, client_id_hash: str) -> ClientRecord | None:
        with self._lock:
            stored = self._records.get(client_id_hash)
        return replace(stored) if stored is not None else None

    def update(self, record: ClientRecord, expected_version: int) -> ClientRecord:
        with self._lock:
            stored = self._records.get(record.client_id_hash)
            current_version = stored.version if stored is not None else 0
            if current_version != expected_version:
                raise ClientVersionConflictError(f"client version conflict for {record.client_id_hash!r}")
            updated = replace(record)
            updated.version = current_version + 1
            if updated.created_at is None:
                updated.created_at = stored.created_at if stored is not None else self._now()
            self._records[updated.client_id_hash] = updated
        return replace(updated)


class MemoryRouteRefreshBrokerStore:
    """Exclusive, expiring refresh lock plus a versioned compare-and-swap."""

    def __init__(
        self,
        now: Any = None,
        ttl: int | None = UTC_NOW_TTL_ROUTE_REFRESH_BROKER_SECONDS,
        lock_ttl_seconds: int = UTC_NOW_LOCK_TTL_SECONDS,
    ) -> None:
        self._now = now or _utc_now
        self._ttl = ttl
        self._lock_ttl_seconds = lock_ttl_seconds
        self._records: dict[str, RouteRefreshBrokerRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: RouteRefreshBrokerRecord) -> None:
        stored = replace(record)
        stored.status = stored.status or STATUS_ACTIVE
        stored.version = 1
        with self._lock:
            self._records[stored.handle_hash] = stored

    def get(self, handle_hash: str) -> RouteRefreshBrokerRecord | None:
        with self._lock:
            stored = self._records.get(handle_hash)
        return replace(stored) if stored is not None else None

    def acquire_lock(self, handle_hash: str, lock_owner: str, expected_version: int) -> RouteRefreshBrokerRecord:
        with self._lock:
            stored = self._records.get(handle_hash)
            if stored is None:
                raise KeyError(handle_hash)
            if stored.status == STATUS_REVOKED:
                raise BrokerRevokedError(f"broker record {handle_hash!r} is revoked")
            # The lock check precedes the version check: concurrent callers all
            # present the version they observed, and all but the winner must be
            # told the record is locked rather than that their version is stale.
            if _lock_is_held(stored, self._now()):
                raise BrokerLockedError(f"broker record {handle_hash!r} is locked")
            if stored.version != expected_version:
                raise BrokerVersionConflictError(f"broker version conflict for {handle_hash!r}")
            stored.refresh_lock_owner = str(lock_owner or "")
            stored.refresh_lock_expires_at = self._now() + timedelta(seconds=self._lock_ttl_seconds)
            stored.version += 1
            return replace(stored)

    def compare_and_swap(self, record: RouteRefreshBrokerRecord, expected_version: int) -> RouteRefreshBrokerRecord:
        with self._lock:
            stored = self._records.get(record.handle_hash)
            if stored is None:
                raise KeyError(record.handle_hash)
            if stored.status == STATUS_REVOKED:
                raise BrokerRevokedError(f"broker record {record.handle_hash!r} is revoked")
            if stored.version != expected_version:
                raise BrokerVersionConflictError(f"broker version conflict for {record.handle_hash!r}")
            updated = replace(record)
            updated.version = expected_version + 1
            self._records[updated.handle_hash] = updated
            return replace(updated)

    def revoke(self, handle_hash: str) -> RouteRefreshBrokerRecord | None:
        with self._lock:
            stored = self._records.get(handle_hash)
            if stored is None:
                return None
            if stored.status != STATUS_REVOKED:
                stored.status = STATUS_REVOKED
                stored.version += 1
                stored.refresh_lock_owner = ""
                stored.refresh_lock_expires_at = None
            return replace(stored)


class MemoryRateLimitStore:
    """Fixed-window, atomic check-and-increment store.

    The per-window budget comes from the key: ``limit`` bounds the count and
    ``window_seconds`` bounds the window. ``ttl`` is the window applied to a key
    that carries none of its own.
    """

    def __init__(
        self,
        now: Any = None,
        ttl: int | None = UTC_NOW_TTL_RATE_LIMIT_WINDOW_SECONDS,
    ) -> None:
        self._now = now or _utc_now
        self._default_window_seconds = float(ttl) if ttl is not None else float(UTC_NOW_TTL_RATE_LIMIT_WINDOW_SECONDS)
        self._buckets: dict[tuple[str, str, str], tuple[datetime, int]] = {}
        self._lock = threading.Lock()

    def check_and_increment(self, key: RateLimitBucketKey) -> RateLimitResult:
        bucket_key = (key.identifier, key.resource, key.operation)
        limit = key.limit
        window_seconds = key.window_seconds if key.window_seconds > 0 else self._default_window_seconds
        now = self._now()
        with self._lock:
            started_at, count = self._buckets.get(bucket_key, (now, 0))
            if now - started_at >= timedelta(seconds=window_seconds):
                started_at, count = now, 0
            count += 1
            self._buckets[bucket_key] = (started_at, count)
        allowed = count <= limit
        remaining = max(0, limit - count)
        window_end = started_at + timedelta(seconds=window_seconds)
        retry_after = 0 if allowed else max(1, int((window_end - now).total_seconds()))
        return RateLimitResult(
            allowed=allowed,
            limit=limit,
            count=count,
            remaining=remaining,
            retry_after_seconds=retry_after,
        )


def _is_expired(expires_at: datetime | None, now: datetime) -> bool:
    return expires_at is not None and now >= expires_at


def _lock_is_held(record: RouteRefreshBrokerRecord, now: datetime) -> bool:
    return (
        bool(record.refresh_lock_owner)
        and record.refresh_lock_expires_at is not None
        and now < record.refresh_lock_expires_at
    )


def run_store_conformance(stores: dict[str, Any], cases: list[dict[str, Any]], clock: Any) -> int:
    """Runs the shared store-conformance fixture rows against the in-memory stores.

    ``stores`` maps a fixture ``store`` name to its reference class; the runner
    builds a fresh instance per row. ``clock`` is a ``ManualClock``: the runner
    pins it to its entry instant before every row and advances it where the row
    says so. Assertions raise ``AssertionError`` on any mismatch; the return
    value is the number of rows executed.
    """
    origin = clock.now()
    ran = 0
    for case in cases:
        clock.set(origin)
        handler = _STORE_SCENARIOS[(case["store"], case["scenario"])]
        handler(stores, case.get("params", {}), case["expect"], clock)
        ran += 1
    return ran


def _transaction_store(stores: dict[str, Any], clock: Any, ttl: int | None) -> Any:
    return stores["transaction"](now=clock.now, ttl=ttl)


def _authorization_code_store(stores: dict[str, Any], clock: Any, ttl: int | None) -> Any:
    return stores["authorization_code"](now=clock.now, ttl=ttl)


def _broker_store(stores: dict[str, Any], clock: Any, ttl: int | None, lock_ttl: int) -> Any:
    return stores["route_refresh_broker"](now=clock.now, ttl=ttl, lock_ttl_seconds=lock_ttl)


def _rate_limit_store(stores: dict[str, Any], clock: Any, window: int) -> Any:
    return stores["rate_limit"](now=clock.now, ttl=window)


def _ttl_param(params: dict[str, Any], key: str = "ttl_seconds") -> int | None:
    claimed = params.get(key)
    if claimed is None:
        return None
    return int(claimed)


def _assert_expected(expect: dict[str, Any], actual: dict[str, Any]) -> None:
    for key, wanted in expect.items():
        if actual.get(key) != wanted:
            raise AssertionError(f"expected {key}={wanted!r}, got {actual.get(key)!r}")


def _run_concurrently(worker: Any, concurrency: int) -> list[Any]:
    """Runs ``worker(index)`` on ``concurrency`` threads released together."""
    results: list[Any] = [None] * concurrency
    start = threading.Barrier(concurrency)

    def run(index: int) -> None:
        start.wait()
        results[index] = worker(index)

    threads = [threading.Thread(target=run, args=(index,)) for index in range(concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def _tally(values: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def _transaction_outcome(record: TransactionRecord | None) -> str:
    if record is None:
        return "not_found"
    if record.status == STATUS_EXPIRED:
        return "expired"
    return "ok"


def _authorization_code_outcome(result: ConsumeResult | None) -> str:
    if result is None:
        return "not_found"
    if result.record.status == STATUS_EXPIRED:
        return "expired"
    return "replayed" if result.replayed else "ok"


def _scenario_transaction_consume_single_use(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    actual = {
        "first": _transaction_outcome(store.consume("state-hash")),
        "second": _transaction_outcome(store.consume("state-hash")),
    }
    _assert_expected(expect, actual)


def _scenario_transaction_consume_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, None)
    _assert_expected(expect, {"consume": _transaction_outcome(store.consume("unknown-state-hash"))})


def _scenario_transaction_consume_after_ttl(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    _assert_expected(expect, {"consume": _transaction_outcome(store.consume("state-hash"))})


def _scenario_transaction_concurrent_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    concurrency = int(params["concurrency"])
    outcomes = _run_concurrently(lambda _index: _transaction_outcome(store.consume("state-hash")), concurrency)
    _assert_expected(expect, _tally(outcomes))


def _scenario_authorization_code_consume_single_use_then_replay(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    actual = {
        "first": _authorization_code_outcome(store.consume("code-hash")),
        "second": _authorization_code_outcome(store.consume("code-hash")),
    }
    _assert_expected(expect, actual)


def _scenario_authorization_code_consume_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, None)
    _assert_expected(expect, {"consume": _authorization_code_outcome(store.consume("unknown-code-hash"))})


def _scenario_authorization_code_consume_after_ttl(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    _assert_expected(expect, {"consume": _authorization_code_outcome(store.consume("code-hash"))})


def _scenario_authorization_code_concurrent_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    concurrency = int(params["concurrency"])
    outcomes = _run_concurrently(lambda _index: _authorization_code_outcome(store.consume("code-hash")), concurrency)
    _assert_expected(expect, _tally(outcomes))


def _scenario_client_put_get_update(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = stores["client"](now=clock.now)
    stored = store.put(ClientRecord(client_id_hash="client-hash", client_id="client"))
    fetched = store.get("client-hash")
    updated = store.update(stored, stored.version)
    actual = {
        "get_version": fetched.version if fetched is not None else 0,
        "update": "ok",
        "updated_version": updated.version,
    }
    _assert_expected(expect, actual)


def _scenario_client_update_stale_version(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = stores["client"](now=clock.now)
    stored = store.put(ClientRecord(client_id_hash="client-hash", client_id="client"))
    store.update(stored, stored.version)
    stale = stored.version
    outcome = "ok"
    try:
        store.update(stored, stale)
    except ClientVersionConflictError:
        outcome = "version_conflict"
    fetched = store.get("client-hash")
    actual = {"update": outcome, "get_version": fetched.version if fetched is not None else 0}
    _assert_expected(expect, actual)


def _scenario_client_get_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = stores["client"](now=clock.now)
    _assert_expected(expect, {"get": "not_found" if store.get("unknown") is None else "ok"})


def _scenario_broker_get_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    _assert_expected(expect, {"get": "not_found" if store.get("unknown") is None else "ok"})


def _acquire_lock_outcome(store: Any, handle_hash: str, owner: str, expected_version: int) -> str:
    try:
        store.acquire_lock(handle_hash, owner, expected_version)
    except BrokerLockedError:
        return "locked"
    except BrokerRevokedError:
        return "revoked"
    except BrokerVersionConflictError:
        return "version_conflict"
    except KeyError:
        return "not_found"
    return "ok"


def _scenario_broker_acquire_lock_exclusive_with_expiry(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, int(params.get("lock_ttl_seconds", UTC_NOW_LOCK_TTL_SECONDS)))
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    first = _acquire_lock_outcome(store, "handle-hash", "owner-1", 1)
    current = store.get("handle-hash")
    contended = _acquire_lock_outcome(store, "handle-hash", "owner-2", current.version if current is not None else 0)
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    after = store.get("handle-hash")
    after_expiry = _acquire_lock_outcome(store, "handle-hash", "owner-3", after.version if after is not None else 0)
    _assert_expected(expect, {"first": first, "contended": contended, "after_expiry": after_expiry})


def _scenario_broker_compare_and_swap_versioned(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    acquire = _acquire_lock_outcome(store, "handle-hash", "owner-1", 1)
    record = store.get("handle-hash")
    if record is None:
        raise AssertionError("broker record must exist after put")
    swapped = store.compare_and_swap(replace(record, scopes=["mcp:tools"]), record.version)
    stale_outcome = "ok"
    try:
        store.compare_and_swap(replace(record, scopes=["mcp:other"]), record.version)
    except BrokerVersionConflictError:
        stale_outcome = "version_conflict"
    swapped_ok = "ok" if swapped.version == record.version + 1 else "unexpected_version"
    actual = {"acquire_lock": acquire, "swap": swapped_ok, "stale_swap": stale_outcome}
    _assert_expected(expect, actual)


def _scenario_broker_revoke_idempotent(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    first = store.revoke("handle-hash")
    second = store.revoke("handle-hash")
    fetched = store.get("handle-hash")
    actual = {
        "revoke": "ok" if first is not None else "not_found",
        "revoke_again": "ok" if second is not None else "not_found",
        "status": fetched.status if fetched is not None else "not_found",
    }
    _assert_expected(expect, actual)


def _scenario_broker_revoke_then_lock(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    revoked = store.revoke("handle-hash")
    locked = _acquire_lock_outcome(store, "handle-hash", "owner-1", 1)
    _assert_expected(expect, {"revoke": "ok" if revoked is not None else "not_found", "acquire_lock": locked})


def _scenario_broker_concurrent_acquire_lock(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, int(params.get("lock_ttl_seconds", UTC_NOW_LOCK_TTL_SECONDS)))
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    concurrency = int(params["concurrency"])
    outcomes = _run_concurrently(
        lambda index: _acquire_lock_outcome(store, "handle-hash", f"owner-{index}", 1), concurrency
    )
    _assert_expected(expect, _tally(outcomes))


def _scenario_broker_concurrent_revoke(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    concurrency = int(params["concurrency"])
    outcomes = _run_concurrently(
        lambda _index: "ok" if store.revoke("handle-hash") is not None else "not_found", concurrency
    )
    _assert_expected(expect, _tally(outcomes))


def _scenario_rate_limit_check_and_increment(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _rate_limit_store(stores, clock, int(params["window_seconds"]))
    key = _rate_limit_key(params)
    outcomes = [
        "allowed" if store.check_and_increment(key).allowed else "limited" for _ in range(int(params["checks"]))
    ]
    _assert_expected(expect, {"outcomes": outcomes})


def _scenario_rate_limit_window_reset(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _rate_limit_store(stores, clock, int(params["window_seconds"]))
    key = _rate_limit_key(params)
    first = "allowed" if store.check_and_increment(key).allowed else "limited"
    second = "allowed" if store.check_and_increment(key).allowed else "limited"
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    after = "allowed" if store.check_and_increment(key).allowed else "limited"
    _assert_expected(expect, {"first": first, "second": second, "after_window": after})


def _rate_limit_key(params: dict[str, Any]) -> RateLimitBucketKey:
    """Builds the bucket key a rate-limit row checks, budget included."""
    return RateLimitBucketKey(
        identifier="client-1",
        resource="https://mcp.example.test/mcp",
        operation="register",
        limit=int(params["limit"]),
        window_seconds=float(params["window_seconds"]),
    )


_STORE_SCENARIOS: dict[tuple[str, str], Any] = {
    ("transaction", "consume_single_use"): _scenario_transaction_consume_single_use,
    ("transaction", "consume_unknown"): _scenario_transaction_consume_unknown,
    ("transaction", "consume_after_ttl"): _scenario_transaction_consume_after_ttl,
    ("transaction", "concurrent_consume"): _scenario_transaction_concurrent_consume,
    ("authorization_code", "consume_single_use_then_replay"): (
        _scenario_authorization_code_consume_single_use_then_replay
    ),
    ("authorization_code", "consume_unknown"): _scenario_authorization_code_consume_unknown,
    ("authorization_code", "consume_after_ttl"): _scenario_authorization_code_consume_after_ttl,
    ("authorization_code", "concurrent_consume"): _scenario_authorization_code_concurrent_consume,
    ("client", "put_get_update"): _scenario_client_put_get_update,
    ("client", "update_stale_version"): _scenario_client_update_stale_version,
    ("client", "get_unknown"): _scenario_client_get_unknown,
    ("route_refresh_broker", "get_unknown"): _scenario_broker_get_unknown,
    ("route_refresh_broker", "acquire_lock_exclusive_with_expiry"): _scenario_broker_acquire_lock_exclusive_with_expiry,
    ("route_refresh_broker", "compare_and_swap_versioned"): _scenario_broker_compare_and_swap_versioned,
    ("route_refresh_broker", "revoke_idempotent"): _scenario_broker_revoke_idempotent,
    ("route_refresh_broker", "revoke_then_lock"): _scenario_broker_revoke_then_lock,
    ("route_refresh_broker", "concurrent_acquire_lock"): _scenario_broker_concurrent_acquire_lock,
    ("route_refresh_broker", "concurrent_revoke"): _scenario_broker_concurrent_revoke,
    ("rate_limit", "check_and_increment"): _scenario_rate_limit_check_and_increment,
    ("rate_limit", "window_reset"): _scenario_rate_limit_window_reset,
}


__all__ = [
    "AuthorizationCodeRecord",
    "AuthorizationCodeStore",
    "BrokerLockedError",
    "BrokerRevokedError",
    "BrokerVersionConflictError",
    "ClientRecord",
    "ClientStore",
    "ClientVersionConflictError",
    "ConsumeResult",
    "MemoryAuthorizationCodeStore",
    "MemoryClientStore",
    "MemoryRateLimitStore",
    "MemoryRouteRefreshBrokerStore",
    "MemoryTransactionStore",
    "RateLimitBucketKey",
    "RateLimitResult",
    "RateLimitStore",
    "RouteRefreshBrokerRecord",
    "RouteRefreshBrokerSeeder",
    "RouteRefreshBrokerStore",
    "StoreError",
    "TransactionRecord",
    "TransactionStore",
    "run_store_conformance",
]
