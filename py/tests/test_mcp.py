from __future__ import annotations

import copy
import json
import os
import re
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from apptheory import (
    MCP_CODE_HEADER_MISMATCH,
    MCP_CODE_INVALID_PARAMS,
    MCP_CODE_METHOD_NOT_FOUND,
    MCP_CODE_PARSE_ERROR,
    MCP_CODE_SERVER_ERROR,
    MCP_HEADER_METHOD,
    MCP_HEADER_NAME,
    MCP_HEADER_PROTOCOL_VERSION,
    MCP_HEADER_SESSION_ID,
    MCP_PROTOCOL_SHAPE_2025_11_25,
    MCP_PROTOCOL_SHAPE_2026_07_28,
    MCP_PROTOCOL_SHAPE_UNKNOWN,
    MCP_PROTOCOL_VERSION,
    MCP_PROTOCOL_VERSION_2026_07_28,
    MCP_PROTOCOL_VERSION_LEGACY,
    MCP_RESULT_TYPE_COMPLETE,
    MCP_RESULT_TYPE_INPUT_REQUIRED,
    BearerTokenClaims,
    Context,
    DynamoMcpStreamStore,
    DynamoMcpTaskStore,
    McpContentBlock,
    McpEventNotFoundError,
    McpPromptArgument,
    McpPromptDef,
    McpPromptMessage,
    McpPromptResult,
    McpResourceContent,
    McpResourceContext,
    McpResourceDef,
    McpResourceTemplateDef,
    McpRPCError,
    McpRPCRequest,
    McpSession,
    McpSessionNotFoundError,
    McpSSEEvent,
    McpStreamNotFoundError,
    McpTask,
    McpTaskInvalidCursorError,
    McpTaskNotFoundError,
    McpTaskRecord,
    McpTaskRuntimeOptions,
    McpTaskTerminalError,
    McpToolContext,
    McpToolDef,
    McpToolExecution,
    McpToolResult,
    MemoryMcpSessionStore,
    MemoryMcpStreamStore,
    MemoryMcpTaskStore,
    Request,
    SecurePrincipal,
    create_mcp_server,
    create_mcp_test_harness,
    detect_mcp_protocol_version,
    detect_mcp_protocol_version_for_message,
    default_mcp_stream_model,
    sequence_mcp_id_generator,
)
from apptheory.mcp import (
    McpCallerAuth,
    McpSessionCapacityError,
    McpSessionExpiredError,
    McpStreamAggregateBackfillError,
    McpStreamAggregateCapacityError,
    McpStreamAppendConflictError,
    McpStreamEventTooLargeError,
    McpStreamTransactionRequiredError,
    McpTaskCapacityError,
)


def _response_json(response: Any) -> Any:
    return json.loads(response.body.decode("utf-8")) if response.body else None


def _post_headers(*, session_id: str = "", accept: str = "application/json, text/event-stream") -> dict[str, Any]:
    headers: dict[str, Any] = {"content-type": ["application/json"], "accept": [accept]}
    if session_id:
        headers[MCP_HEADER_SESSION_ID] = [session_id]
        headers[MCP_HEADER_PROTOCOL_VERSION] = [MCP_PROTOCOL_VERSION]
    return headers


class _Page:
    def __init__(self, items: list[Any], cursor: str = "", next_cursor: str = "") -> None:
        self.items = items
        self.cursor = cursor
        self.next_cursor = next_cursor or cursor


class _FakeNotFound(Exception):
    pass


class _FakeConditionFailed(Exception):
    pass


class _FixedClock:
    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def now(self) -> datetime:
        return self._moment


class _FakeTheoryTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], Any] = {}
        self._lock = threading.RLock()

    def put(
        self,
        item: Any,
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            key = self._key(item)
            if not self._condition_met(
                self.items.get(key),
                condition_expression,
                expression_attribute_names or {},
                expression_attribute_values or {},
            ):
                raise _FakeConditionFailed("conditional check failed")
            self.items[key] = item

    def save(self, item: Any) -> None:
        self.put(item)

    def update(
        self,
        session_id: str,
        item_id: str,
        updates: dict[str, Any],
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, Any] | None = None,
    ) -> Any:
        with self._lock:
            key = (str(session_id), str(item_id))
            existing = self.items.get(key)
            if not self._condition_met(
                existing,
                condition_expression,
                expression_attribute_names or {},
                expression_attribute_values or {},
            ):
                raise _FakeConditionFailed("conditional check failed")
            if existing is None:
                raise _FakeNotFound("not found")
            for name, value in updates.items():
                setattr(existing, name, value)
            return existing

    def get(self, session_id: str, item_id: str) -> Any:
        key = (str(session_id), str(item_id))
        if key not in self.items:
            raise _FakeNotFound("not found")
        return self.items[key]

    def query(self, session_id: str, *, limit: int = 1000, cursor: str = "") -> _Page:
        selected = [item for (pk, _), item in self.items.items() if pk == str(session_id)]
        start = int(str(cursor or "0") or "0")
        next_cursor = str(start + limit) if start + limit < len(selected) else ""
        return _Page(selected[start : start + limit], cursor=next_cursor, next_cursor=next_cursor)

    def delete(self, session_id: str, item_id: str) -> None:
        self.items.pop((str(session_id), str(item_id)), None)

    def transact_write(self, actions: Any) -> None:
        with self._lock:
            self._transact_write_locked(actions)

    def _transact_write_locked(self, actions: Any) -> None:
        from tabletheory_py import TransactConditionCheck, TransactDelete, TransactPut, TransactUpdate

        for action in actions:
            if isinstance(action, TransactPut):
                existing = self.items.get(self._key(action.item))
                if not self._condition_met(
                    existing,
                    getattr(action, "condition_expression", None),
                    getattr(action, "expression_attribute_names", None) or {},
                    getattr(action, "expression_attribute_values", None) or {},
                ):
                    raise _FakeConditionFailed("conditional check failed")
                continue
            existing = self.items.get((str(action.pk), str(action.sk or "")), None)
            if not self._condition_met(
                existing,
                getattr(action, "condition_expression", None),
                getattr(action, "expression_attribute_names", None) or {},
                getattr(action, "expression_attribute_values", None) or {},
            ):
                raise _FakeConditionFailed("conditional check failed")

        for action in actions:
            if isinstance(action, TransactPut):
                self.put(action.item)
            elif isinstance(action, TransactDelete):
                self.delete(str(action.pk), str(action.sk or ""))
            elif isinstance(action, TransactUpdate):
                existing = self.items.get((str(action.pk), str(action.sk or "")))
                if existing is not None:
                    for name, value in action.updates.items():
                        setattr(existing, name, value)
            elif isinstance(action, TransactConditionCheck):
                continue

    def _condition_met(
        self,
        existing: Any | None,
        expression: str | None,
        names: dict[str, str],
        values: dict[str, Any],
    ) -> bool:
        text = str(expression or "").strip()
        if not text:
            return True
        for clause in text.split(" AND "):
            clause = clause.strip()
            missing = re.match(r"^attribute_not_exists\(\s*(#?\w+)\s*\)$", clause, re.IGNORECASE)
            if missing is not None:
                attribute = self._field_name(str(names.get(missing.group(1), missing.group(1))))
                if existing is None or getattr(existing, attribute, None) in (None, ""):
                    continue
                return False
            match = re.match(r"^(#?\w+)\s*(=|<=|>=|<|>)\s*(:\w+)$", clause)
            if match is None:
                raise AssertionError(f"unsupported fake condition: {clause}")
            if existing is None:
                return False
            attribute = self._field_name(str(names.get(match.group(1), match.group(1))))
            operator = match.group(2)
            expected = values.get(match.group(3))
            actual = getattr(existing, attribute, None)
            if isinstance(expected, bool):
                if operator != "=" or bool(actual) != expected:
                    return False
            elif isinstance(expected, (int, float)):
                left = int(actual or 0)
                right = int(expected)
                checks = {
                    "=": left == right,
                    "<=": left <= right,
                    ">=": left >= right,
                    "<": left < right,
                    ">": left > right,
                }
                if not checks[operator]:
                    return False
            elif operator != "=" or str(actual or "") != str(expected or ""):
                return False
        return True

    @staticmethod
    def _field_name(attribute: str) -> str:
        return {
            "sessionId": "session_id",
            "itemId": "item_id",
            "aggregateVersion": "aggregate_version",
            "eventCount": "event_count",
            "aggregateBytes": "aggregate_bytes",
            "expiresAt": "expires_at",
        }.get(attribute, attribute)

    def _key(self, item: Any) -> tuple[str, str]:
        session_id = str(getattr(item, "session_id", ""))
        item_id = str(getattr(item, "item_id", "") or getattr(item, "task_id", ""))
        return session_id, item_id


