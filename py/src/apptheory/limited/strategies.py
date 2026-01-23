from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from apptheory.limited.models import format_window_id, get_fixed_window
from apptheory.limited.types import RateLimitKey, RateLimitStrategy, TimeWindow


@dataclass(slots=True)
class FixedWindowStrategy(RateLimitStrategy):
    window_size_ms: int
    max_requests: int
    identifier_limits: dict[str, int]
    resource_limits: dict[str, int]

    def __init__(self, window_size: dt.timedelta, max_requests: int) -> None:
        self.window_size_ms = int(window_size.total_seconds() * 1000)
        self.max_requests = int(max_requests)
        self.identifier_limits = {}
        self.resource_limits = {}

    def calculate_windows(self, now: dt.datetime) -> list[TimeWindow]:
        size = int(self.window_size_ms)
        if size <= 0:
            return []

        now_ms = int(now.timestamp() * 1000)
        start_ms = (now_ms // size) * size
        start = dt.datetime.fromtimestamp(start_ms / 1000, tz=dt.UTC)
        end = dt.datetime.fromtimestamp((start_ms + size) / 1000, tz=dt.UTC)
        return [TimeWindow(start=start, end=end, key=format_window_id(start))]

    def get_limit(self, key: RateLimitKey) -> int:
        if key.identifier in self.identifier_limits:
            return int(self.identifier_limits[key.identifier])
        if key.resource in self.resource_limits:
            return int(self.resource_limits[key.resource])
        return int(self.max_requests)

    def should_allow(self, counts: dict[str, int], limit: int) -> bool:
        return sum(int(v) for v in counts.values()) < int(limit)

    def set_identifier_limit(self, identifier: str, limit: int) -> None:
        self.identifier_limits[str(identifier)] = int(limit)

    def set_resource_limit(self, resource: str, limit: int) -> None:
        self.resource_limits[str(resource)] = int(limit)


@dataclass(slots=True)
class SlidingWindowStrategy(RateLimitStrategy):
    window_size_ms: int
    max_requests: int
    granularity_ms: int
    identifier_limits: dict[str, int]
    resource_limits: dict[str, int]

    def __init__(self, window_size: dt.timedelta, max_requests: int, granularity: dt.timedelta) -> None:
        self.window_size_ms = int(window_size.total_seconds() * 1000)
        self.max_requests = int(max_requests)
        self.granularity_ms = int(granularity.total_seconds() * 1000)
        self.identifier_limits = {}
        self.resource_limits = {}

    def calculate_windows(self, now: dt.datetime) -> list[TimeWindow]:
        window_ms = int(self.window_size_ms)
        if window_ms <= 0:
            return []

        granularity_ms = int(self.granularity_ms) if self.granularity_ms > 0 else 60_000
        sub_windows = max(1, window_ms // granularity_ms)

        now_ms = int(now.timestamp() * 1000)
        current_start_ms = (now_ms // granularity_ms) * granularity_ms

        windows: list[TimeWindow] = []
        for i in range(sub_windows):
            start_ms = current_start_ms - i * granularity_ms
            if now_ms - start_ms > window_ms:
                continue
            start = dt.datetime.fromtimestamp(start_ms / 1000, tz=dt.UTC)
            end = dt.datetime.fromtimestamp((start_ms + granularity_ms) / 1000, tz=dt.UTC)
            windows.append(TimeWindow(start=start, end=end, key=format_window_id(start)))
        return windows

    def get_limit(self, key: RateLimitKey) -> int:
        if key.identifier in self.identifier_limits:
            return int(self.identifier_limits[key.identifier])
        if key.resource in self.resource_limits:
            return int(self.resource_limits[key.resource])
        return int(self.max_requests)

    def should_allow(self, counts: dict[str, int], limit: int) -> bool:
        return sum(int(v) for v in counts.values()) < int(limit)

    def set_identifier_limit(self, identifier: str, limit: int) -> None:
        self.identifier_limits[str(identifier)] = int(limit)

    def set_resource_limit(self, resource: str, limit: int) -> None:
        self.resource_limits[str(resource)] = int(limit)


@dataclass(slots=True)
class WindowConfig:
    duration_ms: int
    max_requests: int


@dataclass(slots=True)
class MultiWindowStrategy(RateLimitStrategy):
    windows: list[WindowConfig]
    identifier_limits: dict[str, list[WindowConfig]]
    resource_limits: dict[str, list[WindowConfig]]

    def __init__(self, windows: list[WindowConfig]) -> None:
        self.windows = [WindowConfig(int(w.duration_ms), int(w.max_requests)) for w in (windows or [])]
        self.identifier_limits = {}
        self.resource_limits = {}

    def calculate_windows(self, now: dt.datetime) -> list[TimeWindow]:
        if not self.windows:
            return []

        out: list[TimeWindow] = []
        for cfg in self.windows:
            if int(cfg.duration_ms) <= 0:
                continue
            win = get_fixed_window(now, int(cfg.duration_ms))
            out.append(
                TimeWindow(
                    start=win.start,
                    end=win.end,
                    key=f"{format_window_id(win.start)}_{int(cfg.duration_ms)}ms",
                )
            )
        return out

    def get_limit(self, key: RateLimitKey) -> int:
        limits = self._limits_for_key(key)
        if not limits:
            return 0
        return int(limits[0].max_requests)

    def should_allow(self, counts: dict[str, int], _limit: int) -> bool:
        if not self.windows:
            return False

        for cfg in self.windows:
            dur = int(cfg.duration_ms)
            if dur <= 0:
                continue
            suffix = f"_{dur}ms"
            count = 0
            for k, v in counts.items():
                if str(k).endswith(suffix):
                    count = int(v)
                    break
            if count >= int(cfg.max_requests):
                return False

        return True

    def _limits_for_key(self, key: RateLimitKey) -> list[WindowConfig]:
        if self.identifier_limits.get(key.identifier):
            return self.identifier_limits[key.identifier]
        if self.resource_limits.get(key.resource):
            return self.resource_limits[key.resource]
        return self.windows
