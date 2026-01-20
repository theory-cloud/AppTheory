from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from apptheory.aws_http import build_apigw_v2_request, build_lambda_function_url_request
from apptheory.app import App, AuthHook, Limits, ObservabilityHooks, PolicyHook, create_app
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

    def app(
        self,
        *,
        clock: ManualClock | None = None,
        id_generator: IdGenerator | None = None,
        tier: str | None = None,
        limits: Limits | None = None,
        auth_hook: AuthHook | None = None,
        observability: ObservabilityHooks | None = None,
        policy_hook: PolicyHook | None = None,
    ) -> App:
        kwargs: dict[str, object] = {
            "clock": clock or self.clock,
            "id_generator": id_generator or self.ids,
        }
        if tier is not None:
            kwargs["tier"] = tier
        if limits is not None:
            kwargs["limits"] = limits
        if auth_hook is not None:
            kwargs["auth_hook"] = auth_hook
        if observability is not None:
            kwargs["observability"] = observability
        if policy_hook is not None:
            kwargs["policy_hook"] = policy_hook
        return create_app(**kwargs)

    def invoke(self, app: App, request: Request) -> Response:
        return app.serve(request)

    def invoke_apigw_v2(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_apigw_v2(event, ctx=ctx)

    def invoke_lambda_function_url(
        self, app: App, event: dict[str, object], ctx: object | None = None
    ) -> dict[str, object]:
        return app.serve_lambda_function_url(event, ctx=ctx)

    def invoke_sqs(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_sqs(event, ctx=ctx)

    def invoke_eventbridge(self, app: App, event: dict[str, object], ctx: object | None = None) -> object:
        return app.serve_eventbridge(event, ctx=ctx)

    def invoke_dynamodb_stream(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_dynamodb_stream(event, ctx=ctx)

    def invoke_lambda(self, app: App, event: object, ctx: object | None = None) -> object:
        return app.handle_lambda(event, ctx=ctx)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)
