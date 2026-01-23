from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from apptheory.clock import Clock, RealClock
from apptheory.limited.dynamodb import DynamoDBClient
from apptheory.limited.errors import RateLimiterError, new_error, wrap_error
from apptheory.limited.models import (
    RateLimitEntry,
    format_rfc3339_nano,
    format_window_id,
    get_hour_window,
    get_minute_window,
    rate_limit_table_name,
    set_keys,
    unix_seconds,
)
from apptheory.limited.strategies import FixedWindowStrategy, MultiWindowStrategy, SlidingWindowStrategy
from apptheory.limited.types import (
    Config,
    LimitDecision,
    RateLimitKey,
    RateLimitStrategy,
    TimeWindow,
    UsageStats,
    UsageWindow,
)


def default_config() -> Config:
    return Config(
        default_requests_per_hour=1000,
        default_requests_per_minute=100,
        default_burst_capacity=10,
        enable_burst_capacity=False,
        enable_soft_limits=False,
        fail_open=True,
        table_name="rate-limits",
        consistent_read=False,
        ttl_hours=1,
        identifier_limits={},
        resource_limits={},
    )


def _normalize_config(config: Config | None) -> Config:
    if config is None:
        return default_config()
    return config


def _normalize_key(key: RateLimitKey) -> RateLimitKey:
    return RateLimitKey(
        identifier=str(key.identifier or "").strip(),
        resource=str(key.resource or "").strip(),
        operation=str(key.operation or "").strip(),
        metadata=dict(key.metadata or {}) if key.metadata is not None else None,
    )


def _validate_key(key: RateLimitKey) -> None:
    if not key.identifier:
        raise new_error("invalid_input", "identifier is required")
    if not key.resource:
        raise new_error("invalid_input", "resource is required")
    if not key.operation:
        raise new_error("invalid_input", "operation is required")


def _is_condition_failed(exc: Exception) -> bool:
    name = str(getattr(exc, "__class__", type("x", (), {})).__name__)
    if name in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
        return True
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        err = resp.get("Error") if isinstance(resp.get("Error"), dict) else {}
        code = str(err.get("Code") or "").strip()
        return code in {"ConditionalCheckFailedException", "TransactionCanceledException"}
    return False


def _av_s(value: str) -> dict[str, str]:
    return {"S": str(value)}


def _av_n(value: int) -> dict[str, str]:
    return {"N": str(int(value))}


def _av_string_map(value: dict[str, str] | None) -> dict[str, Any]:
    m: dict[str, Any] = {}
    for k, v in (value or {}).items():
        key = str(k).strip()
        if not key:
            continue
        m[key] = _av_s(str(v))
    return {"M": m}


def _get_number(item: dict[str, Any] | None, key: str) -> int:
    if not isinstance(item, dict):
        return 0
    av = item.get(key)
    if not isinstance(av, dict) or "N" not in av:
        return 0
    try:
        return int(float(str(av.get("N") or "0")))
    except Exception:  # noqa: BLE001
        return 0


def _count_for_primary_window(strategy: RateLimitStrategy, windows: list[TimeWindow], counts: dict[str, int]) -> int:
    if not windows:
        return 0
    if isinstance(strategy, SlidingWindowStrategy):
        return sum(int(v) for v in counts.values())
    return int(counts.get(windows[0].key, 0))


def _max_requests_for_window(strategy: MultiWindowStrategy, window: TimeWindow) -> int:
    idx = window.key.rfind("_")
    if idx != -1 and idx < len(window.key) - 1:
        suffix = window.key[idx + 1 :].strip()
        if suffix.endswith("ms"):
            try:
                dur_ms = int(suffix[:-2])
            except Exception:  # noqa: BLE001
                dur_ms = 0
            if dur_ms > 0:
                for cfg in strategy.windows:
                    if int(cfg.duration_ms) == dur_ms:
                        return int(cfg.max_requests)
    return int(strategy.windows[0].max_requests) if strategy.windows else 0


def _reset_time_for_decision(
    strategy: RateLimitStrategy,
    now: dt.datetime,
    windows: list[TimeWindow],
    counts: dict[str, int],
    allowed: bool,
) -> dt.datetime:
    if not windows:
        return now
    if allowed or not isinstance(strategy, MultiWindowStrategy):
        return windows[0].end

    max_reset = windows[0].end
    for window in windows:
        max_allowed = _max_requests_for_window(strategy, window)
        if max_allowed <= 0:
            if window.end > max_reset:
                max_reset = window.end
            continue
        if int(counts.get(window.key, 0)) >= max_allowed and window.end > max_reset:
            max_reset = window.end
    return max_reset