class McpRuntimeTests(unittest.TestCase):
    def test_protocol_version_detection_honors_header_precedence_and_request_metadata(self) -> None:
        request_2026 = {
            "jsonrpc": "2.0",
            "id": "shape",
            "method": "ping",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                }
            },
        }

        self.assertEqual(detect_mcp_protocol_version({}, request_2026), MCP_PROTOCOL_SHAPE_2026_07_28)
        self.assertEqual(
            detect_mcp_protocol_version(
                {"MCP-Protocol-Version": [MCP_PROTOCOL_VERSION]},
                request_2026,
            ),
            MCP_PROTOCOL_SHAPE_2025_11_25,
        )
        self.assertEqual(
            detect_mcp_protocol_version(
                {MCP_HEADER_PROTOCOL_VERSION: ["2099-01-01"]},
                request_2026,
            ),
            MCP_PROTOCOL_SHAPE_UNKNOWN,
        )
        self.assertEqual(
            detect_mcp_protocol_version({}, json.dumps(request_2026)),
            MCP_PROTOCOL_SHAPE_2026_07_28,
        )
        self.assertEqual(
            detect_mcp_protocol_version({}, {"jsonrpc": "2.0", "method": "ping"}),
            MCP_PROTOCOL_SHAPE_UNKNOWN,
        )
        self.assertEqual(
            detect_mcp_protocol_version_for_message({}, request_2026),
            MCP_PROTOCOL_SHAPE_2026_07_28,
        )
        self.assertEqual(
            detect_mcp_protocol_version_for_message(
                {},
                McpRPCRequest(
                    method="ping",
                    params=request_2026["params"],
                ),
            ),
            MCP_PROTOCOL_SHAPE_2026_07_28,
        )
        self.assertEqual(
            detect_mcp_protocol_version_for_message(
                {"MCP-Protocol-Version": [MCP_PROTOCOL_VERSION]},
                request_2026,
            ),
            MCP_PROTOCOL_SHAPE_2025_11_25,
        )
        self.assertEqual(
            detect_mcp_protocol_version_for_message({}, json.dumps(request_2026)),
            MCP_PROTOCOL_SHAPE_UNKNOWN,
        )

    def test_2026_07_28_requests_stay_stateless(self) -> None:
        server = create_mcp_server(
            "PyMCP",
            "test",
            {"id_generator": sequence_mcp_id_generator(["sess-after-stateless"])},
        )
        headers = _post_headers()
        headers[MCP_HEADER_PROTOCOL_VERSION] = [MCP_PROTOCOL_VERSION_2026_07_28]
        headers[MCP_HEADER_METHOD] = ["server/discover"]

        ping = server.serve(
            {
                "method": "POST",
                "headers": headers,
                "body": json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": "discover",
                        "method": "server/discover",
                        "params": {
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                                "io.modelcontextprotocol/clientCapabilities": {},
                            }
                        },
                    }
                ),
            }
        )
        self.assertEqual(ping.status, 200)
        self.assertNotIn(MCP_HEADER_SESSION_ID, ping.headers)
        self.assertEqual(
            _response_json(ping),
            {
                "jsonrpc": "2.0",
                "id": "discover",
                "result": {
                    "supportedVersions": [
                        MCP_PROTOCOL_VERSION_2026_07_28,
                        MCP_PROTOCOL_VERSION,
                        "2025-06-18",
                        "2025-03-26",
                    ],
                    "capabilities": {},
                    "_meta": {
                        "io.modelcontextprotocol/serverInfo": {
                            "name": "PyMCP",
                            "version": "test",
                        }
                    },
                    "resultType": MCP_RESULT_TYPE_COMPLETE,
                    "ttlMs": 0,
                    "cacheScope": "private",
                },
            },
        )

        headers[MCP_HEADER_METHOD] = ["initialize"]
        initialize = server.serve(
            {
                "method": "POST",
                "headers": headers,
                "body": json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": "init",
                        "method": "initialize",
                        "params": {
                            "protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                                "io.modelcontextprotocol/clientCapabilities": {},
                            },
                        },
                    }
                ),
            }
        )
        self.assertNotIn(MCP_HEADER_SESSION_ID, initialize.headers)
        self.assertEqual(_response_json(initialize)["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)

        deleted = server.serve(
            {
                "method": "DELETE",
                "headers": {MCP_HEADER_PROTOCOL_VERSION: [MCP_PROTOCOL_VERSION_2026_07_28]},
            }
        )
        self.assertEqual(deleted.status, 405)
        # RFC 9110 15.5.5: the stateless 2026-07-28 shape permits only POST.
        self.assertEqual(deleted.headers.get("allow"), ["POST"])

        legacy = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(),
                "body": json.dumps({"jsonrpc": "2.0", "id": "legacy", "method": "initialize"}),
            }
        )
        self.assertEqual(legacy.headers[MCP_HEADER_SESSION_ID], ["sess-after-stateless"])

    def test_2026_07_28_tools_support_multi_round_input_required_results(self) -> None:
        server = create_mcp_server("PyMCP", "test")

        def continue_tool(args: Any, context: McpToolContext) -> dict[str, Any]:
            message = str((args or {}).get("message") or "")
            if context.request_state == "confirm" and (context.input_responses or {}).get("confirmation"):
                return {"content": [{"type": "text", "text": f"confirmed {message}"}]}
            return {
                "content": [],
                "resultType": MCP_RESULT_TYPE_INPUT_REQUIRED,
                "inputRequests": {
                    "confirmation": {
                        "method": "elicitation/create",
                        "params": {"message": "Confirm"},
                    }
                },
                "requestState": "confirm",
            }

        server.registry().register_tool({"name": "continue", "inputSchema": {}}, continue_tool)
        headers = _post_headers()
        headers[MCP_HEADER_PROTOCOL_VERSION] = [MCP_PROTOCOL_VERSION_2026_07_28]
        headers[MCP_HEADER_METHOD] = ["tools/call"]
        headers[MCP_HEADER_NAME] = ["continue"]

        first = _response_json(
            server.serve(
                {
                    "method": "POST",
                    "headers": headers,
                    "body": json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": "first",
                            "method": "tools/call",
                            "params": {
                                "name": "continue",
                                "arguments": {"message": "contract"},
                                "_meta": {
                                    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                                    "io.modelcontextprotocol/clientCapabilities": {"elicitation": {}},
                                },
                            },
                        }
                    ),
                }
            )
        )
        self.assertEqual(first["result"]["resultType"], MCP_RESULT_TYPE_INPUT_REQUIRED)
        self.assertEqual(first["result"]["requestState"], "confirm")
        self.assertEqual(first["result"]["inputRequests"]["confirmation"]["method"], "elicitation/create")
        self.assertNotIn("content", first["result"])

        second = _response_json(
            server.serve(
                {
                    "method": "POST",
                    "headers": headers,
                    "body": json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": "second",
                            "method": "tools/call",
                            "params": {
                                "name": "continue",
                                "arguments": {"message": "contract"},
                                "requestState": "confirm",
                                "inputResponses": {"confirmation": {"action": "accept"}},
                                "_meta": {
                                    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                                    "io.modelcontextprotocol/clientCapabilities": {"elicitation": {}},
                                },
                            },
                        }
                    ),
                }
            )
        )
        self.assertEqual(second["result"]["resultType"], MCP_RESULT_TYPE_COMPLETE)
        self.assertEqual(second["result"]["content"][0]["text"], "confirmed contract")

    def test_tools_only_harness(self) -> None:
        server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-1"])})
        server.registry().register_tool(
            {
                "name": "echo",
                "description": "Echo text",
                "inputSchema": {"type": "object"},
            },
            lambda args, _ctx: {"content": [{"type": "text", "text": str((args or {}).get("message") or "")}]},
        )

        harness = create_mcp_test_harness(server)
        init = harness.initialize(id="init")
        self.assertEqual(init.response.status, 200)
        self.assertEqual(init.response.headers["mcp-session-id"], ["sess-1"])
        self.assertEqual(init.body_json["result"]["capabilities"], {"tools": {}})

        call = harness.call("sess-1", "tools/call", {"name": "echo", "arguments": {"message": "hello"}}, "call")
        self.assertEqual(call.response.status, 200)
        self.assertEqual(call.body_json["result"], {"content": [{"type": "text", "text": "hello"}]})

    def test_resources_prompts_and_tasks(self) -> None:
        ids = sequence_mcp_id_generator(["sess-2", "task-1"])
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": ids,
                "task_runtime": McpTaskRuntimeOptions(
                    store=MemoryMcpTaskStore(),
                    default_ttl_ms=60000,
                    max_ttl_ms=60000,
                    poll_interval_ms=100,
                    list_limit=10,
                ),
            },
        )
        server.resources().register_resource(
            {"uri": "theory://resource/hello", "name": "hello"},
            lambda ctx: [{"uri": ctx.uri, "mimeType": "text/plain", "text": "hello"}],
        )
        server.resources().register_resource_template({"uriTemplate": "theory://resource/{name}", "name": "by-name"})
        server.prompts().register_prompt(
            {"name": "greet", "arguments": [{"name": "name", "required": True}]},
            lambda args: {
                "description": "Greeting",
                "messages": [{"role": "user", "content": {"type": "text", "text": f"Hi {(args or {}).get('name')}"}}],
            },
        )
        server.registry().register_tool(
            {"name": "task_echo", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            lambda args, _ctx: {
                "content": [{"type": "text", "text": str((args or {}).get("message") or "")}],
                "structuredContent": {"message": str((args or {}).get("message") or "")},
            },
        )

        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]
        resources = harness.call(session_id, "resources/read", {"uri": "theory://resource/hello"}, "res")
        self.assertEqual(resources.body_json["result"]["contents"][0]["text"], "hello")
        prompts = harness.call(session_id, "prompts/get", {"name": "greet", "arguments": {"name": "Ada"}}, "prompt")
        self.assertEqual(prompts.body_json["result"]["messages"][0]["content"]["text"], "Hi Ada")
        task = harness.call(
            session_id,
            "tools/call",
            {"name": "task_echo", "arguments": {"message": "done"}, "task": {}},
            "create",
        )
        self.assertEqual(task.body_json["result"]["task"]["taskId"], "task-1")
        result = harness.call(session_id, "tasks/result", {"taskId": "task-1"}, "result")
        self.assertEqual(result.body_json["result"]["structuredContent"], {"message": "done"})

    def test_streaming_resume(self) -> None:
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-3"]),
                "stream_store": MemoryMcpStreamStore(id_generator=sequence_mcp_id_generator(["stream-1"])),
            },
        )

        def stream(_args: object, emit: object, _ctx: object) -> dict[str, object]:
            emit(McpSSEEvent(data={"seq": 1, "total": 1, "message": "done"}))
            return {"content": [{"type": "text", "text": "ok"}]}

        server.registry().register_streaming_tool({"name": "stream", "inputSchema": {}}, stream)
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]
        streamed = harness.call(
            session_id,
            "tools/call",
            {"name": "stream", "arguments": {}, "_meta": {"progressToken": "pt"}},
            "stream",
        )
        self.assertEqual([frame.id for frame in streamed.sse_frames], ["1", "2", "3"])
        replay = harness.invoke(method="GET", session_id=session_id, last_event_id="1")
        self.assertEqual([frame.id for frame in replay.sse_frames], ["2", "3"])

    def test_initial_session_listener_defaults_to_enabled_and_can_be_declined(self) -> None:
        default_server = create_mcp_server(
            "PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-keepalive"])}
        )
        default_harness = create_mcp_test_harness(default_server)
        default_session_id = default_harness.initialize(id="init").response.headers["mcp-session-id"][0]
        keepalive = default_harness.invoke(method="GET", session_id=default_session_id)
        self.assertEqual(keepalive.response.status, 200)
        self.assertEqual(keepalive.body, b": keepalive\n\n")

        stream_store = MemoryMcpStreamStore(id_generator=sequence_mcp_id_generator(["stream-listener"]))
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-declined"]),
                "stream_store": stream_store,
                "initial_session_listener_enabled": False,
            },
        )
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]

        declined = harness.invoke(method="GET", session_id=session_id)
        self.assertEqual(declined.response.status, 405)
        self.assertEqual(declined.response.headers["allow"], ["DELETE, GET, POST"])
        self.assertEqual(declined.response.headers["content-type"], ["application/json"])
        self.assertEqual(declined.body_json, {"error": "method not allowed"})

        # The session stays usable over POST after the declined common stream.
        self.assertEqual(harness.call(session_id, "tools/list", {}, "list").response.status, 200)

        # Validation order is unchanged: the 405 is not reachable without a valid session.
        bad_origin = harness.invoke(
            method="GET", session_id=session_id, headers={"origin": ["https://evil.example"]}
        )
        self.assertEqual(bad_origin.response.status, 403)
        self.assertEqual(harness.invoke(method="GET").response.status, 400)
        self.assertEqual(harness.invoke(method="GET", session_id="missing").response.status, 404)
        bad_protocol = harness.invoke(
            method="GET", session_id=session_id, protocol_version=MCP_PROTOCOL_VERSION_LEGACY
        )
        self.assertEqual(bad_protocol.response.status, 400)

        # Last-Event-ID replay keeps working with the listener declined.
        stream_id = stream_store.create(session_id)
        first_event_id = stream_store.append(
            session_id, stream_id, json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
        )
        stream_store.append(
            session_id,
            stream_id,
            json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"seq": 2}}),
        )
        stream_store.close(session_id, stream_id)
        replay = harness.invoke(method="GET", session_id=session_id, last_event_id=first_event_id)
        self.assertEqual(replay.response.status, 200)
        self.assertIn(b"notifications/progress", replay.body)

        # The stateless 2026-07-28 shape keeps its early Allow: POST rejection.
        stateless = harness.invoke(method="GET", protocol_version=MCP_PROTOCOL_VERSION_2026_07_28)
        self.assertEqual(stateless.response.status, 405)
        self.assertEqual(stateless.response.headers["allow"], ["POST"])

        self.assertEqual(harness.invoke(method="DELETE", session_id=session_id).response.status, 202)

    def test_resource_context_type_is_public(self) -> None:
        self.assertEqual(McpResourceContext(uri="theory://x").uri, "theory://x")

    def test_transport_errors_and_session_lifecycle(self) -> None:
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-delete"]),
                "origin_validator": lambda origin: origin == "https://ok.example",
            },
        )
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]

        keepalive = harness.invoke(method="GET", session_id=session_id)
        self.assertEqual(keepalive.response.status, 200)
        self.assertEqual(keepalive.body, b": keepalive\n\n")

        deleted = harness.invoke(method="DELETE", session_id=session_id)
        self.assertEqual(deleted.response.status, 202)
        self.assertEqual(deleted.body, b"")

        after_delete = harness.call(session_id, "ping", {}, "after-delete")
        self.assertEqual(after_delete.response.status, 404)
        self.assertEqual(after_delete.body_json, {"error": "session not found"})

        missing_session = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(),
                "body": json.dumps({"jsonrpc": "2.0", "id": "ping", "method": "ping"}),
            }
        )
        self.assertEqual(missing_session.status, 400)
        self.assertEqual(_response_json(missing_session), {"error": "missing Mcp-Session-Id"})

        bad_content_type = server.serve(
            {
                "method": "POST",
                "headers": {"content-type": ["text/plain"], "accept": ["application/json, text/event-stream"]},
                "body": "{}",
            }
        )
        self.assertEqual(bad_content_type.status, 400)

        bad_accept = server.serve(
            {
                "method": "POST",
                "headers": {"content-type": ["application/json"], "accept": ["application/json"]},
                "body": "{}",
            }
        )
        self.assertEqual(bad_accept.status, 400)

        blocked_origin = server.serve(
            {
                "method": "POST",
                "headers": {
                    "content-type": ["application/json"],
                    "accept": ["application/json, text/event-stream"],
                    "origin": ["https://evil.example"],
                },
                "body": "{}",
            }
        )
        self.assertEqual(blocked_origin.status, 403)

        bad_get_accept = server.serve(
            {
                "method": "GET",
                "headers": {"accept": ["application/json"], MCP_HEADER_SESSION_ID: ["missing"]},
                "body": "",
            }
        )
        self.assertEqual(bad_get_accept.status, 400)

        bad_delete = server.serve({"method": "DELETE", "headers": {}, "body": ""})
        self.assertEqual(bad_delete.status, 400)

        unsupported_method = server.serve({"method": "PUT", "headers": {}, "body": ""})
        self.assertEqual(unsupported_method.status, 405)
        # RFC 9110 15.5.5: the MCP endpoint registers GET, POST, DELETE.
        self.assertEqual(unsupported_method.headers.get("allow"), ["DELETE, GET, POST"])

    def test_jsonrpc_errors_notifications_and_protocol_headers(self) -> None:
        server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-json"])})
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]

        for body in [
            "{bad",
            "[]",
            json.dumps({"method": "ping", "id": "missing-jsonrpc"}),
            json.dumps({"jsonrpc": "1.0", "id": "bad-version", "method": "ping"}),
            json.dumps({"jsonrpc": "2.0", "id": None, "method": "ping"}),
            json.dumps({"jsonrpc": "2.0", "id": "empty-method", "method": ""}),
        ]:
            response = server.serve({"method": "POST", "headers": _post_headers(session_id=session_id), "body": body})
            self.assertEqual(response.status, 200)
            self.assertEqual(_response_json(response)["error"]["code"], MCP_CODE_PARSE_ERROR)

        invalid_message = server.serve(
            {"method": "POST", "headers": _post_headers(session_id=session_id), "body": json.dumps({"jsonrpc": "2.0"})}
        )
        self.assertEqual(invalid_message.status, 400)

        notification = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id=session_id),
                "body": json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            }
        )
        self.assertEqual(notification.status, 202)
        self.assertEqual(notification.body, b"")

        response_message = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id=session_id),
                "body": json.dumps({"jsonrpc": "2.0", "id": "client", "result": {}}),
            }
        )
        self.assertEqual(response_message.status, 202)

        for body in [
            json.dumps({"jsonrpc": "2.0", "result": {}}),
            json.dumps({"jsonrpc": "2.0", "id": "client", "result": {}, "error": {}}),
            json.dumps({"jsonrpc": "1.0", "id": "client", "result": {}}),
        ]:
            invalid_response = server.serve(
                {"method": "POST", "headers": _post_headers(session_id=session_id), "body": body}
            )
            self.assertEqual(invalid_response.status, 400)

        unsupported_protocol = harness.invoke(
            session_id=session_id,
            protocol_version="1900-01-01",
            body_json={"jsonrpc": "2.0", "id": "bad-protocol", "method": "ping"},
        )
        self.assertEqual(unsupported_protocol.response.status, 400)
        self.assertEqual(unsupported_protocol.body_json, {"error": "unsupported MCP-Protocol-Version"})

        legacy_server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-legacy"])})
        legacy_harness = create_mcp_test_harness(legacy_server)
        legacy_session = legacy_harness.initialize(
            id="init", protocol_version=MCP_PROTOCOL_VERSION_LEGACY
        ).response.headers["mcp-session-id"][0]
        mismatch = legacy_harness.call(legacy_session, "ping", {}, "mismatch")
        self.assertEqual(mismatch.response.status, 400)
        self.assertEqual(mismatch.body_json, {"error": "MCP-Protocol-Version mismatch"})

    def test_registry_validation_and_async_normalization(self) -> None:
        server = create_mcp_server("PyMCP", "test")
        registry = server.registry()

        async def async_tool(_args: object, _ctx: McpToolContext) -> McpToolResult:
            return McpToolResult(
                content=[
                    McpContentBlock(
                        type="resource",
                        resource=McpResourceContent(uri="theory://resource/blob", mime_type="text/plain", text="body"),
                        size=4,
                    )
                ],
                is_error=True,
                structured_content={"ok": True},
            )

        with self.assertRaisesRegex(ValueError, "tool name"):
            registry.register_tool({}, lambda _args, _ctx: {"content": []})
        with self.assertRaisesRegex(ValueError, "handler"):
            registry.register_tool({"name": "missing_handler"}, None)  # type: ignore[arg-type]

        registry.register_tool(
            McpToolDef(
                name="async_tool",
                input_schema={"type": "object"},
                title="Async",
                description="Async tool",
                output_schema={"type": "object"},
                execution=McpToolExecution(task_support="optional"),
            ),
            async_tool,
        )
        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register_tool({"name": "async_tool"}, lambda _args, _ctx: {"content": []})
        with self.assertRaisesRegex(ValueError, "tool not found"):
            registry.call("missing", {}, McpToolContext(session_id="s", request_id="r", method="tools/call"))

        normalized = registry.call(
            "async_tool", {}, McpToolContext(session_id="s", request_id="r", method="tools/call")
        )
        self.assertTrue(normalized["isError"])
        self.assertEqual(normalized["structuredContent"], {"ok": True})
        self.assertEqual(normalized["content"][0]["resource"]["text"], "body")

        with self.assertRaisesRegex(ValueError, "streaming tool handler"):
            registry.register_streaming_tool({"name": "stream_missing_handler"}, None)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "tool name"):
            registry.register_streaming_tool({}, lambda _args, _emit, _ctx: {"content": []})
        with self.assertRaisesRegex(ValueError, "already registered"):
            registry.register_streaming_tool({"name": "async_tool"}, lambda _args, _emit, _ctx: {"content": []})

        registry.register_streaming_tool(
            {"name": "stream_plain"},
            lambda _args, emit, _ctx: (emit({"data": "ignored"}), {"content": [{"type": "text", "text": "ok"}]})[1],
        )
        streamed = registry.call_streaming(
            "stream_plain",
            {},
            lambda _event: None,
            McpToolContext(session_id="s", request_id="r", method="tools/call"),
        )
        self.assertEqual(streamed["content"][0]["text"], "ok")
        with self.assertRaisesRegex(ValueError, "tool not found"):
            registry.call_streaming(
                "missing", {}, lambda _event: None, McpToolContext(session_id="s", request_id="r", method="tools/call")
            )

        resources = server.resources()
        with self.assertRaisesRegex(ValueError, "uri"):
            resources.register_resource({}, lambda ctx: [{"uri": ctx.uri}])
        with self.assertRaisesRegex(ValueError, "absolute"):
            resources.register_resource({"uri": "relative", "name": "bad"}, lambda ctx: [{"uri": ctx.uri}])
        with self.assertRaisesRegex(ValueError, "name"):
            resources.register_resource({"uri": "theory://resource/no-name"}, lambda ctx: [{"uri": ctx.uri}])
        with self.assertRaisesRegex(ValueError, "handler"):
            resources.register_resource({"uri": "theory://resource/no-handler", "name": "no-handler"}, None)  # type: ignore[arg-type]
        resources.register_resource(
            McpResourceDef(
                uri="theory://resource/one",
                name="one",
                title="One",
                description="A resource",
                mime_type="text/plain",
                size=1,
            ),
            lambda ctx: [
                McpResourceContent(uri=ctx.uri, mime_type="text/plain", text="one"),
                {"uri": ctx.uri, "blob": "b25l"},
            ],
        )
        with self.assertRaisesRegex(ValueError, "already registered"):
            resources.register_resource({"uri": "theory://resource/one", "name": "dup"}, lambda ctx: [{"uri": ctx.uri}])
        self.assertEqual(resources.list()[0]["title"], "One")
        self.assertEqual(resources.read("theory://resource/one")[1]["blob"], "b25l")
        with self.assertRaisesRegex(ValueError, "resource not found"):
            resources.read("theory://resource/missing")

        with self.assertRaisesRegex(ValueError, "uriTemplate"):
            resources.register_resource_template({})
        with self.assertRaisesRegex(ValueError, "absolute"):
            resources.register_resource_template({"uriTemplate": "bad value", "name": "bad"})
        with self.assertRaisesRegex(ValueError, "name"):
            resources.register_resource_template({"uriTemplate": "theory://resource/{name}"})
        resources.register_resource_template(
            McpResourceTemplateDef(
                uri_template="theory://resource/{name}",
                name="by-name",
                title="By name",
                description="templated",
                mime_type="text/plain",
            )
        )
        with self.assertRaisesRegex(ValueError, "already registered"):
            resources.register_resource_template({"uriTemplate": "theory://resource/{name}", "name": "dup"})
        self.assertEqual(resources.list_templates()[0]["mimeType"], "text/plain")

        prompts = server.prompts()
        with self.assertRaisesRegex(ValueError, "prompt name"):
            prompts.register_prompt({}, lambda _args: {"messages": []})
        with self.assertRaisesRegex(ValueError, "handler"):
            prompts.register_prompt({"name": "no_handler"}, None)  # type: ignore[arg-type]
        prompts.register_prompt(
            McpPromptDef(
                name="greet",
                title="Greet",
                description="Greeting",
                arguments=[McpPromptArgument(name="name", title="Name", description="Person", required=True)],
            ),
            lambda args: McpPromptResult(
                description="Greeting",
                messages=[
                    McpPromptMessage(
                        role="user",
                        content=McpContentBlock(type="text", text=f"Hi {(args or {}).get('name')}"),
                    )
                ],
            ),
        )
        with self.assertRaisesRegex(ValueError, "already registered"):
            prompts.register_prompt({"name": "greet"}, lambda _args: {"messages": []})
        self.assertEqual(prompts.list()[0]["arguments"][0]["required"], True)
        self.assertEqual(prompts.get("greet", {"name": "Ada"})["description"], "Greeting")
        with self.assertRaisesRegex(ValueError, "prompt not found"):
            prompts.get("missing", {})

    def test_http_dispatch_capability_and_tool_errors(self) -> None:
        empty = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-empty"])})
        empty_harness = create_mcp_test_harness(empty)
        empty_session = empty_harness.initialize(id="init").response.headers["mcp-session-id"][0]
        tools_list = empty_harness.call(empty_session, "tools/list", {}, "tools")
        self.assertEqual(tools_list.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)
        tasks_get = empty_harness.call(empty_session, "tasks/get", {"taskId": "missing"}, "task")
        self.assertEqual(tasks_get.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)
        unknown = empty_harness.call(empty_session, "unknown/method", {}, "unknown")
        self.assertEqual(unknown.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)

        server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-tools"])})
        server.registry().register_tool(
            {"name": "boom", "inputSchema": {}}, lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("boom"))
        )
        server.registry().register_tool(
            {"name": "required", "inputSchema": {}, "execution": {"taskSupport": "required"}},
            lambda _args, _ctx: {"content": [{"type": "text", "text": "ok"}]},
        )
        server.registry().register_streaming_tool(
            {"name": "stream_boom", "inputSchema": {}},
            lambda _args, _emit, _ctx: (_ for _ in ()).throw(RuntimeError("stream boom")),
        )
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]

        missing_name = harness.call(session_id, "tools/call", {}, "missing-name")
        self.assertEqual(missing_name.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)

        missing_tool = harness.call(session_id, "tools/call", {"name": "missing"}, "missing-tool")
        self.assertEqual(missing_tool.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)

        boom = harness.call(session_id, "tools/call", {"name": "boom"}, "boom")
        self.assertEqual(boom.body_json["error"]["code"], MCP_CODE_SERVER_ERROR)

        required = harness.call(session_id, "tools/call", {"name": "required"}, "required")
        self.assertEqual(required.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)

        task_when_disabled = harness.call(session_id, "tools/call", {"name": "required", "task": {}}, "task-disabled")
        self.assertEqual(task_when_disabled.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)

        stream_error = harness.call(
            session_id,
            "tools/call",
            {"name": "stream_boom", "arguments": {}, "_meta": {"progressToken": "pt"}},
            "stream-error",
        )
        self.assertEqual(stream_error.body_json["error"]["code"], MCP_CODE_SERVER_ERROR)

    def test_task_runtime_error_paths(self) -> None:
        ids = sequence_mcp_id_generator(["sess-task-errors", "task-ok", "task-fail", "task-is-error"])
        task_store = MemoryMcpTaskStore()
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": ids,
                "task_runtime": {
                    "store": task_store,
                    "defaultTtlMs": 1000,
                    "maxTtlMs": 2000,
                    "pollIntervalMs": 25,
                    "listLimit": 1,
                    "modelImmediateResponse": "prefer-task",
                },
            },
        )
        server.registry().register_tool(
            {"name": "plain", "inputSchema": {}},
            lambda _args, _ctx: {"content": [{"type": "text", "text": "plain"}]},
        )
        server.registry().register_tool(
            {"name": "required", "inputSchema": {}, "execution": {"taskSupport": "required"}},
            lambda args, _ctx: {"content": [{"type": "text", "text": str((args or {}).get("message") or "")}]},
        )
        server.registry().register_tool(
            {"name": "fail", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("task boom")),
        )
        server.registry().register_tool(
            {"name": "is_error", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            lambda _args, _ctx: {"content": [{"type": "text", "text": "bad"}], "isError": True},
        )
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers["mcp-session-id"][0]

        unsupported_task = harness.call(session_id, "tools/call", {"name": "plain", "task": {}}, "unsupported")
        self.assertEqual(unsupported_task.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)

        invalid_ttl = harness.call(session_id, "tools/call", {"name": "required", "task": {"ttl": 0}}, "ttl-zero")
        self.assertEqual(invalid_ttl.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)
        excessive_ttl = harness.call(session_id, "tools/call", {"name": "required", "task": {"ttl": 3000}}, "ttl-high")
        self.assertEqual(excessive_ttl.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)

        ok = harness.call(
            session_id,
            "tools/call",
            {"name": "required", "arguments": {"message": "done"}, "task": {"ttl": 2000}},
            "ok",
        )
        self.assertEqual(ok.body_json["result"]["task"]["taskId"], "task-ok")
        self.assertEqual(
            ok.body_json["result"]["_meta"]["io.modelcontextprotocol/model-immediate-response"], "prefer-task"
        )

        task_failure = harness.call(session_id, "tools/call", {"name": "fail", "task": {}}, "fail")
        self.assertEqual(task_failure.body_json["result"]["task"]["taskId"], "task-fail")
        failure_result = harness.call(session_id, "tasks/result", {"taskId": "task-fail"}, "failure-result")
        self.assertEqual(failure_result.body_json["error"]["code"], MCP_CODE_SERVER_ERROR)

        is_error = harness.call(session_id, "tools/call", {"name": "is_error", "task": {}}, "is-error")
        # The task body runs inside the tools/call invocation, so the reply already
        # carries the terminal state.
        self.assertEqual(is_error.body_json["result"]["task"]["status"], "failed")
        is_error_task = harness.call(session_id, "tasks/get", {"taskId": "task-is-error"}, "is-error-get")
        self.assertEqual(is_error_task.body_json["result"]["status"], "failed")
        self.assertEqual(is_error_task.body_json["result"]["statusMessage"], "tool returned isError result")

        missing_task_id = harness.call(session_id, "tasks/get", {}, "missing-task-id")
        self.assertEqual(missing_task_id.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)
        missing_result = harness.call(session_id, "tasks/result", {"taskId": "missing"}, "missing-result")
        self.assertEqual(missing_result.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)
        invalid_cursor = harness.call(session_id, "tasks/list", {"cursor": "bad"}, "bad-cursor")
        self.assertEqual(invalid_cursor.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)
        first_page = harness.call(session_id, "tasks/list", {}, "first-page")
        self.assertIn("nextCursor", first_page.body_json["result"])
        terminal_cancel = harness.call(session_id, "tasks/cancel", {"taskId": "task-ok"}, "terminal-cancel")
        self.assertEqual(terminal_cancel.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)
        missing_cancel_id = harness.call(session_id, "tasks/cancel", {}, "missing-cancel")
        self.assertEqual(missing_cancel_id.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)

    def test_tools_call_task_augmentation_is_protocol_gated(self) -> None:
        task_store = MemoryMcpTaskStore()
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-1125", "task-1", "sess-618", "sess-326"]),
                "task_runtime": {"store": task_store, "defaultTtlMs": 1000, "maxTtlMs": 5000},
            },
        )
        server.registry().register_tool(
            {"name": "task_echo", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            lambda args, _ctx: {"content": [{"type": "text", "text": str((args or {}).get("message") or "")}]},
        )
        harness = create_mcp_test_harness(server)

        def call_task(session_id: str, protocol_version: str, request_id: str) -> Any:
            return harness.invoke(
                session_id=session_id,
                protocol_version=protocol_version,
                body_json={
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/call",
                    "params": {"name": "task_echo", "arguments": {"message": "hi"}, "task": {}},
                },
            )

        ok_session = harness.initialize(id="init-ok").response.headers["mcp-session-id"][0]
        ok = call_task(ok_session, MCP_PROTOCOL_VERSION, "ok")
        self.assertEqual(ok.body_json["result"]["task"]["taskId"], "task-1")
        self.assertEqual(len(task_store.list({"sessionId": ok_session}).tasks), 1)

        for protocol_version in ("2025-06-18", "2025-03-26"):
            init = harness.initialize(id=f"init-{protocol_version}", protocol_version=protocol_version)
            session_id = init.response.headers["mcp-session-id"][0]
            denied = call_task(session_id, protocol_version, f"denied-{protocol_version}")
            self.assertEqual(denied.body_json["error"]["code"], MCP_CODE_METHOD_NOT_FOUND)
            self.assertEqual(denied.body_json["error"]["message"], "Method not found: tasks not enabled")
            self.assertEqual(task_store.list({"sessionId": session_id}).tasks, [])

    def test_memory_stores_and_expired_sessions(self) -> None:
        session_store = MemoryMcpSessionStore(
            seed=[McpSession(id="expired", expires_at="2020-01-01T00:00:00Z", data={"k": "v"})]
        )
        with self.assertRaises(McpSessionNotFoundError):
            session_store.get("expired")
        with self.assertRaisesRegex(ValueError, "missing session id"):
            session_store.put({"id": ""})
        session_store.put({"id": "live", "createdAt": "2026-01-01T00:00:00Z", "data": {"ok": "true"}})
        self.assertEqual(session_store.get("live").data, {"ok": "true"})
        session_store.delete("live")
        with self.assertRaises(McpSessionNotFoundError):
            session_store.get("live")

        stream_store = MemoryMcpStreamStore(id_generator=sequence_mcp_id_generator(["stream-1", "stream-2"]))
        with self.assertRaisesRegex(ValueError, "missing session id"):
            stream_store.create("")
        stream_id = stream_store.create("sess")
        event1 = stream_store.append("sess", stream_id)
        event2 = stream_store.append("sess", stream_id, bytearray(b"second"))
        stream_store.close("sess", stream_id)
        self.assertEqual([event.id for event in stream_store.subscribe("sess", stream_id, event1)], [event2])
        self.assertEqual(stream_store.stream_for_event("sess", event1), stream_id)
        other_stream = stream_store.create("sess")
        with self.assertRaises(McpEventNotFoundError):
            stream_store.subscribe("sess", other_stream, event1)
        with self.assertRaises(McpStreamNotFoundError):
            stream_store.append("missing", stream_id, "nope")
        stream_store.delete_session("sess")
        with self.assertRaises(McpStreamNotFoundError):
            stream_store.stream_for_event("sess", event1)

        task_store = MemoryMcpTaskStore()
        with self.assertRaisesRegex(ValueError, "missing session id"):
            task_store.create(McpTaskRecord(session_id="", method="tools/call", task=McpTask(task_id="task")))
        record = McpTaskRecord(
            session_id="sess",
            method="tools/call",
            tool_name="tool",
            task=McpTask(task_id="task", created_at="2026-01-01T00:00:00Z", ttl=1),
        )
        task_store.create(record)
        with self.assertRaisesRegex(ValueError, "task already exists"):
            task_store.create(record)
        self.assertEqual(task_store.list({"sessionId": "sess", "limit": 1}).tasks[0].task_id, "task")
        with self.assertRaises(McpTaskInvalidCursorError):
            task_store.list({"sessionId": "sess", "cursor": "-1"})
        with self.assertRaises(McpTaskNotFoundError):
            task_store.get({"sessionId": "sess", "taskId": "missing"})
        canceled = task_store.cancel({"sessionId": "sess", "taskId": "task"})
        self.assertEqual(canceled.task.status, "canceled")
        with self.assertRaises(McpTaskTerminalError):
            task_store.update(canceled)
        task_store.delete_session("sess")
        self.assertEqual(task_store.list({"sessionId": "sess"}).tasks, [])

    def test_dynamo_backed_task_and_stream_stores(self) -> None:
        task_table = _FakeTheoryTable()
        task_store = DynamoMcpTaskStore(table=task_table, clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)))
        record = McpTaskRecord(
            session_id="sess",
            method="tools/call",
            tool_name="tool",
            task=McpTask(
                task_id="task",
                status="working",
                created_at="2026-01-01T00:00:00Z",
                last_updated_at="2026-01-01T00:00:00Z",
                ttl=1000,
                poll_interval=25,
            ),
            result={"content": []},
        )
        created = task_store.create(record)
        self.assertEqual(created.task.task_id, "task")
        fetched = task_store.get({"sessionId": "sess", "taskId": "task"})
        self.assertEqual(fetched.result, {"content": []})
        fetched.task.status = "completed"
        fetched.error = McpRPCError(code=1, message="done", data={"detail": True})
        updated = task_store.update(fetched)
        self.assertEqual(updated.error.message if updated.error else "", "done")
        listed = task_store.list({"session_id": "sess", "limit": 1})
        self.assertEqual([task.task_id for task in listed.tasks], ["task"])
        with self.assertRaises(McpTaskTerminalError):
            task_store.cancel({"session_id": "sess", "task_id": "task"})
        task_store.delete_session("sess")
        with self.assertRaises(McpTaskNotFoundError):
            task_store.get({"session_id": "sess", "task_id": "task"})

        stream_table = _FakeTheoryTable()
        stream_store = DynamoMcpStreamStore(
            table=stream_table,
            id_generator=sequence_mcp_id_generator(["stream-1"]),
        )
        stream_id = stream_store.create("sess")
        first = stream_store.append("sess", stream_id, "first")
        second = stream_store.append("sess", stream_id, b"second")
        self.assertEqual(stream_store.stream_for_event("sess", first), stream_id)
        self.assertEqual([event.data for event in stream_store.subscribe("sess", stream_id, first)], [b"second"])
        with self.assertRaises(McpEventNotFoundError):
            stream_store.subscribe("sess", stream_id, "999")
        self.assertEqual([event.id for event in stream_store.subscribe("sess", stream_id)], [first, second])
        stream_store.close("sess", stream_id)
        stream_store.delete_session("sess")
        with self.assertRaises(McpStreamNotFoundError):
            stream_store.append("sess", stream_id, "missing")

    def test_dynamo_store_enforces_task_expiry(self) -> None:
        task_table = _FakeTheoryTable()
        writer = DynamoMcpTaskStore(table=task_table, clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 5, tzinfo=UTC)))
        record = McpTaskRecord(
            session_id="sess",
            method="tools/call",
            tool_name="tool",
            task=McpTask(task_id="task", created_at="2026-01-01T00:00:00Z", ttl=60000),
        )
        created = writer.create(record)
        self.assertEqual(created.task.task_id, "task")
        self.assertEqual(created.task.ttl, 60000)

        stored = task_table.items[("sess", "task")]
        self.assertEqual(stored.expires_at, int(datetime(2026, 1, 1, 0, 1, 0, tzinfo=UTC).timestamp()))
        # A fresh task is returned normally and keeps its ttl duration.
        fresh = writer.get({"sessionId": "sess", "taskId": "task"})
        self.assertEqual(fresh.task.task_id, "task")
        self.assertEqual(fresh.task.ttl, 60000)

        # ttl <= 0 falls back to the maximum task TTL (1 hour).
        fallback_table = _FakeTheoryTable()
        DynamoMcpTaskStore(table=fallback_table, clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 5, tzinfo=UTC))).create(
            McpTaskRecord(
                session_id="fallback",
                method="tools/call",
                task=McpTask(task_id="task", created_at="2026-01-01T00:00:00Z", ttl=0),
            )
        )
        self.assertEqual(
            fallback_table.items[("fallback", "task")].expires_at,
            int(datetime(2026, 1, 1, 1, 0, 0, tzinfo=UTC).timestamp()),
        )

        # Once `now` passes `expires_at`, the record is never surfaced.
        later = DynamoMcpTaskStore(table=task_table, clock=_FixedClock(datetime(2026, 1, 1, 1, 0, 0, tzinfo=UTC)))
        with self.assertRaises(McpTaskNotFoundError):
            later.get({"sessionId": "sess", "taskId": "task"})
        self.assertEqual(later.list({"sessionId": "sess"}).tasks, [])

    def test_dynamo_store_delete_session_follows_cursors(self) -> None:
        bulk_table = _FakeTheoryTable()
        bulk_store = DynamoMcpTaskStore(table=bulk_table, clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 30, tzinfo=UTC)))
        for index in range(1200):
            bulk_store.create(
                McpTaskRecord(
                    session_id="bulk",
                    method="tools/call",
                    task=McpTask(
                        task_id=f"task-{index:04d}",
                        created_at="2026-01-01T00:00:00Z",
                        last_updated_at="2026-01-01T00:00:00Z",
                        ttl=60000,
                    ),
                )
            )
        first_page = bulk_store.list({"session_id": "bulk", "limit": 500})
        self.assertEqual(len(first_page.tasks), 500)
        self.assertEqual(first_page.next_cursor, "500")
        bulk_store.delete_session("bulk")
        self.assertEqual(bulk_store.list({"session_id": "bulk"}).tasks, [])
        self.assertEqual([key for key in bulk_table.items if key[0] == "bulk"], [])

    def test_malformed_non_ascii_routing_name_is_rejected(self) -> None:
        server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-non-ascii"])})
        headers = _post_headers()
        headers[MCP_HEADER_PROTOCOL_VERSION] = [MCP_PROTOCOL_VERSION_2026_07_28]
        headers[MCP_HEADER_METHOD] = ["tools/call"]
        headers[MCP_HEADER_NAME] = ["=?base64?\u00e9?="]

        response = server.serve(
            {
                "method": "POST",
                "headers": headers,
                "body": json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": "non-ascii",
                        "method": "tools/call",
                        "params": {
                            "name": "echo",
                            "arguments": {"message": "non-ascii"},
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
                                "io.modelcontextprotocol/clientCapabilities": {},
                            },
                        },
                    }
                ),
            }
        )
        self.assertEqual(response.status, 400)
        self.assertEqual(
            _response_json(response),
            {
                "jsonrpc": "2.0",
                "id": "non-ascii",
                "error": {
                    "code": MCP_CODE_HEADER_MISMATCH,
                    "message": "Header mismatch: malformed Mcp-Name Base64 encoding",
                },
            },
        )

    def test_dynamo_stream_store_follows_cursors_for_replay_and_deletion(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-pages"]),
        )
        stream_id = store.create("sess-pages")
        last_event_id = ""
        for index in range(1100):
            last_event_id = store.append("sess-pages", stream_id, f"event-{index}")

        self.assertEqual(store.stream_for_event("sess-pages", last_event_id), stream_id)
        replayed = store.subscribe("sess-pages", stream_id)
        self.assertEqual(len(replayed), 1100)
        self.assertEqual(replayed[-1].data, b"event-1099")

        store.delete_session("sess-pages")
        self.assertEqual([key for key in table.items if key[0] == "sess-pages"], [("sess-pages", "!session")])
        self.assertTrue(bool(getattr(table.items[("sess-pages", "!session")], "deleted")))
        with self.assertRaises(McpStreamNotFoundError):
            store.append("sess-pages", stream_id, "late")

    def test_sessions_bind_to_authenticated_principal(self) -> None:
        server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-principal"])})
        handler = server.handler()

        def serve(principal: str, method: str, headers: dict[str, Any], body: bytes = b"") -> Any:
            ctx = Context(
                request=Request(method=method, path="/mcp", headers=headers, body=body, is_base64=False),
                auth_identity=principal,
            )
            return handler(ctx)

        initialize_body = json.dumps({"jsonrpc": "2.0", "id": "init", "method": "initialize"}).encode()
        initialized = serve("alice", "POST", _post_headers(), initialize_body)
        self.assertEqual(initialized.status, 200)
        session_id = initialized.headers[MCP_HEADER_SESSION_ID][0]

        ping_body = json.dumps({"jsonrpc": "2.0", "id": "ping", "method": "ping"}).encode()
        alice_ping = serve("alice", "POST", _post_headers(session_id=session_id), ping_body)
        self.assertEqual(alice_ping.status, 200)
        self.assertEqual(_response_json(alice_ping)["result"], {})

        for principal in ("bob", ""):
            denied_post = serve(principal, "POST", _post_headers(session_id=session_id), ping_body)
            self.assertEqual(denied_post.status, 404)
            self.assertEqual(_response_json(denied_post), {"error": "session not found"})

            get_headers = {
                MCP_HEADER_SESSION_ID: [session_id],
                MCP_HEADER_PROTOCOL_VERSION: [MCP_PROTOCOL_VERSION],
                "accept": ["text/event-stream"],
            }
            denied_get = serve(principal, "GET", get_headers)
            self.assertEqual(denied_get.status, 404)
            self.assertEqual(_response_json(denied_get), {"error": "session not found"})

            delete_headers = {
                MCP_HEADER_SESSION_ID: [session_id],
                MCP_HEADER_PROTOCOL_VERSION: [MCP_PROTOCOL_VERSION],
            }
            denied_delete = serve(principal, "DELETE", delete_headers)
            self.assertEqual(denied_delete.status, 404)
            self.assertEqual(_response_json(denied_delete), {"error": "session not found"})

        still_alive = serve("alice", "POST", _post_headers(session_id=session_id), ping_body)
        self.assertEqual(still_alive.status, 200)
        deleted = serve(
            "alice",
            "DELETE",
            {MCP_HEADER_SESSION_ID: [session_id], MCP_HEADER_PROTOCOL_VERSION: [MCP_PROTOCOL_VERSION]},
        )
        self.assertEqual(deleted.status, 202)

    def test_session_principal_derivation_fallbacks(self) -> None:
        server = create_mcp_server(
            "PyMCP",
            "test",
            {"id_generator": sequence_mcp_id_generator(["sess-secure", "sess-claims", "sess-tenant", "sess-unbound"])},
        )
        handler = server.handler()
        initialize_body = json.dumps({"jsonrpc": "2.0", "id": "init", "method": "initialize"}).encode()
        ping_body = json.dumps({"jsonrpc": "2.0", "id": "ping", "method": "ping"}).encode()

        def make_context(
            *,
            auth_identity: str = "",
            tenant_id: str = "",
            tenant_bound: bool = False,
            secure_identity: str = "",
            claims_subject: str = "",
        ) -> Context:
            ctx = Context(
                request=Request(method="POST", path="/mcp", headers=_post_headers(), body=b"", is_base64=False),
                auth_identity=auth_identity,
                tenant_id=tenant_id,
                tenant_bound=tenant_bound,
            )
            if secure_identity:
                ctx._secure_principal = SecurePrincipal(identity=secure_identity)
            if claims_subject:
                ctx.set("oauth.bearer_claims", BearerTokenClaims(subject=claims_subject))
            return ctx

        def serve(ctx: Context, method: str, headers: dict[str, Any], body: bytes = b"") -> Any:
            ctx.request = Request(method=method, path="/mcp", headers=headers, body=body, is_base64=False)
            return handler(ctx)

        def initialize(ctx: Context) -> str:
            response = serve(ctx, "POST", _post_headers(), initialize_body)
            self.assertEqual(response.status, 200)
            return response.headers[MCP_HEADER_SESSION_ID][0]

        secure_session = initialize(make_context(secure_identity="svc-secure"))
        secure_ping = serve(
            make_context(auth_identity="svc-secure"), "POST", _post_headers(session_id=secure_session), ping_body
        )
        self.assertEqual(secure_ping.status, 200)
        denied_secure = serve(
            make_context(auth_identity="other"), "POST", _post_headers(session_id=secure_session), ping_body
        )
        self.assertEqual(denied_secure.status, 404)

        claims_session = initialize(make_context(claims_subject="subject-claims"))
        claims_ping = serve(
            make_context(auth_identity="subject-claims"), "POST", _post_headers(session_id=claims_session), ping_body
        )
        self.assertEqual(claims_ping.status, 200)
        denied_claims = serve(
            make_context(auth_identity="other"), "POST", _post_headers(session_id=claims_session), ping_body
        )
        self.assertEqual(denied_claims.status, 404)

        tenant_session = initialize(make_context(tenant_id="tenant-a", tenant_bound=True))
        tenant_ping = serve(
            make_context(auth_identity="tenant-a"), "POST", _post_headers(session_id=tenant_session), ping_body
        )
        self.assertEqual(tenant_ping.status, 200)
        denied_tenant = serve(
            make_context(auth_identity="other"), "POST", _post_headers(session_id=tenant_session), ping_body
        )
        self.assertEqual(denied_tenant.status, 404)

        unbound_session = initialize(make_context(tenant_id="tenant-b", tenant_bound=False))
        unbound_ping = serve(
            make_context(auth_identity="anyone"), "POST", _post_headers(session_id=unbound_session), ping_body
        )
        self.assertEqual(unbound_ping.status, 200)

    def test_memory_stores_bound_stream_and_task_state(self) -> None:
        stream_store = MemoryMcpStreamStore(
            id_generator=sequence_mcp_id_generator(["stream-count"]),
            max_event_bytes=4,
            max_events_per_session=2,
            max_session_bytes=1024,
        )
        stream_id = stream_store.create("sess")
        with self.assertRaises(McpStreamEventTooLargeError):
            stream_store.append("sess", stream_id, b"12345")
        first = stream_store.append("sess", stream_id, b"aa")
        second = stream_store.append("sess", stream_id, b"bb")
        third = stream_store.append("sess", stream_id, b"cc")
        self.assertEqual([event.id for event in stream_store.subscribe("sess", stream_id)], [second, third])
        with self.assertRaises(McpEventNotFoundError):
            stream_store.stream_for_event("sess", first)

        default_store = MemoryMcpStreamStore(id_generator=sequence_mcp_id_generator(["stream-default"]))
        default_stream = default_store.create("sess")
        with self.assertRaises(McpStreamEventTooLargeError):
            default_store.append("sess", default_stream, b"x" * (10 * 1024 * 1024 + 1))

        byte_store = MemoryMcpStreamStore(
            id_generator=sequence_mcp_id_generator(["stream-bytes"]),
            max_events_per_session=100,
            max_session_bytes=4,
        )
        byte_stream = byte_store.create("sess")
        byte_store.append("sess", byte_stream, b"aa")
        byte_store.append("sess", byte_stream, b"bb")
        byte_store.append("sess", byte_stream, b"cc")
        self.assertEqual(
            [event.data for event in byte_store.subscribe("sess", byte_stream)],
            [b"bb", b"cc"],
        )

        clock = _FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC))
        task_store = MemoryMcpTaskStore(clock=clock, max_tasks_per_session=2)

        def task_record(
            task_id: str,
            *,
            status: str = "working",
            created_at: str = "2026-01-01T00:00:00Z",
            ttl: int = 0,
        ) -> McpTaskRecord:
            return McpTaskRecord(
                session_id="sess",
                method="tools/call",
                tool_name="tool",
                task=McpTask(task_id=task_id, status=status, created_at=created_at, ttl=ttl),
            )

        task_store.create(task_record("one"))
        task_store.create(task_record("two"))
        with self.assertRaises(McpTaskCapacityError):
            task_store.create(task_record("three"))
        completed = task_store.get({"sessionId": "sess", "taskId": "one"})
        completed.task.status = "completed"
        task_store.update(completed)
        task_store.create(task_record("three"))
        self.assertEqual(
            {task.task_id for task in task_store.list({"sessionId": "sess"}).tasks},
            {"two", "three"},
        )

        expired_store = MemoryMcpTaskStore(
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 5, tzinfo=UTC)),
            max_tasks_per_session=1,
        )
        expired_store.create(task_record("expired", created_at="2026-01-01T00:00:00Z", ttl=1000))
        expired_store.create(task_record("fresh"))
        self.assertEqual(
            [task.task_id for task in expired_store.list({"sessionId": "sess"}).tasks],
            ["fresh"],
        )

    def test_dynamo_stream_store_ttl_and_payload_bounds(self) -> None:
        now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)
        table = _FakeTheoryTable()
        with patch.dict(os.environ, {"MCP_STREAM_TTL_MINUTES": "5"}):
            store = DynamoMcpStreamStore(
                table=table,
                id_generator=sequence_mcp_id_generator(["stream-ttl"]),
                clock=_FixedClock(now),
            )
            stream_id = store.create("sess-ttl")
            first = store.append("sess-ttl", stream_id, "hello")
        expires_at = int(now.timestamp()) + 300
        self.assertEqual(table.items[("sess-ttl", f"STREAM#{stream_id}")].expires_at, expires_at)
        self.assertEqual(table.items[("sess-ttl", f"EVENT#{first}")].expires_at, expires_at)

        later = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["unused"]),
            clock=_FixedClock(now + timedelta(minutes=6)),
        )
        with self.assertRaises(McpStreamNotFoundError):
            later.subscribe("sess-ttl", stream_id)
        with self.assertRaises(McpEventNotFoundError):
            later.stream_for_event("sess-ttl", first)
        with self.assertRaises(McpStreamNotFoundError):
            later.append("sess-ttl", stream_id, "more")

        table.items[("sess-ttl", f"STREAM#{stream_id}")].expires_at = int(now.timestamp()) + 3600
        table.items[("sess-ttl", f"EVENT#{first}")].expires_at = int(now.timestamp()) - 1
        self.assertEqual(store.subscribe("sess-ttl", stream_id), [])
        with self.assertRaises(McpEventNotFoundError):
            store.stream_for_event("sess-ttl", first)

        oversized_table = _FakeTheoryTable()
        with patch.dict(os.environ, {"MCP_STREAM_MAX_EVENT_BYTES": "4"}):
            oversized = DynamoMcpStreamStore(
                table=oversized_table,
                id_generator=sequence_mcp_id_generator(["stream-oversized"]),
                clock=_FixedClock(now),
            )
            oversized_stream = oversized.create("sess-oversized")
            with self.assertRaises(McpStreamEventTooLargeError):
                oversized.append("sess-oversized", oversized_stream, b"12345")
        self.assertNotIn(("sess-oversized", "EVENT#1"), oversized_table.items)
        stream_item = oversized_table.items[("sess-oversized", f"STREAM#{oversized_stream}")]
        self.assertEqual(stream_item.sequence, 0)

    def test_tool_contexts_carry_authenticated_caller_identity(self) -> None:
        seen: dict[str, McpCallerAuth | None] = {}
        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-auth", "task-auth"]),
                "task_runtime": {"store": MemoryMcpTaskStore(), "defaultTtlMs": 1000, "maxTtlMs": 1000},
            },
        )

        def identity_tool(_args: Any, context: McpToolContext) -> dict[str, Any]:
            seen["normal"] = context.auth
            identity = context.auth.auth_identity if context.auth else ""
            return {"content": [{"type": "text", "text": identity}]}

        def streaming_tool(_args: Any, _emit: Any, context: McpToolContext) -> dict[str, Any]:
            seen["stream"] = context.auth
            return {"content": []}

        def task_tool(_args: Any, context: McpToolContext) -> dict[str, Any]:
            seen["task"] = context.auth
            return {"content": []}

        server.registry().register_tool({"name": "identity", "inputSchema": {}}, identity_tool)
        server.registry().register_streaming_tool({"name": "identity_stream", "inputSchema": {}}, streaming_tool)
        server.registry().register_tool(
            {"name": "identity_task", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            task_tool,
        )
        handler = server.handler()

        def serve(method: str, headers: dict[str, Any], body_json: dict[str, Any]) -> Any:
            ctx = Context(
                request=Request(
                    method=method,
                    path="/mcp",
                    headers=headers,
                    body=json.dumps(body_json).encode(),
                    is_base64=False,
                ),
                auth_identity="alice",
                tenant_id="tenant-a",
                tenant_bound=True,
            )
            ctx._secure_principal = SecurePrincipal(identity="alice", scopes=["mcp:read", "mcp:write"])
            return handler(ctx)

        initialized = serve("POST", _post_headers(), {"jsonrpc": "2.0", "id": "init", "method": "initialize"})
        session_id = initialized.headers[MCP_HEADER_SESSION_ID][0]

        normal = serve(
            "POST",
            _post_headers(session_id=session_id),
            {
                "jsonrpc": "2.0",
                "id": "normal",
                "method": "tools/call",
                "params": {"name": "identity", "arguments": {}},
            },
        )
        self.assertEqual(_response_json(normal)["result"]["content"][0]["text"], "alice")

        streamed = serve(
            "POST",
            _post_headers(session_id=session_id),
            {
                "jsonrpc": "2.0",
                "id": "stream",
                "method": "tools/call",
                "params": {"name": "identity_stream", "arguments": {}},
            },
        )
        self.assertEqual(streamed.status, 200)

        task = serve(
            "POST",
            _post_headers(session_id=session_id),
            {
                "jsonrpc": "2.0",
                "id": "task",
                "method": "tools/call",
                "params": {"name": "identity_task", "arguments": {}, "task": {}},
            },
        )
        self.assertEqual(_response_json(task)["result"]["task"]["status"], "completed")

        expected = McpCallerAuth(
            auth_identity="alice",
            tenant_id="tenant-a",
            tenant_bound=True,
            scopes=["mcp:read", "mcp:write"],
        )
        self.assertEqual(seen["normal"], expected)
        self.assertEqual(seen["stream"], expected)
        self.assertEqual(seen["task"], expected)

        anon_server = create_mcp_server("PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-anon"])})
        anon_seen: list[McpCallerAuth | None] = []

        def anon_tool(_args: Any, context: McpToolContext) -> dict[str, Any]:
            anon_seen.append(context.auth)
            return {"content": []}

        anon_server.registry().register_tool({"name": "identity", "inputSchema": {}}, anon_tool)
        anon_harness = create_mcp_test_harness(anon_server)
        anon_session = anon_harness.initialize(id="init").response.headers[MCP_HEADER_SESSION_ID][0]
        anon_harness.call(anon_session, "tools/call", {"name": "identity"}, "anon")
        self.assertIsNone(anon_seen[0])

    def test_generic_handler_errors_are_sanitized_by_default(self) -> None:
        logged: list[tuple[str, tuple[dict[str, Any], ...]]] = []

        class RecordingLogger:
            def error(self, message: str, *fields: dict[str, Any]) -> None:
                logged.append((message, fields))

        server = create_mcp_server(
            "PyMCP",
            "test",
            {
                "id_generator": sequence_mcp_id_generator(["sess-errors", "task-errors"]),
                "task_runtime": {"store": MemoryMcpTaskStore(), "defaultTtlMs": 1000, "maxTtlMs": 1000},
                "logger": RecordingLogger(),
            },
        )
        server.registry().register_tool(
            {"name": "boom", "inputSchema": {}},
            lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("secret detail")),
        )
        server.registry().register_tool(
            {"name": "task_boom", "inputSchema": {}, "execution": {"taskSupport": "optional"}},
            lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("task secret")),
        )
        server.resources().register_resource(
            {"uri": "theory://resource/boom", "name": "boom"},
            lambda _ctx: (_ for _ in ()).throw(RuntimeError("resource secret")),
        )
        server.prompts().register_prompt(
            {"name": "boom"},
            lambda _args: (_ for _ in ()).throw(RuntimeError("prompt secret")),
        )
        harness = create_mcp_test_harness(server)
        session_id = harness.initialize(id="init").response.headers[MCP_HEADER_SESSION_ID][0]

        tool_error = harness.call(session_id, "tools/call", {"name": "boom"}, "tool-boom")
        self.assertEqual(
            tool_error.body_json["error"],
            {"code": MCP_CODE_SERVER_ERROR, "message": "internal error"},
        )

        missing_tool = harness.call(session_id, "tools/call", {"name": "missing"}, "tool-missing")
        self.assertEqual(
            missing_tool.body_json["error"],
            {"code": MCP_CODE_INVALID_PARAMS, "message": "tool not found: missing"},
        )

        resource_error = harness.call(session_id, "resources/read", {"uri": "theory://resource/boom"}, "resource-boom")
        self.assertEqual(resource_error.body_json["error"]["message"], "internal error")
        missing_resource = harness.call(
            session_id, "resources/read", {"uri": "theory://resource/missing"}, "resource-missing"
        )
        self.assertEqual(
            missing_resource.body_json["error"]["message"],
            "resource not found: theory://resource/missing",
        )

        prompt_error = harness.call(session_id, "prompts/get", {"name": "boom"}, "prompt-boom")
        self.assertEqual(prompt_error.body_json["error"]["message"], "internal error")
        missing_prompt = harness.call(session_id, "prompts/get", {"name": "missing"}, "prompt-missing")
        self.assertEqual(missing_prompt.body_json["error"]["message"], "prompt not found: missing")

        task = harness.call(session_id, "tools/call", {"name": "task_boom", "task": {}}, "task-boom")
        task_id = task.body_json["result"]["task"]["taskId"]
        task_result = harness.call(session_id, "tasks/result", {"taskId": task_id}, "task-result")
        self.assertEqual(task_result.body_json["error"]["message"], "internal error")
        task_status = harness.call(session_id, "tasks/get", {"taskId": task_id}, "task-get")
        self.assertEqual(task_status.body_json["result"]["statusMessage"], "internal error")

        logged_errors = [fields[0]["error"] for _, fields in logged if fields]
        self.assertIn("secret detail", logged_errors)
        self.assertIn("task secret", logged_errors)
        self.assertIn("resource secret", logged_errors)
        self.assertIn("prompt secret", logged_errors)

        verbose = create_mcp_server(
            "PyMCP",
            "test",
            {"id_generator": sequence_mcp_id_generator(["sess-verbose"]), "verbose_handler_errors": True},
        )
        verbose.registry().register_tool(
            {"name": "boom", "inputSchema": {}},
            lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("secret detail")),
        )
        verbose_harness = create_mcp_test_harness(verbose)
        verbose_session = verbose_harness.initialize(id="init").response.headers[MCP_HEADER_SESSION_ID][0]
        verbose_error = verbose_harness.call(verbose_session, "tools/call", {"name": "boom"}, "boom")
        self.assertEqual(verbose_error.body_json["error"]["message"], "secret detail")


