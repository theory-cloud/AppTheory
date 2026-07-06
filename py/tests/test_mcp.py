from __future__ import annotations

import json
import unittest
from typing import Any

from apptheory import (
    MCP_CODE_INVALID_PARAMS,
    MCP_CODE_METHOD_NOT_FOUND,
    MCP_CODE_PARSE_ERROR,
    MCP_CODE_SERVER_ERROR,
    MCP_HEADER_PROTOCOL_VERSION,
    MCP_HEADER_SESSION_ID,
    MCP_PROTOCOL_VERSION,
    MCP_PROTOCOL_VERSION_LEGACY,
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
    McpSSEEvent,
    McpSession,
    McpSessionNotFoundError,
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
    create_mcp_server,
    create_mcp_test_harness,
    sequence_mcp_id_generator,
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
    def __init__(self, items: list[Any], cursor: str = "") -> None:
        self.items = items
        self.cursor = cursor


class _FakeNotFound(Exception):
    pass


class _FakeTheoryTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], Any] = {}

    def put(self, item: Any) -> None:
        self.items[self._key(item)] = item

    def save(self, item: Any) -> None:
        self.put(item)

    def get(self, session_id: str, item_id: str) -> Any:
        key = (str(session_id), str(item_id))
        if key not in self.items:
            raise _FakeNotFound("not found")
        return self.items[key]

    def query(self, session_id: str, *, limit: int = 1000) -> _Page:
        selected = [item for (pk, _), item in self.items.items() if pk == str(session_id)]
        return _Page(selected[:limit], cursor="next" if len(selected) > limit else "")

    def delete(self, session_id: str, item_id: str) -> None:
        self.items.pop((str(session_id), str(item_id)), None)

    def _key(self, item: Any) -> tuple[str, str]:
        session_id = str(getattr(item, "session_id", ""))
        item_id = str(getattr(item, "item_id", "") or getattr(item, "task_id", ""))
        return session_id, item_id


class McpRuntimeTests(unittest.TestCase):
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

        legacy_server = create_mcp_server(
            "PyMCP", "test", {"id_generator": sequence_mcp_id_generator(["sess-legacy"])}
        )
        legacy_harness = create_mcp_test_harness(legacy_server)
        legacy_session = legacy_harness.initialize(id="init", protocol_version=MCP_PROTOCOL_VERSION_LEGACY).response.headers[
            "mcp-session-id"
        ][0]
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
        server.registry().register_tool({"name": "boom", "inputSchema": {}}, lambda _args, _ctx: (_ for _ in ()).throw(RuntimeError("boom")))
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
        excessive_ttl = harness.call(
            session_id, "tools/call", {"name": "required", "task": {"ttl": 3000}}, "ttl-high"
        )
        self.assertEqual(excessive_ttl.body_json["error"]["code"], MCP_CODE_INVALID_PARAMS)

        ok = harness.call(
            session_id,
            "tools/call",
            {"name": "required", "arguments": {"message": "done"}, "task": {"ttl": 2000}},
            "ok",
        )
        self.assertEqual(ok.body_json["result"]["task"]["taskId"], "task-ok")
        self.assertEqual(ok.body_json["result"]["_meta"]["io.modelcontextprotocol/model-immediate-response"], "prefer-task")

        task_failure = harness.call(session_id, "tools/call", {"name": "fail", "task": {}}, "fail")
        self.assertEqual(task_failure.body_json["result"]["task"]["taskId"], "task-fail")
        failure_result = harness.call(session_id, "tasks/result", {"taskId": "task-fail"}, "failure-result")
        self.assertEqual(failure_result.body_json["error"]["code"], MCP_CODE_SERVER_ERROR)

        is_error = harness.call(session_id, "tools/call", {"name": "is_error", "task": {}}, "is-error")
        self.assertEqual(is_error.body_json["result"]["task"]["status"], "working")
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
        task_store = DynamoMcpTaskStore(table=task_table)
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


if __name__ == "__main__":
    unittest.main()
