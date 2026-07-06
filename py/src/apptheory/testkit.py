from __future__ import annotations

import datetime as dt
import gzip
import json as jsonlib
import math
from dataclasses import dataclass
from typing import Any

from apptheory.app import App, AuthHook, Limits, ObservabilityHooks, PolicyHook, create_app
from apptheory.aws_events import AppSyncResolverEvent
from apptheory.aws_events import build_appsync_event as _build_appsync_event
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
        kwargs: dict[str, Any] = {
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

    def invoke_appsync(self, app: App, event: AppSyncResolverEvent, ctx: object | None = None) -> object:
        return app.serve_appsync(event, ctx=ctx)

    def invoke_websocket(self, app: App, event: dict[str, object], ctx: object | None = None) -> dict[str, object]:
        return app.serve_websocket(event, ctx=ctx)

    def invoke_lambda(self, app: App, event: object, ctx: object | None = None) -> object:
        return app.handle_lambda(event, ctx=ctx)


def create_test_env(*, now: dt.datetime | None = None) -> TestEnv:
    return TestEnv(now=now)


def build_appsync_event(**kwargs: Any) -> AppSyncResolverEvent:
    return _build_appsync_event(**kwargs)


def cloudwatch_logs_subscription_data(
    *,
    message_type: str = "",
    owner: str = "",
    log_group: str = "",
    log_stream: str = "",
    subscription_filters: list[str] | None = None,
    log_events: list[dict[str, Any]] | None = None,
) -> bytes:
    payload = {
        "messageType": _default_cloudwatch_logs_subscription_message_type(message_type),
        "owner": _default_cloudwatch_logs_subscription_owner(owner),
        "logGroup": _default_cloudwatch_logs_subscription_log_group(log_group),
        "logStream": _default_cloudwatch_logs_subscription_log_stream(log_stream),
        "subscriptionFilters": _default_cloudwatch_logs_subscription_filters(subscription_filters),
        "logEvents": _default_cloudwatch_logs_subscription_log_events(log_events),
    }
    raw = jsonlib.dumps(payload, separators=(",", ":")).encode("utf-8")
    return gzip.compress(raw, mtime=0)


def kinesis_cloudwatch_logs_subscription_record(
    *,
    event_id: str = "",
    event_source_arn: str = "",
    partition_key: str = "",
    subscription: dict[str, Any] | None = None,
) -> dict[str, Any]:
    subscription = subscription or {}
    record: dict[str, Any] = {
        "data": cloudwatch_logs_subscription_data(
            message_type=str(subscription.get("message_type") or ""),
            owner=str(subscription.get("owner") or ""),
            log_group=str(subscription.get("log_group") or ""),
            log_stream=str(subscription.get("log_stream") or ""),
            subscription_filters=subscription.get("subscription_filters"),
            log_events=subscription.get("log_events"),
        )
    }
    if event_id:
        record["eventID"] = event_id
    if event_source_arn:
        record["eventSourceARN"] = event_source_arn
    if partition_key:
        record["partitionKey"] = partition_key
    return record


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


def _default_cloudwatch_logs_subscription_message_type(value: str) -> str:
    normalized = str(value or "").strip()
    return normalized or "DATA_MESSAGE"


def _default_cloudwatch_logs_subscription_owner(value: str) -> str:
    normalized = str(value or "").strip()
    return normalized or "000000000000"


def _default_cloudwatch_logs_subscription_log_group(value: str) -> str:
    normalized = str(value or "").strip()
    return normalized or "/aws/lambda/apptheory-test"


def _default_cloudwatch_logs_subscription_log_stream(value: str) -> str:
    normalized = str(value or "").strip()
    return normalized or "1970/01/01/[$LATEST]apptheory-test"


def _default_cloudwatch_logs_subscription_filters(filters: list[str] | None) -> list[str]:
    if not filters:
        return ["apptheory-test-filter"]
    return [str(filter_value or "").strip() for filter_value in filters]


def _default_cloudwatch_logs_subscription_log_events(log_events: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not log_events:
        return [{"id": "cwl-event-1", "timestamp": 0, "message": "test log line"}]
    out: list[dict[str, Any]] = []
    for event in log_events:
        event_obj = event if isinstance(event, dict) else {}
        out.append(
            {
                "id": str(event_obj.get("id") or "").strip(),
                "timestamp": _cloudwatch_logs_subscription_log_event_timestamp(event_obj.get("timestamp")),
                "message": str(event_obj.get("message") or ""),
            }
        )
    return out


def _cloudwatch_logs_subscription_log_event_timestamp(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    return 0


@dataclass(slots=True)
class McpTestSSEFrame:
    id: str = ""
    data: str = ""
    event: str = ""


@dataclass(slots=True)
class McpTestResult:
    response: Response
    body: bytes
    body_json: Any | None
    sse_frames: list[McpTestSSEFrame]


class _FixedIdGenerator:
    def __init__(self, id: str) -> None:
        self.id = str(id)

    def new_id(self) -> str:
        return self.id


class McpTestHarness:
    app: App
    server: Any
    path: str

    def __init__(self, server: Any, *, path: str = "/mcp", app_id_generator: IdGenerator | None = None) -> None:
        from apptheory.mcp import MCP_HEADER_LAST_EVENT_ID, MCP_HEADER_PROTOCOL_VERSION, MCP_HEADER_SESSION_ID

        self._mcp_session_header = MCP_HEADER_SESSION_ID
        self._mcp_protocol_header = MCP_HEADER_PROTOCOL_VERSION
        self._mcp_last_event_header = MCP_HEADER_LAST_EVENT_ID
        self.server = server
        self.path = _normalize_mcp_test_path(path)
        self.app = create_app(id_generator=app_id_generator or _FixedIdGenerator("req_mcp_test"))
        handler = server.handler()
        self.app.post(self.path, handler)
        self.app.get(self.path, handler)
        self.app.delete(self.path, handler)

    def invoke(
        self,
        *,
        method: str = "POST",
        path: str = "",
        headers: dict[str, Any] | None = None,
        body: bytes | str | None = None,
        body_json: Any | None = None,
        session_id: str = "",
        protocol_version: str = "",
        last_event_id: str = "",
    ) -> McpTestResult:
        request = self.request(
            method=method,
            path=path,
            headers=headers,
            body=body,
            body_json=body_json,
            session_id=session_id,
            protocol_version=protocol_version,
            last_event_id=last_event_id,
        )
        response = self.app.serve(request)
        response_body = _mcp_response_body_bytes(response)
        parsed: Any | None = None
        if _mcp_has_json_response(response) and response_body:
            parsed = jsonlib.loads(response_body.decode("utf-8"))
        return McpTestResult(
            response=response,
            body=response_body,
            body_json=parsed,
            sse_frames=parse_mcp_test_sse_frames(response_body),
        )

    def initialize(self, *, id: str | int = "init", protocol_version: str = "") -> McpTestResult:
        from apptheory.mcp import MCP_PROTOCOL_VERSION

        return self.invoke(
            body_json={
                "jsonrpc": "2.0",
                "id": id,
                "method": "initialize",
                "params": {"protocolVersion": protocol_version or MCP_PROTOCOL_VERSION},
            }
        )

    def call(self, session_id: str, method: str, params: Any | None = None, id: str | int = "call") -> McpTestResult:
        return self.invoke(
            session_id=session_id,
            body_json={"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}},
        )

    def request(
        self,
        *,
        method: str = "POST",
        path: str = "",
        headers: dict[str, Any] | None = None,
        body: bytes | str | None = None,
        body_json: Any | None = None,
        session_id: str = "",
        protocol_version: str = "",
        last_event_id: str = "",
    ) -> Request:
        from apptheory.mcp import MCP_PROTOCOL_VERSION

        normalized_method = str(method or "POST").strip().upper()
        out_headers = _canonical_mcp_test_headers(headers or {})
        if normalized_method == "POST":
            _set_mcp_default_header(out_headers, "content-type", "application/json")
            _set_mcp_default_header(out_headers, "accept", "application/json, text/event-stream")
        if normalized_method == "GET":
            _set_mcp_default_header(out_headers, "accept", "text/event-stream")
        if session_id:
            out_headers[self._mcp_session_header] = [str(session_id)]
        out_headers[self._mcp_protocol_header] = [str(protocol_version or MCP_PROTOCOL_VERSION)]
        if last_event_id:
            out_headers[self._mcp_last_event_header] = [str(last_event_id)]
        if body_json is not None:
            raw_body = jsonlib.dumps(body_json, separators=(",", ":")).encode("utf-8")
        elif body is not None:
            raw_body = body if isinstance(body, bytes) else str(body).encode("utf-8")
        else:
            raw_body = b""
        return Request(
            method=normalized_method,
            path=_normalize_mcp_test_path(path or self.path),
            headers=out_headers,
            body=raw_body,
            is_base64=False,
        )


def create_mcp_test_harness(
    server: Any, *, path: str = "/mcp", app_id_generator: IdGenerator | None = None
) -> McpTestHarness:
    return McpTestHarness(server, path=path, app_id_generator=app_id_generator)


def fixed_mcp_id_generator(id: str) -> IdGenerator:
    return _FixedIdGenerator(id)


def sequence_mcp_id_generator(ids: list[str], fallback_prefix: str = "mcp-id") -> ManualIdGenerator:
    generator = ManualIdGenerator(prefix=fallback_prefix)
    generator.push(*ids)
    return generator


def parse_mcp_test_sse_frames(body: bytes | bytearray | str) -> list[McpTestSSEFrame]:
    text_body = body.decode("utf-8") if isinstance(body, bytes | bytearray) else str(body or "")
    if "data: " not in text_body and "id: " not in text_body:
        return []
    frames: list[McpTestSSEFrame] = []
    for raw_chunk in text_body.split("\n\n"):
        chunk = raw_chunk.strip("\n")
        if not chunk.strip():
            continue
        frame = McpTestSSEFrame()
        data_lines: list[str] = []
        for line in chunk.split("\n"):
            if line.startswith(":"):
                continue
            if line.startswith("id: "):
                frame.id = line[4:].strip()
            elif line.startswith("event: "):
                frame.event = line[7:].strip()
            elif line.startswith("data: "):
                data_lines.append(line[6:])
        frame.data = "\n".join(data_lines)
        frames.append(frame)
    return frames


def _normalize_mcp_test_path(path: str) -> str:
    value = str(path or "/mcp").strip() or "/mcp"
    return value if value.startswith("/") else f"/{value}"


def _canonical_mcp_test_headers(headers: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, values in (headers or {}).items():
        normalized = str(key or "").strip().lower()
        if not normalized:
            continue
        out[normalized] = [str(v) for v in values] if isinstance(values, list) else [str(values)]
    return out


def _set_mcp_default_header(headers: dict[str, list[str]], key: str, value: str) -> None:
    normalized = key.lower()
    if not headers.get(normalized):
        headers[normalized] = [value]


def _mcp_response_body_bytes(response: Response) -> bytes:
    parts: list[bytes] = []
    if response.body:
        parts.append(bytes(response.body))
    if response.body_stream is not None:
        parts.extend(bytes(chunk or b"") for chunk in response.body_stream)
    return b"".join(parts)


def _mcp_has_json_response(response: Response) -> bool:
    return any(
        str(value).lower().startswith("application/json") for value in (response.headers or {}).get("content-type", [])
    )
