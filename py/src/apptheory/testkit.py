from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from apptheory.app import App, AuthHook, Limits, ObservabilityHooks, PolicyHook, create_app
from apptheory.clock import ManualClock
from apptheory.context import WebSocketClientFactory
from apptheory.errors import AppError, AppTheoryError
from apptheory.ids import IdGenerator, ManualIdGenerator
from apptheory.request import Request
from apptheory.response import Response


@dataclass(slots=True)
class StreamResult:
    status: int
    headers: dict[str, list[str]]
    cookies: list[str]
    chunks: list[bytes]
    body: bytes
    is_base64: bool
    stream_error_code: str


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
        websocket_client_factory: WebSocketClientFactory | None = None,
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
        if websocket_client_factory is not None:
            kwargs["websocket_client_factory"] = websocket_client_factory
        return create_app(**kwargs)

    def invoke(self, app: App, request: Request) -> Response:
        return app.serve(request)

    def invoke_streaming(self, app: App, request: Request, ctx: object | None = None) -> StreamResult:
        resp = app.serve(request, ctx=ctx)

        headers = {str(k): [str(v) for v in (vs or [])] for k, vs in (resp.headers or {}).items()}
        cookies = [str(c) for c in (resp.cookies or [])]

        chunks: list[bytes] = []
        parts: list[bytes] = []

        if resp.body:
            b = bytes(resp.body)
            chunks.append(b)
            parts.append(b)

        stream_error_code = ""
        if resp.body_stream is not None:
            try:
                for chunk in resp.body_stream:
                    b = bytes(chunk or b"")
                    chunks.append(b)
                    parts.append(b)
            except Exception as exc:  # noqa: BLE001
                stream_error_code = (
                    str(exc.code or "") if isinstance(exc, (AppError, AppTheoryError)) else "app.internal"
                )

        return StreamResult(
            status=int(resp.status),
            headers=headers,
            cookies=cookies,
            chunks=chunks,
            body=b"".join(parts),
            is_base64=bool(resp.is_base64),
            stream_error_code=stream_error_code,
        )

    def invoke_apigw_v2(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_apigw_v2(event, ctx=ctx)

    def invoke_lambda_function_url(
        self, app: App, event: dict[str, object], ctx: object | None = None
    ) -> dict[str, object]:
        return app.serve_lambda_function_url(event, ctx=ctx)

    def invoke_alb(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_alb(event, ctx=ctx)

    def invoke_sqs(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_sqs(event, ctx=ctx)

    def invoke_eventbridge(self, app: App, event: dict[str, object], ctx: object | None = None) -> object:
        return app.serve_eventbridge(event, ctx=ctx)

    def invoke_dynamodb_stream(
        self, app: App, event: dict[str, object], ctx: object | None = None
    ) -> dict[str, object]:
        return app.serve_dynamodb_stream(event, ctx=ctx)

    def invoke_kinesis(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_kinesis(event, ctx=ctx)

    def invoke_sns(self, app: App, event: dict[str, object], ctx: object | None = None) -> object:
        return app.serve_sns(event, ctx=ctx)

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
        self.connections: dict[str, dict[str, Any]] = {}
        self.post_error: Exception | None = None
        self.get_error: Exception | None = None
        self.delete_error: Exception | None = None

    def post_to_connection(self, connection_id: str, data: bytes) -> None:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        self.calls.append(
            WebSocketCall(
                op="post_to_connection",
                endpoint=self.endpoint,
                connection_id=conn,
                data=bytes(data or b""),
            )
        )
        if self.post_error is not None:
            raise self.post_error

    def get_connection(self, connection_id: str) -> dict[str, Any]:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        self.calls.append(
            WebSocketCall(
                op="get_connection",
                endpoint=self.endpoint,
                connection_id=conn,
            )
        )
        if self.get_error is not None:
            raise self.get_error
        if conn not in self.connections:
            raise RuntimeError("apptheory: connection not found")
        return dict(self.connections.get(conn) or {})

    def delete_connection(self, connection_id: str) -> None:
        conn = str(connection_id or "").strip()
        if not conn:
            raise RuntimeError("apptheory: websocket connection id is empty")
        self.calls.append(
            WebSocketCall(
                op="delete_connection",
                endpoint=self.endpoint,
                connection_id=conn,
            )
        )
        if self.delete_error is not None:
            raise self.delete_error
        self.connections.pop(conn, None)


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
