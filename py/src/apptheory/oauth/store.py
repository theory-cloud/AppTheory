"""Store SPI for the MCP auth facade (DESIGN section 7).

Five stores, each with a reference in-memory implementation for tests and local
development. Consume-once and compare-and-swap are *required* operations, not
conventions: replay handling and single-flight refresh depend on them. Durable
implementations are application-owned.

An ``Encrypted*`` record field carries upstream material exactly as the provider
handed it to the facade: the framework performs no sealing and adds no
encryption surface or key management, so a durable store implementation MUST
encrypt those fields at rest (for example with a persistence-layer encryption
tag). The in-memory reference stores here are NON-DURABLE and do not encrypt:
they are for deterministic tests and local development only.

The methods are synchronous. A durable implementation is free to keep them
synchronous while performing I/O, and the facade's async surfaces await the
result of the call.
"""

from __future__ import annotations

import base64
import hashlib
import threading
from dataclasses import dataclass, field, fields, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, cast

UTC_NOW_TTL_TRANSACTION_SECONDS = 600
UTC_NOW_TTL_AUTHORIZATION_CODE_SECONDS = 60
UTC_NOW_TTL_ROUTE_REFRESH_BROKER_SECONDS = 900
UTC_NOW_TTL_RATE_LIMIT_WINDOW_SECONDS = 60
# The broker's refresh lock has to outlast the single upstream refresh call it
# protects while staying as short as possible when that call dies: the M2.1
# hardened upstream HTTP deadline is 10 seconds (``oauth``'s default, shared by
# the discovery, token, and JWKS fetches), so 15 seconds is that deadline plus a
# five-second margin. It is also well above the facade's three-second coalesce
# wait cap, so a waiter for an in-flight rotation can never outlive the lock it
# is waiting on and steal it.
UTC_NOW_LOCK_TTL_SECONDS = 15

STATUS_ISSUED = "issued"
STATUS_ACTIVE = "active"
STATUS_REFRESHING = "refreshing"
STATUS_REAUTH_REQUIRED = "reauth_required"
STATUS_CONSUMED = "consumed"
STATUS_EXPIRED = "expired"
STATUS_REVOKED = "revoked"

BROKER_FAMILY_STATUS_ACTIVE = "active"
BROKER_FAMILY_STATUS_REVOKED = "revoked"


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


class BrokerExpiredError(StoreError):
    """The broker record existed but its local lifetime policy elapsed.

    It is deliberately distinguishable from an unknown handle at the SPI so the
    facade can attribute the failure (expiry versus absence) while the
    client-facing body stays the uniform ``invalid_grant``.
    """


class BrokerFamilyCapabilityMissingError(StoreError):
    """The broker store lacks the transactional family capability."""


class BrokerFamilyExistsError(StoreError):
    """``create_family`` was called for a family ID that already exists."""


class BrokerFamilyStateUnavailableError(StoreError):
    """A family-marked record's required family state is missing or corrupt."""


class BrokerFamilyMismatchError(StoreError):
    """A root, successor, or presented record fails its family/generation binding."""


class BrokerSuccessorExistsError(StoreError):
    """A rotation successor handle is already stored."""


class BrokerLegacyLineageUnsupportedError(StoreError):
    """A family-less record was presented for ordinary rotation."""


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
    """The brokered refresh record; holds the encrypted upstream refresh token.

    ``chain_generation`` and ``family_hash`` identify the refresh family the
    handle belongs to. A handle the framework mints under the current policy is
    the root of its own family: ``chain_generation`` is 1 and ``family_hash`` is
    ``hash_key`` of its own handle. Every successor records the presented
    generation plus one and inherits its ``family_hash``, so the depth of a
    rotated-away handle relative to the head is arithmetic rather than
    guesswork. A record that predates the policy carries generation 0 and an
    empty family hash; it is unsupported for ordinary rotation and must be
    migrated or reauthorized, never normalized online.

    ``depth_one_served_at`` is retained for stored-record compatibility. It
    marked the removed beyond-grace access-token-only serve and is no longer
    written.
    """

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
    chain_generation: int = 0
    family_hash: str = ""
    depth_one_served_at: datetime | None = None
    version: int = 0


@dataclass(slots=True)
class RouteRefreshFamilyState:
    """The store-internal family-state record behind one refresh family."""

    family_hash: str = ""
    status: str = BROKER_FAMILY_STATUS_ACTIVE
    version: int = 0
    created_at: datetime | None = None
    revoked_at: datetime | None = None


@dataclass(slots=True)
class RouteRefreshFamilyRotation:
    """One atomic rotation request.

    The presented handle is still locked by ``lock_owner`` at
    ``expected_version``, its family is active, and ``successor`` does not
    exist. The store creates the successor, checks the family/generation and
    identity bindings, writes the grace response onto the presented record,
    clears the lock, and returns the stored successor.
    """

    presented_handle_hash: str = ""
    lock_owner: str = ""
    expected_version: int = 0
    successor: RouteRefreshBrokerRecord | None = None
    grace_refresh_response: str = ""
    grace_expires_at: datetime | None = None


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
    """A consumed code record plus the terminal signal of the consume.

    The stored record is returned unmutated (its ``status`` and ``version`` are
    the caller's, as in Go's in-memory reference store); ``replayed`` marks a
    later consume of an already-burned code and ``expired`` marks a first
    consume of a code past its TTL.
    """

    record: AuthorizationCodeRecord | None = None
    replayed: bool = False
    expired: bool = False


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


class RouteRefreshBrokerFamilyStore(Protocol):
    """The enumeration/revocation half of the family capability of a broker store.

    A refresh family is the chain of handles one authorization grant produced;
    ``family_hash`` names it on every record. ``list_family`` answers which live
    handles belong to a family and what state each is in, and ``revoke_family``
    revokes every live record of a family in one operation.

    This pair alone is not enough for the framework-owned front channel: a
    conforming store must implement
    :class:`RouteRefreshBrokerTransactionalFamilyStore`, which adds atomic root
    creation and atomic rotation. The pair remains exported as the incident
    surface and for stores that keep it while they migrate.
    """

    def list_family(self, family_hash: str) -> list[RouteRefreshBrokerRecord]: ...

    def revoke_family(self, family_hash: str) -> list[RouteRefreshBrokerRecord]: ...


class RouteRefreshBrokerTransactionalFamilyStore(RouteRefreshBrokerFamilyStore, Protocol):
    """The mandatory transactional family capability of a broker store.

    ``create_family`` atomically creates an active family-state record and its
    generation-1 root record. ``rotate_family`` checks the lock owner, expected
    version, active family, family/generation/identity bindings, and successor
    uniqueness in one serialized transaction before creating the successor and
    updating the predecessor. Every get, acquire_lock, and rotate_family of a
    family-marked handle honors the family tombstone.
    """

    def create_family(self, root: RouteRefreshBrokerRecord) -> RouteRefreshBrokerRecord: ...

    def rotate_family(self, rotation: RouteRefreshFamilyRotation) -> RouteRefreshBrokerRecord: ...


class RouteRefreshBrokerHandleTTLReporter(Protocol):
    """The optional capability a broker store reports its local handle lifetime
    policy through.

    The facade compares it with the configured policy at registration, so a
    deployment cannot declare a long-lived ceiling while its store silently keeps
    a shorter one.
    """

    def route_refresh_broker_handle_ttl_seconds(self) -> float: ...


class RateLimitStore(Protocol):
    def check_and_increment(self, key: RateLimitBucketKey) -> RateLimitResult: ...


