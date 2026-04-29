from __future__ import annotations

import json as jsonlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from apptheory.aws_events import AppSyncResolverEvent
from apptheory.clock import Clock, RealClock
from apptheory.errors import AppError
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.request import Request
from apptheory.source_provenance import SourceProvenance, normalize_source_provenance, unknown_source_provenance


@dataclass(slots=True)
class AppSyncContext:
    field_name: str
    parent_type_name: str
    arguments: dict[str, Any]
    identity: dict[str, Any]
    source: dict[str, Any]
    variables: dict[str, Any]
    stash: dict[str, Any]
    prev: Any | None
    request_headers: dict[str, str]
    raw_event: AppSyncResolverEvent | dict[str, Any]

    def __init__(
        self,
        *,
        field_name: str = "",
        parent_type_name: str = "",
        arguments: dict[str, Any] | None = None,
        identity: dict[str, Any] | None = None,
        source: dict[str, Any] | None = None,
        variables: dict[str, Any] | None = None,
        stash: dict[str, Any] | None = None,
        prev: Any | None = None,
        request_headers: dict[str, str] | None = None,
        raw_event: AppSyncResolverEvent | dict[str, Any] | None = None,
    ) -> None:
        self.field_name = str(field_name or "").strip()
        self.parent_type_name = str(parent_type_name or "").strip()
        self.arguments = dict(arguments or {})
        self.identity = dict(identity or {})
        self.source = dict(source or {})
        self.variables = dict(variables or {})
        self.stash = dict(stash or {})
        self.prev = prev
        self.request_headers = {
            str(key): str(value) for key, value in dict(request_headers or {}).items() if str(key).strip()
        }
        self.raw_event = dict(raw_event or {})


@dataclass(slots=True)
class Context:
    request: Request
    params: dict[str, str]
    clock: Clock
    id_generator: IdGenerator
    ctx: Any | None
    request_id: str
    tenant_id: str
    auth_identity: str
    remaining_ms: int
    middleware_trace: list[str]
    websocket: WebSocketContext | None
    appsync: AppSyncContext | None
    _values: dict[str, Any]

    def __init__(
        self,
        *,
        request: Request,
        params: dict[str, str] | None = None,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        ctx: Any | None = None,
        request_id: str = "",
        tenant_id: str = "",
        auth_identity: str = "",
        remaining_ms: int = 0,
        middleware_trace: list[str] | None = None,
        websocket: WebSocketContext | None = None,
        appsync: AppSyncContext | None = None,
    ) -> None:
        self.request = request
        self.params = params or {}
        self.clock = clock or RealClock()
        self.id_generator = id_generator or RealIdGenerator()
        self.ctx = ctx
        self.request_id = str(request_id)
        self.tenant_id = str(tenant_id)
        self.auth_identity = str(auth_identity)
        self.remaining_ms = int(remaining_ms or 0)
        self.middleware_trace = middleware_trace if middleware_trace is not None else []
        self.websocket = websocket
        self.appsync = appsync
        self._values = {}

    def now(self):
        return self.clock.now()

    def new_id(self) -> str:
        return self.id_generator.new_id()

    def param(self, name: str) -> str:
        return self.params.get(name, "")

    def set(self, key: str, value: Any) -> None:
        name = str(key or "").strip()
        if not name:
            return
        self._values[name] = value

    def get(self, key: str, default: Any | None = None) -> Any:
        name = str(key or "").strip()
        if not name:
            return default
        return self._values.get(name, default)

    def source_provenance(self) -> SourceProvenance:
        if self is None:
            return unknown_source_provenance()
        return normalize_source_provenance(self.request.source_provenance)

    def source_ip(self) -> str:
        return self.source_provenance().source_ip

    def as_websocket(self) -> WebSocketContext | None:
        return self.websocket

    def as_appsync(self) -> AppSyncContext | None:
        return self.appsync

    def json_value(self) -> Any:
        if not _has_json_content_type(self.request.headers):
            raise AppError("app.bad_request", "invalid json")
        if not self.request.body:
            return None
        try:
            return jsonlib.loads(self.request.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            raise AppError("app.bad_request", "invalid json") from None


@dataclass(slots=True)
class EventContext:
    clock: Clock
    id_generator: IdGenerator
    ctx: Any | None
    request_id: str
    remaining_ms: int
    _values: dict[str, Any]

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        ctx: Any | None = None,
        request_id: str = "",
        remaining_ms: int = 0,
    ) -> None:
        self.clock = clock or RealClock()
        self.id_generator = id_generator or RealIdGenerator()
        self.ctx = ctx
        self.request_id = str(request_id)
        self.remaining_ms = int(remaining_ms or 0)
        self._values = {}

    def now(self):
        return self.clock.now()

    def new_id(self) -> str:
        return self.id_generator.new_id()

    def set(self, key: str, value: Any) -> None:
        name = str(key or "").strip()
        if not name:
            return
        self._values[name] = value

    def get(self, key: str, default: Any | None = None) -> Any:
        name = str(key or "").strip()
        if not name:
            return default
        return self._values.get(name, default)


