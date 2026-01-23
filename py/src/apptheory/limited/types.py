from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Protocol


@dataclass(slots=True)
class RateLimitKey:
    identifier: str
    resource: str
    operation: str
    metadata: dict[str, str] | None = None


@dataclass(slots=True)
class LimitDecision:
    allowed: bool
    current_count: int
    limit: int
    resets_at: dt.datetime
    retry_after_ms: int | None = None


@dataclass(slots=True)
class UsageWindow:
    count: int
    limit: int
    window_start: dt.datetime
    window_end: dt.datetime


@dataclass(slots=True)
class UsageStats:
    identifier: str
    resource: str
    current_hour: UsageWindow
    current_minute: UsageWindow
    daily_total: int
    custom_windows: dict[str, UsageWindow]


class RateLimiter(Protocol):
    def check_limit(self, key: RateLimitKey) -> LimitDecision: ...
    def record_request(self, key: RateLimitKey) -> None: ...
    def get_usage(self, key: RateLimitKey) -> UsageStats: ...


class AtomicRateLimiter(RateLimiter, Protocol):
    def check_and_increment(self, key: RateLimitKey) -> LimitDecision: ...


@dataclass(slots=True)
class TimeWindow:
    start: dt.datetime
    end: dt.datetime
    key: str


class RateLimitStrategy(Protocol):
    def calculate_windows(self, now: dt.datetime) -> list[TimeWindow]: ...
    def get_limit(self, key: RateLimitKey) -> int: ...
    def should_allow(self, counts: dict[str, int], limit: int) -> bool: ...


@dataclass(slots=True)
class WindowLimit:
    duration_ms: int
    requests: int


@dataclass(slots=True)
class Limit:
    requests_per_hour: int
    requests_per_minute: int
    burst_capacity: int
    custom_windows: dict[str, WindowLimit]


@dataclass(slots=True)
class Config:
    default_requests_per_hour: int
    default_requests_per_minute: int
    default_burst_capacity: int

    enable_burst_capacity: bool
    enable_soft_limits: bool
    fail_open: bool

    table_name: str
    consistent_read: bool
    ttl_hours: int

    identifier_limits: dict[str, Limit]
    resource_limits: dict[str, Limit]
