from __future__ import annotations

import datetime as dt
import sys
import unittest
from copy import deepcopy
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.clock import ManualClock  # noqa: E402
from apptheory.limited.errors import RateLimiterError, new_error, wrap_error  # noqa: E402
from apptheory.limited.limiter import DynamoRateLimiter, default_config  # noqa: E402
from apptheory.limited.models import RateLimitEntry  # noqa: E402
from apptheory.limited.strategies import (  # noqa: E402
    FixedWindowStrategy,
    MultiWindowStrategy,
    SlidingWindowStrategy,
    WindowConfig,
)
from apptheory.limited.types import Limit, LimitDecision, RateLimitKey  # noqa: E402
from theorydb_py import ConditionFailedError, NotFoundError, TransactUpdate, UpdateAdd, UpdateSetIfNotExists  # noqa: E402


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], RateLimitEntry] = {}
        self.fail_batch_get = False

    def batch_get(self, keys: list[tuple[str, str]], *, consistent_read: bool = False) -> list[RateLimitEntry]:
        _ = consistent_read
        if self.fail_batch_get:
            raise RuntimeError("boom")
        out: list[RateLimitEntry] = []
        for pk, sk in keys:
            item = self.items.get((pk, sk))
            if item is not None:
                out.append(deepcopy(item))
        return out

    def get(self, pk: str, sk: str, *, consistent_read: bool = False) -> RateLimitEntry:
        _ = consistent_read
        item = self.items.get((pk, sk))
        if item is None:
            raise NotFoundError("item not found")
        return deepcopy(item)

    def update(
        self,
        pk: str,
        sk: str,
        updates: dict[str, object],
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, object] | None = None,
    ) -> RateLimitEntry:
        _ = expression_attribute_names

        exists = (pk, sk) in self.items
        item = deepcopy(self.items.get((pk, sk)) or RateLimitEntry(pk=pk, sk=sk))

        if condition_expression and "<" in condition_expression and expression_attribute_values:
            limit = int(expression_attribute_values.get(":limit") or 0)
            if not exists:
                raise ConditionFailedError("missing")
            if not (int(item.count) < limit):
                raise ConditionFailedError("over")

        for field, value in updates.items():
            if isinstance(value, UpdateAdd):
                if field == "count":
                    item.count = int(item.count) + int(value.value or 0)
            elif isinstance(value, UpdateSetIfNotExists):
                current = getattr(item, field)
                if not current:
                    setattr(item, field, value.default_value)
            else:
                setattr(item, field, value)

        self.items[(pk, sk)] = deepcopy(item)
        return deepcopy(item)

    def put(
        self,
        item: RateLimitEntry,
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, object] | None = None,
    ) -> None:
        _ = expression_attribute_names, expression_attribute_values
        key = (item.pk, item.sk)
        if condition_expression and key in self.items:
            raise ConditionFailedError("exists")
        self.items[key] = deepcopy(item)

    def transact_write(self, actions: list[TransactUpdate]) -> None:
        staged = deepcopy(self.items)

        def apply_update(action: TransactUpdate) -> None:
            key = (str(action.pk), str(action.sk or ""))
            exists = key in staged
            current = deepcopy(staged.get(key) or RateLimitEntry(pk=key[0], sk=key[1]))

            if action.condition_expression and "attribute_not_exists" in action.condition_expression:
                max_allowed = int((action.expression_attribute_values or {}).get(":maxAllowed") or 0)
                if exists and not (int(current.count) < max_allowed):
                    raise ConditionFailedError("over")

            for field, value in dict(action.updates).items():
                if isinstance(value, UpdateAdd):
                    if field == "count":
                        current.count = int(current.count) + int(value.value or 0)
                elif isinstance(value, UpdateSetIfNotExists):
                    cur = getattr(current, field)
                    if not cur:
                        setattr(current, field, value.default_value)
                else:
                    setattr(current, field, value)

            staged[key] = deepcopy(current)

        try:
            for action in actions:
                apply_update(action)
        except ConditionFailedError:
            raise

        self.items = staged


