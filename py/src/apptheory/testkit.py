from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from apptheory.aws_http import build_apigw_v2_request, build_lambda_function_url_request
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

    def invoke_apigw_v2(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_apigw_v2(event, ctx=ctx)

    def invoke_lambda_function_url(
        self, app: App, event: dict[str, object], ctx: object | None = None
    ) -> dict[str, object]:
        return app.serve_lambda_function_url(event, ctx=ctx)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)