@dataclass(slots=True)
class Stores:
    """The five store SPIs of one deployment, so one value bundles a facade's
    persistence surface.

    The framework's in-memory implementations are for deterministic tests and
    local development: a durable implementation is application-owned and MUST
    encrypt the encrypted record fields at rest.
    """

    transaction: TransactionStore | None = None
    authorization_code: AuthorizationCodeStore | None = None
    client: ClientStore | None = None
    route_refresh_broker: RouteRefreshBrokerStore | None = None
    rate_limit: RateLimitStore | None = None


def hash_key(value: str) -> str:
    """Return the store key for a protected value: the unpadded base64url
    SHA-256 digest of the value.

    Every store SPI is keyed by the hash of the value it protects and never by
    the value itself, so a caller that seeds a record directly -- a
    pre-registered client, for example -- derives the key with this helper and
    the facade derives the same key when it looks the record up.
    """
    digest = hashlib.sha256(str(value).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _copy_record(record: Any, **overrides: Any) -> Any:
    """Return a copy of a store record with independent list fields.

    ``dataclasses.replace`` copies the record but leaves its list fields shared,
    so a caller that mutates a list the store handed out -- or a list handed in
    -- could reach stored state. This clones every list field as well.
    """
    cloned = replace(record, **overrides)
    for info in fields(cloned):
        value = getattr(cloned, info.name)
        if isinstance(value, list):
            setattr(cloned, info.name, list(value))
    return cloned


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
        """Stores a copy, preserving the caller's status and normalizing a
        version below 1 to 1, as Go's in-memory reference store does."""
        stored = _copy_record(record)
        if stored.version < 1:
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
            return _copy_record(stored, status=STATUS_EXPIRED)
        return _copy_record(stored, status=STATUS_CONSUMED)


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
        self._consumed: set[str] = set()
        self._lock = threading.Lock()

    def put(self, record: AuthorizationCodeRecord) -> None:
        """Stores a copy, preserving the caller's status and normalizing a
        version below 1 to 1, as Go's in-memory reference store does. A re-put
        clears the code's consumed flag."""
        stored = _copy_record(record)
        if stored.version < 1:
            stored.version = 1
        if stored.expires_at is None and self._ttl is not None:
            stored.expires_at = self._now() + timedelta(seconds=self._ttl)
        with self._lock:
            self._records[stored.code_hash] = stored
            self._consumed.discard(stored.code_hash)

    def consume(self, code_hash: str) -> ConsumeResult | None:
        """Consume-once, retaining the record so replay is distinguishable.

        The stored record is returned unmutated -- its status and version are
        the caller's, exactly as Go's in-memory reference store does -- and the
        terminal signal travels on the result instead: a replay sets
        ``replayed``, and a first consume of an expired code sets ``expired``.
        Both are terminal no matter which way the clock moves, so a clock that
        has moved past the TTL cannot restamp a replay.
        """
        with self._lock:
            stored = self._records.get(code_hash)
            if stored is None:
                return None
            if code_hash in self._consumed:
                return ConsumeResult(record=_copy_record(stored), replayed=True, expired=False)
            self._consumed.add(code_hash)
            expired = _is_expired(stored.expires_at, self._now())
            return ConsumeResult(
                record=None if expired else _copy_record(stored),
                replayed=False,
                expired=expired,
            )


class MemoryClientStore:
    """Versioned client store; ``update`` is compare-and-swap on version."""

    def __init__(self, now: Any = None, ttl: int | None = None) -> None:
        self._now = now or _utc_now
        self._records: dict[str, ClientRecord] = {}
        self._lock = threading.Lock()

    def put(self, record: ClientRecord) -> ClientRecord:
        stored = _copy_record(record)
        stored.version = 1
        if stored.created_at is None:
            stored.created_at = self._now()
        with self._lock:
            self._records[stored.client_id_hash] = stored
        return _copy_record(stored)

    def get(self, client_id_hash: str) -> ClientRecord | None:
        with self._lock:
            stored = self._records.get(client_id_hash)
        return _copy_record(stored) if stored is not None else None

    def update(self, record: ClientRecord, expected_version: int) -> ClientRecord:
        with self._lock:
            stored = self._records.get(record.client_id_hash)
            current_version = stored.version if stored is not None else 0
            if current_version != expected_version:
                raise ClientVersionConflictError(f"client version conflict for {record.client_id_hash!r}")
            updated = _copy_record(record)
            updated.version = current_version + 1
            if updated.created_at is None:
                updated.created_at = stored.created_at if stored is not None else self._now()
            self._records[updated.client_id_hash] = updated
        return _copy_record(updated)


class MemoryRouteRefreshBrokerStore:
    """Exclusive, expiring refresh lock plus a versioned compare-and-swap.

    A handle is TTL-bounded: each record is kept alongside the instant it was
    first stored, and every operation treats a handle whose ``now`` has reached
    ``stored_at + ttl`` as aged out. An aged-out handle reports
    :class:`BrokerExpiredError`, which is distinguishable from an unknown handle
    at the SPI (``get``/``revoke`` return ``None`` for an unknown key while an
    aged-out one raises, and ``acquire_lock``/``compare_and_swap`` raise
    ``KeyError`` for an unknown key); the client-facing body the facade renders
    is the same. A compare-and-swap rotation keeps the original ``stored_at``, so
    rotating cannot extend a handle's life.
    """

    def __init__(
        self,
        now: Any = None,
        ttl: int | None = None,
        lock_ttl_seconds: int = UTC_NOW_LOCK_TTL_SECONDS,
    ) -> None:
        self._now = now or _utc_now
        self._ttl = UTC_NOW_TTL_ROUTE_REFRESH_BROKER_SECONDS if ttl is None else int(ttl)
        self._lock_ttl_seconds = lock_ttl_seconds
        self._records: dict[str, tuple[RouteRefreshBrokerRecord, datetime]] = {}
        self._families: dict[str, RouteRefreshFamilyState] = {}
        self._lock = threading.Lock()

    def put(self, record: RouteRefreshBrokerRecord) -> None:
        """Stores a copy, preserving the caller's status and normalizing a
        version below 1 to 1, as Go's in-memory reference store does. The
        handle's stored-at instant is recorded for the local lifetime policy."""
        stored = _copy_record(record)
        if stored.version < 1:
            stored.version = 1
        with self._lock:
            self._records[stored.handle_hash] = (stored, self._now())

    def _live(self, handle_hash: str, now: datetime) -> RouteRefreshBrokerRecord | None:
        """Returns the live record for a handle, or ``None`` when the handle is
        unknown. A handle that existed but whose TTL elapsed is purged and
        reported as :class:`BrokerExpiredError`."""
        entry = self._records.get(handle_hash)
        if entry is None:
            return None
        stored, stored_at = entry
        if now >= stored_at + timedelta(seconds=self._ttl):
            del self._records[handle_hash]
            raise BrokerExpiredError(f"broker record {handle_hash!r} expired")
        return stored

    def get(self, handle_hash: str) -> RouteRefreshBrokerRecord | None:
        with self._lock:
            stored = self._live(handle_hash, self._now())
            if stored is not None:
                self._raise_family_error(stored)
        return _copy_record(stored) if stored is not None else None

    def acquire_lock(self, handle_hash: str, lock_owner: str, expected_version: int) -> RouteRefreshBrokerRecord:
        with self._lock:
            stored = self._live(handle_hash, self._now())
            if stored is None:
                raise KeyError(handle_hash)
            self._raise_family_error(stored)
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
            stored.status = STATUS_REFRESHING
            stored.version += 1
            return _copy_record(stored)

    def compare_and_swap(self, record: RouteRefreshBrokerRecord, expected_version: int) -> RouteRefreshBrokerRecord:
        with self._lock:
            stored = self._live(record.handle_hash, self._now())
            if stored is None:
                raise KeyError(record.handle_hash)
            self._raise_family_error(stored)
            if stored.status == STATUS_REVOKED:
                raise BrokerRevokedError(f"broker record {record.handle_hash!r} is revoked")
            if stored.version != expected_version:
                raise BrokerVersionConflictError(f"broker version conflict for {record.handle_hash!r}")
            stored_at = self._records[record.handle_hash][1]
            updated = _copy_record(record)
            updated.version = expected_version + 1
            # A replacement that states no status adopts the stored one, as Go's
            # reference store does, so a rotation cannot clear the handle's status.
            if updated.status == "":
                updated.status = stored.status
            self._records[updated.handle_hash] = (updated, stored_at)
            return _copy_record(updated)

    def revoke(self, handle_hash: str) -> RouteRefreshBrokerRecord | None:
        with self._lock:
            stored = self._live(handle_hash, self._now())
            if stored is None:
                return None
            if stored.status != STATUS_REVOKED:
                stored.status = STATUS_REVOKED
                stored.version += 1
                stored.refresh_lock_owner = ""
                stored.refresh_lock_expires_at = None
            return _copy_record(stored)

    def route_refresh_broker_handle_ttl_seconds(self) -> float:
        """The local handle lifetime policy this store applies, so the facade can
        refuse a configuration that declares a different ceiling. It implements
        ``RouteRefreshBrokerHandleTTLReporter``."""
        return float(self._ttl)

    def _raise_family_error(self, record: RouteRefreshBrokerRecord) -> None:
        """Raise the tombstone/binding error a family-marked record carries.

        A family-less record is readable for migration and incident work; the
        facade refuses its rotation separately.
        """
        if not record.family_hash:
            return
        state = self._families.get(record.family_hash)
        if state is None or not state.family_hash:
            raise BrokerFamilyStateUnavailableError("route refresh family state is missing or corrupt")
        if state.status == BROKER_FAMILY_STATUS_REVOKED:
            raise BrokerRevokedError("route refresh family is revoked")
        if record.chain_generation < 1:
            raise BrokerFamilyMismatchError("route refresh family generation mismatch")
        if record.chain_generation == 1 and record.handle_hash != record.family_hash:
            raise BrokerFamilyMismatchError("route refresh family root mismatch")

    def create_family(self, root: RouteRefreshBrokerRecord) -> RouteRefreshBrokerRecord:
        """Atomically create an active family-state record and its generation-1
        root. A pre-existing family ID is never overwritten or reactivated."""
        if not root.handle_hash or not root.family_hash:
            raise StoreError("family root needs a handle and family hash")
        if root.family_hash != root.handle_hash or root.chain_generation != 1:
            raise BrokerFamilyMismatchError("route refresh family root mismatch")
        if root.status not in ("", STATUS_ISSUED, STATUS_ACTIVE):
            raise BrokerFamilyMismatchError("route refresh family root status mismatch")
        with self._lock:
            if root.family_hash in self._families:
                raise BrokerFamilyExistsError("route refresh family already exists")
            if root.handle_hash in self._records:
                raise BrokerSuccessorExistsError("route refresh successor already exists")
            now = self._now()
            stored = _copy_record(root, status=root.status or STATUS_ISSUED, version=1)
            self._families[root.family_hash] = RouteRefreshFamilyState(
                family_hash=root.family_hash,
                status=BROKER_FAMILY_STATUS_ACTIVE,
                version=1,
                created_at=now,
            )
            self._records[stored.handle_hash] = (stored, now)
            return _copy_record(stored)

    def rotate_family(self, rotation: RouteRefreshFamilyRotation) -> RouteRefreshBrokerRecord:
        """One atomic rotation: lock owner, expected version, active family,
        family/generation/identity bindings, and successor uniqueness."""
        if not rotation.presented_handle_hash or rotation.successor is None or not rotation.successor.handle_hash:
            raise StoreError("rotation needs a presented handle and successor")
        if not rotation.lock_owner:
            raise BrokerLockedError("route refresh broker record is locked")
        with self._lock:
            now = self._now()
            stored = self._live(rotation.presented_handle_hash, now)
            if stored is None:
                raise KeyError(rotation.presented_handle_hash)
            if not stored.family_hash:
                raise BrokerLegacyLineageUnsupportedError("route refresh legacy lineage is unsupported")
            self._raise_family_error(stored)
            if stored.status == STATUS_REVOKED:
                raise BrokerRevokedError("route refresh broker record is revoked")
            if (
                not stored.refresh_lock_owner
                or stored.refresh_lock_owner != rotation.lock_owner
                or stored.refresh_lock_expires_at is None
                or now >= stored.refresh_lock_expires_at
            ):
                raise BrokerLockedError("route refresh broker record is locked")
            if stored.version != rotation.expected_version:
                raise BrokerVersionConflictError("broker version conflict")
            successor = rotation.successor
            if successor.handle_hash == stored.handle_hash:
                raise BrokerSuccessorExistsError("route refresh successor already exists")
            if (
                successor.family_hash != stored.family_hash
                or successor.chain_generation != stored.chain_generation + 1
                or not _same_broker_identity(stored, successor)
            ):
                raise BrokerFamilyMismatchError("route refresh family or generation binding mismatch")
            if successor.handle_hash in self._records:
                raise BrokerSuccessorExistsError("route refresh successor already exists")
            stored_successor = _copy_record(successor, status=successor.status or STATUS_ISSUED, version=1)
            if stored_successor.status != STATUS_ISSUED:
                raise BrokerFamilyMismatchError("route refresh successor status mismatch")
            stored_successor.refresh_lock_owner = ""
            stored_successor.refresh_lock_expires_at = None
            completed = _copy_record(
                stored,
                encrypted_grace_refresh_response=rotation.grace_refresh_response,
                grace_expires_at=rotation.grace_expires_at,
                status=STATUS_ACTIVE,
                refresh_lock_owner="",
                refresh_lock_expires_at=None,
                version=stored.version + 1,
            )
            stored_at = self._records[stored.handle_hash][1]
            self._records[stored_successor.handle_hash] = (stored_successor, now)
            self._records[stored.handle_hash] = (completed, stored_at)
            return _copy_record(stored_successor)

    def list_family(self, family_hash: str) -> list[RouteRefreshBrokerRecord]:
        """Returns every live record of one refresh family. Aged-out records are
        purged as they are observed and are not listed; a blank family hash is
        answered with an empty list, because no record can belong to no family."""
        if (family_hash or "").strip() == "":
            return []
        with self._lock:
            now = self._now()
            family: list[RouteRefreshBrokerRecord] = []
            for handle_hash, (stored, stored_at) in list(self._records.items()):
                if now >= stored_at + timedelta(seconds=self._ttl):
                    del self._records[handle_hash]
                    continue
                if stored.family_hash == family_hash:
                    family.append(_copy_record(stored))
            return family

    def revoke_family(self, family_hash: str) -> list[RouteRefreshBrokerRecord]:
        """Atomically writes the family tombstone and revokes every live member
        it handles. A family that never existed is an idempotent no-op; a family
        with live members but no family state fails closed."""
        if (family_hash or "").strip() == "":
            return []
        with self._lock:
            now = self._now()
            state = self._families.get(family_hash)
            if state is None:
                for stored, stored_at in self._records.values():
                    if now >= stored_at + timedelta(seconds=self._ttl):
                        continue
                    if stored.family_hash == family_hash:
                        raise BrokerFamilyStateUnavailableError("route refresh family state is missing or corrupt")
                return []
            if state.status != BROKER_FAMILY_STATUS_REVOKED:
                state.status = BROKER_FAMILY_STATUS_REVOKED
                state.revoked_at = now
                state.version += 1
            family: list[RouteRefreshBrokerRecord] = []
            for handle_hash, (stored, stored_at) in list(self._records.items()):
                if now >= stored_at + timedelta(seconds=self._ttl):
                    del self._records[handle_hash]
                    continue
                if stored.family_hash != family_hash:
                    continue
                if stored.status != STATUS_REVOKED:
                    stored.status = STATUS_REVOKED
                    stored.refresh_lock_owner = ""
                    stored.refresh_lock_expires_at = None
                    stored.version += 1
                family.append(_copy_record(stored))
            return family


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


def _same_broker_identity(presented: RouteRefreshBrokerRecord, successor: RouteRefreshBrokerRecord) -> bool:
    """Report whether a successor preserves every identity field a handle binds."""
    return (
        presented.issuer == successor.issuer
        and presented.stage == successor.stage
        and presented.canonical_resource == successor.canonical_resource
        and presented.client_namespace == successor.client_namespace
        and presented.endpoint_kind == successor.endpoint_kind
        and presented.partner_id == successor.partner_id
        and presented.agent_id == successor.agent_id
        and presented.client_id_hash == successor.client_id_hash
        and presented.subject_id_hash == successor.subject_id_hash
        and presented.scope_fingerprint == successor.scope_fingerprint
        and presented.upstream_client_id == successor.upstream_client_id
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
    # Replay outranks expiry: a code consumed once is terminal, so a later read
    # (even one whose clock moved forward past the TTL, or backward behind it)
    # must report the replay rather than resurrect or re-expire the record.
    if result.replayed:
        return "replayed"
    if result.expired:
        return "expired"
    return "ok"


def _authorization_code_record_fields(result: ConsumeResult | None) -> dict[str, Any]:
    """Reports a consume's status and version, or the "none"/-1 sentinels when
    the consume returned no record."""
    if result is None or result.record is None:
        return {"status": "none", "version": -1}
    return {"status": result.record.status, "version": result.record.version}


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


def _scenario_transaction_consume_after_ttl_then_replay(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    actual = {
        "first": _transaction_outcome(store.consume("state-hash")),
        "second": _transaction_outcome(store.consume("state-hash")),
    }
    _assert_expected(expect, actual)


def _scenario_transaction_clock_back_after_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    first = _transaction_outcome(store.consume("state-hash"))
    clock.advance(timedelta(seconds=-int(params["clock_back_seconds"])))
    after = _transaction_outcome(store.consume("state-hash"))
    _assert_expected(expect, {"first": first, "after_clock_back": after})


def _scenario_transaction_clock_back_after_expired_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    first = _transaction_outcome(store.consume("state-hash"))
    clock.advance(timedelta(seconds=-int(params["clock_back_seconds"])))
    after = _transaction_outcome(store.consume("state-hash"))
    _assert_expected(expect, {"first": first, "after_clock_back": after})


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


def _scenario_authorization_code_consume_after_ttl_then_replay(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    actual = {
        "first": _authorization_code_outcome(store.consume("code-hash")),
        "second": _authorization_code_outcome(store.consume("code-hash")),
    }
    _assert_expected(expect, actual)


def _scenario_authorization_code_clock_back_after_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    first = _authorization_code_outcome(store.consume("code-hash"))
    clock.advance(timedelta(seconds=-int(params["clock_back_seconds"])))
    after = _authorization_code_outcome(store.consume("code-hash"))
    _assert_expected(expect, {"first": first, "after_clock_back": after})


def _scenario_authorization_code_clock_back_after_expired_consume(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    first = _authorization_code_outcome(store.consume("code-hash"))
    clock.advance(timedelta(seconds=-int(params["clock_back_seconds"])))
    after = _authorization_code_outcome(store.consume("code-hash"))
    _assert_expected(expect, {"first": first, "after_clock_back": after})


def _scenario_authorization_code_consume_record_payload(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(AuthorizationCodeRecord(code_hash="code-hash"))
    clock.advance(timedelta(seconds=int(params.get("advance_seconds", 0))))
    first = store.consume("code-hash")
    replay = store.consume("code-hash")

    first_fields = _authorization_code_record_fields(first)
    replay_fields = _authorization_code_record_fields(replay)
    _assert_expected(
        expect,
        {
            "first": _authorization_code_outcome(first),
            "first_status": first_fields["status"],
            "first_version": first_fields["version"],
            "replay": _authorization_code_outcome(replay),
            "replay_status": replay_fields["status"],
            "replay_version": replay_fields["version"],
        },
    )


def _scenario_transaction_put_payload(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """Seeds one transaction with the caller's version and reports the version
    the consume hands back, so a row pins the put-path version normalization
    rather than only the outcome. The status is deliberately not reported for
    the transaction store: Go returns the caller's status while this store
    stamps the consume outcome on the record."""
    store = _transaction_store(stores, clock, _ttl_param(params))
    store.put(TransactionRecord(state_hash="state-hash", version=int(params.get("put_version", 0))))
    consumed = store.consume("state-hash")
    _assert_expected(
        expect,
        {
            "consume": _transaction_outcome(consumed),
            "version": consumed.version if consumed is not None else -1,
        },
    )


def _scenario_authorization_code_put_payload(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """Seeds one code with the caller's status and version and reports what the
    consume hands back, so a row pins the put-path payload contract rather than
    only the outcome. An absent put_status is the empty string and an absent
    put_version is 0."""
    store = _authorization_code_store(stores, clock, _ttl_param(params))
    store.put(
        AuthorizationCodeRecord(
            code_hash="code-hash",
            status=params.get("put_status", ""),
            version=int(params.get("put_version", 0)),
        )
    )
    result = store.consume("code-hash")
    fields = _authorization_code_record_fields(result)
    _assert_expected(
        expect,
        {
            "consume": _authorization_code_outcome(result),
            "status": fields["status"],
            "version": fields["version"],
        },
    )


def _scenario_broker_put_payload(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """Seeds one handle with the caller's status and version and reports what the
    get hands back, so a row pins the put-path payload contract rather than only
    the outcome. An absent put_status is the empty string and an absent
    put_version is 0."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(
        RouteRefreshBrokerRecord(
            handle_hash="handle-hash",
            status=params.get("put_status", ""),
            version=int(params.get("put_version", 0)),
        )
    )
    record = store.get("handle-hash")
    _assert_expected(
        expect,
        {
            "get": "ok" if record is not None else "not_found",
            "status": record.status if record is not None else "none",
            "version": record.version if record is not None else -1,
        },
    )


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
    """Seeds one client with the row's put version and walks the versioned
    read/update path. The store's put owns the stored version, so a row with a
    put_version above 1 pins that put forces version 1."""
    store = stores["client"](now=clock.now)
    stored = store.put(
        ClientRecord(
            client_id_hash="client-hash",
            client_id="client",
            version=int(params.get("put_version", 0)),
        )
    )
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


def _broker_get_outcome(store: Any, handle_hash: str) -> str:
    try:
        record = store.get(handle_hash)
    except BrokerExpiredError:
        return "expired"
    return "ok" if record is not None else "not_found"


def _scenario_broker_get_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    _assert_expected(expect, {"get": _broker_get_outcome(store, "unknown")})


def _broker_swap_outcome(store: Any, record: RouteRefreshBrokerRecord, expected_version: int | None = None) -> str:
    try:
        store.compare_and_swap(record, record.version if expected_version is None else expected_version)
    except BrokerExpiredError:
        return "expired"
    except BrokerRevokedError:
        return "revoked"
    except BrokerVersionConflictError:
        return "version_conflict"
    except KeyError:
        return "not_found"
    return "ok"


def _acquire_lock_outcome(store: Any, handle_hash: str, owner: str, expected_version: int) -> str:
    try:
        store.acquire_lock(handle_hash, owner, expected_version)
    except BrokerExpiredError:
        return "expired"
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
    swapped = store.compare_and_swap(_copy_record(record, scopes=["mcp:tools"]), record.version)
    stale_outcome = "ok"
    try:
        store.compare_and_swap(_copy_record(record, scopes=["mcp:other"]), record.version)
    except BrokerVersionConflictError:
        stale_outcome = "version_conflict"
    swapped_ok = "ok" if swapped.version == record.version + 1 else "unexpected_version"
    actual = {"acquire_lock": acquire, "swap": swapped_ok, "stale_swap": stale_outcome}
    _assert_expected(expect, actual)


def _scenario_broker_compare_and_swap_inherits_status(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """A rotation that states no status adopts the stored one: the handle is
    seeded, locked so its status is refreshing, and then swapped with a record
    that carries no status, which must not clear it."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash", status=STATUS_ISSUED))
    seeded = store.get("handle-hash")
    store.acquire_lock("handle-hash", "owner-inherit", seeded.version if seeded is not None else 1)
    held = store.get("handle-hash")
    swapped = store.compare_and_swap(
        RouteRefreshBrokerRecord(handle_hash="handle-hash", status=""),
        held.version if held is not None else 1,
    )
    _assert_expected(expect, {"status": swapped.status})


def _scenario_broker_compare_and_swap_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """A swap never creates: an absent handle is not-found, not a create."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    record = RouteRefreshBrokerRecord(handle_hash="handle-hash", version=0)
    _assert_expected(expect, {"swap": _broker_swap_outcome(store, record)})


def _scenario_broker_negative_expected_version(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """A negative expected version is never a skip-version-check wildcard."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    record = store.get("handle-hash")
    swap = _broker_swap_outcome(store, record, expected_version=-1)
    acquire = _acquire_lock_outcome(store, "handle-hash", "owner-negative", -1)
    _assert_expected(expect, {"swap": swap, "acquire_lock": acquire})


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


def _scenario_broker_ttl_boundary(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    _assert_expected(expect, {"get": _broker_get_outcome(store, "handle-hash")})


def _scenario_broker_expired_refuses_lock(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    outcome = _acquire_lock_outcome(store, "handle-hash", "owner-ttl", 1)
    _assert_expected(expect, {"acquire_lock": outcome})


def _scenario_broker_expired_refuses_swap(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    record = store.get("handle-hash")
    if record is None:
        raise AssertionError("broker record must exist after put")
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    _assert_expected(expect, {"swap": _broker_swap_outcome(store, record)})


def _scenario_broker_expired_vs_unknown(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """An unknown key and an aged-out key report different outcomes at the SPI,
    even though the client-facing body is the same."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    clock.advance(timedelta(seconds=int(params["advance_seconds"])))
    actual = {
        "unknown": _broker_get_outcome(store, "unknown-handle"),
        "expired": _broker_get_outcome(store, "handle-hash"),
    }
    _assert_expected(expect, actual)


def _seed_broker_family(store: Any, key: str, family_hash: str) -> None:
    store.put(
        RouteRefreshBrokerRecord(
            handle_hash=key,
            issuer="https://auth.example.test",
            stage="lab",
            canonical_resource="https://mcp.example.test/mcp",
            status=STATUS_ACTIVE,
            chain_generation=2,
            family_hash=family_hash,
        )
    )


def _seed_family_with_root(store: Any, family_hash: str, size: int, prefix: str) -> None:
    """Create a family root through the transactional capability and backfill
    the remaining members through the store's create path."""
    if size <= 0:
        return
    store.create_family(_copy_record(_family_root(family_hash), status=STATUS_ACTIVE))
    for index in range(1, size):
        _seed_broker_family(store, f"{prefix}-{index}", family_hash)


def _scenario_broker_list_family(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """Seeds two families and reports what the family listing returns for one of
    them, so a store that cannot enumerate a family is visible."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    list_family = getattr(store, "list_family", None)
    if not callable(list_family):
        raise AssertionError("the broker store must implement the family capability")
    family_hash = "family-hash"
    other_hash = "other-family-hash"
    _seed_family_with_root(store, family_hash, int(params.get("family_size", 0)), "member")
    _seed_family_with_root(store, other_hash, int(params.get("other_family_size", 0)), "other")
    family_list = cast("Any", list_family)
    actual = {
        "family_size": len(cast("list[RouteRefreshBrokerRecord]", family_list(family_hash))),
        "other_family_size": len(cast("list[RouteRefreshBrokerRecord]", family_list(other_hash))),
    }
    _assert_expected(expect, actual)


def _scenario_broker_revoke_family(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    """Seeds two families, revokes one through the family capability, and reports
    what was revoked and what the other family's state is, so a family revoke
    that misses members or leaks across families is visible."""
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    revoke_family = getattr(store, "revoke_family", None)
    if not callable(revoke_family):
        raise AssertionError("the broker store must implement the family capability")
    family_hash = "family-hash"
    other_hash = "other-family-hash"
    family_size = int(params.get("family_size", 0))
    other_size = int(params.get("other_family_size", 0))
    _seed_family_with_root(store, family_hash, family_size, "member")
    _seed_family_with_root(store, other_hash, other_size, "other")
    family_keys = ([family_hash] + [f"member-{index}" for index in range(1, family_size)]) if family_size > 0 else []
    other_keys = ([other_hash] + [f"other-{index}" for index in range(1, other_size)]) if other_size > 0 else []
    revoked = revoke_family(family_hash)
    family_statuses = sorted(_broker_status(store, key) for key in family_keys)
    other_statuses = sorted(_broker_status(store, key) for key in other_keys)
    _assert_expected(
        expect,
        {
            "revoked_family_size": len(cast("list[RouteRefreshBrokerRecord]", revoked)),
            "family_statuses": family_statuses,
            "other_statuses": other_statuses,
        },
    )


def _broker_status(store: Any, key: str) -> str:
    try:
        record = store.get(key)
    except BrokerRevokedError:
        return STATUS_REVOKED
    if record is None:
        raise AssertionError(f"broker record {key!r} must exist")
    return record.status


def _scenario_broker_revoke_then_swap(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    revoked = store.revoke("handle-hash")
    actual = {
        "revoke": "ok" if revoked is not None else "not_found",
        "swap": _broker_swap_outcome(store, revoked) if revoked is not None else "not_found",
    }
    _assert_expected(expect, actual)


def _scenario_broker_acquire_lock_bumps_version(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    before = store.get("handle-hash")
    version = before.version if before is not None else 0
    store.acquire_lock("handle-hash", "owner-bump", version)
    after = store.get("handle-hash")
    _assert_expected(expect, {"version_delta": (after.version if after is not None else 0) - version})


def _scenario_broker_acquire_lock_sets_refreshing(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    before = store.get("handle-hash")
    store.acquire_lock("handle-hash", "owner-status", before.version if before is not None else 0)
    record = store.get("handle-hash")
    _assert_expected(expect, {"status": record.status if record is not None else "not_found"})


def _scenario_broker_revoke_bumps_version(
    stores: dict[str, Any], params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    store.put(RouteRefreshBrokerRecord(handle_hash="handle-hash"))
    first = store.get("handle-hash")
    version_0 = first.version if first is not None else 0
    store.revoke("handle-hash")
    second = store.get("handle-hash")
    version_1 = second.version if second is not None else 0
    store.revoke("handle-hash")
    third = store.get("handle-hash")
    version_2 = third.version if third is not None else 0
    _assert_expected(
        expect,
        {"revoke_version_delta": version_1 - version_0, "revoke_again_version_delta": version_2 - version_1},
    )


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


def _family_root(family_hash: str) -> RouteRefreshBrokerRecord:
    return RouteRefreshBrokerRecord(
        handle_hash=family_hash,
        issuer="https://auth.example.test",
        stage="lab",
        canonical_resource="https://mcp.example.test/mcp",
        client_namespace="conformance",
        endpoint_kind="namespace",
        client_id_hash="client-hash",
        subject_id_hash="subject-hash",
        scopes=["mcp:tools"],
        scope_fingerprint="scope-fingerprint",
        upstream_client_id="upstream-client",
        upstream_refresh_token_hash=hash_key("upstream-refresh-root"),
        status=STATUS_ISSUED,
        chain_generation=1,
        family_hash=family_hash,
    )


def _family_member(
    presented: RouteRefreshBrokerRecord, handle_hash: str, family_hash: str, generation: int
) -> RouteRefreshBrokerRecord:
    return _copy_record(
        presented,
        handle_hash=handle_hash,
        family_hash=family_hash,
        chain_generation=generation,
        status=STATUS_ISSUED,
        version=0,
        encrypted_upstream_refresh_token="upstream-refresh-successor",  # noqa: S106 - a deterministic fixture value, not a credential
        upstream_refresh_token_hash=hash_key("upstream-refresh-successor"),
        refresh_lock_owner="",
        refresh_lock_expires_at=None,
    )


def _family_outcome(operation: Any) -> str:
    try:
        operation()
        return "ok"
    except BrokerFamilyExistsError:
        return "family_exists"
    except BrokerFamilyStateUnavailableError:
        return "family_state_unavailable"
    except BrokerFamilyMismatchError:
        return "family_mismatch"
    except BrokerSuccessorExistsError:
        return "successor_exists"
    except BrokerLegacyLineageUnsupportedError:
        return "legacy_lineage_unsupported"
    except BrokerRevokedError:
        return "revoked"
    except BrokerLockedError:
        return "locked"
    except BrokerVersionConflictError:
        return "version_conflict"
    except BrokerExpiredError:
        return "expired"
    except KeyError:
        return "not_found"


def _family_read(store: Any, handle_hash: str) -> RouteRefreshBrokerRecord | None:
    try:
        return store.get(handle_hash)
    except StoreError:
        return None


def _family_rotate(
    store: Any,
    locked: RouteRefreshBrokerRecord,
    successor_key: str,
    family_hash: str,
    *,
    lock_owner: str = "conformance-owner",
    expected_version: int | None = None,
    generation: int | None = None,
) -> RouteRefreshBrokerRecord:
    return store.rotate_family(
        RouteRefreshFamilyRotation(
            presented_handle_hash=locked.handle_hash,
            lock_owner=lock_owner,
            expected_version=locked.version if expected_version is None else expected_version,
            successor=_family_member(
                locked,
                successor_key,
                family_hash,
                (locked.chain_generation + 1) if generation is None else generation,
            ),
            grace_refresh_response='{"refresh_token":"' + successor_key + '"}',
            grace_expires_at=locked.refresh_lock_expires_at,
        )
    )


def _family_create_and_lock(store: Any, family_hash: str) -> RouteRefreshBrokerRecord:
    store.create_family(_family_root(family_hash))
    root = store.get(family_hash)
    if root is None:
        raise AssertionError("the family root must exist")
    return store.acquire_lock(root.handle_hash, "conformance-owner", root.version)


def _run_family_scenario(  # noqa: C901 - one branch per shared-table scenario
    stores: dict[str, Any], scenario: str, params: dict[str, Any], expect: dict[str, Any], clock: Any
) -> None:
    store = _broker_store(stores, clock, None, UTC_NOW_LOCK_TTL_SECONDS)
    family_hash = "family-hash"
    actual: dict[str, Any] = {}
    if scenario == "family_create":
        created = store.create_family(_family_root(family_hash))
        second = _family_outcome(lambda: store.create_family(_family_root(family_hash)))
        stored = store.get(family_hash)
        actual = {
            "create": "ok",
            "root_version": created.version,
            "root_generation": created.chain_generation,
            "root_family_is_self": created.family_hash == created.handle_hash,
            "second_create": second,
            "root_after_second_version": stored.version if stored is not None else -1,
            "root_get": "ok" if stored is not None else "not_found",
        }
    elif scenario == "family_create_binding":
        root = _family_root(family_hash)
        root.chain_generation = int(params.get("generation", 0))
        if params.get("family_binding") == "other":
            root.family_hash = "other-family-hash"
        create = _family_outcome(lambda: store.create_family(root))
        actual = {
            "create": create,
            "root_get": "ok" if _family_read(store, root.handle_hash) is not None else "not_found",
        }
    elif scenario == "family_rotate":
        store.create_family(_family_root(family_hash))
        root = store.get(family_hash)
        if root is None:
            raise AssertionError("the family root must exist")
        locked = store.acquire_lock(root.handle_hash, "conformance-owner", root.version)
        rotate = _family_outcome(lambda: _family_rotate(store, locked, "successor", family_hash))
        successor = _family_read(store, "successor")
        presented = _family_read(store, root.handle_hash)
        actual = {
            "rotate": rotate,
            "successor_get": "ok" if successor is not None else "not_found",
            "successor_version": successor.version if successor is not None else -1,
            "successor_generation": successor.chain_generation if successor is not None else -1,
            "successor_family_matches": successor is not None and successor.family_hash == family_hash,
            "presented_get": "ok" if presented is not None else "not_found",
            "presented_version": presented.version if presented is not None else -1,
            "presented_status": presented.status if presented is not None else "none",
            "presented_grace_set": bool(
                presented is not None
                and presented.encrypted_grace_refresh_response
                and presented.grace_expires_at is not None
            ),
            "presented_lock_cleared": bool(
                presented is not None and not presented.refresh_lock_owner and presented.refresh_lock_expires_at is None
            ),
        }
    elif scenario == "family_rotate_wrong_owner":
        locked = _family_create_and_lock(store, family_hash)
        rotate = _family_outcome(
            lambda: _family_rotate(store, locked, "successor", family_hash, lock_owner="another-owner")
        )
        presented = _family_read(store, locked.handle_hash)
        actual = {
            "rotate": rotate,
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
            "presented_version": presented.version if presented is not None else -1,
            "presented_status": presented.status if presented is not None else "none",
        }
    elif scenario == "family_rotate_stale_version":
        locked = _family_create_and_lock(store, family_hash)
        rotate = _family_outcome(
            lambda: _family_rotate(store, locked, "successor", family_hash, expected_version=locked.version - 1)
        )
        actual = {
            "rotate": rotate,
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
        }
    elif scenario == "family_rotate_existing_successor":
        locked = _family_create_and_lock(store, family_hash)
        store.put(_family_member(locked, "successor", family_hash, locked.chain_generation + 1))
        rotate = _family_outcome(lambda: _family_rotate(store, locked, "successor", family_hash))
        presented = _family_read(store, locked.handle_hash)
        successor = _family_read(store, "successor")
        actual = {
            "rotate": rotate,
            "successor_status_after": successor.status if successor is not None else "none",
            "successor_version_after": successor.version if successor is not None else -1,
            "presented_status_after": presented.status if presented is not None else "none",
            "presented_version_after": presented.version if presented is not None else -1,
        }
    elif scenario in ("family_rotate_generation_mismatch", "family_rotate_family_mismatch"):
        locked = _family_create_and_lock(store, family_hash)
        generation = (
            locked.chain_generation + 2
            if scenario == "family_rotate_generation_mismatch"
            else locked.chain_generation + 1
        )
        successor_family = "other-family-hash" if scenario == "family_rotate_family_mismatch" else family_hash
        rotate = _family_outcome(
            lambda: _family_rotate(store, locked, "successor", successor_family, generation=generation)
        )
        actual = {
            "rotate": rotate,
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
        }
    elif scenario == "family_rotate_legacy":
        store.put(
            RouteRefreshBrokerRecord(
                handle_hash="legacy",
                issuer="https://auth.example.test",
                stage="lab",
                canonical_resource="https://mcp.example.test/mcp",
                status=STATUS_ACTIVE,
            )
        )
        legacy = store.get("legacy")
        if legacy is None:
            raise AssertionError("the legacy record must exist")
        locked = store.acquire_lock("legacy", "conformance-owner", legacy.version)
        rotate = _family_outcome(
            lambda: store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash="legacy",
                    lock_owner="conformance-owner",
                    expected_version=locked.version,
                    successor=_family_member(locked, "successor", "", 2),
                    grace_refresh_response='{"refresh_token":"successor"}',
                    grace_expires_at=locked.refresh_lock_expires_at,
                )
            )
        )
        presented = _family_read(store, "legacy")
        actual = {
            "rotate": rotate,
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
            "presented_version": presented.version if presented is not None else -1,
            "presented_status": presented.status if presented is not None else "none",
        }
    elif scenario == "family_missing_state":
        store.put(_family_member(_family_root(family_hash), "member", family_hash, 1))
        get = _family_outcome(lambda: store.get("member"))
        lock = _family_outcome(lambda: store.acquire_lock("member", "conformance-owner", 1))
        rotate = _family_outcome(
            lambda: store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash="member",
                    lock_owner="conformance-owner",
                    expected_version=1,
                    successor=_family_member(_family_root(family_hash), "successor", family_hash, 2),
                    grace_refresh_response='{"refresh_token":"successor"}',
                    grace_expires_at=None,
                )
            )
        )
        revoke = _family_outcome(lambda: store.revoke_family(family_hash))
        actual = {
            "get": get,
            "lock": lock,
            "rotate": rotate,
            "revoke": revoke,
            "list": "ok",
            "listed": len(store.list_family(family_hash)),
            "record_status": "none",
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
        }
    elif scenario == "family_mixed_lineage":
        store.create_family(_family_root(family_hash))
        root = store.get(family_hash)
        if root is None:
            raise AssertionError("the family root must exist")
        locked = store.acquire_lock(root.handle_hash, "conformance-owner", root.version)
        successor = _family_rotate(store, locked, "successor", family_hash)
        store.put(
            RouteRefreshBrokerRecord(
                handle_hash="legacy",
                issuer="https://auth.example.test",
                stage="lab",
                canonical_resource="https://mcp.example.test/mcp",
                encrypted_grace_refresh_response='{"refresh_token":"successor"}',
                status=STATUS_ACTIVE,
            )
        )
        legacy = store.get("legacy")
        if legacy is None:
            raise AssertionError("the legacy record must exist")
        legacy_lock = _family_outcome(lambda: store.acquire_lock("legacy", "conformance-owner", legacy.version))
        legacy_rotate = _family_outcome(
            lambda: store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash="legacy",
                    lock_owner="conformance-owner",
                    expected_version=legacy.version + 1,
                    successor=_family_member(legacy, "legacy-successor", successor.family_hash, 2),
                    grace_refresh_response='{"refresh_token":"legacy-successor"}',
                    grace_expires_at=None,
                )
            )
        )
        listed = store.list_family(family_hash)
        actual = {
            "legacy_lock": legacy_lock,
            "legacy_rotate": legacy_rotate,
            "list": "ok",
            "listed": len(listed),
            "legacy_listed": any(record.handle_hash == "legacy" for record in listed),
            "successor_get": "ok",
            "successor_generation": successor.chain_generation,
        }
    elif scenario == "family_tombstone_every_member":
        store.create_family(_family_root(family_hash))
        current = store.get(family_hash)
        if current is None:
            raise AssertionError("the family head must exist")
        for index in range(int(params.get("rotations", 1))):
            locked = store.acquire_lock(current.handle_hash, f"owner-{index}", current.version)
            current = store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash=locked.handle_hash,
                    lock_owner=f"owner-{index}",
                    expected_version=locked.version,
                    successor=_family_member(locked, f"successor-{index}", family_hash, locked.chain_generation + 1),
                    grace_refresh_response='{"refresh_token":"successor-' + str(index) + '"}',
                    grace_expires_at=locked.refresh_lock_expires_at,
                )
            )
        revoked = store.revoke_family(family_hash)
        listed = store.list_family(family_hash)
        head_get = _family_outcome(lambda: store.get(current.handle_hash))
        head_lock = _family_outcome(lambda: store.acquire_lock(current.handle_hash, "late-owner", -1))
        head_rotate = _family_outcome(
            lambda: store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash=current.handle_hash,
                    lock_owner="late-owner",
                    expected_version=-1,
                    successor=_family_member(current, "late-successor", family_hash, current.chain_generation + 1),
                    grace_refresh_response='{"refresh_token":"late-successor"}',
                    grace_expires_at=None,
                )
            )
        )
        revoked_again = store.revoke_family(family_hash)
        actual = {
            "revoke": "ok",
            "revoked": len(revoked),
            "list": "ok",
            "listed": len(listed),
            "all_listed_revoked": all(record.status == STATUS_REVOKED for record in listed),
            "head_get": head_get,
            "head_lock": head_lock,
            "head_rotate": head_rotate,
            "late_successor_get": "ok" if _family_read(store, "late-successor") is not None else "not_found",
            "create_again": _family_outcome(lambda: store.create_family(_family_root(family_hash))),
            "revoke_again": "ok",
            "revoke_again_count": len(revoked_again),
        }
    elif scenario == "family_tombstone_beyond_batch":
        store.create_family(_family_root(family_hash))
        members = int(params.get("members", 1))
        for index in range(members):
            store.put(_family_member(_family_root(family_hash), f"member-{index}", family_hash, index + 2))
        revoked = store.revoke_family(family_hash)
        listed = store.list_family(family_hash)
        actual = {
            "revoke": "ok",
            "revoked": len(revoked),
            "list": "ok",
            "listed": len(listed),
            "all_listed_revoked": all(record.status == STATUS_REVOKED for record in listed),
            "first_get": _family_outcome(lambda: store.get("member-0")),
            "last_get": _family_outcome(lambda: store.get(f"member-{members - 1}")),
            "create_again": _family_outcome(lambda: store.create_family(_family_root(family_hash))),
        }
    elif scenario == "family_revocation_first":
        locked = _family_create_and_lock(store, family_hash)
        revoked = store.revoke_family(family_hash)
        rotate = _family_outcome(lambda: _family_rotate(store, locked, "successor", family_hash))
        actual = {
            "revoke": "ok",
            "revoked": len(revoked),
            "rotate": rotate,
            "presented_get": _family_outcome(lambda: store.get(locked.handle_hash)),
            "successor_get": "ok" if _family_read(store, "successor") is not None else "not_found",
            "lock_again": _family_outcome(lambda: store.acquire_lock(locked.handle_hash, "late-owner", -1)),
            "revoke_again": _family_outcome(lambda: store.revoke_family(family_hash)),
        }
    elif scenario == "family_rotation_first":
        locked = _family_create_and_lock(store, family_hash)
        successor = _family_rotate(store, locked, "successor", family_hash)
        revoked = store.revoke_family(family_hash)
        successor_rotate = _family_outcome(
            lambda: store.rotate_family(
                RouteRefreshFamilyRotation(
                    presented_handle_hash=successor.handle_hash,
                    lock_owner="late-owner",
                    expected_version=-1,
                    successor=_family_member(successor, "late-successor", family_hash, successor.chain_generation + 1),
                    grace_refresh_response='{"refresh_token":"late-successor"}',
                    grace_expires_at=None,
                )
            )
        )
        actual = {
            "revoke": "ok",
            "revoked": len(revoked),
            "successor_get": _family_outcome(lambda: store.get(successor.handle_hash)),
            "successor_lock": _family_outcome(lambda: store.acquire_lock(successor.handle_hash, "late-owner", -1)),
            "successor_rotate": successor_rotate,
            "late_successor_get": "ok" if _family_read(store, "late-successor") is not None else "not_found",
        }
    elif scenario == "family_tombstone_survives_expiry":
        store.create_family(_family_root(family_hash))
        store.revoke_family(family_hash)
        clock.advance(timedelta(seconds=int(params.get("advance_seconds", 0))))
        get = _family_outcome(lambda: store.get(family_hash))
        listed = store.list_family(family_hash)
        revoked_again = store.revoke_family(family_hash)
        actual = {
            "list": "ok",
            "listed": len(listed),
            "get": get,
            "create_again": _family_outcome(lambda: store.create_family(_family_root(family_hash))),
            "revoke_again": "ok",
            "revoke_again_count": len(revoked_again),
        }
    else:
        raise AssertionError(f"unknown family scenario {scenario}")
    _assert_expected(expect, actual)


_STORE_SCENARIOS: dict[tuple[str, str], Any] = {
    ("transaction", "consume_single_use"): _scenario_transaction_consume_single_use,
    ("transaction", "consume_unknown"): _scenario_transaction_consume_unknown,
    ("transaction", "consume_after_ttl"): _scenario_transaction_consume_after_ttl,
    ("transaction", "consume_after_ttl_then_replay"): _scenario_transaction_consume_after_ttl_then_replay,
    ("transaction", "clock_back_after_consume"): _scenario_transaction_clock_back_after_consume,
    ("transaction", "clock_back_after_expired_consume"): _scenario_transaction_clock_back_after_expired_consume,
    ("transaction", "concurrent_consume"): _scenario_transaction_concurrent_consume,
    ("transaction", "put_payload"): _scenario_transaction_put_payload,
    ("authorization_code", "consume_single_use_then_replay"): (
        _scenario_authorization_code_consume_single_use_then_replay
    ),
    ("authorization_code", "consume_unknown"): _scenario_authorization_code_consume_unknown,
    ("authorization_code", "consume_after_ttl"): _scenario_authorization_code_consume_after_ttl,
    ("authorization_code", "consume_record_payload"): _scenario_authorization_code_consume_record_payload,
    ("authorization_code", "put_payload"): _scenario_authorization_code_put_payload,
    ("authorization_code", "consume_after_ttl_then_replay"): (
        _scenario_authorization_code_consume_after_ttl_then_replay
    ),
    ("authorization_code", "clock_back_after_consume"): _scenario_authorization_code_clock_back_after_consume,
    ("authorization_code", "clock_back_after_expired_consume"): (
        _scenario_authorization_code_clock_back_after_expired_consume
    ),
    ("authorization_code", "concurrent_consume"): _scenario_authorization_code_concurrent_consume,
    ("client", "put_get_update"): _scenario_client_put_get_update,
    ("client", "update_stale_version"): _scenario_client_update_stale_version,
    ("client", "get_unknown"): _scenario_client_get_unknown,
    ("route_refresh_broker", "get_unknown"): _scenario_broker_get_unknown,
    ("route_refresh_broker", "put_payload"): _scenario_broker_put_payload,
    ("route_refresh_broker", "acquire_lock_exclusive_with_expiry"): _scenario_broker_acquire_lock_exclusive_with_expiry,
    ("route_refresh_broker", "compare_and_swap_versioned"): _scenario_broker_compare_and_swap_versioned,
    ("route_refresh_broker", "compare_and_swap_inherits_status"): (_scenario_broker_compare_and_swap_inherits_status),
    ("route_refresh_broker", "compare_and_swap_unknown"): _scenario_broker_compare_and_swap_unknown,
    ("route_refresh_broker", "negative_expected_version"): _scenario_broker_negative_expected_version,
    ("route_refresh_broker", "revoke_idempotent"): _scenario_broker_revoke_idempotent,
    ("route_refresh_broker", "revoke_then_lock"): _scenario_broker_revoke_then_lock,
    ("route_refresh_broker", "broker_ttl_boundary"): _scenario_broker_ttl_boundary,
    ("route_refresh_broker", "broker_expired_refuses_lock"): _scenario_broker_expired_refuses_lock,
    ("route_refresh_broker", "broker_expired_refuses_swap"): _scenario_broker_expired_refuses_swap,
    ("route_refresh_broker", "broker_expired_vs_unknown"): _scenario_broker_expired_vs_unknown,
    ("route_refresh_broker", "list_family"): _scenario_broker_list_family,
    ("route_refresh_broker", "revoke_family"): _scenario_broker_revoke_family,
    ("route_refresh_broker", "revoke_then_swap"): _scenario_broker_revoke_then_swap,
    ("route_refresh_broker", "acquire_lock_bumps_version"): _scenario_broker_acquire_lock_bumps_version,
    ("route_refresh_broker", "revoke_bumps_version"): _scenario_broker_revoke_bumps_version,
    ("route_refresh_broker", "acquire_lock_sets_refreshing"): _scenario_broker_acquire_lock_sets_refreshing,
    ("route_refresh_broker", "concurrent_acquire_lock"): _scenario_broker_concurrent_acquire_lock,
    ("route_refresh_broker", "concurrent_revoke"): _scenario_broker_concurrent_revoke,
    ("rate_limit", "check_and_increment"): _scenario_rate_limit_check_and_increment,
    ("rate_limit", "window_reset"): _scenario_rate_limit_window_reset,
}


for _family_scenario in (
    "family_create",
    "family_create_binding",
    "family_rotate",
    "family_rotate_wrong_owner",
    "family_rotate_stale_version",
    "family_rotate_existing_successor",
    "family_rotate_generation_mismatch",
    "family_rotate_family_mismatch",
    "family_rotate_legacy",
    "family_missing_state",
    "family_mixed_lineage",
    "family_tombstone_every_member",
    "family_tombstone_beyond_batch",
    "family_revocation_first",
    "family_rotation_first",
    "family_tombstone_survives_expiry",
):
    _STORE_SCENARIOS[("route_refresh_broker", _family_scenario)] = (
        lambda stores, params, expect, clock, _scenario=_family_scenario: _run_family_scenario(
            stores, _scenario, params, expect, clock
        )
    )


__all__ = [
    "AuthorizationCodeRecord",
    "AuthorizationCodeStore",
    "BrokerExpiredError",
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
    "RouteRefreshBrokerFamilyStore",
    "RouteRefreshBrokerHandleTTLReporter",
    "RouteRefreshBrokerRecord",
    "RouteRefreshBrokerSeeder",
    "RouteRefreshBrokerStore",
    "StoreError",
    "Stores",
    "TransactionRecord",
    "TransactionStore",
    "hash_key",
    "run_store_conformance",
]