@dataclass(slots=True)
class DynamoRateLimiter:
    dynamo: Any
    config: Config
    strategy: RateLimitStrategy
    clock: Clock

    def __init__(
        self,
        *,
        dynamo: Any | None = None,
        config: Config | None = None,
        strategy: RateLimitStrategy | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.config = _normalize_config(config)
        self.strategy = strategy or FixedWindowStrategy(dt.timedelta(hours=1), self.config.default_requests_per_hour)
        self.dynamo = dynamo or DynamoDBClient()
        self.clock = clock or RealClock()

    def set_clock(self, clock: Clock | None) -> None:
        self.clock = clock or RealClock()

    def check_limit(self, key: RateLimitKey) -> LimitDecision:
        k = _normalize_key(key)
        _validate_key(k)

        now = self.clock.now()
        windows = self.strategy.calculate_windows(now)
        if not windows:
            raise new_error("internal_error", "no windows calculated")

        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        counts: dict[str, int] = {}
        for window in windows:
            entry = RateLimitEntry(
                identifier=k.identifier,
                resource=k.resource,
                operation=k.operation,
                window_start=unix_seconds(window.start),
            )
            set_keys(entry)
            try:
                out = self.dynamo.get_item(
                    TableName=table,
                    Key={"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                    ConsistentRead=bool(cfg.consistent_read),
                )
            except Exception as exc:
                if cfg.fail_open:
                    return LimitDecision(
                        allowed=True,
                        current_count=0,
                        limit=int(self.strategy.get_limit(k)),
                        resets_at=windows[0].end,
                    )
                raise wrap_error(exc, "internal_error", "failed to check rate limit") from exc

            item = out.get("Item") if isinstance(out, dict) else None
            counts[window.key] = _get_number(item, "Count")

        limit = int(self.strategy.get_limit(k))
        allowed = bool(self.strategy.should_allow(counts, limit))
        current_count = _count_for_primary_window(self.strategy, windows, counts)
        resets_at = _reset_time_for_decision(self.strategy, now, windows, counts, allowed)
        retry_after_ms = max(0, int((resets_at - now).total_seconds() * 1000)) if not allowed else None
        return LimitDecision(
            allowed=allowed,
            current_count=int(current_count),
            limit=int(limit),
            resets_at=resets_at,
            retry_after_ms=retry_after_ms,
        )

    def record_request(self, key: RateLimitKey) -> None:
        k = _normalize_key(key)
        _validate_key(k)

        now = self.clock.now()
        windows = self.strategy.calculate_windows(now)
        if not windows:
            raise new_error("internal_error", "no windows calculated")

        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        target_windows = windows if isinstance(self.strategy, MultiWindowStrategy) else windows[:1]

        now_str = format_rfc3339_nano(now)
        for window in target_windows:
            entry = RateLimitEntry(
                identifier=k.identifier,
                resource=k.resource,
                operation=k.operation,
                window_start=unix_seconds(window.start),
            )
            set_keys(entry)

            ttl = unix_seconds(window.end) + int(cfg.ttl_hours) * 3600
            window_id = format_window_id(window.start)

            try:
                self.dynamo.update_item(
                    TableName=table,
                    Key={"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                    UpdateExpression=(
                        "ADD #Count :inc SET #UpdatedAt=:now, "
                        "#WindowType=if_not_exists(#WindowType,:wt), "
                        "#WindowID=if_not_exists(#WindowID,:wid), "
                        "#Identifier=if_not_exists(#Identifier,:id), "
                        "#Resource=if_not_exists(#Resource,:res), "
                        "#Operation=if_not_exists(#Operation,:op), "
                        "#WindowStart=if_not_exists(#WindowStart,:ws), "
                        "#TTL=if_not_exists(#TTL,:ttl), "
                        "#CreatedAt=if_not_exists(#CreatedAt,:now)"
                    ),
                    ExpressionAttributeNames={
                        "#Count": "Count",
                        "#UpdatedAt": "UpdatedAt",
                        "#WindowType": "WindowType",
                        "#WindowID": "WindowID",
                        "#Identifier": "Identifier",
                        "#Resource": "Resource",
                        "#Operation": "Operation",
                        "#WindowStart": "WindowStart",
                        "#TTL": "TTL",
                        "#CreatedAt": "CreatedAt",
                    },
                    ExpressionAttributeValues={
                        ":inc": _av_n(1),
                        ":now": _av_s(now_str),
                        ":wt": _av_s(window.key),
                        ":wid": _av_s(window_id),
                        ":id": _av_s(k.identifier),
                        ":res": _av_s(k.resource),
                        ":op": _av_s(k.operation),
                        ":ws": _av_n(unix_seconds(window.start)),
                        ":ttl": _av_n(ttl),
                    },
                )
            except Exception as exc:
                raise wrap_error(exc, "internal_error", "failed to record request") from exc

    def get_usage(self, key: RateLimitKey) -> UsageStats:
        k = _normalize_key(key)
        _validate_key(k)

        now = self.clock.now()
        minute_window = get_minute_window(now)
        hour_window = get_hour_window(now)

        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        minute_limit = int(cfg.default_requests_per_minute)
        hour_limit = int(cfg.default_requests_per_hour)
        ident_override = cfg.identifier_limits.get(k.identifier) if isinstance(cfg.identifier_limits, dict) else None
        if ident_override is not None:
            if int(ident_override.requests_per_minute) > 0:
                minute_limit = int(ident_override.requests_per_minute)
            if int(ident_override.requests_per_hour) > 0:
                hour_limit = int(ident_override.requests_per_hour)

        def load_count(window_start: dt.datetime) -> int:
            entry = RateLimitEntry(
                identifier=k.identifier,
                resource=k.resource,
                operation=k.operation,
                window_start=unix_seconds(window_start),
            )
            set_keys(entry)
            out = self.dynamo.get_item(
                TableName=table,
                Key={"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                ConsistentRead=bool(cfg.consistent_read),
            )
            item = out.get("Item") if isinstance(out, dict) else None
            return _get_number(item, "Count")

        try:
            minute_count = load_count(minute_window.start)
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to get minute usage") from exc

        try:
            hour_count = load_count(hour_window.start)
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to get hour usage") from exc

        return UsageStats(
            identifier=k.identifier,
            resource=k.resource,
            custom_windows={},
            current_minute=UsageWindow(
                count=int(minute_count),
                limit=int(minute_limit),
                window_start=minute_window.start,
                window_end=minute_window.end,
            ),
            current_hour=UsageWindow(
                count=int(hour_count),
                limit=int(hour_limit),
                window_start=hour_window.start,
                window_end=hour_window.end,
            ),
            daily_total=int(hour_count),
        )

    def check_and_increment(self, key: RateLimitKey) -> LimitDecision:
        k = _normalize_key(key)
        _validate_key(k)

        now = self.clock.now()
        if isinstance(self.strategy, MultiWindowStrategy):
            return self._check_and_increment_multi_window(k, now, self.strategy)
        return self._check_and_increment_single_window(k, now)

    def _check_and_increment_single_window(self, key: RateLimitKey, now: dt.datetime) -> LimitDecision:
        windows = self.strategy.calculate_windows(now)
        if not windows:
            raise new_error("internal_error", "no windows calculated")

        window = windows[0]
        limit = int(self.strategy.get_limit(key))

        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        entry = RateLimitEntry(
            identifier=key.identifier,
            resource=key.resource,
            operation=key.operation,
            window_start=unix_seconds(window.start),
        )
        set_keys(entry)

        try:
            out = self.dynamo.update_item(
                TableName=table,
                Key={"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                UpdateExpression="ADD #Count :inc SET #UpdatedAt=:now",
                ConditionExpression="#Count < :limit",
                ExpressionAttributeNames={"#Count": "Count", "#UpdatedAt": "UpdatedAt"},
                ExpressionAttributeValues={
                    ":inc": _av_n(1),
                    ":now": _av_s(format_rfc3339_nano(now)),
                    ":limit": _av_n(limit),
                },
                ReturnValues="ALL_NEW",
            )
            attrs = out.get("Attributes") if isinstance(out, dict) else None
            count = _get_number(attrs, "Count")
            return LimitDecision(allowed=True, current_count=int(count), limit=int(limit), resets_at=window.end)
        except RateLimiterError:
            raise
        except Exception as exc:
            if _is_condition_failed(exc):
                return self._handle_single_window_condition_failed(key, now, window, limit, entry)
            if cfg.fail_open:
                return LimitDecision(allowed=True, current_count=0, limit=int(limit), resets_at=window.end)
            raise wrap_error(exc, "internal_error", "failed to check and increment rate limit") from exc

    def _handle_single_window_condition_failed(
        self,
        key: RateLimitKey,
        now: dt.datetime,
        window: TimeWindow,
        limit: int,
        entry: RateLimitEntry,
    ) -> LimitDecision:
        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        try:
            out = self.dynamo.get_item(
                TableName=table,
                Key={"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                ConsistentRead=bool(cfg.consistent_read),
            )
        except Exception as exc:
            if cfg.fail_open:
                return LimitDecision(allowed=True, current_count=0, limit=int(limit), resets_at=window.end)
            raise wrap_error(exc, "internal_error", "failed to load rate limit entry") from exc

        item = out.get("Item") if isinstance(out, dict) else None
        if isinstance(item, dict):
            count = _get_number(item, "Count")
            return LimitDecision(
                allowed=False,
                current_count=int(count),
                limit=int(limit),
                resets_at=window.end,
                retry_after_ms=max(0, int((window.end - now).total_seconds() * 1000)),
            )

        return self._create_single_window_entry(key, now, window, limit)

    def _create_single_window_entry(
        self,
        key: RateLimitKey,
        now: dt.datetime,
        window: TimeWindow,
        limit: int,
    ) -> LimitDecision:
        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        if limit <= 0:
            return LimitDecision(
                allowed=False,
                current_count=0,
                limit=int(limit),
                resets_at=window.end,
                retry_after_ms=max(0, int((window.end - now).total_seconds() * 1000)),
            )

        entry = RateLimitEntry(
            identifier=key.identifier,
            resource=key.resource,
            operation=key.operation,
            window_start=unix_seconds(window.start),
            window_type=window.key,
            window_id=format_window_id(window.start),
            count=1,
            created_at=format_rfc3339_nano(now),
            updated_at=format_rfc3339_nano(now),
            ttl=unix_seconds(window.end) + int(cfg.ttl_hours) * 3600,
            metadata=dict(key.metadata or {}) if key.metadata is not None else {},
        )
        set_keys(entry)

        item = {
            "PK": _av_s(entry.pk),
            "SK": _av_s(entry.sk),
            "Identifier": _av_s(entry.identifier),
            "Resource": _av_s(entry.resource),
            "Operation": _av_s(entry.operation),
            "WindowStart": _av_n(entry.window_start),
            "WindowType": _av_s(entry.window_type),
            "WindowID": _av_s(entry.window_id),
            "Count": _av_n(entry.count),
            "TTL": _av_n(entry.ttl),
            "CreatedAt": _av_s(entry.created_at),
            "UpdatedAt": _av_s(entry.updated_at),
            "Metadata": _av_string_map(entry.metadata),
        }

        try:
            self.dynamo.put_item(
                TableName=table,
                Item=item,
                ConditionExpression="attribute_not_exists(#PK)",
                ExpressionAttributeNames={"#PK": "PK"},
            )
            return LimitDecision(allowed=True, current_count=1, limit=int(limit), resets_at=window.end)
        except Exception as exc:
            if _is_condition_failed(exc):
                return self.check_and_increment(key)
            if cfg.fail_open:
                return LimitDecision(allowed=True, current_count=0, limit=int(limit), resets_at=window.end)
            raise wrap_error(exc, "internal_error", "failed to create rate limit entry") from exc

    def _check_and_increment_multi_window(
        self,
        key: RateLimitKey,
        now: dt.datetime,
        strategy: MultiWindowStrategy,
    ) -> LimitDecision:
        windows = strategy.calculate_windows(now)
        if not windows:
            raise new_error("internal_error", "no windows calculated")

        primary_limit = int(strategy.get_limit(key))
        if primary_limit <= 0:
            return LimitDecision(
                allowed=False,
                current_count=0,
                limit=int(primary_limit),
                resets_at=windows[0].end,
                retry_after_ms=max(0, int((windows[0].end - now).total_seconds() * 1000)),
            )

        cfg = self.config
        table = cfg.table_name or rate_limit_table_name()

        now_str = format_rfc3339_nano(now)
        transact_items: list[dict[str, Any]] = []
        for window in windows:
            max_allowed = _max_requests_for_window(strategy, window)
            if max_allowed <= 0:
                decision = self.check_limit(key)
                decision.allowed = False
                decision.retry_after_ms = decision.retry_after_ms or max(
                    0,
                    int((decision.resets_at - now).total_seconds() * 1000),
                )
                return decision

            entry = RateLimitEntry(
                identifier=key.identifier,
                resource=key.resource,
                operation=key.operation,
                window_start=unix_seconds(window.start),
            )
            set_keys(entry)

            ttl = unix_seconds(window.end) + int(cfg.ttl_hours) * 3600
            window_id = format_window_id(window.start)

            transact_items.append(
                {
                    "Update": {
                        "TableName": table,
                        "Key": {"PK": _av_s(entry.pk), "SK": _av_s(entry.sk)},
                        "UpdateExpression": (
                            "ADD #Count :inc SET #UpdatedAt=:now, "
                            "#WindowType=if_not_exists(#WindowType,:wt), "
                            "#WindowID=if_not_exists(#WindowID,:wid), "
                            "#Identifier=if_not_exists(#Identifier,:id), "
                            "#Resource=if_not_exists(#Resource,:res), "
                            "#Operation=if_not_exists(#Operation,:op), "
                            "#WindowStart=if_not_exists(#WindowStart,:ws), "
                            "#TTL=if_not_exists(#TTL,:ttl), "
                            "#CreatedAt=if_not_exists(#CreatedAt,:now)"
                        ),
                        "ConditionExpression": "attribute_not_exists(#Count) OR #Count < :maxAllowed",
                        "ExpressionAttributeNames": {
                            "#Count": "Count",
                            "#UpdatedAt": "UpdatedAt",
                            "#WindowType": "WindowType",
                            "#WindowID": "WindowID",
                            "#Identifier": "Identifier",
                            "#Resource": "Resource",
                            "#Operation": "Operation",
                            "#WindowStart": "WindowStart",
                            "#TTL": "TTL",
                            "#CreatedAt": "CreatedAt",
                        },
                        "ExpressionAttributeValues": {
                            ":inc": _av_n(1),
                            ":now": _av_s(now_str),
                            ":wt": _av_s(window.key),
                            ":wid": _av_s(window_id),
                            ":id": _av_s(key.identifier),
                            ":res": _av_s(key.resource),
                            ":op": _av_s(key.operation),
                            ":ws": _av_n(unix_seconds(window.start)),
                            ":ttl": _av_n(ttl),
                            ":maxAllowed": _av_n(int(max_allowed)),
                        },
                    }
                }
            )

        try:
            self.dynamo.transact_write_items(TransactItems=transact_items)
        except Exception as exc:
            if _is_condition_failed(exc):
                decision = self.check_limit(key)
                decision.allowed = False
                decision.retry_after_ms = decision.retry_after_ms or max(
                    0,
                    int((decision.resets_at - now).total_seconds() * 1000),
                )
                return decision
            if cfg.fail_open:
                return LimitDecision(allowed=True, current_count=0, limit=int(primary_limit), resets_at=windows[0].end)
            raise wrap_error(exc, "internal_error", "failed to check and increment rate limit") from exc

        # Load the primary window count.
        primary = windows[0]
        primary_entry = RateLimitEntry(
            identifier=key.identifier,
            resource=key.resource,
            operation=key.operation,
            window_start=unix_seconds(primary.start),
        )
        set_keys(primary_entry)
        try:
            out = self.dynamo.get_item(
                TableName=table,
                Key={"PK": _av_s(primary_entry.pk), "SK": _av_s(primary_entry.sk)},
                ConsistentRead=bool(cfg.consistent_read),
            )
            item = out.get("Item") if isinstance(out, dict) else None
            count = _get_number(item, "Count")
        except Exception as exc:
            if cfg.fail_open:
                return LimitDecision(allowed=True, current_count=0, limit=int(primary_limit), resets_at=primary.end)
            raise wrap_error(exc, "internal_error", "failed to load updated rate limit entry") from exc

        return LimitDecision(allowed=True, current_count=int(count), limit=int(primary_limit), resets_at=primary.end)
