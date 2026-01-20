from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from apptheory.aws_http import build_apigw_v2_request, build_lambda_function_url_request
from apptheory.app import App, AuthHook, Limits, ObservabilityHooks, PolicyHook, create_app
from apptheory.clock import ManualClock
from apptheory.context import WebSocketClientFactory
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

    def invoke_websocket(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_websocket(event, ctx=ctx)

    def invoke_lambda(self, app: App, event: object, ctx: object | None = None) -> object:
        return app.handle_lambda(event, ctx=ctx)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)


def build_websocket_event(
    *,
    route_key: str,
    event_type: str = "MESSAGE",
    connection_id: str = "conn-1",
    domain_name: str = "example.execute-api.us-east-1.amazonaws.com",
    stage: str = "dev",
    request_id: str = "ws-req-1",
    method: str = "POST",
    path: str = "/",
    headers: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
    body: str = "",
    is_base64: bool = False,
) -> dict[str, Any]:
    return {
        "path": str(path or "/"),
        "httpMethod": str(method or "").strip().upper(),
        "headers": dict(headers or {}),
        "queryStringParameters": dict(query or {}),
        "requestContext": {
            "stage": str(stage or "").strip(),
            "requestId": str(request_id or "").strip(),
            "connectionId": str(connection_id or "").strip(),
            "domainName": str(domain_name or "").strip(),
            "eventType": str(event_type or "").strip(),
            "routeKey": str(route_key or "").strip(),
        },
        "body": str(body or ""),
        "isBase64Encoded": bool(is_base64),
    }


@dataclass(slots=True)
class WebSocketCall:
    op: str
    endpoint: str
    connection_id: str
    data: bytes = b""


class FakeWebSocketManagementClient:
    def __init__(self, endpoint: str) -> None:
        self.endpoint = str(endpoint or "").strip()
        self.calls: list[WebSocketCall] = []

    def post_to_connection(self, connection_id: str, data: bytes) -> None:
        self.calls.append(
            WebSocketCall(
                op="post_to_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
                data=bytes(data or b""),
            )
        )

    def get_connection(self, connection_id: str) -> dict[str, Any]:
        self.calls.append(
            WebSocketCall(
                op="get_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
            )
        )
        return {}

    def delete_connection(self, connection_id: str) -> None:
        self.calls.append(
            WebSocketCall(
                op="delete_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
            )
        )


class FakeWebSocketClientFactory:
    def __init__(self) -> None:
        self.clients: dict[str, FakeWebSocketManagementClient] = {}

    def __call__(self, endpoint: str, _ctx: Any | None) -> FakeWebSocketManagementClient:
        key = str(endpoint or "").strip()
        if key not in self.clients:
            self.clients[key] = FakeWebSocketManagementClient(key)
        return self.clients[key]


def create_fake_websocket_client_factory() -> WebSocketClientFactory:
    return FakeWebSocketClientFactory()
