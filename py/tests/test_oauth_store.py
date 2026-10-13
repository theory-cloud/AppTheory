from __future__ import annotations

import datetime as dt
import json
import unittest
from pathlib import Path
from typing import Any

from apptheory.clock import ManualClock
from apptheory.oauth.store import (
    AuthorizationCodeRecord,
    BrokerLockedError,
    BrokerRevokedError,
    BrokerVersionConflictError,
    ClientRecord,
    ClientVersionConflictError,
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
        self.assertEqual(len(cases), 20)
        self.assertEqual(
            {case["store"] for case in cases},
            {"transaction", "authorization_code", "client", "route_refresh_broker", "rate_limit"},
        )
        self.assertEqual(self.fixture["ttl_seconds"]["transaction_max"], 600)

    def test_fixture_cases(self) -> None:
        cases = self.fixture["cases"]
        ran = run_store_conformance(STORE_CLASSES, cases, self.clock)
        print(f"store conformance: {ran} cases run")
        self.assertEqual(ran, 20)
        self.assertEqual(len(cases), 20)

    def test_every_scenario_is_exercised(self) -> None:
        # Bidirectional: dropping or duplicating a shared row must fail here
        # rather than silently shrinking coverage.
        pairs = {(case["store"], case["scenario"]) for case in self.fixture["cases"]}
        self.assertEqual(len(pairs), 20)


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

    def test_consumed_record_is_retained_until_ttl(self) -> None:
        self.store.put(AuthorizationCodeRecord(code_hash="c"))
        self.store.consume("c")
        self.clock.advance(dt.timedelta(seconds=61))
        expired = self.store.consume("c")
        self.assertIsNotNone(expired)
        self.assertEqual(expired.record.status, "expired")


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
        self.store = MemoryRouteRefreshBrokerStore(now=self.clock.now, ttl=900, lock_ttl_seconds=30)

    def test_lock_is_exclusive_and_expires(self) -> None:
        self.store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        self.store.acquire_lock("h", "owner-1", 1)
        with self.assertRaises(BrokerLockedError):
            self.store.acquire_lock("h", "owner-2", 2)
        self.clock.advance(dt.timedelta(seconds=31))
        locked = self.store.acquire_lock("h", "owner-3", 2)
        self.assertEqual(locked.refresh_lock_owner, "owner-3")

    def test_compare_and_swap_is_versioned(self) -> None:
        self.store.put(RouteRefreshBrokerRecord(handle_hash="h"))
        record = self.store.acquire_lock("h", "owner-1", 1)
        swapped = self.store.compare_and_swap(record, record.version)
        self.assertEqual(swapped.version, record.version + 1)
        with self.assertRaises(BrokerVersionConflictError):
            self.store.compare_and_swap(record, record.version)

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


if __name__ == "__main__":
    unittest.main()
