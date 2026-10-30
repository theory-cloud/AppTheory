from __future__ import annotations

import datetime as dt
import json
import unittest
from pathlib import Path
from typing import Any

from apptheory.clock import ManualClock
from apptheory.oauth.store import (
    STATUS_ACTIVE,
    STATUS_REFRESHING,
    STATUS_REVOKED,
    UTC_NOW_LOCK_TTL_SECONDS,
    AuthorizationCodeRecord,
    BrokerExpiredError,
    BrokerLockedError,
    BrokerRevokedError,
    BrokerVersionConflictError,
    ClientRecord,
    ClientVersionConflictError,
    ConsumeResult,
    MemoryAuthorizationCodeStore,
    MemoryClientStore,
    MemoryRateLimitStore,
    MemoryRouteRefreshBrokerStore,
    MemoryTransactionStore,
    RateLimitBucketKey,
    RouteRefreshBrokerRecord,
    TransactionRecord,
    run_store_conformance,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"
FIXTURE_NAME = "facade-store-conformance.v1.json"

STORE_CLASSES = {
    "transaction": MemoryTransactionStore,
    "authorization_code": MemoryAuthorizationCodeStore,
    "client": MemoryClientStore,
    "route_refresh_broker": MemoryRouteRefreshBrokerStore,
    "rate_limit": MemoryRateLimitStore,
}


class NonTerminalCodeStore(MemoryAuthorizationCodeStore):
    """Deliberately broken: a replayed or expired-burned consume looks fresh."""

    def consume(self, code_hash: str) -> ConsumeResult | None:
        result = super().consume(code_hash)
        if result is not None and (result.replayed or result.expired):
            return ConsumeResult(record=result.record, replayed=False, expired=False)
        return result


class TTLIgnoringBrokerStore(MemoryRouteRefreshBrokerStore):
    """Deliberately broken: the requested TTL is ignored and handles outlive the table."""

    TTL_SECONDS = 360000

    def __init__(self, now: Any = None, ttl: int | None = None, lock_ttl_seconds: int = UTC_NOW_LOCK_TTL_SECONDS) -> None:
        super().__init__(now=now, ttl=self.TTL_SECONDS, lock_ttl_seconds=lock_ttl_seconds)


class NonBumpingBrokerStore(MemoryRouteRefreshBrokerStore):
    """Deliberately broken: a read hides the version bump a lock or revoke advanced.

    The Go and TypeScript reference brokers mark a locked record ``refreshing``;
    this reference broker keeps it ``active`` and records the lock only in the
    owner/expiry fields, so a currently held lock counts as the bumped record a
    read must report one version lower.
    """

    def get(self, handle_hash: str) -> RouteRefreshBrokerRecord | None:
        record = super().get(handle_hash)
        if record is None:
            return None
        holds_lock = bool(record.refresh_lock_owner) and (
            record.refresh_lock_expires_at is not None and self._now() < record.refresh_lock_expires_at
        )
        if record.status in (STATUS_REVOKED, STATUS_REFRESHING) or holds_lock:
            record.version -= 1
        return record


# A row run against a broken store fails either as a conformance assertion
# mismatch or as the store's own error surfacing through a scenario that assumes
# the operation succeeds: hiding a lock's version bump makes the versioned-swap
# row present a stale version, so its store call raises a version conflict.
_BROKEN_STORE_FAILURES = (AssertionError, BrokerVersionConflictError)


def _load_fixture(name: str) -> dict[str, Any]:
    with (FIXTURE_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def _epoch(raw: str) -> dt.datetime:
    return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))


class StoreConformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture(FIXTURE_NAME)
        cls.clock = ManualClock(_epoch(cls.fixture["clock"]["epoch"]))

    def test_fixture_table_is_complete(self) -> None:
        cases = self.fixture["cases"]
        self.assertEqual(len(cases), 65)
        self.assertEqual(
            {case["store"] for case in cases},
            {"transaction", "authorization_code", "client", "route_refresh_broker", "rate_limit"},
        )
        self.assertEqual(self.fixture["ttl_seconds"]["transaction_max"], 600)

    def test_fixture_cases(self) -> None:
        cases = self.fixture["cases"]
        ran = run_store_conformance(STORE_CLASSES, cases, self.clock)
        print(f"store conformance: {ran} cases run")
        self.assertEqual(ran, 65)
        self.assertEqual(len(cases), 65)

    def test_fixture_lock_ttl_is_the_mandated_default(self) -> None:
        # A conforming durable store is judged against the table's
        # lock_ttl_seconds, so the table must carry the framework-mandated lock
        # TTL (15 s: the M2.1 hardened upstream HTTP deadline plus a five-second
        # margin) or it would judge a correct store as non-conforming.
        ttls = [
            int(case["params"]["lock_ttl_seconds"])
            for case in self.fixture["cases"]
            if "lock_ttl_seconds" in case.get("params", {})
        ]
        self.assertTrue(ttls, "no conformance row pins a lock_ttl_seconds")
        self.assertEqual(max(ttls), UTC_NOW_LOCK_TTL_SECONDS)

    def test_every_scenario_is_exercised(self) -> None:
        # Bidirectional: dropping or duplicating a shared row must fail here
        # rather than silently shrinking coverage. Distinct (store, scenario)
        # pairs are five fewer than the 48 rows: the broker TTL boundary is
        # probed by two rows that share one scenario, the code payload rows
        # share the consume_record_payload scenario, the four put_payload rows
        # pair that scenario with three stores, the two client put_get_update
        # rows (one with a put_version, one without) share one scenario, and the
        # two revoke_family rows share one scenario.
        pairs = {(case["store"], case["scenario"]) for case in self.fixture["cases"]}
        self.assertEqual(len(pairs), 59)


class TransactionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))
        self.store = MemoryTransactionStore(now=self.clock.now, ttl=600)

    def test_consume_is_single_use_and_unknown_is_not_found(self) -> None:
        self.store.put(TransactionRecord(state_hash="h"))
        first = self.store.consume("h")
        self.assertIsNotNone(first)
        self.assertEqual(first.status, "consumed")
        self.assertIsNone(self.store.consume("h"))
        self.assertIsNone(self.store.consume("missing"))

    def test_expired_record_is_reported_as_expired_once(self) -> None:
        self.store.put(TransactionRecord(state_hash="h"))
        self.clock.advance(dt.timedelta(seconds=601))
        expired = self.store.consume("h")
        self.assertIsNotNone(expired)
        self.assertEqual(expired.status, "expired")
        self.assertIsNone(self.store.consume("h"))


class AuthorizationCodeStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))
        self.store = MemoryAuthorizationCodeStore(now=self.clock.now, ttl=60)

    def test_replay_is_distinguishable_from_unknown(self) -> None:
        self.store.put(AuthorizationCodeRecord(code_hash="c"))
        first = self.store.consume("c")
        self.assertIsNotNone(first)
        self.assertFalse(first.replayed)
        second = self.store.consume("c")
        self.assertIsNotNone(second)
        self.assertTrue(second.replayed)
        self.assertIsNone(self.store.consume("unknown"))

    def test_replay_returns_the_retained_record_unmutated(self) -> None:
        self.store.put(AuthorizationCodeRecord(code_hash="c"))
        self.store.consume("c")
        self.clock.advance(dt.timedelta(seconds=61))
        replayed = self.store.consume("c")
        self.assertIsNotNone(replayed)
        self.assertTrue(replayed.replayed)
        self.assertFalse(replayed.expired)
        # The store returns the retained record unmutated -- its status and
        # version are the caller's, as in Go's reference store -- so a replay
        # never re-stamps the record it returns.
        self.assertEqual(replayed.record.status, "issued")
        self.assertEqual(replayed.record.version, 1)

    def test_expired_code_is_burned_expired_on_first_consume_then_replayed(self) -> None:
        self.store.put(AuthorizationCodeRecord(code_hash="e"))
        self.clock.advance(dt.timedelta(seconds=61))
        first = self.store.consume("e")
        self.assertIsNotNone(first)
        self.assertFalse(first.replayed)
        self.assertTrue(first.expired)
        # A first consume of an expired code returns no record, matching Go.
        self.assertIsNone(first.record)
        second = self.store.consume("e")
        self.assertIsNotNone(second)
        self.assertTrue(second.replayed)
        self.assertEqual(second.record.status, "issued")


class ClientStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))
        self.store = MemoryClientStore(now=self.clock.now)

    def test_update_advances_version_and_stale_update_conflicts(self) -> None:
        stored = self.store.put(ClientRecord(client_id_hash="c", client_id="client"))
        self.assertEqual(stored.version, 1)
        updated = self.store.update(stored, 1)
        self.assertEqual(updated.version, 2)
        self.assertEqual(self.store.get("c").version, 2)
        with self.assertRaises(ClientVersionConflictError):
            self.store.update(stored, 1)

    def test_get_unknown_is_none(self) -> None:
        self.assertIsNone(self.store.get("missing"))


class RouteRefreshBrokerStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))
        self.store = MemoryRouteRefreshBrokerStore(
            now=self.clock.now, ttl=900, lock_ttl_seconds=UTC_NOW_LOCK_TTL_SECONDS
        )

    def test_lock_is_exclusive_and_expires(self) -> None:
        self.store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        self.store.acquire_lock("h", "owner-1", 1)
        with self.assertRaises(BrokerLockedError):
            self.store.acquire_lock("h", "owner-2", 2)
        self.clock.advance(dt.timedelta(seconds=UTC_NOW_LOCK_TTL_SECONDS + 1))
        locked = self.store.acquire_lock("h", "owner-3", 2)
        self.assertEqual(locked.refresh_lock_owner, "owner-3")

    def test_compare_and_swap_is_versioned(self) -> None:
        self.store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        record = self.store.acquire_lock("h", "owner-1", 1)
        swapped = self.store.compare_and_swap(record, record.version)
        self.assertEqual(swapped.version, record.version + 1)
        with self.assertRaises(BrokerVersionConflictError):
            self.store.compare_and_swap(record, record.version)

    def test_compare_and_swap_unknown_handle_is_not_found(self) -> None:
        # A swap never creates: an absent handle stays absent, even with the
        # version a create-sentinel store would have accepted.
        with self.assertRaises(KeyError):
            self.store.compare_and_swap(RouteRefreshBrokerRecord(handle_hash="unknown", version=0), 0)
        self.assertIsNone(self.store.get("unknown"))

    def test_revoke_is_idempotent_and_terminal(self) -> None:
        self.store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        first = self.store.revoke("h")
        self.assertEqual(first.status, "revoked")
        second = self.store.revoke("h")
        self.assertEqual(second.status, "revoked")
        self.assertEqual(second.version, first.version)
        with self.assertRaises(BrokerRevokedError):
            self.store.acquire_lock("h", "owner-1", second.version)
        self.assertIsNone(self.store.revoke("missing"))

    def test_record_reports_expired_at_the_ttl_boundary(self) -> None:
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=1)
        store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        stored_at = self.clock.now()
        self.clock.set(stored_at + dt.timedelta(seconds=1) - dt.timedelta(microseconds=1))
        self.assertIsNotNone(store.get("h"))
        self.clock.set(stored_at + dt.timedelta(seconds=1))
        with self.assertRaises(BrokerExpiredError):
            store.get("h")
        # The aged-out record is purged when it is observed, so a later read is
        # an unknown handle rather than expired again.
        self.assertIsNone(store.get("h"))

    def test_expired_is_distinguishable_from_unknown(self) -> None:
        # The SPI distinguishes an aged-out handle from one that never existed;
        # the facade renders the same client body for both. Each operation gets
        # its own seeded handle, because observing an aged-out record purges it.
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=900)
        for handle in ("g", "l", "s", "r"):
            store.put(RouteRefreshBrokerRecord(handle_hash=handle))
        self.assertIsNone(store.get("unknown"))
        self.clock.advance(dt.timedelta(seconds=900))
        with self.assertRaises(BrokerExpiredError):
            store.get("g")
        with self.assertRaises(BrokerExpiredError):
            store.acquire_lock("l", "owner", 1)
        with self.assertRaises(BrokerExpiredError):
            store.compare_and_swap(RouteRefreshBrokerRecord(handle_hash="s"), 1)
        with self.assertRaises(BrokerExpiredError):
            store.revoke("r")
        with self.assertRaises(KeyError):
            store.acquire_lock("unknown", "owner", 1)

    def test_family_capability_lists_and_revokes_every_member(self) -> None:
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=900)
        store.create_family(
            RouteRefreshBrokerRecord(
                handle_hash="family-a",
                status=STATUS_ACTIVE,
                chain_generation=1,
                family_hash="family-a",
            )
        )
        store.put(
            RouteRefreshBrokerRecord(
                handle_hash="member-1",
                status=STATUS_ACTIVE,
                chain_generation=2,
                family_hash="family-a",
            )
        )
        store.create_family(
            RouteRefreshBrokerRecord(
                handle_hash="family-b",
                status=STATUS_ACTIVE,
                chain_generation=1,
                family_hash="family-b",
            )
        )
        self.assertEqual(2, len(store.list_family("family-a")))
        self.assertEqual(1, len(store.list_family("family-b")))
        self.assertEqual([], store.list_family(""))

        revoked = store.revoke_family("family-a")
        self.assertEqual(2, len(revoked))
        self.assertTrue(all(record.status == STATUS_REVOKED for record in revoked))
        self.assertEqual(2, len(store.list_family("family-a")))
        self.assertTrue(all(record.status == STATUS_REVOKED for record in store.list_family("family-a")))
        self.assertEqual([STATUS_ACTIVE], [record.status for record in store.list_family("family-b")])

        # Revocation is idempotent: a second call reports the same members and
        # changes neither their status nor their version.
        versions = [record.version for record in store.list_family("family-a")]
        again = store.revoke_family("family-a")
        self.assertEqual(len(revoked), len(again))
        self.assertEqual(versions, [record.version for record in again])

    def test_family_capability_reports_the_handle_ttl(self) -> None:
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=900)
        self.assertEqual(900.0, store.route_refresh_broker_handle_ttl_seconds())

    def test_swap_keeps_the_original_store_instant(self) -> None:
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=900)
        store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        record = store.get("h")
        store.compare_and_swap(record, record.version)
        self.clock.advance(dt.timedelta(seconds=900))
        with self.assertRaises(BrokerExpiredError):
            store.get("h")

    def test_reference_broker_lock_ttl_pins_the_upstream_fetch_deadline(self) -> None:
        # The reference broker store's default lock TTL is the number the
        # brokered refresh grant is built around: 15 seconds is the M2.1 hardened
        # upstream HTTP deadline (10 s, shared by the discovery, token, and JWKS
        # fetches) plus a five-second margin, and it is well above the facade's
        # three-second coalesce wait cap, so a waiter for an in-flight rotation can
        # never outlive and steal the lock. Changing the default without the
        # matching facade change is a silent regression, so the number and the
        # expiry a lock actually writes are both pinned.
        self.assertEqual(15, UTC_NOW_LOCK_TTL_SECONDS)
        store = MemoryRouteRefreshBrokerStore(now=self.clock.now)
        store.put(RouteRefreshBrokerRecord(handle_hash="handle"))
        locked = store.acquire_lock("handle", "owner", 1)
        held = locked.refresh_lock_expires_at - self.clock.now()
        self.assertEqual(dt.timedelta(seconds=UTC_NOW_LOCK_TTL_SECONDS), held)
        with self.assertRaises(BrokerLockedError):
            store.acquire_lock("handle", "thief", locked.version)


class RateLimitStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))
        self.store = MemoryRateLimitStore(now=self.clock.now, ttl=60)
        self.key = RateLimitBucketKey(
            identifier="c", resource="r", operation="register", limit=2, window_seconds=60
        )

    def test_window_budget_and_reset(self) -> None:
        self.assertTrue(self.store.check_and_increment(self.key).allowed)
        self.assertTrue(self.store.check_and_increment(self.key).allowed)
        limited = self.store.check_and_increment(self.key)
        self.assertFalse(limited.allowed)
        self.assertGreater(limited.retry_after_seconds, 0)
        self.clock.advance(dt.timedelta(seconds=61))
        self.assertTrue(self.store.check_and_increment(self.key).allowed)

    def test_limited_result_reports_the_window_bound(self) -> None:
        self.store.check_and_increment(self.key)
        self.store.check_and_increment(self.key)
        result = self.store.check_and_increment(self.key)
        self.assertEqual(result.limit, 2)
        self.assertEqual(result.count, 3)
        self.assertEqual(result.remaining, 0)


class SliceIsolationTests(unittest.TestCase):
    """A list the store hands out, or a caller hands in, must never alias stored state."""

    def setUp(self) -> None:
        self.clock = ManualClock(_epoch("2026-01-01T00:00:00Z"))

    def test_transaction_store_copies_the_caller_scopes(self) -> None:
        store = MemoryTransactionStore(now=self.clock.now)
        record = TransactionRecord(state_hash="tx", scopes=["scope-a"])
        store.put(record)
        record.scopes[0] = "mutated-caller"
        consumed = store.consume("tx")
        self.assertEqual(consumed.scopes, ["scope-a"])

    def test_authorization_code_store_copies_returned_scopes(self) -> None:
        store = MemoryAuthorizationCodeStore(now=self.clock.now)
        record = AuthorizationCodeRecord(code_hash="code", scopes=["scope-a"])
        store.put(record)
        record.scopes[0] = "mutated-caller"
        first = store.consume("code")
        self.assertEqual(first.record.scopes, ["scope-a"])
        first.record.scopes[0] = "mutated-returned"
        replayed = store.consume("code")
        self.assertEqual(replayed.record.scopes, ["scope-a"])

    def test_client_store_copies_returned_lists(self) -> None:
        store = MemoryClientStore(now=self.clock.now)
        record = ClientRecord(
            client_id_hash="client",
            redirect_uris=["https://a.example.test/cb"],
            grant_types=["authorization_code"],
            response_types=["code"],
        )
        store.put(record)
        record.redirect_uris[0] = "mutated-caller"
        stored = store.get("client")
        self.assertEqual(stored.redirect_uris, ["https://a.example.test/cb"])
        stored.redirect_uris[0] = "mutated-returned"
        stored.grant_types[0] = "mutated-returned"
        stored.response_types[0] = "mutated-returned"
        again = store.get("client")
        self.assertEqual(again.redirect_uris, ["https://a.example.test/cb"])
        self.assertEqual(again.grant_types, ["authorization_code"])
        self.assertEqual(again.response_types, ["code"])

    def test_broker_store_copies_returned_scopes(self) -> None:
        store = MemoryRouteRefreshBrokerStore(
            now=self.clock.now, ttl=900, lock_ttl_seconds=UTC_NOW_LOCK_TTL_SECONDS
        )
        record = RouteRefreshBrokerRecord(handle_hash="handle", status="active", scopes=["scope-a"])
        store.put(record)
        record.scopes[0] = "mutated-caller"
        stored = store.get("handle")
        self.assertEqual(stored.scopes, ["scope-a"])
        stored.scopes[0] = "mutated-returned"
        again = store.get("handle")
        self.assertEqual(again.scopes, ["scope-a"])


