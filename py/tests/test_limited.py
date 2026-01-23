from __future__ import annotations

import datetime as dt
import sys
import unittest
from copy import deepcopy
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.clock import ManualClock  # noqa: E402
from apptheory.limited.dynamodb import DynamoDBClient  # noqa: E402
from apptheory.limited.errors import RateLimiterError, new_error, wrap_error  # noqa: E402
from apptheory.limited.limiter import DynamoRateLimiter, default_config  # noqa: E402
from apptheory.limited.strategies import (  # noqa: E402
    FixedWindowStrategy,
    MultiWindowStrategy,
    SlidingWindowStrategy,
    WindowConfig,
)
from apptheory.limited.types import Limit, LimitDecision, RateLimitKey  # noqa: E402


class ConditionalCheckFailedException(Exception):
    pass


class TransactionCanceledException(Exception):
    pass


class FakeDynamo:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict] = {}
        self.fail_get = False

    @staticmethod
    def _get_s(av: object) -> str:
        return str(av.get("S") or "") if isinstance(av, dict) else ""

    @staticmethod
    def _get_n(av: object) -> int:
        if not isinstance(av, dict) or "N" not in av:
            return 0
        try:
            return int(float(str(av.get("N") or "0")))
        except Exception:  # noqa: BLE001
            return 0

    def get_item(self, *, Key: dict, **_kwargs) -> dict:
        if self.fail_get:
            raise RuntimeError("boom")
        pk = self._get_s(Key.get("PK"))
        sk = self._get_s(Key.get("SK"))
        item = self.items.get((pk, sk))
        return {"Item": deepcopy(item)} if item is not None else {}

    def put_item(self, *, Item: dict, ConditionExpression: str | None = None, **_kwargs) -> dict:
        pk = self._get_s(Item.get("PK"))
        sk = self._get_s(Item.get("SK"))
        if ConditionExpression and (pk, sk) in self.items:
            raise ConditionalCheckFailedException("exists")
        self.items[(pk, sk)] = deepcopy(Item)
        return {}

    def update_item(
        self,
        *,
        Key: dict,
        UpdateExpression: str,
        ExpressionAttributeValues: dict,
        ConditionExpression: str | None = None,
        ReturnValues: str | None = None,
        **_kwargs,
    ) -> dict:
        pk = self._get_s(Key.get("PK"))
        sk = self._get_s(Key.get("SK"))
        item = deepcopy(self.items.get((pk, sk)) or {})

        inc = self._get_n(ExpressionAttributeValues.get(":inc"))
        cond = str(ConditionExpression or "")

        if "#Count <" in cond:
            if "Count" not in item:
                raise ConditionalCheckFailedException("missing")
            limit = self._get_n(ExpressionAttributeValues.get(":limit"))
            current = self._get_n(item.get("Count"))
            if not (current < limit):
                raise ConditionalCheckFailedException("over")

        if "attribute_not_exists" in cond and ":maxAllowed" in cond:
            max_allowed = self._get_n(ExpressionAttributeValues.get(":maxAllowed"))
            current = self._get_n(item.get("Count")) if "Count" in item else 0
            if "Count" in item and not (current < max_allowed):
                raise ConditionalCheckFailedException("over")

        if "ADD #Count" in UpdateExpression:
            current = self._get_n(item.get("Count")) if "Count" in item else 0
            item["Count"] = {"N": str(current + inc)}

        if ":now" in ExpressionAttributeValues:
            item["UpdatedAt"] = ExpressionAttributeValues[":now"]

        if "if_not_exists" in UpdateExpression:
            def set_if_missing(name: str, token: str) -> None:
                if name not in item and token in ExpressionAttributeValues:
                    item[name] = ExpressionAttributeValues[token]

            set_if_missing("WindowType", ":wt")
            set_if_missing("WindowID", ":wid")
            set_if_missing("Identifier", ":id")
            set_if_missing("Resource", ":res")
            set_if_missing("Operation", ":op")
            set_if_missing("WindowStart", ":ws")
            set_if_missing("TTL", ":ttl")
            set_if_missing("CreatedAt", ":now")

        self.items[(pk, sk)] = deepcopy(item)

        if ReturnValues == "ALL_NEW":
            return {"Attributes": deepcopy(item)}
        return {}

    def transact_write_items(self, *, TransactItems: list[dict], **_kwargs) -> dict:
        staged = deepcopy(self.items)
        try:
            for tx in TransactItems:
                upd = tx.get("Update") if isinstance(tx, dict) else None
                if not isinstance(upd, dict):
                    continue
                pk = self._get_s(upd.get("Key", {}).get("PK"))
                sk = self._get_s(upd.get("Key", {}).get("SK"))
                # Apply using the same logic as update_item, but against staged.
                tmp = FakeDynamo()
                tmp.items = staged
                tmp.update_item(**upd)
                staged = tmp.items
        except ConditionalCheckFailedException as exc:
            raise TransactionCanceledException(str(exc)) from exc

        self.items = staged
        return {}


