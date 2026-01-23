from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Protocol


class Clock(Protocol):
    def now(self) -> dt.datetime: ...


@dataclass(slots=True)
class RealClock:
    def now(self) -> dt.datetime:
        return dt.datetime.now(tz=dt.UTC)


@dataclass(slots=True)
class ManualClock:
    _now: dt.datetime

    def __init__(self, now: dt.datetime | None = None) -> None:
        self._now = now or dt.datetime.fromtimestamp(0, tz=dt.UTC)

    def now(self) -> dt.datetime:
        return self._now

    def set(self, now: dt.datetime) -> None:
        self._now = now

    def advance(self, delta: dt.timedelta) -> dt.datetime:
        self._now = self._now + delta
        return self._now
