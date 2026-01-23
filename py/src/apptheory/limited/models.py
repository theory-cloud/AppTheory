from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass, field


@dataclass(slots=True)
class RateLimitEntry:
    pk: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "PK",
                "roles": ["pk"],
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    sk: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "SK",
                "roles": ["sk"],
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )

    identifier: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "Identifier",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    resource: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "Resource",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    operation: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "Operation",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )

    window_start: int = field(
        default=0,
        metadata={
            "theorydb": {
                "name": "WindowStart",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    window_type: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "WindowType",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    window_id: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "WindowID",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )

    count: int = field(
        default=0,
        metadata={
            "theorydb": {
                "name": "Count",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    ttl: int = field(
        default=0,
        metadata={
            "theorydb": {
                "name": "TTL",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )

    created_at: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "CreatedAt",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    updated_at: str = field(
        default="",
        metadata={
            "theorydb": {
                "name": "UpdatedAt",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )
    metadata: dict[str, str] | None = field(
        default=None,
        metadata={
            "theorydb": {
                "name": "Metadata",
                "omitempty": False,
                "set": False,
                "json": False,
                "binary": False,
                "encrypted": False,
                "converter": None,
                "ignore": False,
            }
        },
    )


def set_keys(entry: RateLimitEntry) -> None:
    entry.pk = f"{entry.identifier}#{entry.window_start}"
    entry.sk = f"{entry.resource}#{entry.operation}"


def rate_limit_table_name() -> str:
    return (
        os.environ.get("APPTHEORY_RATE_LIMIT_TABLE_NAME", "").strip()
        or os.environ.get("RATE_LIMIT_TABLE_NAME", "").strip()
        or os.environ.get("RATE_LIMIT_TABLE", "").strip()
        or os.environ.get("LIMITED_TABLE_NAME", "").strip()
        or "rate-limits"
    )


@dataclass(slots=True)
class RateLimitWindow:
    window_type: str
    start: dt.datetime
    end: dt.datetime


def unix_seconds(value: dt.datetime) -> int:
    return int(value.timestamp())


def format_window_id(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def format_rfc3339_nano(value: dt.datetime) -> str:
    v = value.astimezone(dt.UTC)
    base = v.strftime("%Y-%m-%dT%H:%M:%S")
    ns = f"{v.microsecond:06d}000"
    return f"{base}.{ns}Z"


def get_minute_window(now: dt.datetime) -> RateLimitWindow:
    start = now.astimezone(dt.UTC).replace(second=0, microsecond=0)
    return RateLimitWindow(window_type="MINUTE", start=start, end=start + dt.timedelta(minutes=1))


def get_hour_window(now: dt.datetime) -> RateLimitWindow:
    start = now.astimezone(dt.UTC).replace(minute=0, second=0, microsecond=0)
    return RateLimitWindow(window_type="HOUR", start=start, end=start + dt.timedelta(hours=1))


def get_day_window(now: dt.datetime) -> RateLimitWindow:
    start = now.astimezone(dt.UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return RateLimitWindow(window_type="DAY", start=start, end=start + dt.timedelta(days=1))


def get_fixed_window(now: dt.datetime, duration_ms: int) -> RateLimitWindow:
    dur = int(duration_ms)
    if dur <= 0:
        return RateLimitWindow(window_type="CUSTOM_0ms", start=now, end=now)

    now_ms = int(now.timestamp() * 1000)
    start_ms = (now_ms // dur) * dur
    start = dt.datetime.fromtimestamp(start_ms / 1000, tz=dt.UTC)
    end = dt.datetime.fromtimestamp((start_ms + dur) / 1000, tz=dt.UTC)
    return RateLimitWindow(window_type=f"CUSTOM_{dur}ms", start=start, end=end)