class TestLimited(unittest.TestCase):
    def test_error_helpers_include_cause(self) -> None:
        err = new_error("invalid_input", "bad input")
        self.assertEqual(str(err), "bad input")

        cause = ValueError("boom")
        wrapped = wrap_error(cause, "internal_error", "wrapped")
        self.assertIn("wrapped", str(wrapped))
        self.assertIn("boom", str(wrapped))

    def test_dynamodb_client_uses_injected_boto_client(self) -> None:
        calls: list[str] = []

        class FakeBoto:
            def get_item(self, **_kwargs) -> dict:
                calls.append("get_item")
                return {"Item": {"PK": {"S": "pk"}}}

            def update_item(self, **_kwargs) -> dict:
                calls.append("update_item")
                return {"Attributes": {"Count": {"N": "1"}}}

            def put_item(self, **_kwargs) -> dict:
                calls.append("put_item")
                return {}

            def transact_write_items(self, **_kwargs) -> dict:
                calls.append("transact_write_items")
                return {}

        c = DynamoDBClient()
        c._boto = FakeBoto()

        self.assertIn("Item", c.get_item(TableName="t", Key={"PK": {"S": "pk"}, "SK": {"S": "sk"}}))
        self.assertIn("Attributes", c.update_item(TableName="t", Key={"PK": {"S": "pk"}, "SK": {"S": "sk"}}, UpdateExpression=""))
        c.put_item(TableName="t", Item={"PK": {"S": "pk"}, "SK": {"S": "sk"}})
        c.transact_write_items(TransactItems=[])
        self.assertEqual(calls, ["get_item", "update_item", "put_item", "transact_write_items"])

    def test_dynamodb_client_requires_boto3_when_not_injected(self) -> None:
        import builtins

        real_import = builtins.__import__

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
            if name == "boto3":
                raise ImportError("no boto3")
            return real_import(name, globals, locals, fromlist, level)

        builtins.__import__ = fake_import
        try:
            c = DynamoDBClient(region="us-east-1")
            with self.assertRaises(RuntimeError):
                c.get_item(TableName="t", Key={"PK": {"S": "pk"}, "SK": {"S": "sk"}})
        finally:
            builtins.__import__ = real_import

    def test_dynamodb_client_creates_boto3_client_with_region_and_endpoint(self) -> None:
        import types

        calls: list[tuple[str, str | None, str | None]] = []

        class FakeBotoClient:
            def get_item(self, **_kwargs) -> dict:
                return {"Item": {"PK": {"S": "pk"}}}

            def update_item(self, **_kwargs) -> dict:
                return {"Attributes": {"Count": {"N": "1"}}}

            def put_item(self, **_kwargs) -> dict:
                return {}

            def transact_write_items(self, **_kwargs) -> dict:
                return {}

        fake_boto3 = types.ModuleType("boto3")

        def client(service_name, region_name=None, endpoint_url=None):
            calls.append((str(service_name), region_name, endpoint_url))
            return FakeBotoClient()

        fake_boto3.client = client  # type: ignore[attr-defined]

        prev = sys.modules.get("boto3")
        sys.modules["boto3"] = fake_boto3
        try:
            c = DynamoDBClient(region="us-east-1", endpoint_url="http://localhost")
            self.assertIn("Item", c.get_item(TableName="t", Key={"PK": {"S": "pk"}, "SK": {"S": "sk"}}))
            self.assertIn("Attributes", c.update_item(TableName="t", Key={"PK": {"S": "pk"}, "SK": {"S": "sk"}}, UpdateExpression=""))

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "dynamodb")
            self.assertEqual(calls[0][1], "us-east-1")
            self.assertEqual(calls[0][2], "http://localhost")
        finally:
            if prev is None:
                del sys.modules["boto3"]
            else:
                sys.modules["boto3"] = prev

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
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock)

        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="   ", resource="/r", operation="GET"))
        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="i1", resource="   ", operation="GET"))
        with self.assertRaises(RateLimiterError):
            limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="   "))

    def test_check_and_increment_creates_and_then_denies(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
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
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
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
        item = dynamo.items[(pk, sk)]
        self.assertEqual(item["Count"]["N"], "2")
        self.assertIn("CreatedAt", item)
        self.assertIn("UpdatedAt", item)

    def test_multiwindow_transact_denies_when_any_window_exceeded(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
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
        dynamo = FakeDynamo()
        dynamo.fail_get = True

        cfg = default_config()
        cfg.fail_open = True

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock)
        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(decision.allowed)

    def test_get_usage_reads_minute_and_hour(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock)

        # Pre-seed counts for the current minute/hour windows.
        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        dynamo.items[(pk, sk)] = {
            "PK": {"S": pk},
            "SK": {"S": sk},
            "Count": {"N": "7"},
        }

        stats = limiter.get_usage(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertEqual(stats.current_minute.count, 7)
        self.assertEqual(stats.current_hour.count, 7)

    def test_check_limit_denies_and_sets_retry_after(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2),
        )

        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        dynamo.items[(pk, sk)] = {"PK": {"S": pk}, "SK": {"S": sk}, "Count": {"N": "2"}}

        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertIsInstance(decision, LimitDecision)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.current_count, 2)
        self.assertEqual(decision.limit, 2)
        self.assertIsNotNone(decision.retry_after_ms)

    def test_check_and_increment_denies_when_limit_is_zero(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
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
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(
            dynamo=dynamo,
            config=cfg,
            clock=clock,
            strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2),
        )

        key = RateLimitKey(identifier="i1", resource="/r", operation="GET", metadata={"": "ignored", " ip ": "127.0.0.1"})
        d1 = limiter.check_and_increment(key)
        self.assertTrue(d1.allowed)

        ts = int(now.timestamp())
        item = dynamo.items[(f"i1#{ts}", "/r#GET")]
        m = item.get("Metadata", {}).get("M", {})
        self.assertIn("ip", m)
        self.assertNotIn("", m)

    def test_check_limit_sliding_sums_counts_and_handles_bad_numbers(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 1, 30, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

        cfg = default_config()
        cfg.fail_open = False

        strategy = SlidingWindowStrategy(dt.timedelta(minutes=2), 10, dt.timedelta(minutes=1))
        windows = strategy.calculate_windows(now)
        expected = 0
        for idx, window in enumerate(windows):
            count = idx + 1
            expected += count
            ts = int(window.start.timestamp())
            dynamo.items[(f"i1#{ts}", "/r#GET")] = {
                "PK": {"S": f"i1#{ts}"},
                "SK": {"S": "/r#GET"},
                "Count": {"N": str(count)},
            }

        # Ensure malformed numbers are treated as 0.
        if windows:
            ts0 = int(windows[0].start.timestamp())
            dynamo.items[(f"i1#{ts0}", "/r#GET")]["Count"]["N"] = "not-a-number"
            expected -= 1

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock, strategy=strategy)
        decision = limiter.check_limit(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.current_count, expected)

    def test_check_and_increment_handles_boto_style_condition_error(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)

        class BotoStyleConditionError(Exception):
            def __init__(self) -> None:
                super().__init__("conditional")
                self.response = {"Error": {"Code": "ConditionalCheckFailedException"}}

        class BotoStyleDynamo(FakeDynamo):
            def update_item(self, **_kwargs) -> dict:  # type: ignore[override]
                raise BotoStyleConditionError()

        dynamo = BotoStyleDynamo()
        cfg = default_config()
        cfg.fail_open = False

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock, strategy=FixedWindowStrategy(dt.timedelta(minutes=1), 2))
        out = limiter.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(out.allowed)
        self.assertEqual(out.current_count, 1)

    def test_check_and_increment_fail_open_on_non_condition_error(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)

        class FailingDynamo(FakeDynamo):
            def update_item(self, **_kwargs) -> dict:  # type: ignore[override]
                raise RuntimeError("boom")

        dynamo = FailingDynamo()
        cfg = default_config()
        cfg.fail_open = True

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock)
        out = limiter.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertTrue(out.allowed)

        cfg2 = default_config()
        cfg2.fail_open = False
        limiter2 = DynamoRateLimiter(dynamo=dynamo, config=cfg2, clock=clock)
        with self.assertRaises(RateLimiterError):
            limiter2.check_and_increment(RateLimitKey(identifier="i1", resource="/r", operation="GET"))

    def test_get_usage_applies_identifier_overrides(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 0, tzinfo=dt.UTC)
        clock = ManualClock(now)
        dynamo = FakeDynamo()

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

        limiter = DynamoRateLimiter(dynamo=dynamo, config=cfg, clock=clock)

        ts = int(now.timestamp())
        pk = f"i1#{ts}"
        sk = "/r#GET"
        dynamo.items[(pk, sk)] = {"PK": {"S": pk}, "SK": {"S": sk}, "Count": {"N": "7"}}

        stats = limiter.get_usage(RateLimitKey(identifier="i1", resource="/r", operation="GET"))
        self.assertEqual(stats.current_minute.limit, 4)
        self.assertEqual(stats.current_hour.limit, 8)
