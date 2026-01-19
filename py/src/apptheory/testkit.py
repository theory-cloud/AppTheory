from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from apptheory.app import App, create_app
from apptheory.clock import ManualClock
from apptheory.ids import IdGenerator, ManualIdGenerator
from apptheory.request import Request
from apptheory.response import Response


@dataclass(slots=True)
class TestEnv:
    clock: ManualClock
    ids: ManualIdGenerator

    def __init__(self, *, now: dt.datetime | None = None) -> None:
        self.clock = ManualClock(now or dt.datetime.fromtimestamp(0, tz=dt.UTC))
        self.ids = ManualIdGenerator()

    def app(self, *, clock: ManualClock | None = None, id_generator: IdGenerator | None = None) -> App:
        return create_app(clock=clock or self.clock, id_generator=id_generator or self.ids)

    def invoke(self, app: App, request: Request) -> Response:
        return app.serve(request)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)