class _MutableM3Clock:
    def __init__(self, moment: datetime) -> None:
        self.moment = moment

    def now(self) -> datetime:
        return self.moment


class _M3SpillStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, expires_at: int, sha256: str) -> None:
        self.objects[key] = bytes(data)

    def get(self, key: str, max_bytes: int) -> bytes:
        return self.objects[key]

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


class M3StateBoundsTests(unittest.TestCase):
    def test_shared_fixture_pins_limits_and_cases(self) -> None:
        fixture = json.loads(
            (Path(__file__).resolve().parents[2] / "contract-tests/conformance/state-bounds-conformance.v1.json").read_text()
        )
        self.assertEqual("m3.mcp-state-bounds/v1", fixture["contract"]["id"])
        self.assertEqual(1000, fixture["limits"]["memory_sessions_per_store"])
        self.assertEqual(10000, fixture["limits"]["durable_aggregate_events_per_session"])
        self.assertEqual(64 * 1024 * 1024, fixture["limits"]["durable_aggregate_bytes_per_session"])
        self.assertEqual("Session capacity exceeded", fixture["errors"]["session_capacity"]["message"])
        self.assertEqual(-32000, fixture["errors"]["session_capacity"]["jsonrpc_code"])
        self.assertEqual(200, fixture["errors"]["session_capacity"]["http_status"])
        self.assertFalse(fixture["errors"]["session_capacity"]["session_header"])
        ids = {item["id"] for item in fixture["cases"]}
        for case_id in (
            "memory.session.capacity_refuses_new_live_session",
            "memory.session.expired_first_reclaims_before_admission",
            "memory.session.same_id_live_refresh_consumes_no_capacity",
            "memory.session.expired_incoming_put_not_revived",
            "memory.session.cleanup_removes_associated_state",
            "http.initialize.capacity_refusal_maps_server_error",
            "durable.aggregate.count_boundary",
            "durable.aggregate.byte_boundary",
            "durable.aggregate.spill_counts_toward_aggregate",
            "durable.aggregate.pre_aggregate_schema_refused",
            "durable.aggregate.concurrent_append_unique_sequence",
            "durable.aggregate.non_transactional_backend_refused",
            "durable.delete.paginates_beyond_1000_records",
            "durable.delete.late_append_refused",
        ):
            self.assertIn(case_id, ids)

    def test_memory_session_capacity_expiry_and_same_id_refresh(self) -> None:
        clock = _MutableM3Clock(datetime(1970, 1, 1, 0, 0, 10, tzinfo=UTC))
        store = MemoryMcpSessionStore(clock=clock, max_sessions=2)
        store.put({"id": "one", "expires_at": "1970-01-01T00:02:00Z"})
        store.put({"id": "two", "expires_at": "1970-01-01T00:02:00Z"})
        with self.assertRaises(McpSessionCapacityError):
            store.put({"id": "three", "expires_at": "1970-01-01T00:02:00Z"})
        store.get("one")
        store.get("two")
        with self.assertRaises(McpSessionNotFoundError):
            store.get("three")

        store.put({"id": "one", "expires_at": "1970-01-01T00:02:00Z", "data": {"refreshed": "true"}})

        clock.moment = datetime(1970, 1, 1, 0, 3, 20, tzinfo=UTC)
        expired = store.put_and_collect_expired({"id": "four", "expires_at": "1970-01-01T00:05:00Z"})
        self.assertEqual(["one", "two"], sorted(expired))
        with self.assertRaisesRegex(Exception, "session expired"):
            store.put({"id": "stale", "expires_at": "1970-01-01T00:03:00Z"})

    def test_initialize_capacity_maps_server_error_without_session_header(self) -> None:
        store = MemoryMcpSessionStore(max_sessions=1)
        store.put({"id": "occupied", "expires_at": "2099-01-01T00:00:00Z"})
        server = create_mcp_server("M3", "1", {"session_store": store})
        response = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(),
                "body": json.dumps(
                    {"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {"protocolVersion": MCP_PROTOCOL_VERSION}}
                ),
            }
        )
        self.assertEqual(200, response.status)
        self.assertEqual([], response.headers.get(MCP_HEADER_SESSION_ID, []))
        body = _response_json(response)
        self.assertEqual(MCP_CODE_SERVER_ERROR, body["error"]["code"])
        self.assertEqual("Session capacity exceeded", body["error"]["message"])

    def test_cleanup_removes_stream_and_task_state(self) -> None:
        clock = _MutableM3Clock(datetime(1970, 1, 1, 0, 0, 20, tzinfo=UTC))
        session_store = MemoryMcpSessionStore(clock=clock, max_sessions=2)
        stream_store = MemoryMcpStreamStore(id_generator=sequence_mcp_id_generator(["stream-cleanup"]))
        task_store = MemoryMcpTaskStore(clock=clock)
        server = create_mcp_server(
            "M3",
            "1",
            {"session_store": session_store, "stream_store": stream_store, "task_runtime": {"store": task_store}},
        )
        session_store.put({"id": "sess-cleanup", "expires_at": "1970-01-01T01:00:00Z"})
        stream_id = stream_store.create("sess-cleanup")
        stream_store.append("sess-cleanup", stream_id, "event")
        task_store.create(
            McpTaskRecord(
                session_id="sess-cleanup",
                method="tools/call",
                task=McpTask(task_id="task-cleanup", status="working", created_at="1970-01-01T00:00:20Z"),
            )
        )
        server._cleanup_session_state("sess-cleanup")
        with self.assertRaises(McpStreamNotFoundError):
            stream_store.subscribe("sess-cleanup", stream_id)
        with self.assertRaises(McpTaskNotFoundError):
            task_store.get({"session_id": "sess-cleanup", "task_id": "task-cleanup"})

    def test_dynamo_aggregate_count_bytes_spill_and_pre_aggregate(self) -> None:
        table = _FakeTheoryTable()
        spill = _M3SpillStore()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-count"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
            max_aggregate_events=3,
            max_aggregate_bytes=24,
            inline_max_bytes=4,
            spill_store=spill,
        )
        stream_id = store.create("sess-count")
        payload = b"0123456789"
        self.assertEqual("1", store.append("sess-count", stream_id, payload))
        self.assertEqual("2", store.append("sess-count", stream_id, payload))
        with self.assertRaises(McpStreamAggregateCapacityError):
            store.append("sess-count", stream_id, payload)
        self.assertEqual(2, len(spill.objects))

        state = table.items[("sess-count", "!session")]
        state.aggregate_version = 0
        with self.assertRaises(McpStreamAggregateBackfillError):
            store.append("sess-count", stream_id, b"z")

    def test_dynamo_missing_session_state_maps_to_not_found(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-missing"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        stream_id = store.create("sess-missing")
        table.items.pop(("sess-missing", "!session"))
        with self.assertRaises(McpStreamNotFoundError):
            store.append("sess-missing", stream_id, b"x")
        self.assertFalse(any(key[1].startswith("EVENT#") for key in table.items))

    def test_dynamo_append_requires_transaction_and_cleans_refused_spills(self) -> None:
        class _NoTxTable(_FakeTheoryTable):
            transact_write = None  # type: ignore[assignment]

        no_tx = DynamoMcpStreamStore(
            table=_NoTxTable(),
            id_generator=sequence_mcp_id_generator(["stream-no-tx"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        stream_id = no_tx.create("sess-no-tx")
        with self.assertRaises(McpStreamTransactionRequiredError):
            no_tx.append("sess-no-tx", stream_id, b"x")

        table = _FakeTheoryTable()
        spill = _M3SpillStore()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-refusal"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
            inline_max_bytes=4,
            spill_store=spill,
            append_retries=1,
        )
        refusal_stream = store.create("sess-refusal")
        original = table.transact_write

        def tombstone_first(actions: Any) -> None:
            state = table.items[("sess-refusal", "!session")]
            state.deleted = True
            original(actions)

        table.transact_write = tombstone_first
        with self.assertRaises(McpStreamNotFoundError):
            store.append("sess-refusal", refusal_stream, b"0123456789")
        self.assertEqual({}, spill.objects)

    def test_dynamo_concurrent_appends_do_not_overshoot(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-race"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
            max_aggregate_events=1,
            append_retries=16,
        )
        stream_id = store.create("sess-race")

        def attempt() -> str:
            return store.append("sess-race", stream_id, b"x")

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(attempt) for _ in range(2)]
            successes = 0
            failures = 0
            for future in futures:
                try:
                    future.result()
                    successes += 1
                except McpStreamAggregateCapacityError:
                    failures += 1
        self.assertEqual(1, successes)
        self.assertEqual(1, failures)
        self.assertEqual(1, table.items[("sess-race", "!session")].event_count)

    def test_dynamo_second_create_keeps_aggregate_and_stream_state(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-one", "stream-two"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        first = store.create("sess-twice")
        self.assertEqual("1", store.append("sess-twice", first, b"one"))
        second = store.create("sess-twice")
        self.assertEqual("stream-two", second)
        self.assertEqual("2", store.append("sess-twice", second, b"two"))

        state = table.items[("sess-twice", "!session")]
        self.assertFalse(state.deleted)
        self.assertEqual(2, state.sequence)
        self.assertEqual(2, state.event_count)
        self.assertEqual(6, state.aggregate_bytes)
        self.assertFalse(hasattr(state, "version"))
        self.assertEqual(["one"], [event.data.decode() for event in store.subscribe("sess-twice", first)])
        self.assertEqual(["two"], [event.data.decode() for event in store.subscribe("sess-twice", second)])

    def test_dynamo_existing_session_refresh_preserves_concurrent_aggregate(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-one", "stream-two"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        first = store.create("sess-race-state")
        store.append("sess-race-state", first, b"one")

        key = ("sess-race-state", "!session")
        original_save = table.save
        original_update = table.update

        def bump_concurrent_append() -> None:
            current = table.items[key]
            bumped = copy.deepcopy(current)
            bumped.sequence += 1
            bumped.event_count += 1
            bumped.aggregate_bytes += 3
            table.items[key] = bumped

        def racing_save(item: Any) -> None:
            bump_concurrent_append()
            original_save(item)

        def racing_update(session_id: str, item_id: str, updates: dict[str, Any], **kwargs: Any) -> Any:
            bump_concurrent_append()
            return original_update(session_id, item_id, updates, **kwargs)

        table.save = racing_save
        table.update = racing_update
        store.create("sess-race-state")

        state = table.items[key]
        self.assertEqual(2, state.sequence)
        self.assertEqual(2, state.event_count)
        self.assertEqual(6, state.aggregate_bytes)

    def test_dynamo_existing_session_refresh_cannot_resurrect_tombstone(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-one", "stream-two"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        store.create("sess-resurrect")

        key = ("sess-resurrect", "!session")
        original_save = table.save
        original_update = table.update

        def racing_save(item: Any) -> None:
            tombstone = copy.deepcopy(item)
            tombstone.deleted = True
            table.items[key] = tombstone
            original_save(item)

        def racing_update(session_id: str, item_id: str, updates: dict[str, Any], **kwargs: Any) -> Any:
            table.items[key].deleted = True
            return original_update(session_id, item_id, updates, **kwargs)

        table.save = racing_save
        table.update = racing_update
        with self.assertRaises(McpStreamNotFoundError):
            store.create("sess-resurrect")
        self.assertTrue(table.items[key].deleted)

    def test_dynamo_new_session_create_cannot_overwrite_racing_tombstone(self) -> None:
        table = _FakeTheoryTable()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-late"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        key = ("sess-late", "!session")
        original_put = table.put

        def racing_put(item: Any, **kwargs: Any) -> None:
            if (str(item.session_id), str(item.item_id)) == key:
                table.items[key] = SimpleNamespace(
                    session_id="sess-late",
                    item_id="!session",
                    stream_id="",
                    kind="session",
                    sequence=0,
                    aggregate_version=1,
                    event_count=0,
                    aggregate_bytes=0,
                    deleted=True,
                    expires_at=int(datetime(2026, 1, 1, 1, 0, 0, tzinfo=UTC).timestamp()),
                )
            original_put(item, **kwargs)

        table.put = racing_put
        with self.assertRaises(McpStreamNotFoundError):
            store.create("sess-late")
        self.assertTrue(table.items[key].deleted)
        self.assertEqual(0, table.items[key].event_count)

    def test_dynamo_retryable_cleanup_failure_is_not_hidden_by_success(self) -> None:
        table = _FakeTheoryTable()

        class _FlakySpillStore(_M3SpillStore):
            def __init__(self) -> None:
                super().__init__()
                self.delete_calls = 0

            def delete(self, key: str) -> None:
                self.delete_calls += 1
                if self.delete_calls == 1:
                    raise RuntimeError("spill cleanup unavailable")
                super().delete(key)

        spill = _FlakySpillStore()
        store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["stream-retry"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
            inline_max_bytes=4,
            spill_store=spill,
            append_retries=4,
        )
        stream_id = store.create("sess-retry")
        state_key = ("sess-retry", "!session")
        original = table.transact_write
        injected = False

        def one_retryable_failure(actions: Any) -> None:
            nonlocal injected
            if not injected:
                injected = True
                table.items[state_key].sequence += 1
            original(actions)

        table.transact_write = one_retryable_failure
        with self.assertRaises(McpStreamAppendConflictError) as caught:
            store.append("sess-retry", stream_id, b"0123456789")
        cause = caught.exception.__cause__
        self.assertIsInstance(cause, ExceptionGroup)
        assert isinstance(cause, ExceptionGroup)
        self.assertEqual("spill cleanup failed", cause.message)
        self.assertIn("cleanup unavailable", str(cause.exceptions[1]))
        self.assertFalse(any(key[0] == "sess-retry" and key[1].startswith("EVENT#") for key in table.items))
        self.assertEqual(1, len(spill.objects), "the orphan is left to lifecycle retry")

    def test_memory_session_get_reports_observed_expiry_distinctly(self) -> None:
        store = MemoryMcpSessionStore(
            clock=_FixedClock(datetime(1970, 1, 1, 0, 1, 20, tzinfo=UTC)),
            seed=[{"id": "expired", "expires_at": "1970-01-01T00:01:10Z"}],
        )
        with self.assertRaises(McpSessionExpiredError):
            store.get("expired")
        with self.assertRaises(McpSessionNotFoundError):
            store.get("unknown")

    def test_unknown_session_id_creates_no_durable_state(self) -> None:
        table = _FakeTheoryTable()
        stream_store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["unused"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        server = create_mcp_server("M3", "1", {"stream_store": stream_store})
        response = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id="forged-session"),
                "body": json.dumps({"jsonrpc": "2.0", "id": "forged", "method": "ping"}),
            }
        )
        self.assertEqual(404, response.status)
        self.assertEqual({}, {key: item for key, item in table.items.items() if key[0] == "forged-session"})

    def test_cross_instance_miss_keeps_victim_durable_history(self) -> None:
        table = _FakeTheoryTable()
        stream_store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["victim-stream"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        server_a = create_mcp_server("A", "1", {"stream_store": stream_store})
        server_a.registry().register_streaming_tool(
            {"name": "victim", "inputSchema": {}},
            lambda _args, _emit, _ctx: {"content": []},
        )
        initialized = server_a.serve(
            {
                "method": "POST",
                "headers": _post_headers(),
                "body": json.dumps(
                    {"jsonrpc": "2.0", "id": "init", "method": "initialize", "params": {"protocolVersion": MCP_PROTOCOL_VERSION}}
                ),
            }
        )
        session_id = initialized.headers[MCP_HEADER_SESSION_ID][0]
        streamed = server_a.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id=session_id),
                "body": json.dumps({"jsonrpc": "2.0", "id": "s1", "method": "tools/call", "params": {"name": "victim"}}),
            }
        )
        self.assertEqual(200, streamed.status)
        self.assertEqual(2, table.items[(session_id, "!session")].event_count)

        server_b = create_mcp_server("B", "1", {"stream_store": stream_store})
        miss = server_b.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id=session_id),
                "body": json.dumps({"jsonrpc": "2.0", "id": "s2", "method": "ping"}),
            }
        )
        self.assertEqual(404, miss.status)
        self.assertFalse(table.items[(session_id, "!session")].deleted)
        self.assertEqual(2, len(stream_store.subscribe(session_id, "victim-stream")))

    def test_observed_expiry_cleans_associated_durable_state(self) -> None:
        table = _FakeTheoryTable()
        stream_store = DynamoMcpStreamStore(
            table=table,
            id_generator=sequence_mcp_id_generator(["expired-stream"]),
            clock=_FixedClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        )
        session_store = MemoryMcpSessionStore(seed=[{"id": "sess-expired", "expires_at": "1970-01-01T00:00:00Z"}])
        server = create_mcp_server("M3", "1", {"session_store": session_store, "stream_store": stream_store})
        stream_id = stream_store.create("sess-expired")
        stream_store.append("sess-expired", stream_id, b"old")

        response = server.serve(
            {
                "method": "POST",
                "headers": _post_headers(session_id="sess-expired"),
                "body": json.dumps({"jsonrpc": "2.0", "id": "expired", "method": "ping"}),
            }
        )
        self.assertEqual(404, response.status)
        self.assertTrue(table.items[("sess-expired", "!session")].deleted)
        with self.assertRaises(McpStreamNotFoundError):
            stream_store.subscribe("sess-expired", stream_id)


if __name__ == "__main__":
    unittest.main()
