from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from apptheory.app import App, create_app
from apptheory.clock import ManualClock
from apptheory.request import Request
from apptheory.response import Response


@dataclass(slots=True)
class TestEnv:
    clock: ManualClock

    def __init__(self, *, now: dt.datetime | None = None) -> None:
        self.clock = ManualClock(now or dt.datetime.fromtimestamp(0, tz=dt.UTC))

    def app(self) -> App:
        return create_app(clock=self.clock)

    def invoke(self, app: App, request: Request) -> Response:
        return app.serve(request)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)