class TestLimited(unittest.TestCase):
    def test_error_helpers_include_cause(self) -> None:
        err = new_error("invalid_input", "bad input")
        self.assertEqual(str(err), "bad input")

        cause = ValueError("boom")
        wrapped = wrap_error(cause, "internal_error", "wrapped")
        self.assertIn("wrapped", str(wrapped))
        self.assertIn("boom", str(wrapped))

    def test_strategies_calculate_windows_and_limits(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 1, 30, tzinfo=dt.UTC)

        fixed = FixedWindowStrategy(dt.timedelta(minutes=1), 3)
        fixed.set_identifier_limit("i1", 2)
        fixed.set_resource_limit("/r", 5)
        self.assertEqual(fixed.get_limit(RateLimitKey(identifier="i1", resource="/x", operation="GET")), 2)
        self.assertEqual(fixed.get_limit(RateLimitKey(identifier="i2", resource="/r", operation="GET")), 5)
        self.assertEqual(len(fixed.calculate_windows(now)), 1)

        sliding = SlidingWindowStrategy(dt.timedelta(minutes=2), 10, dt.timedelta(minutes=1))
        sliding.set_resource_limit("/r", 4)
        self.assertEqual(sliding.get_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET")), 4)
        self.assertGreaterEqual(len(sliding.calculate_windows(now)), 1)

        multi = MultiWindowStrategy([WindowConfig(duration_ms=60_000, max_requests=2), WindowConfig(duration_ms=3_600_000, max_requests=10)])
        windows = multi.calculate_windows(now)
        self.assertEqual(len(windows), 2)
        self.assertEqual(multi.get_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET")), 2)
        self.assertFalse(multi.should_allow({windows[0].key: 2, windows[1].key: 0}, 0))

    def test_check_limit_validates_key_fields(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock)

        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="   ", resource="/r", operation="GET"))
        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="i1", resource="   ", operation="GET"))
        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="   "))

    def test_check_and_increment_creates_and_then_denies(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2),
        )

        key = RateLimitKey(identifier="i1", resource="/r", operation="GET")
        d1 = limiter.check_and_increment(key)
        self.assertTrue(d1.allowed)
        self.assertEqual(d1.current_count, 1)

        d2 = limiter.check_and_increment(key)
        self.assertTrue(d2.allowed)
        self.assertEqual(d2.current_count, 2)

        d3 = limiter.check_and_increment(key)
        self.assertFalse(d3.allowed)
        self.assertEqual(d3.current_count, 2)
        self.assertIsNotNone(d3.retry_after_ms)

    def test_record_request_increments_and_sets_metadata(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 100),
        )

        key = RateLimitKey(identifier="i1", resource="/r", operation="GET", metadata={"ip": "127.0.0.1"})
        limiter.record_request(key)
        limiter.record_request(key)

        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        item = table.items[(pk, sk)]
        self.assertEqual(item.count, 2)
        self.assertTrue(item.created_at)
        self.assertTrue(item.updated_at)

    def test_multiwindow_transact_denies_when_any_window_exceeded(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=MultiWindowStrategy(
                [
                    WindowConfig(duration_ms=60_000, max_requests=2),
                    WindowConfig(duration_ms=3_600_000, max_requests=10),
                ]
            ),
        )

        key = RateLimitKey(identifier="i1", resource="/r", operation="GET")
        limiter.check_and_increment(key)
        limiter.check_and_increment(key)
        d3 = limiter.check_and_increment(key)
        self.assertFalse(d3.allowed)
        self.assertEqual(d3.limit, 2)

    def test_check_limit_fail_open(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()
        table.fail_batch_get = True

        cfg = default_config()
        cfg.fail_open = True

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock)
        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(decision.allowed)

    def test_get_usage_reads_minute_and_hour(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock)

        # Pre-seed counts for the current minute/hour windows.
        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        table.items[(pk, sk)] = RateLimitEntry(pk=pk, sk=sk, count=7)

        stats = limiter.get_usage(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertEqual(stats.current_minute.count, 7)
        self.assertEqual(stats.current_hour.count, 7)

    def test_check_limit_denies_and_sets_retry_after(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2),
        )

        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        table.items[(pk, sk)] = RateLimitEntry(pk=pk, sk=sk, count=2)

        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertIsInstance(decision, LimitDecision)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.current_count, 2)
        self.assertEqual(decision.limit, 2)
        self.assertIsNotNone(decision.retry_after_ms)

    def test_check_and_increment_denies_when_limit_is_zero(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 0),
        )

        out = limiter.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertFalse(out.allowed)
        self.assertEqual(out.limit, 0)
        self.assertIsNotNone(out.retry_after_ms)

    def test_check_and_increment_includes_metadata_and_skips_blank_keys(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            table=table,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2),
        )

        key = RateLimitKey(identifier="i1", resource="/r", operation="GET", metadata={"": "ignored", " ip ": "127.0.0.1"})
        d1 = limiter.check_and_increment(key)
        self.assertTrue(d1.allowed)

        ts = int(now.timestamp())
        item = table.items[(f"i1#{ts}", "/r#GET")]
        self.assertIsInstance(item.metadata, dict)
        self.assertIn("ip", item.metadata or {})
        self.assertNotIn("", item.metadata or {})

    def test_check_limit_sliding_sums_counts_and_handles_bad_numbers(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 1, 30, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False

        strategy = SlidingWindowStrategy(dt.timedelta(minutes=2), 10, dt.timedelta(minutes=1))
        windows = strategy.calculate_windows(now)
        expected = 0
        for idx, window in enumerate(windows):
            count = idx + 1
            expected += count
            ts = int(window.start.timestamp())
            table.items[(f"i1#{ts}", "/r#GET")] = RateLimitEntry(pk=f"i1#{ts}", sk="/r#GET", count=count)

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock, strategy=strategy)
        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.current_count, expected)

    def test_check_and_increment_fail_open_on_non_condition_error(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)

        class FailingTable(FakeTable):
            def update(self, *args, **kwargs):  # type: ignore[override]
                _ = args, kwargs
                raise RuntimeError("boom")

        table = FailingTable()
        cfg = default_config()
        cfg.fail_open = True

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock)
        out = limiter.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(out.allowed)

        cfg2 = default_config()
        cfg2.fail_open = False
        limiter2 = DynamoRateLimiter(table=table, config=cfg2, clock=clock)
        with self.assertRaises(RateLimiterError):
            limiter2.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))

    def test_get_usage_applies_identifier_overrides(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        table = FakeTable()

        cfg = default_config()
        cfg.fail_open = False
        cfg.identifier_limits = {
            "i1": Limit(
                requests_per_hour=8,
                requests_per_minute=4,
                burst_capacity=0,
                custom_windows={},
            )
        }

        limiter = DynamoRateLimiter(table=table, config=cfg, clock=clock)

        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        table.items[(pk, sk)] = RateLimitEntry(pk=pk, sk=sk, count=7)

        stats = limiter.get_usage(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertEqual(stats.current_minute.limit, 4)
        self.assertEqual(stats.current_hour.limit, 8)
