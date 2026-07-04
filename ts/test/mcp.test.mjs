import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_CODE_INVALID_PARAMS,
  MCP_CODE_METHOD_NOT_FOUND,
  MCP_HEADER_LAST_EVENT_ID,
  MCP_HEADER_PROTOCOL_VERSION,
  MCP_HEADER_SESSION_ID,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_LEGACY,
  DynamoMcpStreamStore,
  DynamoMcpTaskStore,
  McpEventNotFoundError,
  McpPromptRegistry,
  McpResourceRegistry,
  McpSessionNotFoundError,
  McpStreamNotFoundError,
  McpTaskInvalidCursorError,
  McpTaskNotFoundError,
  McpTaskTerminalError,
  McpToolRegistry,
  MemoryMcpSessionStore,
  MemoryMcpStreamStore,
  MemoryMcpTaskStore,
  createMcpServer,
  createMcpTestHarness,
  defaultMcpStreamModel,
  defaultMcpTaskModel,
  fixedIdGenerator,
  parseMcpTestSSEFrames,
  sequenceIdGenerator,
} from "../dist/index.js";

const POST_HEADERS = {
  "content-type": ["application/json"],
  accept: ["application/json, text/event-stream"],
};

function textBlock(text) {
  return { type: "text", text };
}

async function post(server, body, headers = {}) {
  return server.serve({
    method: "POST",
    headers: { ...POST_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

async function json(response) {
  assert.ok(response.body, "response should have a body");
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}

function sessionHeader(response) {
  return response.headers?.[MCP_HEADER_SESSION_ID]?.[0] ?? "";
}

async function initialize(server, id = "init", protocolVersion = MCP_PROTOCOL_VERSION) {
  const response = await post(server, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion },
  });
  return { response, body: await json(response), sessionId: sessionHeader(response) };
}

function rpc(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function fakeDb() {
  const items = new Map();
  const registered = [];
  const keyOf = (model, key) => {
    const sessionId = String(key.sessionId ?? "");
    const sort = String(key.taskId ?? key.itemId ?? "");
    return `${model}:${sessionId}:${sort}`;
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const db = {
    registered,
    register(model) {
      registered.push(model.name);
    },
    async create(model, item, options = {}) {
      const key = keyOf(model, item);
      if (options.ifNotExists && items.has(key)) {
        const err = new Error("conditional check failed");
        err.name = "ErrConditionFailed";
        throw err;
      }
      items.set(key, clone(item));
      return clone(item);
    },
    async get(model, key) {
      const item = items.get(keyOf(model, key));
      if (!item) {
        const err = new Error("not found");
        err.name = "ErrItemNotFound";
        throw err;
      }
      return clone(item);
    },
    async save(model, item) {
      items.set(keyOf(model, item), clone(item));
      return clone(item);
    },
    async delete(model, key) {
      items.delete(keyOf(model, key));
    },
    query(model) {
      const state = { partition: "", limit: 1000, cursor: "" };
      const builder = {
        partitionKey(value) {
          state.partition = String(value ?? "");
          return builder;
        },
        sort(_direction) {
          return builder;
        },
        limit(value) {
          state.limit = Number(value) || 1000;
          return builder;
        },
        cursor(value) {
          state.cursor = String(value ?? "");
          return builder;
        },
        async page() {
          const start = Number(state.cursor || 0);
          const all = [...items.entries()]
            .filter(([key]) => key.startsWith(`${model}:${state.partition}:`))
            .map(([, value]) => clone(value))
            .sort((a, b) => String(a.taskId ?? a.itemId).localeCompare(String(b.taskId ?? b.itemId)));
          const pageItems = all.slice(start, start + state.limit);
          const next = start + state.limit < all.length ? String(start + state.limit) : "";
          return { items: pageItems, cursor: next };
        },
      };
      return builder;
    },
  };
  return db;
}

function taskRecord(overrides = {}) {
  return {
    sessionId: "sess-1",
    method: "tools/call",
    toolName: "echo",
    task: {
      taskId: "task-1",
      status: "working",
      createdAt: "2026-07-03T00:00:00Z",
      lastUpdatedAt: "2026-07-03T00:00:00Z",
      ttl: 60000,
      pollInterval: 100,
    },
    ...overrides,
  };
}

test("mcp registries normalize definitions and fail closed", async () => {
  const tools = new McpToolRegistry();
  assert.throws(() => tools.registerTool({ name: "", inputSchema: {} }, () => ({ content: [] })), /tool name/);
  assert.throws(() => tools.registerTool({ name: "echo", inputSchema: {} }, null), /handler/);
  tools.registerTool(
    {
      name: " echo ",
      title: " Echo ",
      description: " repeats ",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
    },
    (args, context) => ({
      content: [textBlock(`${context.sessionId}:${args.message}`)],
      structuredContent: { ok: true },
    }),
  );
  assert.throws(() => tools.registerTool({ name: "echo", inputSchema: {} }, () => ({ content: [] })), /already/);
  assert.equal(tools.len(), 1);
  assert.equal(tools.supportsTasks(), true);
  assert.equal(tools.taskSupport("echo"), "optional");
  assert.deepEqual(tools.list()[0].execution, { taskSupport: "optional" });
  assert.deepEqual(await tools.call("echo", { message: "hi" }, { sessionId: "s", requestId: "r", method: "tools/call" }), {
    content: [textBlock("s:hi")],
    structuredContent: { ok: true },
  });
  await assert.rejects(() => tools.call("missing", {}, { sessionId: "s", requestId: "r", method: "tools/call" }), /tool not found/);

  const streamed = new McpToolRegistry();
  assert.throws(() => streamed.registerStreamingTool({ name: "", inputSchema: {} }, () => ({ content: [] })), /tool name/);
  streamed.registerStreamingTool({ name: "stream", inputSchema: {}, execution: { taskSupport: "ignored" } }, (args, emit) => {
    emit({ data: { message: args.message, seq: 1, total: 1 } });
    return { content: [textBlock("done")], isError: true };
  });
  assert.equal(streamed.supportsStreaming("stream"), true);
  const emitted = [];
  assert.deepEqual(await streamed.callStreaming("stream", { message: "half" }, (event) => emitted.push(event), { sessionId: "s", requestId: "r", method: "tools/call" }), {
    content: [textBlock("done")],
    isError: true,
  });
  assert.deepEqual(emitted, [{ data: { message: "half", seq: 1, total: 1 } }]);

  const resources = new McpResourceRegistry();
  assert.throws(() => resources.registerResource({ uri: "relative", name: "bad" }, () => []), /absolute/);
  assert.throws(() => resources.registerResource({ uri: "file:///ok", name: "" }, () => []), /name/);
  resources.registerResource(
    { uri: "file:///ok", name: " ok ", title: " OK ", description: " Desc ", mimeType: "text/plain", size: 3 },
    ({ uri }) => [{ uri, text: "abc", mimeType: "text/plain", blob: "YWJj" }],
  );
  assert.throws(() => resources.registerResource({ uri: "file:///ok", name: "dup" }, () => []), /already/);
  resources.registerResourceTemplate({ uriTemplate: "file:///items/{id}", name: "item", title: "Item" });
  assert.throws(() => resources.registerResourceTemplate({ uriTemplate: "bad template", name: "bad" }), /absolute/);
  assert.equal(resources.len(), 1);
  assert.equal(resources.templateLen(), 1);
  assert.equal(resources.list()[0].title, "OK");
  assert.equal(resources.listTemplates()[0].uriTemplate, "file:///items/{id}");
  assert.deepEqual(await resources.read("file:///ok"), [{ uri: "file:///ok", mimeType: "text/plain", text: "abc", blob: "YWJj" }]);
  await assert.rejects(() => resources.read("file:///missing"), /resource not found/);

  const prompts = new McpPromptRegistry();
  assert.throws(() => prompts.registerPrompt({ name: "" }, () => ({ messages: [] })), /prompt name/);
  prompts.registerPrompt(
    { name: "greet", title: " Greet ", description: " hi ", arguments: [{ name: "name", required: true, title: "Name" }] },
    (args) => ({ description: "Rendered", messages: [{ role: "user", content: textBlock(`Hello ${args.name}`) }] }),
  );
  assert.throws(() => prompts.registerPrompt({ name: "greet" }, () => ({ messages: [] })), /already/);
  assert.equal(prompts.len(), 1);
  assert.deepEqual(prompts.list()[0].arguments, [{ name: "name", title: "Name", required: true }]);
  assert.deepEqual(await prompts.get("greet", { name: "Ada" }), {
    description: "Rendered",
    messages: [{ role: "user", content: textBlock("Hello Ada") }],
  });
  await assert.rejects(() => prompts.get("missing", {}), /prompt not found/);
});

test("mcp memory stores are deterministic and fail closed", async () => {
  const now = new Date("2026-07-03T00:00:00Z");
  const sessionStore = new MemoryMcpSessionStore({
    now: () => now,
    seed: [
      { id: "live", createdAt: "2026-07-03T00:00:00Z", expiresAt: "2026-07-03T01:00:00Z", data: { p: "v" } },
      { id: "old", createdAt: "2026-07-02T00:00:00Z", expiresAt: "2026-07-02T01:00:00Z" },
    ],
  });
  assert.equal((await sessionStore.get(" live ")).data.p, "v");
  await assert.rejects(() => sessionStore.get("old"), McpSessionNotFoundError);
  await sessionStore.put({ id: "new", createdAt: "", expiresAt: "" });
  assert.equal((await sessionStore.get("new")).id, "new");
  await assert.rejects(() => sessionStore.put({ id: "", createdAt: "", expiresAt: "" }), /missing session id/);
  await sessionStore.delete("new");
  await assert.rejects(() => sessionStore.get("new"), McpSessionNotFoundError);

  const streams = new MemoryMcpStreamStore({ idGenerator: sequenceIdGenerator(["stream-1", "stream-2"]) });
  await assert.rejects(() => streams.create(""), /missing session id/);
  const streamId = await streams.create("sess");
  assert.equal(streamId, "stream-1");
  const first = await streams.append("sess", streamId, Buffer.from("one"));
  const second = await streams.append("sess", streamId, Buffer.from("two"));
  assert.equal(first, "1");
  assert.equal(second, "2");
  assert.equal(await streams.streamForEvent("sess", "1"), streamId);
  assert.deepEqual((await streams.subscribe("sess", streamId, "1")).map((event) => Buffer.from(event.data).toString()), ["two"]);
  await assert.rejects(() => streams.subscribe("sess", streamId, "9"), McpEventNotFoundError);
  await streams.close("sess", streamId);
  await streams.deleteSession("sess");
  await assert.rejects(() => streams.streamForEvent("sess", "1"), McpStreamNotFoundError);

  const tasks = new MemoryMcpTaskStore({ now: () => new Date("2026-07-03T00:00:02Z") });
  const created = await tasks.create(taskRecord());
  assert.equal(created.task.taskId, "task-1");
  await assert.rejects(() => tasks.create(taskRecord()), /already exists/);
  await assert.rejects(() => tasks.get({ sessionId: "sess-1", taskId: "missing" }), McpTaskNotFoundError);
  await tasks.create(taskRecord({ task: { ...taskRecord().task, taskId: "task-2", createdAt: "2026-07-03T00:00:01Z" } }));
  assert.deepEqual((await tasks.list({ sessionId: "sess-1", limit: 1 })).nextCursor, "1");
  await assert.rejects(() => tasks.list({ sessionId: "sess-1", cursor: "bad" }), McpTaskInvalidCursorError);
  const updated = await tasks.update({ ...created, task: { ...created.task, status: "completed", lastUpdatedAt: "2026-07-03T00:00:03Z" }, result: { ok: true } });
  assert.equal(updated.task.status, "completed");
  await assert.rejects(() => tasks.update(updated), McpTaskTerminalError);
  const canceled = await tasks.cancel({ sessionId: "sess-1", taskId: "task-2" });
  assert.equal(canceled.task.status, "canceled");
  assert.equal(canceled.error.message, "task canceled");
  await assert.rejects(() => tasks.cancel({ sessionId: "sess-1", taskId: "task-2" }), McpTaskTerminalError);
  await tasks.deleteSession("sess-1");
  assert.deepEqual(await tasks.list({ sessionId: "sess-1" }), { tasks: [] });
});

test("mcp server handles core HTTP, registry, and session paths", async () => {
  const server = createMcpServer(" Unit MCP ", " 1.0 ", {
    idGenerator: sequenceIdGenerator(["sess-1"]),
    sessionTtlMs: 60000,
    originValidator: (origin) => origin === "https://allowed.example",
  });
  server.registry().registerTool({ name: "echo", inputSchema: { type: "object" } }, (args, context) => ({
    content: [textBlock(`${context.sessionId}:${args.message}`)],
  }));
  server.resources().registerResource({ uri: "file:///unit", name: "unit" }, () => [{ uri: "file:///unit", text: "resource" }]);
  server.resources().registerResourceTemplate({ uriTemplate: "file:///unit/{id}", name: "unit-template" });
  server.prompts().registerPrompt({ name: "greet", arguments: [{ name: "name", required: true }] }, (args) => ({
    messages: [{ role: "user", content: textBlock(`Hello ${args.name}`) }],
  }));

  assert.equal((await server.serve({ method: "PATCH" })).status, 405);
  assert.equal((await post(server, rpc("x", "ping"), { origin: ["https://blocked.example"] })).status, 403);
  assert.match(JSON.stringify(await json(await server.serve({ method: "POST", headers: { accept: ["application/json, text/event-stream"] }, body: "{}" }))), /Content-Type/);
  assert.match(JSON.stringify(await json(await server.serve({ method: "POST", headers: { "content-type": ["application/json"], accept: ["application/json"] }, body: "{}" }))), /Accept/);
  assert.equal((await json(await server.serve({ method: "POST", headers: POST_HEADERS, body: "{" }))).error.code, -32700);
  assert.match(JSON.stringify(await json(await server.serve({ method: "POST", headers: POST_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", result: {} }) }))), /invalid JSON-RPC response/);

  const initialized = await initialize(server);
  assert.equal(initialized.body.result.serverInfo.name, "Unit MCP");
  assert.equal(initialized.body.result.capabilities.tools instanceof Object, true);
  assert.equal(initialized.sessionId, "sess-1");

  const sessionHeaders = { [MCP_HEADER_SESSION_ID]: [initialized.sessionId], [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION] };
  assert.equal((await post(server, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders)).status, 202);
  assert.deepEqual((await json(await post(server, rpc("ping", "ping"), sessionHeaders))).result, {});
  assert.equal((await json(await post(server, rpc("tools", "tools/list"), sessionHeaders))).result.tools[0].name, "echo");
  assert.equal((await json(await post(server, rpc("call", "tools/call", { name: "echo", arguments: { message: "hi" } }), sessionHeaders))).result.content[0].text, "sess-1:hi");
  assert.equal((await json(await post(server, rpc("resources", "resources/list"), sessionHeaders))).result.resources[0].uri, "file:///unit");
  assert.equal((await json(await post(server, rpc("read", "resources/read", { uri: "file:///unit" }), sessionHeaders))).result.contents[0].text, "resource");
  assert.equal((await json(await post(server, rpc("templates", "resources/templates/list"), sessionHeaders))).result.resourceTemplates[0].uriTemplate, "file:///unit/{id}");
  assert.equal((await json(await post(server, rpc("prompts", "prompts/list"), sessionHeaders))).result.prompts[0].name, "greet");
  assert.equal((await json(await post(server, rpc("prompt", "prompts/get", { name: "greet", arguments: { name: "Ada" } }), sessionHeaders))).result.messages[0].content.text, "Hello Ada");

  assert.equal((await post(server, rpc("missing-session", "ping"), {})).status, 400);
  assert.equal((await post(server, rpc("bad-session", "ping"), { [MCP_HEADER_SESSION_ID]: ["missing"] })).status, 404);
  assert.match(JSON.stringify(await json(await post(server, rpc("bad-proto", "tasks/list"), { ...sessionHeaders, [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION_LEGACY] }))), /MCP-Protocol-Version mismatch/);
  assert.match(JSON.stringify(await json(await post(server, rpc("bad-resource", "resources/read", { uri: "file:///missing" }), sessionHeaders))), /resource not found/);
  assert.match(JSON.stringify(await json(await post(server, rpc("bad-prompt", "prompts/get", { name: "missing" }), sessionHeaders))), /prompt not found/);
});

test("mcp server streams, resumes SSE, and testkit invokes deterministically", async () => {
  const server = createMcpServer("Stream MCP", "1", { idGenerator: sequenceIdGenerator(["sess-stream", "stream-1"]) });
  server.registry().registerStreamingTool({ name: "stream", inputSchema: {} }, async (args, emit) => {
    await emit({ data: { seq: 1, total: 2, message: `half ${args.message}` } });
    await emit({ data: "almost" });
    return { content: [textBlock(`done ${args.message}`)] };
  });
  const harness = createMcpTestHarness(server, { path: "mcp", appIdGenerator: fixedIdGenerator("req-test") });
  const init = await harness.initialize();
  assert.equal(init.bodyJson.result.serverInfo.name, "Stream MCP");
  const sessionId = init.response.headers[MCP_HEADER_SESSION_ID][0];
  const result = await harness.call(sessionId, "tools/call", {
    name: "stream",
    arguments: { message: "go" },
    _meta: { progressToken: "tok" },
  });
  assert.equal(result.response.headers["content-type"][0], "text/event-stream");
  assert.equal(result.sseFrames.length, 4);
  assert.deepEqual(result.sseFrames.map((frame) => frame.id), ["1", "2", "3", "4"]);
  assert.match(result.sseFrames[1].data, /half go/);
  assert.match(result.sseFrames[3].data, /done go/);

  const replay = await harness.invoke({ method: "GET", sessionId, lastEventId: "2" });
  assert.deepEqual(replay.sseFrames.map((frame) => frame.id), ["3", "4"]);
  assert.deepEqual(parseMcpTestSSEFrames(Buffer.from(": keepalive\n\nid: 9\nevent: message\ndata: a\ndata: b\n\n")).filter((frame) => frame.id || frame.data), [
    { id: "9", event: "message", data: "a\nb" },
  ]);

  assert.equal((await harness.invoke({ method: "GET", sessionId, headers: { accept: ["application/json"] } })).response.status, 400);
  assert.equal((await harness.invoke({ method: "DELETE", sessionId })).response.status, 202);
  assert.equal((await harness.invoke({ method: "GET", sessionId })).response.status, 404);
});

test("mcp task runtime handles lifecycle and error paths", async () => {
  const taskStore = new MemoryMcpTaskStore({ now: () => new Date("2026-07-03T00:00:02Z") });
  const server = createMcpServer("Task MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-task", "task-1", "task-2", "task-3"]),
    taskRuntime: {
      store: taskStore,
      defaultTtlMs: 60000,
      maxTtlMs: 120000,
      pollIntervalMs: 100,
      listLimit: 2,
      modelImmediateResponse: "poll tasks/result",
    },
  });
  server.registry().registerTool({ name: "task_echo", inputSchema: {}, execution: { taskSupport: "optional" } }, (args) => ({
    content: [textBlock(args.message)],
    structuredContent: { message: args.message },
  }));
  server.registry().registerTool({ name: "required", inputSchema: {}, execution: { taskSupport: "required" } }, () => ({ content: [textBlock("required")] }));
  server.registry().registerTool({ name: "plain", inputSchema: {} }, () => ({ content: [textBlock("plain")] }));
  server.registry().registerTool({ name: "fails", inputSchema: {}, execution: { taskSupport: "optional" } }, () => {
    throw new Error("boom");
  });

  const init = await initialize(server);
  const headers = { [MCP_HEADER_SESSION_ID]: [init.sessionId], [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION] };
  const created = await json(await post(server, rpc("create", "tools/call", { name: "task_echo", arguments: { message: "task result" }, task: {} }), headers));
  assert.equal(created.result.task.taskId, "task-1");
  assert.equal(created.result._meta["io.modelcontextprotocol/model-immediate-response"], "poll tasks/result");
  assert.equal((await json(await post(server, rpc("result", "tasks/result", { taskId: "task-1" }), headers))).result.structuredContent.message, "task result");
  assert.equal((await json(await post(server, rpc("get", "tasks/get", { taskId: "task-1" }), headers))).result.status, "completed");
  assert.equal((await json(await post(server, rpc("list", "tasks/list"), headers))).result.tasks[0].taskId, "task-1");
  assert.equal((await json(await post(server, rpc("cancel", "tasks/cancel", { taskId: "task-1" }), headers))).error.code, MCP_CODE_INVALID_PARAMS);

  assert.equal((await json(await post(server, rpc("required", "tools/call", { name: "required", arguments: {} }), headers))).error.code, MCP_CODE_METHOD_NOT_FOUND);
  assert.equal((await json(await post(server, rpc("plain-task", "tools/call", { name: "plain", arguments: {}, task: {} }), headers))).error.code, MCP_CODE_METHOD_NOT_FOUND);
  assert.equal((await json(await post(server, rpc("ttl-low", "tools/call", { name: "task_echo", arguments: {}, task: { ttl: 0 } }), headers))).error.message, "Invalid params: task.ttl must be positive");
  assert.equal((await json(await post(server, rpc("ttl-high", "tools/call", { name: "task_echo", arguments: {}, task: { ttl: 999999 } }), headers))).error.message, "Invalid params: task.ttl exceeds maximum");
  assert.equal((await json(await post(server, rpc("missing-task", "tasks/get", {}), headers))).error.message, "Invalid params: missing taskId");
  const failed = await json(await post(server, rpc("failed", "tools/call", { name: "fails", arguments: {}, task: {} }), headers));
  assert.equal(failed.result.task.status, "working");
  assert.equal((await json(await post(server, rpc("failed-result", "tasks/result", { taskId: "task-2" }), headers))).error.message, "boom");

  const noTasks = createMcpServer("No Tasks", "1", { idGenerator: sequenceIdGenerator(["sess-no-tasks"]) });
  noTasks.registry().registerTool({ name: "plain", inputSchema: {} }, () => ({ content: [textBlock("plain")] }));
  const noTasksInit = await initialize(noTasks);
  const noTasksHeaders = { [MCP_HEADER_SESSION_ID]: [noTasksInit.sessionId], [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION] };
  assert.equal((await json(await post(noTasks, rpc("task-disabled", "tools/call", { name: "plain", task: {} }), noTasksHeaders))).error.code, MCP_CODE_METHOD_NOT_FOUND);
});

test("dynamo-backed MCP stores use TableTheory clients without raw SDK escape hatches", async () => {
  const db = fakeDb();
  const taskModel = defaultMcpTaskModel("unit-tasks");
  const streamModel = defaultMcpStreamModel("unit-streams");
  const tasks = new DynamoMcpTaskStore(db, { model: taskModel, now: () => new Date("2026-07-03T00:00:05Z") });
  assert.ok(db.registered.includes(taskModel.name));
  const created = await tasks.create(taskRecord());
  assert.equal((await tasks.get({ sessionId: "sess-1", taskId: "task-1" })).task.status, "working");
  const complete = await tasks.update({ ...created, task: { ...created.task, status: "completed", lastUpdatedAt: "2026-07-03T00:00:01Z" }, result: { content: [textBlock("ok")] } });
  assert.equal(complete.result.content[0].text, "ok");
  await assert.rejects(() => tasks.update(complete), McpTaskTerminalError);
  await assert.rejects(() => tasks.get({ sessionId: "sess-1", taskId: "missing" }), McpTaskNotFoundError);
  await tasks.create(taskRecord({ task: { ...taskRecord().task, taskId: "task-2", createdAt: "2026-07-03T00:00:02Z" } }));
  assert.equal((await tasks.list({ sessionId: "sess-1", limit: 1 })).tasks.length, 1);
  const canceled = await tasks.cancel({ sessionId: "sess-1", taskId: "task-2" });
  assert.equal(canceled.task.status, "canceled");
  await tasks.deleteSession("sess-1");
  assert.deepEqual(await tasks.list({ sessionId: "sess-1" }), { tasks: [] });

  const streams = new DynamoMcpStreamStore(db, { model: streamModel, idGenerator: sequenceIdGenerator(["stream-dyn"]) });
  assert.ok(db.registered.includes(streamModel.name));
  const streamId = await streams.create("sess-stream");
  assert.equal(streamId, "stream-dyn");
  await streams.append("sess-stream", streamId, Buffer.from("one"));
  await streams.append("sess-stream", streamId, Buffer.from("two"));
  assert.equal(await streams.streamForEvent("sess-stream", "1"), streamId);
  assert.deepEqual((await streams.subscribe("sess-stream", streamId, "1")).map((event) => Buffer.from(event.data).toString()), ["two"]);
  await assert.rejects(() => streams.subscribe("sess-stream", streamId, "9"), McpEventNotFoundError);
  await streams.close("sess-stream", streamId);
  await streams.deleteSession("sess-stream");
  await assert.rejects(() => streams.streamForEvent("sess-stream", "1"), McpEventNotFoundError);
});
