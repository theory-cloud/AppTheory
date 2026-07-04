"""Model Context Protocol runtime for the AppTheory Python SDK."""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import inspect
import json as jsonlib
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, is_dataclass
from typing import Any, Literal, Protocol, TypeVar, cast
from urllib.parse import urlparse

from apptheory.clock import Clock, RealClock
from apptheory.context import Context
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.response import Response

MCP_PROTOCOL_VERSION = "2025-11-25"
MCP_PROTOCOL_VERSION_PRIOR = "2025-06-18"
MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26"

MCP_HEADER_PROTOCOL_VERSION = "mcp-protocol-version"
MCP_HEADER_SESSION_ID = "mcp-session-id"
MCP_HEADER_LAST_EVENT_ID = "last-event-id"

MCP_CODE_PARSE_ERROR = -32700
MCP_CODE_INVALID_REQUEST = -32600
MCP_CODE_METHOD_NOT_FOUND = -32601
MCP_CODE_INVALID_PARAMS = -32602
MCP_CODE_INTERNAL_ERROR = -32603
MCP_CODE_SERVER_ERROR = -32000

JSONRPC_VERSION = "2.0"
DEFAULT_SESSION_TTL_MINUTES = 60
DEFAULT_TASK_TTL_MS = 10 * 60 * 1000
DEFAULT_TASK_MAX_TTL_MS = 60 * 60 * 1000
DEFAULT_TASK_POLL_INTERVAL_MS = 5000
DEFAULT_TASK_LIST_LIMIT = 100
MAX_TASK_LIST_LIMIT = 500
RELATED_TASK_METADATA_KEY = "io.modelcontextprotocol/related-task"
MODEL_IMMEDIATE_RESPONSE_METADATA_KEY = "io.modelcontextprotocol/model-immediate-response"
TASK_CANCELED_MESSAGE = "task canceled"
DEFAULT_TASK_TABLE_NAME = "mcp-tasks"
DEFAULT_STREAM_TABLE_NAME = "mcp-streams"

McpTaskSupport = Literal["forbidden", "optional", "required"]
McpTaskStatus = Literal["working", "input_required", "completed", "failed", "canceled"]
McpRequestID = str | int | bool | None
McpJSONValue = str | int | float | bool | None | list[Any] | dict[str, Any]
McpJSONRecord = dict[str, McpJSONValue]

T = TypeVar("T")


@dataclass(slots=True)
class McpRPCError:
    code: int
    message: str
    data: Any | None = None


@dataclass(slots=True)
class McpRPCResponse:
    jsonrpc: str = JSONRPC_VERSION
    id: Any | None = None
    result: Any | None = None
    error: McpRPCError | dict[str, Any] | None = None


@dataclass(slots=True)
class McpRPCRequest:
    jsonrpc: str = JSONRPC_VERSION
    method: str = ""
    id: Any | None = None
    params: Any | None = None


@dataclass(slots=True)
class McpResourceContent:
    uri: str
    mime_type: str = ""
    text: str = ""
    blob: str = ""


@dataclass(slots=True)
class McpContentBlock:
    type: str
    text: str = ""
    data: str = ""
    mime_type: str = ""
    uri: str = ""
    name: str = ""
    title: str = ""
    description: str = ""
    size: int | None = None
    resource: McpResourceContent | dict[str, Any] | None = None


@dataclass(slots=True)
class McpToolResult:
    content: list[McpContentBlock | dict[str, Any]] = field(default_factory=list)
    is_error: bool = False
    structured_content: dict[str, Any] | None = None


@dataclass(slots=True)
class McpToolExecution:
    task_support: McpTaskSupport = "forbidden"


@dataclass(slots=True)
class McpToolDef:
    name: str
    input_schema: Any = field(default_factory=dict)
    title: str = ""
    description: str = ""
    output_schema: Any | None = None
    execution: McpToolExecution | dict[str, Any] | None = None


@dataclass(slots=True)
class McpSSEEvent:
    data: Any | None = None


@dataclass(slots=True)
class McpToolContext:
    session_id: str
    request_id: Any
    method: str


@dataclass(slots=True)
class McpResourceDef:
    uri: str
    name: str
    title: str = ""
    description: str = ""
    mime_type: str = ""
    size: int | None = None


@dataclass(slots=True)
class McpResourceTemplateDef:
    uri_template: str
    name: str
    title: str = ""
    description: str = ""
    mime_type: str = ""


@dataclass(slots=True)
class McpResourceContext:
    uri: str


@dataclass(slots=True)
class McpPromptArgument:
    name: str
    title: str = ""
    description: str = ""
    required: bool = False