class WebSocketManagementClient(Protocol):
    def post_to_connection(self, connection_id: str, data: bytes) -> Any: ...

    def get_connection(self, connection_id: str) -> Any: ...

    def delete_connection(self, connection_id: str) -> Any: ...


WebSocketClientFactory = Callable[[str, Any | None], WebSocketManagementClient]


@dataclass(slots=True)
class WebSocketContext:
    clock: Clock
    id_generator: IdGenerator
    ctx: Any | None
    request_id: str
    remaining_ms: int
    connection_id: str
    route_key: str
    domain_name: str
    stage: str
    event_type: str
    management_endpoint: str
    body: bytes
    client_factory: WebSocketClientFactory | None
    _client: WebSocketManagementClient | None
    _client_error: Exception | None

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        ctx: Any | None = None,
        request_id: str = "",
        remaining_ms: int = 0,
        connection_id: str = "",
        route_key: str = "",
        domain_name: str = "",
        stage: str = "",
        event_type: str = "",
        management_endpoint: str = "",
        body: bytes | None = None,
        client_factory: WebSocketClientFactory | None = None,
    ) -> None:
        self.clock = clock or RealClock()
        self.id_generator = id_generator or RealIdGenerator()
        self.ctx = ctx
        self.request_id = str(request_id)
        self.remaining_ms = int(remaining_ms or 0)
        self.connection_id = str(connection_id or "").strip()
        self.route_key = str(route_key or "").strip()
        self.domain_name = str(domain_name or "").strip()
        self.stage = str(stage or "").strip()
        self.event_type = str(event_type or "").strip()
        self.management_endpoint = str(management_endpoint or "").strip()
        self.body = bytes(body or b"")
        self.client_factory = client_factory
        self._client = None
        self._client_error = None

    def now(self):
        return self.clock.now()

    def new_id(self) -> str:
        return self.id_generator.new_id()

    def _management_client(self) -> WebSocketManagementClient:
        if self._client is not None:
            return self._client
        if self._client_error is not None:
            raise self._client_error
        if self.client_factory is None:
            self._client_error = RuntimeError("apptheory: missing websocket client factory")
            raise self._client_error

        try:
            client = self.client_factory(self.management_endpoint, self.ctx)
        except Exception as exc:
            self._client_error = exc
            raise

        if client is None:
            self._client_error = RuntimeError("apptheory: websocket client factory returned None")
            raise self._client_error

        self._client = client
        return client

    def send_message(self, data: bytes) -> None:
        if not self.connection_id:
            raise RuntimeError("apptheory: websocket connection id is empty")
        client = self._management_client()
        client.post_to_connection(self.connection_id, bytes(data or b""))

    def send_json_message(self, value: Any) -> None:
        payload = jsonlib.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True).encode("utf-8")
        self.send_message(payload)


def _has_json_content_type(headers: dict[str, list[str]]) -> bool:
    for value in headers.get("content-type", []):
        v = str(value).strip().lower()
        if v.startswith("application/json"):
            return True
    return False