class StoreConformanceNonVacuityTests(unittest.TestCase):
    """The shared table must fail one deliberately-broken store per semantic it pins."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture(FIXTURE_NAME)
        cls.cases = cls.fixture["cases"]

    def _new_clock(self) -> ManualClock:
        return ManualClock(_epoch(self.fixture["clock"]["epoch"]))

    def _stores(self, **overrides: Any) -> dict[str, Any]:
        stores = dict(STORE_CLASSES)
        stores.update(overrides)
        return stores

    def _failing_row_ids(self, stores: dict[str, Any]) -> list[str]:
        """Runs each row on its own, so one broken bundle reports every failing row."""
        failed: list[str] = []
        for case in self.cases:
            try:
                run_store_conformance(stores, [case], self._new_clock())
            except _BROKEN_STORE_FAILURES:
                failed.append(case["id"])
        return failed

    def _assert_broken_bundle_fails(self, stores: dict[str, Any], expected_rows: list[str]) -> None:
        # The full table must not run to completion against a broken store.
        with self.assertRaises(_BROKEN_STORE_FAILURES):
            run_store_conformance(stores, self.cases, self._new_clock())

        failed = self._failing_row_ids(stores)
        self.assertGreaterEqual(len(failed), 1, "the conformance table reported no failing row")
        for row in expected_rows:
            self.assertIn(row, failed, f"expected row {row} to fail; failing rows: {failed}")
        print("failing rows: " + ", ".join(failed))

    def test_good_baseline_reports_zero_failures(self) -> None:
        ran = run_store_conformance(self._stores(), self.cases, self._new_clock())
        self.assertEqual(ran, len(self.cases))

    def test_non_terminal_code_store_fails_the_table(self) -> None:
        self._assert_broken_bundle_fails(
            self._stores(authorization_code=NonTerminalCodeStore),
            [
                "store.authorization_code.consume_is_single_use_then_replayed",
                "store.authorization_code.expired_consume_then_replay",
                "store.authorization_code.clock_back_after_consume_is_replayed",
                "store.authorization_code.clock_back_after_expired_burn_is_replayed",
                "store.authorization_code.consume_record_payload_live",
                "store.authorization_code.consume_record_payload_expired_burn",
            ],
        )

    def test_ttl_ignoring_broker_store_fails_the_table(self) -> None:
        self._assert_broken_bundle_fails(
            self._stores(route_refresh_broker=TTLIgnoringBrokerStore),
            [
                "store.route_refresh_broker.record_expired_at_ttl_boundary",
                "store.route_refresh_broker.expired_record_refuses_lock",
                "store.route_refresh_broker.expired_record_refuses_swap",
            ],
        )

    def test_non_bumping_broker_store_fails_the_table(self) -> None:
        self._assert_broken_bundle_fails(
            self._stores(route_refresh_broker=NonBumpingBrokerStore),
            [
                "store.route_refresh_broker.acquire_lock_bumps_version",
                "store.route_refresh_broker.revoke_bumps_version",
            ],
        )


if __name__ == "__main__":
    unittest.main()