@dataclass(slots=True)
class McpPromptDef:
    name: str
    title: str = ""
    description: str = ""
    arguments: list[McpPromptArgument | dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class McpPromptMessage:
    role: str
    content: McpContentBlock | dict[str, Any]


@dataclass(slots=True)
class McpPromptResult:
    messages: list[McpPromptMessage | dict[str, Any]] = field(default_factory=list)
    description: str = ""


@dataclass(slots=True)
class McpSession:
    id: str
    created_at: str = ""
    expires_at: str = ""
    data: dict[str, str] | None = None


@dataclass(slots=True)
class McpStreamEvent:
    id: str
    data: bytes = b""


@dataclass(slots=True)
class McpTask:
    task_id: str
    status: McpTaskStatus = "working"
    created_at: str = ""
    last_updated_at: str = ""
    ttl: int = 0
    status_message: str = ""
    poll_interval: int | None = None


@dataclass(slots=True)
class McpTaskRecord:
    session_id: str
    method: str
    task: McpTask
    tool_name: str = ""
    result: Any | None = None
    error: McpRPCError | dict[str, Any] | None = None


@dataclass(slots=True)
class McpTaskLookup:
    session_id: str
    task_id: str


@dataclass(slots=True)
class McpTaskListRequest:
    session_id: str
    cursor: str = ""
    limit: int = 0


@dataclass(slots=True)
class McpTaskListResult:
    tasks: list[McpTask] = field(default_factory=list)
    next_cursor: str = ""


class McpToolHandler(Protocol):
    def __call__(self, args: Any, context: McpToolContext) -> McpToolResult | dict[str, Any] | Awaitable[Any]: ...


class McpStreamingToolHandler(Protocol):
    def __call__(
        self,
        args: Any,
        emit: Callable[[McpSSEEvent | dict[str, Any]], None | Awaitable[None]],
        context: McpToolContext,
    ) -> McpToolResult | dict[str, Any] | Awaitable[Any]: ...


class McpResourceHandler(Protocol):
    def __call__(self, context: McpResourceContext) -> list[McpResourceContent | dict[str, Any]] | Awaitable[Any]: ...


class McpPromptHandler(Protocol):
    def __call__(self, args: Any) -> McpPromptResult | dict[str, Any] | Awaitable[Any]: ...


class McpSessionStore(Protocol):
    def get(self, id: str) -> McpSession | dict[str, Any]: ...

    def put(self, session: McpSession | dict[str, Any]) -> None: ...

    def delete(self, id: str) -> None: ...


class McpStreamStore(Protocol):
    def create(self, session_id: str) -> str: ...

    def append(self, session_id: str, stream_id: str, data: bytes | bytearray | str | None = None) -> str: ...

    def close(self, session_id: str, stream_id: str) -> None: ...

    def subscribe(self, session_id: str, stream_id: str, after_event_id: str = "") -> list[McpStreamEvent]: ...

    def stream_for_event(self, session_id: str, event_id: str) -> str: ...

    def delete_session(self, session_id: str) -> None: ...


class McpTaskStore(Protocol):
    def create(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord: ...

    def get(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord: ...

    def update(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord: ...

    def list(self, request: McpTaskListRequest | dict[str, Any]) -> McpTaskListResult: ...

    def cancel(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord: ...

    def delete_session(self, session_id: str) -> None: ...


@dataclass(slots=True)
class McpTaskRuntimeOptions:
    store: McpTaskStore
    default_ttl_ms: int = 0
    max_ttl_ms: int = 0
    poll_interval_ms: int = 0
    list_limit: int = 0
    model_immediate_response: str = ""


@dataclass(slots=True)
class McpServerOptions:
    id_generator: IdGenerator | None = None
    session_store: McpSessionStore | None = None
    stream_store: McpStreamStore | None = None
    task_runtime: McpTaskRuntimeOptions | dict[str, Any] | None = None
    origin_validator: Callable[[str], bool] | None = None
    session_ttl_ms: int = 0
    clock: Clock | None = None


@dataclass(slots=True)
class _RegisteredTool:
    definition: dict[str, Any]
    handler: McpToolHandler
    streaming_handler: McpStreamingToolHandler | None = None


@dataclass(slots=True)
class _RegisteredResource:
    definition: dict[str, Any]
    handler: McpResourceHandler


@dataclass(slots=True)
class _RegisteredPrompt:
    definition: dict[str, Any]
    handler: McpPromptHandler


@dataclass(slots=True)
class _NormalizedTaskRuntime:
    store: McpTaskStore | None = None
    default_ttl_ms: int = DEFAULT_TASK_TTL_MS
    max_ttl_ms: int = DEFAULT_TASK_MAX_TTL_MS
    poll_interval_ms: int = DEFAULT_TASK_POLL_INTERVAL_MS
    list_limit: int = DEFAULT_TASK_LIST_LIMIT
    model_immediate_response: str = ""


@dataclass(slots=True)
class _ParsedRPCRequest:
    method: str
    id_present: bool
    id: Any | None = None
    params: Any | None = None


class McpSessionNotFoundError(Exception):
    def __init__(self, message: str = "session not found") -> None:
        super().__init__(message)


class McpStreamNotFoundError(Exception):
    def __init__(self, message: str = "stream not found") -> None:
        super().__init__(message)


class McpEventNotFoundError(Exception):
    def __init__(self, message: str = "event not found") -> None:
        super().__init__(message)


class McpTaskNotFoundError(Exception):
    def __init__(self, message: str = "task not found") -> None:
        super().__init__(message)


class McpTaskTerminalError(Exception):
    def __init__(self, message: str = "task already terminal") -> None:
        super().__init__(message)


class McpTaskInvalidCursorError(Exception):
    def __init__(self, message: str = "invalid task list cursor") -> None:
        super().__init__(message)


class McpToolRegistry:
    def __init__(self) -> None:
        self._tools: list[_RegisteredTool] = []
        self._index: dict[str, int] = {}

    def register_tool(self, definition: McpToolDef | Mapping[str, Any], handler: McpToolHandler) -> None:
        name = str(_field(definition, "name") or "").strip()
        if not name:
            raise ValueError("tool name must not be empty")
        if name in self._index:
            raise ValueError(f"tool already registered: {name}")
        if handler is None:
            raise ValueError("tool handler must not be nil")
        normalized = _normalize_tool_def({**_as_dict(definition), "name": name})
        self._index[name] = len(self._tools)
        self._tools.append(_RegisteredTool(normalized, handler))

    def register_streaming_tool(
        self,
        definition: McpToolDef | Mapping[str, Any],
        handler: McpStreamingToolHandler,
    ) -> None:
        name = str(_field(definition, "name") or "").strip()
        if not name:
            raise ValueError("tool name must not be empty")
        if name in self._index:
            raise ValueError(f"tool already registered: {name}")
        if handler is None:
            raise ValueError("streaming tool handler must not be nil")
        normalized = _normalize_tool_def({**_as_dict(definition), "name": name})

        def wrapped(args: Any, context: McpToolContext) -> Any:
            return handler(args, lambda _event: None, context)

        self._index[name] = len(self._tools)
        self._tools.append(_RegisteredTool(normalized, cast(McpToolHandler, wrapped), handler))

    def list(self) -> list[dict[str, Any]]:
        return [_json_clone(entry.definition) for entry in self._tools]

    def len(self) -> int:
        return len(self._tools)

    def supports_streaming(self, name: str) -> bool:
        entry = self._entry(name)
        return entry is not None and entry.streaming_handler is not None

    def supports_tasks(self) -> bool:
        return any(self.task_support(str(entry.definition.get("name") or "")) != "forbidden" for entry in self._tools)

    def task_support(self, name: str) -> McpTaskSupport:
        entry = self._entry(name)
        execution = _as_dict(entry.definition.get("execution") if entry else None)
        support = str(execution.get("taskSupport") or execution.get("task_support") or "forbidden")
        return cast(McpTaskSupport, support if support in {"optional", "required"} else "forbidden")

    def call(self, name: str, args: Any, context: McpToolContext) -> dict[str, Any]:
        entry = self._entry(name)
        if entry is None:
            raise ValueError(f"tool not found: {name}")
        return _normalize_tool_result(_resolve_maybe(entry.handler(args, context)))

    def call_streaming(
        self,
        name: str,
        args: Any,
        emit: Callable[[McpSSEEvent | dict[str, Any]], None | Awaitable[None]],
        context: McpToolContext,
    ) -> dict[str, Any]:
        entry = self._entry(name)
        if entry is None:
            raise ValueError(f"tool not found: {name}")
        if entry.streaming_handler is not None:
            return _normalize_tool_result(_resolve_maybe(entry.streaming_handler(args, emit, context)))
        return _normalize_tool_result(_resolve_maybe(entry.handler(args, context)))

    def _entry(self, name: str) -> _RegisteredTool | None:
        idx = self._index.get(str(name or ""))
        if idx is None:
            return None
        return self._tools[idx] if 0 <= idx < len(self._tools) else None


class McpResourceRegistry:
    def __init__(self) -> None:
        self._resources: list[_RegisteredResource] = []
        self._index: dict[str, int] = {}
        self._templates: list[dict[str, Any]] = []
        self._template_index: dict[str, int] = {}

    def register_resource(
        self,
        definition: McpResourceDef | Mapping[str, Any],
        handler: McpResourceHandler,
    ) -> None:
        uri = str(_field(definition, "uri") or "").strip()
        if not uri:
            raise ValueError("resource uri must not be empty")
        if not _valid_resource_uri(uri):
            raise ValueError(f"resource uri must be absolute: {uri}")
        if not str(_field(definition, "name") or "").strip():
            raise ValueError("resource name must not be empty")
        if handler is None:
            raise ValueError("resource handler must not be nil")
        if uri in self._index:
            raise ValueError(f"resource already registered: {uri}")
        normalized = _normalize_resource_def({**_as_dict(definition), "uri": uri})
        self._index[uri] = len(self._resources)
        self._resources.append(_RegisteredResource(normalized, handler))

    def register_resource_template(self, definition: McpResourceTemplateDef | Mapping[str, Any]) -> None:
        raw = _as_dict(definition)
        uri_template = str(raw.get("uriTemplate") or raw.get("uri_template") or "").strip()
        if not uri_template:
            raise ValueError("resource template uriTemplate must not be empty")
        if not _valid_resource_uri(uri_template):
            raise ValueError(f"resource template uriTemplate must be absolute: {uri_template}")
        if not str(raw.get("name") or "").strip():
            raise ValueError("resource template name must not be empty")
        if uri_template in self._template_index:
            raise ValueError(f"resource template already registered: {uri_template}")
        normalized = _normalize_resource_template_def({**raw, "uriTemplate": uri_template})
        self._template_index[uri_template] = len(self._templates)
        self._templates.append(normalized)

    def list(self) -> list[dict[str, Any]]:
        return [_json_clone(entry.definition) for entry in self._resources]

    def list_templates(self) -> list[dict[str, Any]]:
        return [_json_clone(entry) for entry in self._templates]

    def len(self) -> int:
        return len(self._resources)

    def template_len(self) -> int:
        return len(self._templates)

    def read(self, uri: str) -> list[dict[str, Any]]:
        key = str(uri or "")
        idx = self._index.get(key)
        if idx is None:
            raise ValueError(f"resource not found: {key}")
        entry = self._resources[idx]
        contents = _resolve_maybe(entry.handler(McpResourceContext(uri=key)))
        return [_normalize_resource_content(content) for content in contents] if isinstance(contents, list) else []


class McpPromptRegistry:
    def __init__(self) -> None:
        self._prompts: list[_RegisteredPrompt] = []
        self._index: dict[str, int] = {}

    def register_prompt(self, definition: McpPromptDef | Mapping[str, Any], handler: McpPromptHandler) -> None:
        name = str(_field(definition, "name") or "").strip()
        if not name:
            raise ValueError("prompt name must not be empty")
        if handler is None:
            raise ValueError("prompt handler must not be nil")
        if name in self._index:
            raise ValueError(f"prompt already registered: {name}")
        normalized = _normalize_prompt_def({**_as_dict(definition), "name": name})
        self._index[name] = len(self._prompts)
        self._prompts.append(_RegisteredPrompt(normalized, handler))

    def list(self) -> list[dict[str, Any]]:
        return [_json_clone(entry.definition) for entry in self._prompts]

    def len(self) -> int:
        return len(self._prompts)

    def get(self, name: str, args: Any) -> dict[str, Any]:
        key = str(name or "")
        idx = self._index.get(key)
        if idx is None:
            raise ValueError(f"prompt not found: {key}")
        entry = self._prompts[idx]
        return _normalize_prompt_result(_resolve_maybe(entry.handler(args)))


class MemoryMcpSessionStore:
    def __init__(self, *, clock: Clock | None = None, seed: list[McpSession | dict[str, Any]] | None = None) -> None:
        self._sessions: dict[str, McpSession] = {}
        self._clock = clock or RealClock()
        for session in seed or []:
            normalized = _clone_session(session)
            if normalized.id:
                self._sessions[normalized.id] = normalized

    def get(self, id: str) -> McpSession:
        key = str(id or "").strip()
        session = self._sessions.get(key)
        if session is None:
            raise McpSessionNotFoundError()
        if _session_expired_at(self._clock.now(), session):
            self._sessions.pop(key, None)
            raise McpSessionNotFoundError()
        return _clone_session(session)

    def put(self, session: McpSession | dict[str, Any]) -> None:
        normalized = _clone_session(session)
        if not normalized.id:
            raise ValueError("missing session id")
        self._sessions[normalized.id] = normalized

    def delete(self, id: str) -> None:
        self._sessions.pop(str(id or "").strip(), None)


@dataclass(slots=True)
class _MemoryStream:
    events: list[McpStreamEvent] = field(default_factory=list)
    closed: bool = False


@dataclass(slots=True)
class _MemoryStreamSession:
    next_seq: int = 0
    event_to_stream: dict[str, str] = field(default_factory=dict)
    streams: dict[str, _MemoryStream] = field(default_factory=dict)


class MemoryMcpStreamStore:
    def __init__(self, *, id_generator: IdGenerator | None = None) -> None:
        self._sessions: dict[str, _MemoryStreamSession] = {}
        self._id_generator = id_generator or RealIdGenerator()

    def create(self, session_id: str) -> str:
        sid = _normalize_required(session_id, "missing session id")
        session = self._ensure_session(sid)
        stream_id = _normalize_required(self._id_generator.new_id(), "stream id generator returned empty id")
        session.streams[stream_id] = _MemoryStream()
        return stream_id

    def append(self, session_id: str, stream_id: str, data: bytes | bytearray | str | None = None) -> str:
        session = self._lookup_session(session_id)
        stream = self._lookup_stream(session, stream_id)
        session.next_seq += 1
        event_id = str(session.next_seq)
        stream.events.append(McpStreamEvent(id=event_id, data=_to_bytes(data)))
        session.event_to_stream[event_id] = str(stream_id or "").strip()
        return event_id

    def close(self, session_id: str, stream_id: str) -> None:
        stream = self._lookup_stream(self._lookup_session(session_id), stream_id)
        stream.closed = True

    def subscribe(self, session_id: str, stream_id: str, after_event_id: str = "") -> list[McpStreamEvent]:
        session = self._lookup_session(session_id)
        stream = self._lookup_stream(session, stream_id)
        after = str(after_event_id or "").strip()
        stream_key = str(stream_id or "").strip()
        if after and session.event_to_stream.get(after) != stream_key:
            raise McpEventNotFoundError()
        after_number = int(after or "0")
        return [McpStreamEvent(id=e.id, data=bytes(e.data)) for e in stream.events if int(e.id or "0") > after_number]

    def stream_for_event(self, session_id: str, event_id: str) -> str:
        session = self._lookup_session(session_id)
        stream_id = session.event_to_stream.get(str(event_id or "").strip())
        if not stream_id:
            raise McpEventNotFoundError()
        return stream_id

    def delete_session(self, session_id: str) -> None:
        self._sessions.pop(str(session_id or "").strip(), None)

    def _ensure_session(self, session_id: str) -> _MemoryStreamSession:
        session = self._sessions.get(session_id)
        if session is None:
            session = _MemoryStreamSession()
            self._sessions[session_id] = session
        return session

    def _lookup_session(self, session_id: str) -> _MemoryStreamSession:
        sid = _normalize_required(session_id, "missing session id")
        session = self._sessions.get(sid)
        if session is None:
            raise McpStreamNotFoundError()
        return session

    def _lookup_stream(self, session: _MemoryStreamSession, stream_id: str) -> _MemoryStream:
        key = _normalize_required(stream_id, "missing stream id")
        stream = session.streams.get(key)
        if stream is None:
            raise McpStreamNotFoundError()
        return stream


class MemoryMcpTaskStore:
    def __init__(self, *, clock: Clock | None = None) -> None:
        self._sessions: dict[str, dict[str, McpTaskRecord]] = {}
        self._clock = clock or RealClock()

    def create(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord:
        record = _clone_task_record(task)
        record.session_id = _normalize_required(record.session_id, "missing session id")
        record.task.task_id = _normalize_required(record.task.task_id, "missing task id")
        session = self._sessions.setdefault(record.session_id, {})
        if record.task.task_id in session:
            raise ValueError("task already exists")
        session[record.task.task_id] = record
        return _clone_task_record(record)

    def get(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord:
        record = self._record(lookup)
        if record is None:
            raise McpTaskNotFoundError()
        return _clone_task_record(record)

    def update(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord:
        next_record = _clone_task_record(task)
        existing = self._record({"session_id": next_record.session_id, "task_id": next_record.task.task_id})
        if existing is None:
            raise McpTaskNotFoundError()
        if _task_status_terminal(existing.task.status):
            raise McpTaskTerminalError()
        session = self._sessions.get(next_record.session_id)
        if session is None:
            raise McpTaskNotFoundError()
        session[next_record.task.task_id] = next_record
        return _clone_task_record(next_record)

    def list(self, request: McpTaskListRequest | dict[str, Any]) -> McpTaskListResult:
        session_id = str(_field(request, "session_id") or _field(request, "sessionId") or "").strip()
        if not session_id:
            return McpTaskListResult()
        session = self._sessions.get(session_id)
        if session is None:
            return McpTaskListResult()
        cursor = _parse_task_cursor(str(_field(request, "cursor") or ""))
        limit = _task_list_limit(_int_field(request, "limit"))
        records = sorted(session.values(), key=lambda r: (r.task.created_at, r.task.task_id))
        chosen = records[cursor : cursor + limit]
        result = McpTaskListResult(tasks=[_clone_task(record.task) for record in chosen])
        if cursor + limit < len(records):
            result.next_cursor = str(cursor + limit)
        return result

    def cancel(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord:
        record = self._record(lookup)
        if record is None:
            raise McpTaskNotFoundError()
        if _task_status_terminal(record.task.status):
            raise McpTaskTerminalError()
        record.task.status = "canceled"
        record.task.status_message = TASK_CANCELED_MESSAGE
        record.task.last_updated_at = _iso_no_millis(self._clock.now())
        record.error = McpRPCError(code=MCP_CODE_SERVER_ERROR, message=TASK_CANCELED_MESSAGE)
        return _clone_task_record(record)

    def delete_session(self, session_id: str) -> None:
        self._sessions.pop(str(session_id or "").strip(), None)

    def _record(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord | None:
        session_id = str(_field(lookup, "session_id") or _field(lookup, "sessionId") or "").strip()
        task_id = str(_field(lookup, "task_id") or _field(lookup, "taskId") or "").strip()
        if not session_id or not task_id:
            return None
        return self._sessions.get(session_id, {}).get(task_id)


class DynamoMcpTaskStore:
    def __init__(self, *, table: Any | None = None, table_name: str | None = None, clock: Clock | None = None) -> None:
        self._table = table or _new_theorydb_table(default_mcp_task_model(table_name), table_name)
        self._clock = clock or RealClock()

    def create(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord:
        item = _task_record_to_item(_clone_task_record(task))
        if hasattr(self._table, "put"):
            self._table.put(item)
        else:
            self._table.save(item)
        return _item_to_task_record(item)

    def get(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord:
        session_id = str(_field(lookup, "session_id") or _field(lookup, "sessionId") or "").strip()
        task_id = str(_field(lookup, "task_id") or _field(lookup, "taskId") or "").strip()
        try:
            return _item_to_task_record(self._table.get(session_id, task_id))
        except Exception as exc:
            if _is_not_found_error(exc):
                raise McpTaskNotFoundError() from exc
            raise

    def update(self, task: McpTaskRecord | dict[str, Any]) -> McpTaskRecord:
        record = _clone_task_record(task)
        existing = self.get({"session_id": record.session_id, "task_id": record.task.task_id})
        if _task_status_terminal(existing.task.status):
            raise McpTaskTerminalError()
        item = _task_record_to_item(record)
        self._table.save(item)
        return _item_to_task_record(item)

    def list(self, request: McpTaskListRequest | dict[str, Any]) -> McpTaskListResult:
        session_id = str(_field(request, "session_id") or _field(request, "sessionId") or "").strip()
        if not session_id:
            return McpTaskListResult()
        try:
            page = self._table.query(session_id, limit=_task_list_limit(_int_field(request, "limit")))
            records = sorted(
                (_item_to_task_record(item) for item in getattr(page, "items", [])),
                key=lambda r: (r.task.created_at, r.task.task_id),
            )
            return McpTaskListResult(
                tasks=[_clone_task(record.task) for record in records],
                next_cursor=str(getattr(page, "cursor", "") or ""),
            )
        except Exception as exc:
            if _is_not_found_error(exc):
                return McpTaskListResult()
            raise

    def cancel(self, lookup: McpTaskLookup | dict[str, Any]) -> McpTaskRecord:
        record = self.get(lookup)
        if _task_status_terminal(record.task.status):
            raise McpTaskTerminalError()
        record.task.status = "canceled"
        record.task.status_message = TASK_CANCELED_MESSAGE
        record.task.last_updated_at = _iso_no_millis(self._clock.now())
        record.error = McpRPCError(code=MCP_CODE_SERVER_ERROR, message=TASK_CANCELED_MESSAGE)
        return self.update(record)

    def delete_session(self, session_id: str) -> None:
        tasks = self.list({"session_id": session_id, "limit": MAX_TASK_LIST_LIMIT}).tasks
        for task in tasks:
            try:
                self._table.delete(str(session_id or "").strip(), _field(task, "task_id") or _field(task, "taskId"))
            except Exception as exc:
                if not _is_not_found_error(exc):
                    raise


class DynamoMcpStreamStore:
    def __init__(
        self,
        *,
        table: Any | None = None,
        table_name: str | None = None,
        id_generator: IdGenerator | None = None,
    ) -> None:
        self._table = table or _new_theorydb_table(default_mcp_stream_model(table_name), table_name)
        self._id_generator = id_generator or RealIdGenerator()

    def create(self, session_id: str) -> str:
        sid = _normalize_required(session_id, "missing session id")
        stream_id = _normalize_required(self._id_generator.new_id(), "stream id generator returned empty id")
        self._table.put(
            _McpStreamItem(session_id=sid, item_id=f"STREAM#{stream_id}", stream_id=stream_id, kind="stream")
        )
        return stream_id

    def append(self, session_id: str, stream_id: str, data: bytes | bytearray | str | None = None) -> str:
        sid = _normalize_required(session_id, "missing session id")
        stream = self._stream_record(sid, stream_id)
        sequence = int(_field(stream, "sequence") or 0) + 1
        event_id = str(sequence)
        _set_item_attr(stream, "sequence", sequence)
        self._table.save(stream)
        self._table.put(
            _McpStreamItem(
                session_id=sid,
                item_id=f"EVENT#{event_id}",
                stream_id=str(stream_id or "").strip(),
                kind="event",
                sequence=sequence,
                event_id=event_id,
                data=_base64_encode(_to_bytes(data)),
            )
        )
        return event_id

    def close(self, session_id: str, stream_id: str) -> None:
        stream = self._stream_record(session_id, stream_id)
        _set_item_attr(stream, "closed", True)
        self._table.save(stream)

    def subscribe(self, session_id: str, stream_id: str, after_event_id: str = "") -> list[McpStreamEvent]:
        sid = _normalize_required(session_id, "missing session id")
        stream = str(stream_id or "").strip()
        after = int(str(after_event_id or "").strip() or "0")
        events = self._event_records(sid)
        if after > 0 and not any(
            str(_field(item, "event_id") or _field(item, "eventId") or "") == str(after)
            and str(_field(item, "stream_id") or _field(item, "streamId") or "") == stream
            for item in events
        ):
            raise McpEventNotFoundError()
        out: list[McpStreamEvent] = []
        for item in sorted(events, key=lambda v: int(_field(v, "sequence") or 0)):
            if str(_field(item, "stream_id") or _field(item, "streamId") or "") != stream:
                continue
            if int(_field(item, "sequence") or 0) <= after:
                continue
            out.append(
                McpStreamEvent(
                    id=str(_field(item, "event_id") or _field(item, "eventId") or ""),
                    data=_base64_decode(str(_field(item, "data") or "")),
                )
            )
        return out

    def stream_for_event(self, session_id: str, event_id: str) -> str:
        wanted = str(event_id or "").strip()
        for item in self._event_records(_normalize_required(session_id, "missing session id")):
            if str(_field(item, "event_id") or _field(item, "eventId") or "") == wanted:
                return str(_field(item, "stream_id") or _field(item, "streamId") or "")
        raise McpEventNotFoundError()

    def delete_session(self, session_id: str) -> None:
        sid = str(session_id or "").strip()
        if not sid:
            return
        for item in self._session_items(sid):
            try:
                self._table.delete(sid, str(_field(item, "item_id") or _field(item, "itemId") or ""))
            except Exception as exc:
                if not _is_not_found_error(exc):
                    raise

    def _stream_record(self, session_id: str, stream_id: str) -> Any:
        try:
            return self._table.get(str(session_id or "").strip(), f"STREAM#{str(stream_id or '').strip()}")
        except Exception as exc:
            if _is_not_found_error(exc):
                raise McpStreamNotFoundError() from exc
            raise

    def _event_records(self, session_id: str) -> list[Any]:
        return [item for item in self._session_items(session_id) if str(_field(item, "kind") or "") == "event"]

    def _session_items(self, session_id: str) -> list[Any]:
        try:
            page = self._table.query(str(session_id or "").strip(), limit=1000)
            return list(getattr(page, "items", []) or [])
        except Exception as exc:
            if _is_not_found_error(exc):
                return []
            raise


class McpServer:
    def __init__(self, name: str, version: str, options: McpServerOptions | dict[str, Any] | None = None) -> None:
        opts = options if isinstance(options, McpServerOptions) else McpServerOptions(**dict(options or {}))
        self.name = str(name or "").strip() or "AppTheoryMCP"
        self.version = str(version or "").strip() or "0.0.0"
        self.id_generator = opts.id_generator or RealIdGenerator()
        self.clock = opts.clock or RealClock()
        self.session_store = opts.session_store or MemoryMcpSessionStore(clock=self.clock)
        self.stream_store = opts.stream_store or MemoryMcpStreamStore()
        self.session_ttl_ms = _normalize_session_ttl_ms(opts.session_ttl_ms)
        self.origin_validator = opts.origin_validator or (
            lambda origin: origin in {"https://claude.ai", "https://claude.com"}
        )
        self.task_runtime = _normalize_task_runtime(opts.task_runtime)
        self.tool_registry = McpToolRegistry()
        self.resource_registry = McpResourceRegistry()
        self.prompt_registry = McpPromptRegistry()

    def registry(self) -> McpToolRegistry:
        return self.tool_registry

    def resources(self) -> McpResourceRegistry:
        return self.resource_registry

    def prompts(self) -> McpPromptRegistry:
        return self.prompt_registry

    def handler(self) -> Callable[[Context], Response]:
        def _handler(ctx: Context) -> Response:
            return self.handle(ctx.request.method, ctx.request.headers, ctx.request.body)

        return _handler

    def serve(self, request: Mapping[str, Any]) -> Response:
        return self.handle(
            str(request.get("method") or ""),
            cast(dict[str, Any], request.get("headers") or {}),
            _to_bytes(request.get("body")),
        )

    def handle(self, method: str, headers: dict[str, Any], body: bytes | bytearray | str | None) -> Response:
        normalized_method = str(method or "").strip().upper()
        if normalized_method == "POST":
            return self._handle_post(headers, _to_bytes(body))
        if normalized_method == "GET":
            return self._handle_get(headers)
        if normalized_method == "DELETE":
            return self._handle_delete(headers)
        return _json_bytes_response(405, {"error": "method not allowed"})

    def _handle_post(self, headers: dict[str, Any], body: bytes) -> Response:
        origin_response = self._validate_origin(headers)
        if origin_response is not None:
            return origin_response
        header_response = _validate_post_headers(headers)
        if header_response is not None:
            return header_response
        try:
            raw = _parse_json_object(body)
        except Exception as exc:  # noqa: BLE001
            return self._marshal_single_response(
                _new_error_response(None, MCP_CODE_PARSE_ERROR, f"Parse error: {_error_message(exc)}")
            )
        if "method" in raw:
            return self._handle_post_request(headers, body)
        if "result" in raw or "error" in raw:
            return self._handle_post_response(headers, body)
        return _bad_request("invalid JSON-RPC message")

    def _handle_post_request(self, headers: dict[str, Any], body: bytes) -> Response:
        try:
            request = _parse_request(body)
        except Exception as exc:  # noqa: BLE001
            return self._marshal_single_response(
                _new_error_response(None, MCP_CODE_PARSE_ERROR, f"Parse error: {_error_message(exc)}")
            )
        if request.method == "initialize":
            return self._handle_initialize_http(request)
        session_id, session, response = self._require_session(headers)
        if response is not None:
            return response
        if session is None or not session_id:
            return _internal_server_error()
        protocol_response = self._require_protocol_version(headers, session)
        if protocol_response is not None:
            return protocol_response
        if not request.id_present:
            self._handle_notification(session, request)
            return _empty_response(202)
        return self._handle_request_http(session_id, session, request, headers)

    def _handle_post_response(self, headers: dict[str, Any], body: bytes) -> Response:
        try:
            _parse_response(body)
        except Exception:  # noqa: BLE001
            return _bad_request("invalid JSON-RPC response")
        _, session, response = self._require_session(headers)
        if response is not None:
            return response
        if session is not None:
            protocol_response = self._require_protocol_version(headers, session)
            if protocol_response is not None:
                return protocol_response
        return _empty_response(202)

    def _handle_get(self, headers: dict[str, Any]) -> Response:
        origin_response = self._validate_origin(headers)
        if origin_response is not None:
            return origin_response
        header_response = _validate_get_headers(headers)
        if header_response is not None:
            return header_response
        session_id, session, response = self._require_session(headers)
        if response is not None:
            return response
        if session is None or not session_id:
            return _internal_server_error()
        protocol_response = self._require_protocol_version(headers, session)
        if protocol_response is not None:
            return protocol_response
        last_event_id = _first_header(headers, MCP_HEADER_LAST_EVENT_ID)
        if not last_event_id:
            return _sse_bytes_response(200, [b": keepalive\n\n"], session_id)
        try:
            stream_id = self.stream_store.stream_for_event(session_id, last_event_id)
            events = self.stream_store.subscribe(session_id, stream_id, last_event_id)
            return self._stream_to_sse(session_id, events)
        except McpEventNotFoundError:
            return _not_found("event not found")
        except McpStreamNotFoundError:
            return _not_found("stream not found")
        except Exception:  # noqa: BLE001
            return _internal_server_error()

    def _handle_delete(self, headers: dict[str, Any]) -> Response:
        origin_response = self._validate_origin(headers)
        if origin_response is not None:
            return origin_response
        session_id = _first_header(headers, MCP_HEADER_SESSION_ID)
        if not session_id:
            return _bad_request("missing Mcp-Session-Id")
        try:
            session = self._get_session(session_id)
        except McpSessionNotFoundError:
            return _not_found("session not found")
        except Exception:  # noqa: BLE001
            return _internal_server_error()
        protocol_response = self._require_protocol_version(headers, session)
        if protocol_response is not None:
            return protocol_response
        self.session_store.delete(session_id)
        self.stream_store.delete_session(session_id)
        if self.task_runtime.store is not None:
            self.task_runtime.store.delete_session(session_id)
        return _empty_response(202)

    def _handle_initialize_http(self, request: _ParsedRPCRequest) -> Response:
        negotiated = _negotiate_protocol_version(request.params)
        session = self._create_session(negotiated)
        return self._marshal_single_response(self._handle_initialize(request, negotiated), session.id, True)

    def _handle_notification(self, session: McpSession, request: _ParsedRPCRequest) -> None:
        if request.method != "notifications/initialized":
            return
        data = dict(session.data or {})
        data["initialized"] = "true"
        self.session_store.put(
            McpSession(id=session.id, created_at=session.created_at, expires_at=session.expires_at, data=data)
        )

    def _handle_request_http(
        self,
        session_id: str,
        session: McpSession,
        request: _ParsedRPCRequest,
        headers: dict[str, Any],
    ) -> Response:
        protocol = _session_protocol_version(session)
        if (
            request.method == "tools/call"
            and _accepts_event_stream(headers)
            and self._should_stream_tools_call(request)
        ):
            return self._handle_tools_call_stream(session_id, request)
        return self._marshal_single_response(self._dispatch(request, protocol, session_id))

    def _dispatch(self, request: _ParsedRPCRequest, protocol_version: str, session_id: str) -> dict[str, Any]:
        if not _method_allowed_for_protocol(protocol_version, request.method):
            return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, f"Method not found: {request.method}")
        if _is_task_method(request.method):
            return self._dispatch_task_method(request, session_id)
        if not self._method_capability_enabled(request.method):
            return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, f"Method not found: {request.method}")
        if request.method == "initialize":
            return self._handle_initialize(request, _negotiate_protocol_version(request.params))
        if request.method == "ping":
            return _new_result_response(request.id, {})
        if request.method == "tools/list":
            return _new_result_response(request.id, {"tools": self.tool_registry.list()})
        if request.method == "tools/call":
            return self._handle_tools_call(request, session_id)
        if request.method == "resources/list":
            return _new_result_response(request.id, {"resources": self.resource_registry.list()})
        if request.method == "resources/read":
            return self._handle_resources_read(request)
        if request.method == "resources/templates/list":
            return _new_result_response(request.id, {"resourceTemplates": self.resource_registry.list_templates()})
        if request.method == "prompts/list":
            return _new_result_response(request.id, {"prompts": self.prompt_registry.list()})
        if request.method == "prompts/get":
            return self._handle_prompts_get(request)
        return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, f"Method not found: {request.method}")

    def _dispatch_task_method(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        if not self._tasks_enabled():
            return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, f"Method not found: {request.method}")
        if request.method == "tasks/get":
            return self._handle_tasks_get(request, session_id)
        if request.method == "tasks/result":
            return self._handle_tasks_result(request, session_id)
        if request.method == "tasks/list":
            return self._handle_tasks_list(request, session_id)
        if request.method == "tasks/cancel":
            return self._handle_tasks_cancel(request, session_id)
        return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, f"Method not found: {request.method}")

    def _handle_initialize(self, request: _ParsedRPCRequest, protocol_version: str) -> dict[str, Any]:
        return _new_result_response(
            request.id,
            {
                "protocolVersion": protocol_version,
                "capabilities": self._initialize_capabilities(protocol_version),
                "serverInfo": {"name": self.name, "version": self.version},
            },
        )

    def _initialize_capabilities(self, protocol_version: str) -> dict[str, Any]:
        capabilities: dict[str, Any] = {}
        if self.resource_registry.len() > 0 or self.resource_registry.template_len() > 0:
            capabilities["resources"] = {}
        if self.tool_registry.len() > 0:
            capabilities["tools"] = {}
        if self.prompt_registry.len() > 0:
            capabilities["prompts"] = {}
        if protocol_version == MCP_PROTOCOL_VERSION and self._tasks_enabled():
            capabilities["tasks"] = {"cancel": {}, "list": {}, "requests": {"tools": {"call": {}}}}
        return capabilities

    def _handle_tools_call(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        params = _params_record(request.params)
        name = str(params.get("name") or "").strip()
        if not name:
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, "Invalid params: missing tool name")
        task_support = self.tool_registry.task_support(name)
        if "task" in params:
            if not self._tasks_enabled():
                return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tasks not enabled")
            return self._handle_task_tools_call(request, session_id, name, params)
        if task_support == "required":
            return _new_error_response(
                request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tool requires task execution"
            )
        try:
            result = self.tool_registry.call(
                name,
                params.get("arguments"),
                McpToolContext(session_id=session_id, request_id=request.id, method=request.method),
            )
            return _new_result_response(request.id, result)
        except Exception as exc:  # noqa: BLE001
            return _tool_call_error(request.id, name, exc)

    def _handle_resources_read(self, request: _ParsedRPCRequest) -> dict[str, Any]:
        params = _params_record(request.params)
        uri = str(params.get("uri") or "")
        try:
            return _new_result_response(request.id, {"contents": self.resource_registry.read(uri)})
        except Exception as exc:  # noqa: BLE001
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, _error_message(exc))

    def _handle_prompts_get(self, request: _ParsedRPCRequest) -> dict[str, Any]:
        params = _params_record(request.params)
        name = str(params.get("name") or "")
        try:
            return _new_result_response(request.id, self.prompt_registry.get(name, params.get("arguments")))
        except Exception as exc:  # noqa: BLE001
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, _error_message(exc))

    def _should_stream_tools_call(self, request: _ParsedRPCRequest) -> bool:
        if not self._method_capability_enabled("tools/call"):
            return False
        params = _params_record(request.params)
        name = str(params.get("name") or "").strip()
        if not name or "task" in params:
            return False
        if self.tool_registry.task_support(name) == "required":
            return False
        return self.tool_registry.supports_streaming(name)

    def _handle_tools_call_stream(self, session_id: str, request: _ParsedRPCRequest) -> Response:
        stream_id = ""
        try:
            stream_id = self.stream_store.create(session_id)
            self.stream_store.append(session_id, stream_id)
            params = _params_record(request.params)
            name = str(params.get("name") or "").strip()
            progress_token = _normalize_progress_token(_params_record(params.get("_meta")).get("progressToken"))
            progress_sequence = 0

            def emit(event: McpSSEEvent | dict[str, Any]) -> None:
                nonlocal progress_sequence
                if progress_token is None:
                    return
                progress_sequence += 1
                progress = _progress_from_sse_event(event, progress_sequence)
                notification = {
                    "jsonrpc": JSONRPC_VERSION,
                    "method": "notifications/progress",
                    "params": {
                        "message": progress["message"],
                        "progress": progress["progress"],
                        "progressToken": progress_token,
                        "total": progress.get("total"),
                    },
                }
                self.stream_store.append(session_id, stream_id, _json_bytes(notification))

            result = self.tool_registry.call_streaming(
                name,
                params.get("arguments"),
                emit,
                McpToolContext(session_id=session_id, request_id=request.id, method=request.method),
            )
            self.stream_store.append(session_id, stream_id, _json_bytes(_new_result_response(request.id, result)))
            self.stream_store.close(session_id, stream_id)
            return self._stream_to_sse(session_id, self.stream_store.subscribe(session_id, stream_id))
        except Exception as exc:  # noqa: BLE001
            if stream_id:
                with contextlib.suppress(Exception):
                    self.stream_store.close(session_id, stream_id)
            return self._marshal_single_response(_tool_call_error(request.id, "", exc))

    def _handle_task_tools_call(
        self,
        request: _ParsedRPCRequest,
        session_id: str,
        name: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        store = self.task_runtime.store
        if store is None:
            return _new_error_response(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tasks not enabled")
        support = self.tool_registry.task_support(name)
        if support not in {"optional", "required"}:
            return _new_error_response(
                request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tool does not support task execution"
            )
        ttl = _task_ttl(self.task_runtime, _params_record(params.get("task")))
        if ttl["error"]:
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, ttl["error"])
        task_id = _normalize_required(self.id_generator.new_id(), "task id generator returned empty id")
        now = _iso_no_millis(self.clock.now())
        record = McpTaskRecord(
            session_id=session_id,
            method="tools/call",
            tool_name=name,
            task=McpTask(
                task_id=task_id,
                status="working",
                created_at=now,
                last_updated_at=now,
                ttl=int(ttl["value"]),
                poll_interval=self.task_runtime.poll_interval_ms,
            ),
        )
        created = store.create(record)
        self._finish_task(store, created, params.get("arguments"))
        meta: dict[str, Any] = {RELATED_TASK_METADATA_KEY: {"taskId": created.task.task_id}}
        if self.task_runtime.model_immediate_response:
            meta[MODEL_IMMEDIATE_RESPONSE_METADATA_KEY] = self.task_runtime.model_immediate_response
        return _new_result_response(request.id, {"_meta": meta, "task": _task_to_json(created.task)})

    def _finish_task(self, store: McpTaskStore, record: McpTaskRecord, args: Any) -> None:
        next_record = _clone_task_record(record)
        next_record.task.last_updated_at = _iso_no_millis(self.clock.now())
        try:
            result = self.tool_registry.call(
                str(record.tool_name or ""),
                args,
                McpToolContext(session_id=record.session_id, request_id=record.task.task_id, method=record.method),
            )
            next_record.result = result
            next_record.task.status = "failed" if bool(result.get("isError")) else "completed"
            if bool(result.get("isError")):
                next_record.task.status_message = "tool returned isError result"
        except Exception as exc:  # noqa: BLE001
            next_record.error = McpRPCError(code=MCP_CODE_SERVER_ERROR, message=_error_message(exc))
            next_record.task.status = "failed"
            next_record.task.status_message = _error_message(exc)
        try:
            store.update(next_record)
        except McpTaskTerminalError:
            return

    def _handle_tasks_get(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        lookup, error = _task_lookup_from_request(request, session_id)
        if error:
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, error)
        try:
            return _new_result_response(request.id, _task_to_json(self._require_task_store().get(lookup).task))
        except Exception as exc:  # noqa: BLE001
            return _task_store_error(request.id, exc)

    def _handle_tasks_result(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        lookup, error = _task_lookup_from_request(request, session_id)
        if error:
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, error)
        try:
            record = self._require_task_store().get(lookup)
            if record.error is not None:
                return {"jsonrpc": JSONRPC_VERSION, "id": request.id, "error": _error_to_json(record.error)}
            if record.task.status == "canceled" and record.result is None:
                return _new_error_response(request.id, MCP_CODE_SERVER_ERROR, TASK_CANCELED_MESSAGE)
            if record.result is None:
                return _new_error_response(request.id, MCP_CODE_INTERNAL_ERROR, "task result not available")
            return _new_result_response(
                request.id, _task_result_with_related_metadata(record.result, record.task.task_id)
            )
        except Exception as exc:  # noqa: BLE001
            return _task_store_error(request.id, exc)

    def _handle_tasks_list(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        try:
            return _new_result_response(
                request.id,
                _task_list_result_to_json(
                    self._require_task_store().list(
                        {
                            "session_id": session_id,
                            "cursor": str(_params_record(request.params).get("cursor") or ""),
                            "limit": self.task_runtime.list_limit,
                        }
                    )
                ),
            )
        except Exception as exc:  # noqa: BLE001
            return _task_store_error(request.id, exc)

    def _handle_tasks_cancel(self, request: _ParsedRPCRequest, session_id: str) -> dict[str, Any]:
        lookup, error = _task_lookup_from_request(request, session_id)
        if error:
            return _new_error_response(request.id, MCP_CODE_INVALID_PARAMS, error)
        try:
            return _new_result_response(request.id, _task_to_json(self._require_task_store().cancel(lookup).task))
        except Exception as exc:  # noqa: BLE001
            return _task_store_error(request.id, exc)

    def _require_task_store(self) -> McpTaskStore:
        if self.task_runtime.store is None:
            raise ValueError("tasks not enabled")
        return self.task_runtime.store

    def _tasks_enabled(self) -> bool:
        return self.task_runtime.store is not None and self.tool_registry.supports_tasks()

    def _method_capability_enabled(self, method: str) -> bool:
        if method in {"tools/list", "tools/call"}:
            return self.tool_registry.len() > 0
        if method in {"resources/list", "resources/read"}:
            return self.resource_registry.len() > 0
        if method == "resources/templates/list":
            return self.resource_registry.template_len() > 0
        if method in {"prompts/list", "prompts/get"}:
            return self.prompt_registry.len() > 0
        return True

    def _get_session(self, session_id: str) -> McpSession:
        session = _clone_session(self.session_store.get(session_id))
        if _session_expired_at(self.clock.now(), session):
            self.session_store.delete(session_id)
            raise McpSessionNotFoundError()
        refreshed = _clone_session(session)
        refreshed.expires_at = _iso_no_millis(self.clock.now() + dt.timedelta(milliseconds=self.session_ttl_ms))
        if not refreshed.created_at:
            refreshed.created_at = _iso_no_millis(self.clock.now())
        self.session_store.put(refreshed)
        return refreshed

    def _require_session(self, headers: dict[str, Any]) -> tuple[str, McpSession | None, Response | None]:
        session_id = _first_header(headers, MCP_HEADER_SESSION_ID)
        if not session_id:
            return "", None, _bad_request("missing Mcp-Session-Id")
        try:
            return session_id, self._get_session(session_id), None
        except McpSessionNotFoundError:
            return "", None, _not_found("session not found")
        except Exception:  # noqa: BLE001
            return "", None, _internal_server_error()

    def _require_protocol_version(self, headers: dict[str, Any], session: McpSession) -> Response | None:
        value = _first_header(headers, MCP_HEADER_PROTOCOL_VERSION)
        if not value:
            return None
        if not _is_supported_protocol_version(value):
            return _bad_request("unsupported MCP-Protocol-Version")
        expected = str((session.data or {}).get("protocolVersion") or "").strip()
        if expected and expected != value:
            return _bad_request("MCP-Protocol-Version mismatch")
        return None

    def _create_session(self, protocol_version: str) -> McpSession:
        now = self.clock.now()
        session = McpSession(
            id=_normalize_required(self.id_generator.new_id(), "session id generator returned empty id"),
            created_at=_iso_no_millis(now),
            expires_at=_iso_no_millis(now + dt.timedelta(milliseconds=self.session_ttl_ms)),
            data={"protocolVersion": protocol_version},
        )
        self.session_store.put(session)
        return session

    def _marshal_single_response(
        self, response: dict[str, Any], session_id: str = "", include_session: bool = False
    ) -> Response:
        headers: dict[str, list[str]] = {"content-type": ["application/json"]}
        if include_session and session_id:
            headers[MCP_HEADER_SESSION_ID] = [session_id]
        return Response(status=200, headers=headers, cookies=[], body=_json_bytes(response), is_base64=False)

    def _stream_to_sse(self, session_id: str, events: list[McpStreamEvent]) -> Response:
        return _sse_bytes_response(200, [_format_mcp_sse_frame(event) for event in events], session_id)

    def _validate_origin(self, headers: dict[str, Any]) -> Response | None:
        origin = _first_header(headers, "origin")
        if not origin:
            return None
        if not self.origin_validator(origin):
            return _json_bytes_response(403, {"error": "forbidden"})
        return None


def create_mcp_server(name: str, version: str, options: McpServerOptions | dict[str, Any] | None = None) -> McpServer:
    return McpServer(name, version, options)


def default_mcp_task_model(table_name: str | None = None) -> Any:
    from theorydb_py import ModelDefinition

    return ModelDefinition.from_dataclass(
        _McpTaskItem, table_name=table_name or os.environ.get("MCP_TASK_TABLE") or DEFAULT_TASK_TABLE_NAME
    )


def default_mcp_stream_model(table_name: str | None = None) -> Any:
    from theorydb_py import ModelDefinition

    return ModelDefinition.from_dataclass(
        _McpStreamItem, table_name=table_name or os.environ.get("MCP_STREAM_TABLE") or DEFAULT_STREAM_TABLE_NAME
    )


def _new_theorydb_table(model: Any, table_name: str | None = None) -> Any:
    from theorydb_py import Table

    return Table(model, table_name=table_name or getattr(model, "table_name", None))


def _normalize_session_ttl_ms(value: int) -> int:
    if int(value or 0) > 0:
        return int(value)
    raw = str(os.environ.get("MCP_SESSION_TTL_MINUTES") or "").strip()
    try:
        minutes = float(raw or DEFAULT_SESSION_TTL_MINUTES)
    except ValueError:
        minutes = DEFAULT_SESSION_TTL_MINUTES
    return int(minutes * 60 * 1000) if minutes > 0 else DEFAULT_SESSION_TTL_MINUTES * 60 * 1000


def _normalize_task_runtime(options: McpTaskRuntimeOptions | dict[str, Any] | None) -> _NormalizedTaskRuntime:
    store = _field(options, "store") if options is not None else None
    if store is None:
        return _NormalizedTaskRuntime()
    max_ttl_ms = _positive_integer(
        _field(options, "max_ttl_ms") or _field(options, "maxTtlMs"), DEFAULT_TASK_MAX_TTL_MS
    )
    default_ttl_ms = _positive_integer(
        _field(options, "default_ttl_ms") or _field(options, "defaultTtlMs"), DEFAULT_TASK_TTL_MS
    )
    if default_ttl_ms > max_ttl_ms:
        default_ttl_ms = max_ttl_ms
    poll_interval_ms = _positive_integer(
        _field(options, "poll_interval_ms") or _field(options, "pollIntervalMs"), DEFAULT_TASK_POLL_INTERVAL_MS
    )
    list_limit = _positive_integer(
        _field(options, "list_limit") or _field(options, "listLimit"), DEFAULT_TASK_LIST_LIMIT
    )
    if list_limit > MAX_TASK_LIST_LIMIT:
        list_limit = MAX_TASK_LIST_LIMIT
    return _NormalizedTaskRuntime(
        store=cast(McpTaskStore, store),
        default_ttl_ms=default_ttl_ms,
        max_ttl_ms=max(max_ttl_ms, 1),
        poll_interval_ms=poll_interval_ms,
        list_limit=list_limit,
        model_immediate_response=str(
            _field(options, "model_immediate_response") or _field(options, "modelImmediateResponse") or ""
        ).strip(),
    )


def _positive_integer(value: Any, fallback: int) -> int:
    try:
        n = int(value or 0)
    except Exception:  # noqa: BLE001
        n = 0
    return n if n > 0 else fallback


def _is_supported_protocol_version(value: str) -> bool:
    return value in {MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_PRIOR, MCP_PROTOCOL_VERSION_LEGACY}


def _negotiate_protocol_version(params: Any) -> str:
    requested = str(_params_record(params).get("protocolVersion") or "").strip()
    if not requested:
        return MCP_PROTOCOL_VERSION
    return requested if _is_supported_protocol_version(requested) else MCP_PROTOCOL_VERSION


def _session_protocol_version(session: McpSession) -> str:
    value = str((session.data or {}).get("protocolVersion") or "").strip()
    return value if _is_supported_protocol_version(value) else MCP_PROTOCOL_VERSION_LEGACY


def _method_allowed_for_protocol(protocol_version: str, method: str) -> bool:
    if not _is_supported_protocol_version(protocol_version):
        return False
    if _is_task_method(method):
        return protocol_version == MCP_PROTOCOL_VERSION
    return method in {
        "initialize",
        "notifications/initialized",
        "notifications/cancelled",
        "ping",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "resources/templates/list",
        "resources/subscribe",
        "resources/unsubscribe",
        "logging/setLevel",
        "completion/complete",
        "prompts/list",
        "prompts/get",
    }


def _is_task_method(method: str) -> bool:
    return method in {"tasks/get", "tasks/result", "tasks/list", "tasks/cancel"}


def _parse_request(body: bytes) -> _ParsedRPCRequest:
    raw = _parse_json_object(body)
    if "jsonrpc" not in raw:
        raise ValueError("missing required field: jsonrpc")
    if "method" not in raw:
        raise ValueError("missing required field: method")
    id_present = "id" in raw
    if id_present and raw.get("id") is None:
        raise ValueError("id must not be null")
    jsonrpc = str(raw.get("jsonrpc") or "")
    if jsonrpc != JSONRPC_VERSION:
        raise ValueError(f"unsupported jsonrpc version: {jsonrpc}")
    method = str(raw.get("method") or "")
    if not method:
        raise ValueError("method must not be empty")
    return _ParsedRPCRequest(method=method, id_present=id_present, id=raw.get("id"), params=raw.get("params"))


def _parse_response(body: bytes) -> None:
    raw = _parse_json_object(body)
    if "jsonrpc" not in raw:
        raise ValueError("missing required field: jsonrpc")
    if "id" not in raw:
        raise ValueError("missing required field: id")
    has_result = "result" in raw
    has_error = "error" in raw
    if has_result == has_error:
        raise ValueError("response must have exactly one of result or error")
    if str(raw.get("jsonrpc") or "") != JSONRPC_VERSION:
        raise ValueError(f"unsupported jsonrpc version: {raw.get('jsonrpc') or ''}")


def _parse_json_object(body: bytes) -> dict[str, Any]:
    if not body:
        raise ValueError("empty request body")
    parsed = jsonlib.loads(body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("invalid JSON object")
    return cast(dict[str, Any], parsed)


def _validate_post_headers(headers: dict[str, Any]) -> Response | None:
    if not _content_type_is_json(headers):
        return _bad_request("POST /mcp requires Content-Type: application/json")
    if not _accepts_json(headers) or not _accepts_event_stream(headers):
        return _bad_request("POST /mcp requires Accept: application/json and text/event-stream")
    return None


def _validate_get_headers(headers: dict[str, Any]) -> Response | None:
    if not _accepts_event_stream(headers):
        return _bad_request("GET /mcp requires Accept: text/event-stream")
    return None


def _content_type_is_json(headers: dict[str, Any]) -> bool:
    media = _parse_media_range(_first_header(headers, "content-type"))
    return bool(media and media[0] == "application" and media[1] == "json")


def _accepts_json(headers: dict[str, Any]) -> bool:
    return _header_includes_media_type(headers, "accept", "application/json")


def _accepts_event_stream(headers: dict[str, Any]) -> bool:
    return _header_includes_media_type(headers, "accept", "text/event-stream")


def _header_includes_media_type(headers: dict[str, Any], key: str, want: str) -> bool:
    want_media = _parse_media_range(want)
    if want_media is None:
        return False
    for value in _header_values(headers, key):
        for part in str(value).split(","):
            media = _parse_media_range(part)
            if media is None:
                continue
            type_matches = media[0] in {"*", want_media[0]}
            subtype_matches = media[1] in {"*", want_media[1]}
            if type_matches and subtype_matches:
                return True
    return False


def _parse_media_range(raw: str) -> tuple[str, str] | None:
    parts = str(raw or "").split(";")
    media_type = parts[0].strip().lower()
    if not media_type or "/" not in media_type:
        return None
    type_part, subtype_part = media_type.split("/", 1)
    if not type_part.strip() or not subtype_part.strip():
        return None
    for param in parts[1:]:
        name, _, value = str(param).partition("=")
        if name.strip().lower() != "q":
            continue
        try:
            if float(value.strip().strip('"')) <= 0:
                return None
        except ValueError:
            continue
    return type_part.strip(), subtype_part.strip()


def _first_header(headers: dict[str, Any], key: str) -> str:
    values = _header_values(headers, key)
    return str(values[0]) if values else ""


def _header_values(headers: dict[str, Any], key: str) -> list[str]:
    lower = str(key or "").lower()
    direct = headers.get(lower)
    if isinstance(direct, list):
        return [str(v) for v in direct]
    if direct is not None:
        return [str(direct)]
    for name, values in (headers or {}).items():
        if str(name).lower() != lower:
            continue
        if isinstance(values, list):
            return [str(v) for v in values]
        return [str(values)]
    return []


def _new_error_response(id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": id if id is not None else None,
        "error": {"code": int(code), "message": str(message)},
    }


def _new_result_response(id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": JSONRPC_VERSION, "id": id if id is not None else None, "result": result}


def _bad_request(message: str) -> Response:
    return _json_bytes_response(400, {"error": message})


def _not_found(message: str) -> Response:
    return _json_bytes_response(404, {"error": message})


def _internal_server_error() -> Response:
    return _json_bytes_response(500, {"error": "internal server error"})


def _json_bytes_response(status: int, value: Any) -> Response:
    return Response(
        status=status,
        headers={"content-type": ["application/json"]},
        cookies=[],
        body=_json_bytes(value),
        is_base64=False,
    )


def _empty_response(status: int) -> Response:
    return Response(status=status, headers={}, cookies=[], body=b"", is_base64=False)


def _sse_bytes_response(status: int, chunks: list[bytes], session_id: str) -> Response:
    return Response(
        status=status,
        headers={
            "content-type": ["text/event-stream"],
            "cache-control": ["no-cache"],
            "connection": ["keep-alive"],
            MCP_HEADER_SESSION_ID: [session_id],
        },
        cookies=[],
        body=b"".join(chunks),
        is_base64=False,
    )


def _format_mcp_sse_frame(event: McpStreamEvent) -> bytes:
    lines: list[str] = []
    event_id = str(event.id or "").strip()
    if event_id:
        lines.append(f"id: {event_id}")
    data = bytes(event.data or b"").decode("utf-8") if event.data else ""
    if data:
        lines.append("event: message")
    lines.extend(f"data: {line}" for line in data.replace("\r\n", "\n").replace("\r", "\n").split("\n"))
    return f"{'\n'.join(lines)}\n\n".encode()


def _normalize_tool_def(definition: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": str(definition.get("name") or "").strip(),
        "inputSchema": definition.get("inputSchema", definition.get("input_schema", {})),
    }
    _copy_optional_string(out, "title", definition.get("title"))
    _copy_optional_string(out, "description", definition.get("description"))
    output_schema = definition.get("outputSchema", definition.get("output_schema"))
    if output_schema is not None:
        out["outputSchema"] = output_schema
    execution = _as_dict(definition.get("execution"))
    support = str(execution.get("taskSupport") or execution.get("task_support") or "")
    if support in {"optional", "required"}:
        out["execution"] = {"taskSupport": support}
    return out


def _normalize_tool_result(result: Any) -> dict[str, Any]:
    raw = _as_dict(result)
    content = raw.get("content")
    out: dict[str, Any] = {
        "content": [_normalize_content_block(block) for block in content] if isinstance(content, list) else []
    }
    if bool(raw.get("isError") or raw.get("is_error")):
        out["isError"] = True
    structured = raw.get("structuredContent", raw.get("structured_content"))
    if isinstance(structured, dict):
        out["structuredContent"] = dict(structured)
    return out


def _normalize_content_block(block: Any) -> dict[str, Any]:
    raw = _as_dict(block)
    out: dict[str, Any] = {"type": str(raw.get("type") or "")}
    for key, snake in [
        ("text", "text"),
        ("data", "data"),
        ("mimeType", "mime_type"),
        ("uri", "uri"),
        ("name", "name"),
        ("title", "title"),
        ("description", "description"),
    ]:
        _copy_optional_string(out, key, raw.get(key, raw.get(snake)))
    size = raw.get("size")
    if isinstance(size, int | float):
        out["size"] = int(size)
    resource = raw.get("resource")
    if resource is not None:
        out["resource"] = _normalize_resource_content(resource)
    return out


def _normalize_resource_def(definition: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "uri": str(definition.get("uri") or "").strip(),
        "name": str(definition.get("name") or "").strip(),
    }
    _copy_optional_string(out, "title", definition.get("title"))
    _copy_optional_string(out, "description", definition.get("description"))
    _copy_optional_string(out, "mimeType", definition.get("mimeType", definition.get("mime_type")))
    size = definition.get("size")
    if isinstance(size, int | float):
        out["size"] = int(size)
    return out


def _normalize_resource_template_def(definition: Mapping[str, Any]) -> dict[str, Any]:
    out = {
        "uriTemplate": str(definition.get("uriTemplate") or definition.get("uri_template") or "").strip(),
        "name": str(definition.get("name") or "").strip(),
    }
    _copy_optional_string(out, "title", definition.get("title"))
    _copy_optional_string(out, "description", definition.get("description"))
    _copy_optional_string(out, "mimeType", definition.get("mimeType", definition.get("mime_type")))
    return out


def _normalize_resource_content(content: Any) -> dict[str, Any]:
    raw = _as_dict(content)
    out: dict[str, Any] = {"uri": str(raw.get("uri") or "")}
    _copy_optional_string(out, "mimeType", raw.get("mimeType", raw.get("mime_type")))
    _copy_optional_string(out, "text", raw.get("text"))
    _copy_optional_string(out, "blob", raw.get("blob"))
    return out


def _normalize_prompt_def(definition: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"name": str(definition.get("name") or "").strip()}
    _copy_optional_string(out, "title", definition.get("title"))
    _copy_optional_string(out, "description", definition.get("description"))
    args = definition.get("arguments")
    if isinstance(args, list):
        out["arguments"] = [_normalize_prompt_argument(arg) for arg in args]
    return out


def _normalize_prompt_argument(argument: Any) -> dict[str, Any]:
    raw = _as_dict(argument)
    out: dict[str, Any] = {"name": str(raw.get("name") or "")}
    _copy_optional_string(out, "title", raw.get("title"))
    _copy_optional_string(out, "description", raw.get("description"))
    if bool(raw.get("required")):
        out["required"] = True
    return out


def _normalize_prompt_result(result: Any) -> dict[str, Any]:
    raw = _as_dict(result)
    messages = raw.get("messages")
    out: dict[str, Any] = {
        "messages": [
            {
                "role": str(_field(message, "role") or ""),
                "content": _normalize_content_block(_field(message, "content")),
            }
            for message in messages
        ]
        if isinstance(messages, list)
        else []
    }
    _copy_optional_string(out, "description", raw.get("description"))
    return out


def _copy_optional_string(out: dict[str, Any], key: str, value: Any) -> None:
    normalized = str(value or "").strip()
    if normalized:
        out[key] = normalized


def _valid_resource_uri(uri: str) -> bool:
    value = str(uri or "").strip()
    if not value or any(ch.isspace() for ch in value):
        return False
    return bool(urlparse(value).scheme)


def _params_record(params: Any) -> dict[str, Any]:
    return dict(params) if isinstance(params, dict) else {}


def _to_bytes(value: bytes | bytearray | str | Any | None) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return bytes(value)
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    return str(value).encode("utf-8")


def _clone_session(session: McpSession | dict[str, Any]) -> McpSession:
    return McpSession(
        id=str(_field(session, "id") or "").strip(),
        created_at=str(_field(session, "created_at") or _field(session, "createdAt") or ""),
        expires_at=str(_field(session, "expires_at") or _field(session, "expiresAt") or ""),
        data=dict(_field(session, "data") or {}) if isinstance(_field(session, "data"), dict) else None,
    )


def _session_expired_at(now: dt.datetime, session: McpSession) -> bool:
    if not session.expires_at:
        return False
    try:
        expires = dt.datetime.fromisoformat(session.expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.UTC)
    return expires <= now_utc.astimezone(dt.UTC)


def _iso_no_millis(value: dt.datetime) -> str:
    dt_utc = value.astimezone(dt.UTC) if value.tzinfo else value.replace(tzinfo=dt.UTC)
    return dt_utc.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _error_message(exc: Any) -> str:
    return str(exc)


def _normalize_required(value: Any, message: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(message)
    return normalized


def _tool_call_error(id: Any, tool_name: str, exc: Any) -> dict[str, Any]:
    message = _error_message(exc)
    if message.startswith("tool not found:"):
        return _new_error_response(id, MCP_CODE_INVALID_PARAMS, message)
    return _new_error_response(id, MCP_CODE_SERVER_ERROR, message if tool_name else message or "internal error")


def _normalize_progress_token(value: Any) -> str | int | float | None:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    if isinstance(value, int | float):
        return value
    return None


def _progress_from_sse_event(event: McpSSEEvent | dict[str, Any], fallback_progress: int) -> dict[str, Any]:
    data = _field(event, "data")
    if isinstance(data, dict):
        progress = _number_from_unknown(data.get("progress", data.get("seq")))
        return {
            "progress": progress if progress is not None else fallback_progress,
            "total": data.get("total"),
            "message": data.get("message") if isinstance(data.get("message"), str) else "",
        }
    if isinstance(data, str):
        return {"progress": fallback_progress, "total": None, "message": data}
    return {"progress": fallback_progress, "total": None, "message": ""}


def _number_from_unknown(value: Any) -> float | int | None:
    try:
        return int(value) if float(value).is_integer() else float(value)
    except Exception:  # noqa: BLE001
        return None


def _task_ttl(runtime: _NormalizedTaskRuntime, meta: dict[str, Any]) -> dict[str, Any]:
    ttl = runtime.default_ttl_ms
    if "ttl" in meta:
        try:
            candidate = int(meta.get("ttl") or 0)
        except Exception:  # noqa: BLE001
            candidate = 0
        if candidate <= 0:
            return {"value": 0, "error": "Invalid params: task.ttl must be positive"}
        ttl = candidate
    if ttl > runtime.max_ttl_ms:
        return {"value": 0, "error": "Invalid params: task.ttl exceeds maximum"}
    return {"value": ttl, "error": ""}


def _task_lookup_from_request(request: _ParsedRPCRequest, session_id: str) -> tuple[McpTaskLookup, str]:
    task_id = str(_params_record(request.params).get("taskId") or "").strip()
    if not task_id:
        return McpTaskLookup(session_id=session_id, task_id=""), "Invalid params: missing taskId"
    return McpTaskLookup(session_id=session_id, task_id=task_id), ""


def _task_store_error(id: Any, exc: Any) -> dict[str, Any]:
    if isinstance(exc, McpTaskNotFoundError | McpTaskTerminalError | McpTaskInvalidCursorError):
        return _new_error_response(id, MCP_CODE_INVALID_PARAMS, _error_message(exc))
    return _new_error_response(id, MCP_CODE_SERVER_ERROR, _error_message(exc))


def _task_status_terminal(status: str) -> bool:
    return status in {"completed", "failed", "canceled"}


def _task_list_limit(value: Any) -> int:
    limit = _positive_integer(value, DEFAULT_TASK_LIST_LIMIT)
    return min(limit, MAX_TASK_LIST_LIMIT)


def _parse_task_cursor(value: str) -> int:
    cursor = str(value or "").strip()
    if not cursor:
        return 0
    try:
        parsed = int(cursor)
    except ValueError as exc:
        raise McpTaskInvalidCursorError() from exc
    if parsed < 0:
        raise McpTaskInvalidCursorError()
    return parsed


def _clone_task(task: McpTask | dict[str, Any]) -> McpTask:
    status = str(_field(task, "status") or "working")
    if status not in {"working", "input_required", "completed", "failed", "canceled"}:
        status = "working"
    return McpTask(
        task_id=str(_field(task, "task_id") or _field(task, "taskId") or ""),
        status=cast(McpTaskStatus, status),
        status_message=str(_field(task, "status_message") or _field(task, "statusMessage") or ""),
        created_at=str(_field(task, "created_at") or _field(task, "createdAt") or ""),
        last_updated_at=str(_field(task, "last_updated_at") or _field(task, "lastUpdatedAt") or ""),
        ttl=int(_field(task, "ttl") or 0),
        poll_interval=_int_or_none(_field(task, "poll_interval") or _field(task, "pollInterval")),
    )


def _clone_task_record(record: McpTaskRecord | dict[str, Any]) -> McpTaskRecord:
    return McpTaskRecord(
        session_id=str(_field(record, "session_id") or _field(record, "sessionId") or ""),
        method=str(_field(record, "method") or ""),
        tool_name=str(_field(record, "tool_name") or _field(record, "toolName") or ""),
        task=_clone_task(cast(McpTask | dict[str, Any], _field(record, "task") or {})),
        result=_json_clone(_field(record, "result")) if _field(record, "result") is not None else None,
        error=_clone_error(_field(record, "error")),
    )


def _clone_error(error: Any) -> McpRPCError | None:
    if error is None:
        return None
    return McpRPCError(
        code=int(_field(error, "code") or 0), message=str(_field(error, "message") or ""), data=_field(error, "data")
    )


def _task_to_json(task: McpTask | dict[str, Any]) -> dict[str, Any]:
    normalized = _clone_task(task)
    out: dict[str, Any] = {
        "taskId": normalized.task_id,
        "status": normalized.status,
        "createdAt": normalized.created_at,
        "lastUpdatedAt": normalized.last_updated_at,
        "ttl": normalized.ttl,
    }
    if normalized.status_message:
        out["statusMessage"] = normalized.status_message
    if normalized.poll_interval is not None:
        out["pollInterval"] = normalized.poll_interval
    return out


def _task_list_result_to_json(result: McpTaskListResult | dict[str, Any]) -> dict[str, Any]:
    tasks = _field(result, "tasks") or []
    out: dict[str, Any] = {"tasks": [_task_to_json(task) for task in tasks] if isinstance(tasks, list) else []}
    next_cursor = str(_field(result, "next_cursor") or _field(result, "nextCursor") or "")
    if next_cursor:
        out["nextCursor"] = next_cursor
    return out


def _error_to_json(error: McpRPCError | dict[str, Any]) -> dict[str, Any]:
    cloned = _clone_error(error)
    if cloned is None:
        return {}
    out: dict[str, Any] = {"code": cloned.code, "message": cloned.message}
    if cloned.data is not None:
        out["data"] = cloned.data
    return out


def _task_result_with_related_metadata(result: Any, task_id: str) -> Any:
    out: dict[str, Any] = dict(cast(dict[str, Any], result)) if isinstance(result, dict) else {}
    meta_raw = out.get("_meta")
    existing_meta: dict[str, Any] = dict(cast(dict[str, Any], meta_raw)) if isinstance(meta_raw, dict) else {}
    existing_meta[RELATED_TASK_METADATA_KEY] = {"taskId": task_id}
    out["_meta"] = existing_meta
    return out


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:  # noqa: BLE001
        return None


def _int_field(value: Any, name: str) -> int:
    try:
        return int(_field(value, name) or 0)
    except Exception:  # noqa: BLE001
        return 0


def _as_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if is_dataclass(value):
        out: dict[str, Any] = {}
        for name in getattr(value, "__dataclass_fields__", {}):
            out[name] = getattr(value, name)
        return out
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return {}


def _field(value: Any, name: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _set_item_attr(value: Any, name: str, item_value: Any) -> None:
    if isinstance(value, dict):
        value[name] = item_value
    else:
        setattr(value, name, item_value)


def _json_clone(value: Any) -> Any:
    return jsonlib.loads(jsonlib.dumps(value, separators=(",", ":")))


def _json_bytes(value: Any) -> bytes:
    return jsonlib.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _resolve_maybe(value: T | Awaitable[T]) -> T:
    if not inspect.isawaitable(value):
        return cast(T, value)

    async def _await_any(awaitable: Awaitable[T]) -> T:
        return await awaitable

    try:
        return asyncio.run(_await_any(cast(Awaitable[T], value)))
    except RuntimeError as exc:  # pragma: no cover
        raise RuntimeError(
            "apptheory.mcp: cannot resolve awaitable from sync MCP handler while an event loop is running"
        ) from exc


def _base64_encode(value: bytes) -> str:
    import base64

    return base64.b64encode(value).decode("ascii")


def _base64_decode(value: str) -> bytes:
    import base64

    return base64.b64decode(str(value or ""))


def _is_not_found_error(exc: Exception) -> bool:
    name = type(exc).__name__.lower()
    message = str(exc).lower()
    return (
        isinstance(exc, McpTaskNotFoundError | McpStreamNotFoundError) or "notfound" in name or "not found" in message
    )


def _theorydb_meta(
    name: str,
    *,
    roles: list[str] | None = None,
    omitempty: bool = False,
    json_field: bool = False,
) -> dict[str, Any]:
    return {
        "theorydb": {
            "name": name,
            "roles": list(roles or []),
            "omitempty": bool(omitempty),
            "set": False,
            "json": bool(json_field),
            "binary": False,
            "encrypted": False,
            "converter": None,
            "ignore": False,
        }
    }


def _s(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default="", metadata=_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _n(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default=0, metadata=_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _b(name: str, *, omitempty: bool = False) -> Any:
    return field(default=False, metadata=_theorydb_meta(name, omitempty=omitempty))


def _m(name: str, *, omitempty: bool = False) -> Any:
    return field(default=None, metadata=_theorydb_meta(name, omitempty=omitempty, json_field=True))


_MCP_TASK_RESULT_FIELD = _m("result", omitempty=True)
_MCP_TASK_ERROR_FIELD = _m("error", omitempty=True)


@dataclass(slots=True)
class _McpTaskItem:
    session_id: str = _s("sessionId", roles=["pk"])
    task_id: str = _s("taskId", roles=["sk"])
    method: str = _s("method")
    tool_name: str = _s("toolName", omitempty=True)
    status: str = _s("status")
    status_message: str = _s("statusMessage", omitempty=True)
    created_at: str = _s("createdAt")
    last_updated_at: str = _s("lastUpdatedAt")
    ttl: int = _n("ttl", omitempty=True)
    poll_interval: int = _n("pollInterval", omitempty=True)
    result: dict[str, Any] | None = _MCP_TASK_RESULT_FIELD
    error: dict[str, Any] | None = _MCP_TASK_ERROR_FIELD


@dataclass(slots=True)
class _McpStreamItem:
    session_id: str = _s("sessionId", roles=["pk"])
    item_id: str = _s("itemId", roles=["sk"])
    stream_id: str = _s("streamId")
    kind: str = _s("kind")
    closed: bool = _b("closed", omitempty=True)
    sequence: int = _n("sequence", omitempty=True)
    event_id: str = _s("eventId", omitempty=True)
    data: str = _s("data", omitempty=True)


def _task_record_to_item(record: McpTaskRecord) -> _McpTaskItem:
    return _McpTaskItem(
        session_id=record.session_id,
        task_id=record.task.task_id,
        method=record.method,
        tool_name=record.tool_name,
        status=record.task.status,
        status_message=record.task.status_message,
        created_at=record.task.created_at,
        last_updated_at=record.task.last_updated_at,
        ttl=record.task.ttl,
        poll_interval=record.task.poll_interval or 0,
        result=record.result if isinstance(record.result, dict) else None,
        error=_error_to_json(record.error) if record.error is not None else None,
    )


def _item_to_task_record(item: Any) -> McpTaskRecord:
    task = McpTask(
        task_id=str(_field(item, "task_id") or _field(item, "taskId") or ""),
        status=cast(McpTaskStatus, str(_field(item, "status") or "working")),
        status_message=str(_field(item, "status_message") or _field(item, "statusMessage") or ""),
        created_at=str(_field(item, "created_at") or _field(item, "createdAt") or ""),
        last_updated_at=str(_field(item, "last_updated_at") or _field(item, "lastUpdatedAt") or ""),
        ttl=int(_field(item, "ttl") or 0),
        poll_interval=_int_or_none(_field(item, "poll_interval") or _field(item, "pollInterval")),
    )
    return McpTaskRecord(
        session_id=str(_field(item, "session_id") or _field(item, "sessionId") or ""),
        method=str(_field(item, "method") or ""),
        tool_name=str(_field(item, "tool_name") or _field(item, "toolName") or ""),
        task=task,
        result=_field(item, "result"),
        error=_clone_error(_field(item, "error")),
    )


__all__ = [
    "DEFAULT_STREAM_TABLE_NAME",
    "DEFAULT_TASK_TABLE_NAME",
    "MCP_CODE_INTERNAL_ERROR",
    "MCP_CODE_INVALID_PARAMS",
    "MCP_CODE_INVALID_REQUEST",
    "MCP_CODE_METHOD_NOT_FOUND",
    "MCP_CODE_PARSE_ERROR",
    "MCP_CODE_SERVER_ERROR",
    "MCP_HEADER_LAST_EVENT_ID",
    "MCP_HEADER_PROTOCOL_VERSION",
    "MCP_HEADER_SESSION_ID",
    "MCP_PROTOCOL_VERSION",
    "MCP_PROTOCOL_VERSION_LEGACY",
    "MCP_PROTOCOL_VERSION_PRIOR",
    "DynamoMcpStreamStore",
    "DynamoMcpTaskStore",
    "McpContentBlock",
    "McpEventNotFoundError",
    "McpJSONRecord",
    "McpJSONValue",
    "McpPromptArgument",
    "McpPromptDef",
    "McpPromptHandler",
    "McpPromptMessage",
    "McpPromptRegistry",
    "McpPromptResult",
    "McpRPCError",
    "McpRPCRequest",
    "McpRPCResponse",
    "McpRequestID",
    "McpResourceContent",
    "McpResourceContext",
    "McpResourceDef",
    "McpResourceHandler",
    "McpResourceRegistry",
    "McpResourceTemplateDef",
    "McpSSEEvent",
    "McpServer",
    "McpServerOptions",
    "McpSession",
    "McpSessionNotFoundError",
    "McpSessionStore",
    "McpStreamEvent",
    "McpStreamNotFoundError",
    "McpStreamStore",
    "McpStreamingToolHandler",
    "McpTask",
    "McpTaskInvalidCursorError",
    "McpTaskListRequest",
    "McpTaskListResult",
    "McpTaskLookup",
    "McpTaskRecord",
    "McpTaskRuntimeOptions",
    "McpTaskStatus",
    "McpTaskStore",
    "McpTaskSupport",
    "McpTaskTerminalError",
    "McpToolContext",
    "McpToolDef",
    "McpToolExecution",
    "McpToolHandler",
    "McpToolRegistry",
    "McpToolResult",
    "MemoryMcpSessionStore",
    "MemoryMcpStreamStore",
    "MemoryMcpTaskStore",
    "create_mcp_server",
    "default_mcp_stream_model",
    "default_mcp_task_model",
]
