import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MCP_CODE_INVALID_PARAMS,
  MCP_CODE_METHOD_NOT_FOUND,
  MCP_CODE_SERVER_ERROR,
  MCP_HEADER_LAST_EVENT_ID,
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
  DynamoMcpStreamStore,
  DynamoMcpTaskStore,
  McpEventNotFoundError,
  McpPromptRegistry,
  McpResourceRegistry,
  McpSessionNotFoundError,
  McpSessionCapacityError,
  McpStreamAggregateBackfillError,
  McpStreamAggregateCapacityError,
  McpStreamTransactionRequiredError,
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
  detectMcpProtocolVersion,
  detectMcpProtocolVersionForMessage,
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

test("detectMcpProtocolVersion gives the header precedence over request _meta", () => {
  const request2026 = {
    jsonrpc: "2.0",
    id: "version",
    method: "ping",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
      },
    },
  };

  assert.equal(detectMcpProtocolVersion({}, request2026), MCP_PROTOCOL_SHAPE_2026_07_28);
  assert.equal(
    detectMcpProtocolVersion({ "MCP-Protocol-Version": [MCP_PROTOCOL_VERSION] }, request2026),
    MCP_PROTOCOL_SHAPE_2025_11_25,
  );
  assert.equal(
    detectMcpProtocolVersion({ [MCP_HEADER_PROTOCOL_VERSION]: ["2099-01-01"] }, request2026),
    MCP_PROTOCOL_SHAPE_UNKNOWN,
  );
  assert.equal(detectMcpProtocolVersion({}, JSON.stringify(request2026)), MCP_PROTOCOL_SHAPE_2026_07_28);
  assert.equal(detectMcpProtocolVersion({}, { jsonrpc: "2.0", method: "ping" }), MCP_PROTOCOL_SHAPE_UNKNOWN);
  assert.equal(
    detectMcpProtocolVersionForMessage({}, request2026),
    MCP_PROTOCOL_SHAPE_2026_07_28,
  );
  assert.equal(
    detectMcpProtocolVersionForMessage(
      { "MCP-Protocol-Version": [MCP_PROTOCOL_VERSION] },
      request2026,
    ),
    MCP_PROTOCOL_SHAPE_2025_11_25,
  );
  assert.equal(
    detectMcpProtocolVersionForMessage({}, JSON.stringify(request2026)),
    MCP_PROTOCOL_SHAPE_UNKNOWN,
  );
});

test("mcp 2026-07-28 requests stay stateless", async () => {
  let generatedIds = 0;
  const server = createMcpServer("MCP", "test", {
    idGenerator: {
      newId() {
        generatedIds += 1;
        return `unexpected-${generatedIds}`;
      },
    },
  });

  const ping = await post(
    server,
    rpc("discover", "server/discover", {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    }),
    {
      [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION_2026_07_28],
      [MCP_HEADER_METHOD]: ["server/discover"],
    },
  );
  assert.equal(ping.status, 200);
  assert.equal(sessionHeader(ping), "");
  assert.deepEqual(await json(ping), {
    jsonrpc: "2.0",
    id: "discover",
    result: {
      supportedVersions: [
        MCP_PROTOCOL_VERSION_2026_07_28,
        MCP_PROTOCOL_VERSION,
        "2025-06-18",
        "2025-03-26",
      ],
      capabilities: {},
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "MCP",
          version: "test",
        },
      },
      resultType: MCP_RESULT_TYPE_COMPLETE,
      ttlMs: 0,
      cacheScope: "private",
    },
  });
  assert.equal(generatedIds, 0);

  const initialize = await post(
    server,
    rpc("init", "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    }),
    {
      [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION_2026_07_28],
      [MCP_HEADER_METHOD]: ["initialize"],
    },
  );
  assert.equal(sessionHeader(initialize), "");
  assert.equal((await json(initialize)).error.code, MCP_CODE_METHOD_NOT_FOUND);
  assert.equal(generatedIds, 0);

  const deleted = await server.serve({
    method: "DELETE",
    headers: { [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION_2026_07_28] },
  });
  assert.equal(deleted.status, 405);
  // RFC 9110 15.5.5: the stateless 2026-07-28 shape permits only POST.
  assert.deepEqual(deleted.headers["allow"], ["POST"]);
});

test("mcp 2026-07-28 tools support multi-round input_required results", async () => {
  const server = createMcpServer("MCP", "test");
  server.registry().registerTool({ name: "continue", inputSchema: {} }, (args, context) => {
    if (context.requestState === "confirm" && context.inputResponses?.confirmation) {
      return { content: [textBlock(`confirmed ${args.message}`)] };
    }
    return {
      content: [],
      resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
      inputRequests: {
        confirmation: {
          method: "elicitation/create",
          params: { message: "Confirm" },
        },
      },
      requestState: "confirm",
    };
  });
  const headers = {
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION_2026_07_28],
    [MCP_HEADER_METHOD]: ["tools/call"],
    [MCP_HEADER_NAME]: ["continue"],
  };

  const first = await json(
    await post(
      server,
      rpc("first", "tools/call", {
        name: "continue",
        arguments: { message: "contract" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
          "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
        },
      }),
      headers,
    ),
  );
  assert.equal(first.result.resultType, MCP_RESULT_TYPE_INPUT_REQUIRED);
  assert.equal(first.result.requestState, "confirm");
  assert.equal(first.result.inputRequests.confirmation.method, "elicitation/create");
  assert.equal(first.result.content, undefined);

  const second = await json(
    await post(
      server,
      rpc("second", "tools/call", {
        name: "continue",
        arguments: { message: "contract" },
        requestState: "confirm",
        inputResponses: { confirmation: { action: "accept" } },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION_2026_07_28,
          "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
        },
      }),
      headers,
    ),
  );
  assert.equal(second.result.resultType, MCP_RESULT_TYPE_COMPLETE);
  assert.equal(second.result.content[0].text, "confirmed contract");
});

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
    items,
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
    async transactWrite(actions) {
      const evaluate = (action, existing) => {
        const expression = String(action.conditionExpression ?? "").trim();
        if (!expression) {
          return true;
        }
        const names = action.expressionAttributeNames ?? {};
        const values = action.expressionAttributeValues ?? {};
        for (const clause of expression.split(/\s+AND\s+/i)) {
          const match = clause.trim().match(/^(#?[\w]+)\s*=\s*(:[\w]+)$/);
          if (!match) {
            throw new Error(`unsupported fake condition: ${clause}`);
          }
          const field = String(names[match[1]] ?? match[1]);
          const expected = values[match[2]];
          if (!expected) {
            throw new Error(`missing fake condition value: ${match[2]}`);
          }
          const actual = existing[field];
          if (expected.BOOL !== undefined) {
            if (Boolean(actual) !== expected.BOOL) return false;
            continue;
          }
          if (expected.N !== undefined) {
            if (Number(actual ?? 0) !== Number(expected.N)) return false;
            continue;
          }
          if (expected.S !== undefined) {
            if (String(actual ?? "") !== expected.S) return false;
            continue;
          }
          throw new Error("unsupported fake condition value");
        }
        return true;
      };

      for (const action of actions) {
        const key = action.key ?? action.item;
        const itemKey = keyOf(action.model, key);
        const existing = items.get(itemKey);
        if (action.kind === "condition" && !existing) {
          const err = new Error("conditional check failed");
          err.name = "ErrConditionFailed";
          throw err;
        }
        if (action.kind !== "put" && !existing) {
          const err = new Error("conditional check failed");
          err.name = "ErrConditionFailed";
          throw err;
        }
        if ((action.kind === "update" || action.kind === "condition") && !evaluate(action, existing)) {
          const err = new Error("conditional check failed");
          err.name = "ErrConditionFailed";
          throw err;
        }
      }

      for (const action of actions) {
        if (action.kind === "put") {
          items.set(keyOf(action.model, action.item), clone(action.item));
          continue;
        }
        if (action.kind === "delete") {
          items.delete(keyOf(action.model, action.key));
          continue;
        }
        if (action.kind === "update") {
          const itemKey = keyOf(action.model, action.key ?? action.item);
          const existing = items.get(itemKey) ?? {};
          const next = clone(existing);
          for (const field of action.fields ?? []) {
            if (Object.prototype.hasOwnProperty.call(action.item, field)) {
              next[field] = clone(action.item[field]);
            }
          }
          items.set(itemKey, next);
        }
      }
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

  const patched = await server.serve({ method: "PATCH" });
  assert.equal(patched.status, 405);
  // RFC 9110 15.5.5: the MCP endpoint registers GET, POST, DELETE.
  assert.deepEqual(patched.headers["allow"], ["DELETE, GET, POST"]);
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

test("mcp initial session listener defaults to enabled and can be declined with 405", async () => {
  const defaultServer = createMcpServer("Listener MCP", "1", { idGenerator: sequenceIdGenerator(["sess-listener"]) });
  const defaultHarness = createMcpTestHarness(defaultServer);
  const defaultSessionId = (await defaultHarness.initialize()).response.headers[MCP_HEADER_SESSION_ID][0];
  const keepalive = await defaultHarness.invoke({ method: "GET", sessionId: defaultSessionId });
  assert.equal(keepalive.response.status, 200);
  assert.equal(keepalive.body.toString("utf8"), ": keepalive\n\n");

  const streamStore = new MemoryMcpStreamStore({ idGenerator: sequenceIdGenerator(["stream-listener"]) });
  const server = createMcpServer("Listener MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-declined"]),
    streamStore,
    initialSessionListenerEnabled: false,
  });
  const harness = createMcpTestHarness(server);
  const sessionId = (await harness.initialize()).response.headers[MCP_HEADER_SESSION_ID][0];

  const declined = await harness.invoke({ method: "GET", sessionId });
  assert.equal(declined.response.status, 405);
  assert.deepEqual(declined.response.headers.allow, ["DELETE, GET, POST"]);
  assert.deepEqual(declined.response.headers["content-type"], ["application/json"]);
  assert.deepEqual(declined.bodyJson, { error: "method not allowed" });

  // The session stays usable over POST after the declined common stream.
  assert.equal((await harness.call(sessionId, "tools/list")).response.status, 200);

  // Validation order is unchanged: the 405 is not reachable without a valid session.
  assert.equal(
    (await harness.invoke({ method: "GET", sessionId, headers: { origin: ["https://evil.example"] } })).response.status,
    403,
  );
  assert.equal((await harness.invoke({ method: "GET" })).response.status, 400);
  assert.equal((await harness.invoke({ method: "GET", sessionId: "missing" })).response.status, 404);
  assert.equal(
    (await harness.invoke({ method: "GET", sessionId, protocolVersion: MCP_PROTOCOL_VERSION_LEGACY })).response.status,
    400,
  );

  // Last-Event-ID replay keeps working with the listener declined.
  const streamId = await streamStore.create(sessionId);
  const firstEventId = await streamStore.append(
    sessionId,
    streamId,
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
  );
  await streamStore.append(
    sessionId,
    streamId,
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { seq: 2 } })),
  );
  await streamStore.close(sessionId, streamId);
  const replay = await harness.invoke({ method: "GET", sessionId, lastEventId: firstEventId });
  assert.equal(replay.response.status, 200);
  assert.match(JSON.stringify(replay.sseFrames), /notifications\/progress/);

  // The stateless 2026-07-28 shape keeps its early Allow: POST rejection.
  const stateless = await harness.invoke({ method: "GET", protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28 });
  assert.equal(stateless.response.status, 405);
  assert.deepEqual(stateless.response.headers.allow, ["POST"]);

  assert.equal((await harness.invoke({ method: "DELETE", sessionId })).response.status, 202);
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
  // The task body runs inside the tools/call invocation, so the reply already
  // carries the terminal state.
  assert.equal(failed.result.task.status, "failed");
  // Generic handler errors are sanitized by default.
  assert.equal((await json(await post(server, rpc("failed-result", "tasks/result", { taskId: "task-2" }), headers))).error.message, "internal error");

  const noTasks = createMcpServer("No Tasks", "1", { idGenerator: sequenceIdGenerator(["sess-no-tasks"]) });
  noTasks.registry().registerTool({ name: "plain", inputSchema: {} }, () => ({ content: [textBlock("plain")] }));
  const noTasksInit = await initialize(noTasks);
  const noTasksHeaders = { [MCP_HEADER_SESSION_ID]: [noTasksInit.sessionId], [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION] };
  assert.equal((await json(await post(noTasks, rpc("task-disabled", "tools/call", { name: "plain", task: {} }), noTasksHeaders))).error.code, MCP_CODE_METHOD_NOT_FOUND);
});

test("mcp tools/call task augmentation is gated to the 2025-11-25 protocol", async () => {
  const taskStore = new MemoryMcpTaskStore({ now: () => new Date("2026-07-03T00:00:02Z") });
  const server = createMcpServer("Task Gate MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-1125", "task-1", "sess-618", "sess-326"]),
    taskRuntime: { store: taskStore, defaultTtlMs: 60000 },
  });
  server.registry().registerTool(
    { name: "task_echo", inputSchema: {}, execution: { taskSupport: "optional" } },
    (args) => ({ content: [textBlock(`echo ${args.message}`)] }),
  );

  const callTask = (sessionId, protocolVersion, id) =>
    post(
      server,
      rpc(id, "tools/call", { name: "task_echo", arguments: { message: "hi" }, task: {} }),
      { [MCP_HEADER_SESSION_ID]: [sessionId], [MCP_HEADER_PROTOCOL_VERSION]: [protocolVersion] },
    );

  const okInit = await initialize(server, "init-ok", MCP_PROTOCOL_VERSION);
  const ok = await json(await callTask(okInit.sessionId, MCP_PROTOCOL_VERSION, "ok"));
  assert.equal(ok.result.task.taskId, "task-1");
  assert.equal((await taskStore.list({ sessionId: okInit.sessionId })).tasks.length, 1);

  for (const protocolVersion of ["2025-06-18", "2025-03-26"]) {
    const init = await initialize(server, `init-${protocolVersion}`, protocolVersion);
    const denied = await json(await callTask(init.sessionId, protocolVersion, `denied-${protocolVersion}`));
    assert.equal(denied.error.code, MCP_CODE_METHOD_NOT_FOUND, protocolVersion);
    assert.equal(denied.error.message, "Method not found: tasks not enabled", protocolVersion);
    assert.deepEqual(await taskStore.list({ sessionId: init.sessionId }), { tasks: [] }, protocolVersion);
  }
});

test("dynamo task store enforces task expiry and deletes every session page", async () => {
  const db = fakeDb();
  const taskModel = defaultMcpTaskModel("unit-tasks-expiry");
  const writer = new DynamoMcpTaskStore(db, { model: taskModel, now: () => new Date("2026-07-03T00:00:05Z") });
  const created = await writer.create(taskRecord());
  assert.equal(created.task.status, "working");
  assert.equal(created.task.ttl, 60000);

  const stored = db.items.get(`${taskModel.name}:sess-1:task-1`);
  assert.equal(stored.expiresAt, Math.floor((Date.parse("2026-07-03T00:00:00Z") + 60000) / 1000));
  // A fresh task is returned normally and keeps its ttl duration.
  const fresh = await writer.get({ sessionId: "sess-1", taskId: "task-1" });
  assert.equal(fresh.task.taskId, "task-1");
  assert.equal(fresh.task.ttl, 60000);

  // Once `now` passes `expiresAt`, the record is never surfaced.
  const later = new DynamoMcpTaskStore(db, { model: taskModel, now: () => new Date("2026-07-03T01:00:00Z") });
  await assert.rejects(() => later.get({ sessionId: "sess-1", taskId: "task-1" }), McpTaskNotFoundError);
  assert.deepEqual(await later.list({ sessionId: "sess-1" }), { tasks: [] });

  const pageModel = defaultMcpTaskModel("unit-tasks-pages");
  const paged = new DynamoMcpTaskStore(db, { model: pageModel, now: () => new Date("2026-07-03T00:00:05Z") });
  for (let index = 0; index < 1200; index += 1) {
    await paged.create(
      taskRecord({
        task: {
          taskId: `task-${String(index).padStart(4, "0")}`,
          status: "working",
          createdAt: "2026-07-03T00:00:00Z",
          lastUpdatedAt: "2026-07-03T00:00:00Z",
          ttl: 60000,
          pollInterval: 100,
        },
      }),
    );
  }
  const firstPage = await paged.list({ sessionId: "sess-1", limit: 500 });
  assert.equal(firstPage.tasks.length, 500);
  assert.equal(firstPage.nextCursor, "500");
  await paged.deleteSession("sess-1");
  assert.deepEqual(await paged.list({ sessionId: "sess-1" }), { tasks: [] });
  assert.equal([...db.items.keys()].filter((key) => key.startsWith(`${pageModel.name}:sess-1:`)).length, 0);
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

test("dynamo-backed MCP stream store follows cursors for replay and deletion", async () => {
  const db = fakeDb();
  const streamModel = defaultMcpStreamModel("unit-streams-pages");
  const streams = new DynamoMcpStreamStore(db, {
    model: streamModel,
    idGenerator: sequenceIdGenerator(["stream-pages"]),
  });

  const streamId = await streams.create("sess-pages");
  let lastEventId = "";
  for (let index = 0; index < 1100; index += 1) {
    lastEventId = await streams.append("sess-pages", streamId, Buffer.from(`event-${index}`));
  }

  assert.equal(await streams.streamForEvent("sess-pages", lastEventId), streamId);
  const replayed = await streams.subscribe("sess-pages", streamId);
  assert.equal(replayed.length, 1100);
  assert.equal(Buffer.from(replayed.at(-1).data).toString(), "event-1099");

  await streams.deleteSession("sess-pages");
  const remaining = [...db.items.keys()].filter((key) =>
    key.startsWith(`${streamModel.name}:sess-pages:`),
  );
  assert.deepEqual(remaining, [`${streamModel.name}:sess-pages:!session`]);
  assert.equal(
    db.items.get(`${streamModel.name}:sess-pages:!session`).deleted,
    true,
  );
  await assert.rejects(
    () => streams.append("sess-pages", streamId, Buffer.from("late")),
    McpStreamNotFoundError,
  );
});

function authContext(options = {}) {
  const method = String(options.method ?? "POST").toUpperCase();
  let defaults = {};
  if (method === "POST") {
    defaults = POST_HEADERS;
  } else if (method === "GET") {
    defaults = { accept: ["text/event-stream"] };
  }
  const headers = { ...defaults, ...(options.headers ?? {}) };
  let body = Buffer.alloc(0);
  if (options.body !== undefined) {
    body = Buffer.from(typeof options.body === "string" ? options.body : JSON.stringify(options.body), "utf8");
  }
  return {
    request: { method, path: "/mcp", headers, query: {}, body, isBase64: false },
    authIdentity: String(options.identity ?? ""),
    tenantId: String(options.tenantId ?? ""),
    tenantBound: options.tenantBound === true,
    securePrincipal: () => options.principal ?? null,
    get: () => options.claims ?? null,
  };
}

function initializeBody(id = "init") {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION },
  };
}

test("mcp sessions are bound to the authenticated principal", async () => {
  const server = createMcpServer("Auth MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-auth"]),
  });
  server.registry().registerTool({ name: "ping", inputSchema: {} }, () => ({
    content: [textBlock("pong")],
  }));
  const handler = server.handler();

  const init = await handler(
    authContext({ identity: "alice", body: initializeBody() }),
  );
  assert.equal(init.status, 200);
  const sessionId = sessionHeader(init);
  assert.equal(sessionId, "sess-auth");
  const headers = {
    [MCP_HEADER_SESSION_ID]: [sessionId],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };

  const same = await json(
    await handler(authContext({ identity: "alice", body: rpc("same", "ping"), headers })),
  );
  assert.deepEqual(same.result, {});
  assert.equal(
    (await json(await handler(authContext({
      identity: "alice",
      body: rpc("call", "tools/call", { name: "ping" }),
      headers,
    })))).result.content[0].text,
    "pong",
  );

  const other = await handler(
    authContext({ identity: "bob", body: rpc("other", "ping"), headers }),
  );
  assert.equal(other.status, 404);
  assert.equal((await json(other)).error, "session not found");

  assert.equal(
    (await handler(authContext({ identity: "bob", method: "GET", headers }))).status,
    404,
  );
  assert.equal(
    (await handler(authContext({ identity: "alice", method: "GET", headers }))).status,
    200,
  );
  assert.equal(
    (await handler(authContext({ identity: "bob", method: "DELETE", headers }))).status,
    404,
  );
  assert.equal(
    (await handler(authContext({ identity: "alice", method: "DELETE", headers }))).status,
    202,
  );
  assert.equal(
    (await handler(authContext({ identity: "alice", body: rpc("gone", "ping"), headers }))).status,
    404,
  );
});

test("mcp sessions use secure principal and tenant-bound identity fallbacks", async () => {
  const server = createMcpServer("Auth Fallback MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-svc", "sess-tenant"]),
  });
  const handler = server.handler();

  const svcInit = await handler(
    authContext({
      principal: { identity: "svc-1", scopes: ["read"], claims: {}, kind: "service" },
      body: initializeBody("init-svc"),
    }),
  );
  const svcHeaders = {
    [MCP_HEADER_SESSION_ID]: [sessionHeader(svcInit)],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  assert.equal(
    (await handler(authContext({ identity: "svc-1", body: rpc("svc", "ping"), headers: svcHeaders }))).status,
    200,
  );
  assert.equal(
    (await handler(authContext({ identity: "svc-2", body: rpc("svc-other", "ping"), headers: svcHeaders }))).status,
    404,
  );

  const tenantInit = await handler(
    authContext({
      tenantId: "tenant-1",
      tenantBound: true,
      body: initializeBody("init-tenant"),
    }),
  );
  const tenantHeaders = {
    [MCP_HEADER_SESSION_ID]: [sessionHeader(tenantInit)],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  assert.equal(
    (await handler(authContext({ identity: "tenant-1", body: rpc("tenant", "ping"), headers: tenantHeaders }))).status,
    200,
  );
  assert.equal(
    (await handler(authContext({ identity: "tenant-2", body: rpc("tenant-other", "ping"), headers: tenantHeaders }))).status,
    404,
  );
});

test("mcp tool contexts carry authenticated caller identity", async () => {
  const server = createMcpServer("Auth Tool MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-ctx", "task-1", "sess-anon"]),
    taskRuntime: { store: new MemoryMcpTaskStore() },
  });
  server.registry().registerTool({ name: "whoami", inputSchema: {} }, (args, context) => ({
    content: [textBlock(JSON.stringify(context.auth ?? null))],
  }));
  server.registry().registerStreamingTool(
    { name: "stream-who", inputSchema: {} },
    (args, emit, context) => ({
      content: [textBlock(JSON.stringify(context.auth ?? null))],
    }),
  );
  server.registry().registerTool(
    { name: "task-who", inputSchema: {}, execution: { taskSupport: "optional" } },
    (args, context) => ({
      content: [textBlock(JSON.stringify(context.auth ?? null))],
    }),
  );
  const handler = server.handler();
  const principal = { identity: "alice", scopes: ["read", "write"], claims: {}, kind: "user" };
  const auth = {
    identity: "alice",
    tenantId: "tenant-1",
    tenantBound: true,
    principal,
  };
  const init = await handler(authContext({ ...auth, body: initializeBody() }));
  const headers = {
    [MCP_HEADER_SESSION_ID]: [sessionHeader(init)],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  const expected = {
    authIdentity: "alice",
    tenantId: "tenant-1",
    tenantBound: true,
    scopes: ["read", "write"],
  };

  const normal = await json(
    await handler(authContext({
      ...auth,
      body: rpc("normal", "tools/call", { name: "whoami" }),
      headers,
    })),
  );
  assert.deepEqual(JSON.parse(normal.result.content[0].text), expected);

  const streamed = await handler(authContext({
    ...auth,
    body: rpc("stream", "tools/call", { name: "stream-who" }),
    headers,
  }));
  const frames = parseMcpTestSSEFrames(Buffer.from(streamed.body));
  const streamResult = JSON.parse(frames.at(-1).data);
  assert.deepEqual(JSON.parse(streamResult.result.content[0].text), expected);

  const task = await json(
    await handler(authContext({
      ...auth,
      body: rpc("task", "tools/call", { name: "task-who", task: {} }),
      headers,
    })),
  );
  assert.equal(task.result.task.taskId, "task-1");
  const taskResult = await json(
    await handler(authContext({
      ...auth,
      body: rpc("task-result", "tasks/result", { taskId: "task-1" }),
      headers,
    })),
  );
  assert.deepEqual(JSON.parse(taskResult.result.content[0].text), expected);

  const anonInit = await server.serve({
    method: "POST",
    headers: POST_HEADERS,
    body: JSON.stringify(initializeBody("init-anon")),
  });
  const anonHeaders = {
    [MCP_HEADER_SESSION_ID]: [sessionHeader(anonInit)],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  const anon = await json(await server.serve({
    method: "POST",
    headers: { ...POST_HEADERS, ...anonHeaders },
    body: JSON.stringify(rpc("anon", "tools/call", { name: "whoami" })),
  }));
  assert.equal(anon.result.content[0].text, "null");
});

test("mcp memory stream store bounds events and rejects oversize payloads", async () => {
  const streams = new MemoryMcpStreamStore({
    idGenerator: sequenceIdGenerator(["stream-bounded"]),
    maxEventBytes: 4,
    maxEventsPerSession: 2,
    maxTotalBytesPerSession: 6,
  });
  await assert.rejects(
    () => streams.append("sess-bounded", "missing", Buffer.from("12345")),
    /stream event too large/,
  );
  const streamId = await streams.create("sess-bounded");
  await streams.append("sess-bounded", streamId, Buffer.from("aa"));
  await streams.append("sess-bounded", streamId, Buffer.from("bb"));
  const third = await streams.append("sess-bounded", streamId, Buffer.from("cc"));
  assert.deepEqual(
    (await streams.subscribe("sess-bounded", streamId)).map((event) => Buffer.from(event.data).toString()),
    ["bb", "cc"],
  );
  await assert.rejects(() => streams.streamForEvent("sess-bounded", "1"), McpEventNotFoundError);

  const bytes = new MemoryMcpStreamStore({
    idGenerator: sequenceIdGenerator(["stream-bytes"]),
    maxTotalBytesPerSession: 5,
  });
  const bytesStream = await bytes.create("sess-bytes");
  await bytes.append("sess-bytes", bytesStream, Buffer.from("aa"));
  await bytes.append("sess-bytes", bytesStream, Buffer.from("bb"));
  await bytes.append("sess-bytes", bytesStream, Buffer.from("ccc"));
  assert.deepEqual(
    (await bytes.subscribe("sess-bytes", bytesStream)).map((event) => Buffer.from(event.data).toString()),
    ["bb", "ccc"],
  );
  assert.equal(third, "3");
});

test("mcp memory task store caps tasks per session", async () => {
  const tasks = new MemoryMcpTaskStore({
    now: () => new Date("2026-07-03T00:00:02Z"),
    maxTasksPerSession: 2,
  });
  const first = await tasks.create(taskRecord());
  await tasks.create(
    taskRecord({ task: { ...taskRecord().task, taskId: "task-2", createdAt: "2026-07-03T00:00:01Z" } }),
  );
  await assert.rejects(
    () => tasks.create(taskRecord({ task: { ...taskRecord().task, taskId: "task-3" } })),
    /Task capacity exceeded/,
  );
  await tasks.update({
    ...first,
    task: { ...first.task, status: "completed", lastUpdatedAt: "2026-07-03T00:00:02Z" },
  });
  await tasks.create(taskRecord({ task: { ...taskRecord().task, taskId: "task-3" } }));
  assert.equal((await tasks.get({ sessionId: "sess-1", taskId: "task-3" })).task.taskId, "task-3");
  await assert.rejects(() => tasks.get({ sessionId: "sess-1", taskId: "task-1" }), McpTaskNotFoundError);

  const reaping = new MemoryMcpTaskStore({
    now: () => new Date("2026-07-03T00:01:00Z"),
    maxTasksPerSession: 1,
  });
  await reaping.create(
    taskRecord({ task: { ...taskRecord().task, taskId: "expired", ttl: 1000 } }),
  );
  await reaping.create(
    taskRecord({ task: { ...taskRecord().task, taskId: "fresh", ttl: 600000 } }),
  );
  assert.equal((await reaping.get({ sessionId: "sess-1", taskId: "fresh" })).task.taskId, "fresh");
  await assert.rejects(() => reaping.get({ sessionId: "sess-1", taskId: "expired" }), McpTaskNotFoundError);
});

test("dynamo stream store writes ttl and hides expired records", async () => {
  const db = fakeDb();
  const streamModel = defaultMcpStreamModel("unit-streams-ttl");
  const now = new Date("2026-07-03T00:00:00Z");
  const streams = new DynamoMcpStreamStore(db, {
    model: streamModel,
    idGenerator: sequenceIdGenerator(["stream-ttl"]),
    now: () => now,
    streamTtlMinutes: 10,
    maxEventBytes: 4,
  });
  const streamId = await streams.create("sess-ttl");
  const expectedExpiry = Math.floor((now.getTime() + 10 * 60 * 1000) / 1000);
  assert.equal(
    db.items.get(`${streamModel.name}:sess-ttl:STREAM#${streamId}`).expiresAt,
    expectedExpiry,
  );
  await streams.append("sess-ttl", streamId, Buffer.from("one"));
  const event = db.items.get(`${streamModel.name}:sess-ttl:EVENT#1`);
  assert.equal(event.expiresAt, expectedExpiry);
  assert.equal(db.items.get(`${streamModel.name}:sess-ttl:STREAM#${streamId}`).expiresAt, expectedExpiry);
  await assert.rejects(
    () => streams.append("sess-ttl", streamId, Buffer.from("12345")),
    /stream event too large/,
  );

  const later = new DynamoMcpStreamStore(db, {
    model: streamModel,
    now: () => new Date("2026-07-03T00:11:00Z"),
  });
  await assert.rejects(
    () => later.subscribe("sess-ttl", streamId),
    McpStreamNotFoundError,
  );
  await assert.rejects(
    () => later.streamForEvent("sess-ttl", "1"),
    McpEventNotFoundError,
  );
  await assert.rejects(
    () => later.append("sess-ttl", streamId, Buffer.from("two")),
    McpStreamNotFoundError,
  );
});

test("mcp handler errors are sanitized unless verboseHandlerErrors is enabled", async () => {
  const build = (options = {}) => {
    const server = createMcpServer("Error MCP", "1", {
      idGenerator: sequenceIdGenerator(["sess-error"]),
      ...options,
    });
    server.registry().registerTool({ name: "fails", inputSchema: {} }, () => {
      throw new Error("boom");
    });
    server.resources().registerResource({ uri: "file:///boom", name: "boom" }, () => {
      throw new Error("boom");
    });
    server.prompts().registerPrompt({ name: "boom" }, () => {
      throw new Error("boom");
    });
    return server;
  };

  for (const [verbose, expected] of [[false, "internal error"], [true, "boom"]]) {
    const server = build(verbose ? { verboseHandlerErrors: true } : {});
    const init = await initialize(server);
    const headers = {
      [MCP_HEADER_SESSION_ID]: [init.sessionId],
      [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
    };
    assert.equal(
      (await json(await post(server, rpc("tool", "tools/call", { name: "fails" }), headers))).error.message,
      expected,
    );
    assert.equal(
      (await json(await post(server, rpc("resource", "resources/read", { uri: "file:///boom" }), headers))).error.message,
      expected,
    );
    assert.equal(
      (await json(await post(server, rpc("prompt", "prompts/get", { name: "boom" }), headers))).error.message,
      expected,
    );
    assert.match(
      JSON.stringify(await json(await post(server, rpc("missing", "resources/read", { uri: "file:///missing" }), headers))),
      /resource not found/,
    );
  }
});

test("mcp task store errors are redacted unless verboseHandlerErrors is enabled", async () => {
  const secret = "task store secret detail";
  for (const [verbose, expected] of [[false, "internal error"], [true, secret]]) {
    const store = new MemoryMcpTaskStore();
    store.get = async () => {
      throw new Error(secret);
    };
    const server = createMcpServer("Task Store Error MCP", "1", {
      idGenerator: sequenceIdGenerator([`sess-task-store-${verbose}`]),
      taskRuntime: { store, defaultTtlMs: 60000 },
      ...(verbose ? { verboseHandlerErrors: true } : {}),
    });
    server.registry().registerTool(
      { name: "task_tool", inputSchema: {}, execution: { taskSupport: "optional" } },
      () => ({ content: [textBlock("ok")] }),
    );
    const init = await initialize(server);
    const headers = {
      [MCP_HEADER_SESSION_ID]: [init.sessionId],
      [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
    };
    const resp = await json(
      await post(server, rpc("store-error", "tasks/get", { taskId: "task-1" }), headers),
    );
    assert.equal(resp.error.code, MCP_CODE_SERVER_ERROR);
    assert.equal(resp.error.message, expected);
  }
});

test("mcp task store errors preserve control messages", async () => {
  const store = new MemoryMcpTaskStore();
  store.get = async () => {
    throw new Error("task capacity exceeded");
  };
  const server = createMcpServer("Task Store Control MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-task-store-control"]),
    taskRuntime: { store, defaultTtlMs: 60000 },
  });
  server.registry().registerTool(
    { name: "task_tool", inputSchema: {}, execution: { taskSupport: "optional" } },
    () => ({ content: [textBlock("ok")] }),
  );
  const init = await initialize(server);
  const headers = {
    [MCP_HEADER_SESSION_ID]: [init.sessionId],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  const resp = await json(
    await post(server, rpc("store-control", "tasks/get", { taskId: "task-1" }), headers),
  );
  assert.equal(resp.error.code, MCP_CODE_SERVER_ERROR);
  assert.equal(resp.error.message, "task capacity exceeded");
});

test("mcp tasks/result redacts stored task errors unless verboseHandlerErrors is enabled", async () => {
  const secret = "db DSN postgres://user:secret@host/app: boom";
  for (const [verbose, expected] of [[false, "internal error"], [true, secret]]) {
    const now = new Date("2026-07-03T00:00:02Z");
    const store = new MemoryMcpTaskStore({ now: () => now });
    const server = createMcpServer("Task Result Error MCP", "1", {
      idGenerator: sequenceIdGenerator([`sess-task-result-${verbose}`]),
      taskRuntime: { store, defaultTtlMs: 600000 },
      ...(verbose ? { verboseHandlerErrors: true } : {}),
    });
    server.registry().registerTool(
      { name: "task_tool", inputSchema: {}, execution: { taskSupport: "optional" } },
      () => ({ content: [textBlock("ok")] }),
    );
    const init = await initialize(server);
    const headers = {
      [MCP_HEADER_SESSION_ID]: [init.sessionId],
      [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
    };
    await store.create({
      sessionId: init.sessionId,
      method: "tools/call",
      toolName: "leaky",
      task: {
        taskId: "task-stored",
        status: "failed",
        createdAt: "2026-07-03T00:00:00Z",
        lastUpdatedAt: "2026-07-03T00:00:00Z",
        ttl: 600000,
      },
      error: { code: MCP_CODE_SERVER_ERROR, message: secret },
    });
    const resp = await json(
      await post(server, rpc("stored-error", "tasks/result", { taskId: "task-stored" }), headers),
    );
    assert.equal(resp.error.code, MCP_CODE_SERVER_ERROR);
    assert.equal(resp.error.message, expected);
  }
});

test("mcp tasks/result preserves stored control errors", async () => {
  const now = new Date("2026-07-03T00:00:02Z");
  const store = new MemoryMcpTaskStore({ now: () => now });
  const server = createMcpServer("Task Result Control MCP", "1", {
    idGenerator: sequenceIdGenerator(["sess-task-result-control"]),
    taskRuntime: { store, defaultTtlMs: 600000 },
  });
  server.registry().registerTool(
    { name: "task_tool", inputSchema: {}, execution: { taskSupport: "optional" } },
    () => ({ content: [textBlock("ok")] }),
  );
  const init = await initialize(server);
  const headers = {
    [MCP_HEADER_SESSION_ID]: [init.sessionId],
    [MCP_HEADER_PROTOCOL_VERSION]: [MCP_PROTOCOL_VERSION],
  };
  await store.create({
    sessionId: init.sessionId,
    method: "tools/call",
    toolName: "cancelled",
    task: {
      taskId: "task-canceled",
      status: "canceled",
      createdAt: "2026-07-03T00:00:00Z",
      lastUpdatedAt: "2026-07-03T00:00:00Z",
      ttl: 600000,
    },
    error: { code: MCP_CODE_SERVER_ERROR, message: "task canceled" },
  });
  const resp = await json(
    await post(server, rpc("stored-cancel", "tasks/result", { taskId: "task-canceled" }), headers),
  );
  assert.equal(resp.error.code, MCP_CODE_SERVER_ERROR);
  assert.equal(resp.error.message, "task canceled");
});

const M3_STATE_BOUNDS_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/conformance/state-bounds-conformance.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("M3 shared state-bounds fixture pins required limits and cases", () => {
  assert.equal(M3_STATE_BOUNDS_FIXTURE.contract.id, "m3.mcp-state-bounds/v1");
  assert.equal(M3_STATE_BOUNDS_FIXTURE.limits.memory_sessions_per_store, 1000);
  assert.equal(
    M3_STATE_BOUNDS_FIXTURE.limits.durable_aggregate_events_per_session,
    10000,
  );
  assert.equal(
    M3_STATE_BOUNDS_FIXTURE.limits.durable_aggregate_bytes_per_session,
    64 * 1024 * 1024,
  );
  assert.equal(
    M3_STATE_BOUNDS_FIXTURE.errors.session_capacity.message,
    "Session capacity exceeded",
  );
  assert.equal(
    M3_STATE_BOUNDS_FIXTURE.errors.session_capacity.jsonrpc_code,
    -32000,
  );
  assert.equal(M3_STATE_BOUNDS_FIXTURE.errors.session_capacity.http_status, 200);
  assert.equal(
    M3_STATE_BOUNDS_FIXTURE.errors.session_capacity.session_header,
    false,
  );
  const ids = new Set(M3_STATE_BOUNDS_FIXTURE.cases.map((item) => item.id));
  for (const id of [
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
  ]) {
    assert.equal(ids.has(id), true, `fixture must carry ${id}`);
  }
});

test("M3 memory session store enforces capacity, expiry, and same-ID refresh", async () => {
  let now = new Date(10_000);
  const store = new MemoryMcpSessionStore({
    now: () => now,
    maxSessions: 2,
  });
  await store.put({ id: "one", createdAt: "", expiresAt: new Date(70_000).toISOString() });
  await store.put({ id: "two", createdAt: "", expiresAt: new Date(70_000).toISOString() });
  await assert.rejects(
    () =>
      store.put({
        id: "three",
        createdAt: "",
        expiresAt: new Date(70_000).toISOString(),
      }),
    McpSessionCapacityError,
  );
  await store.get("one");
  await store.get("two");
  await assert.rejects(() => store.get("three"), McpSessionNotFoundError);

  await store.put({
    id: "one",
    createdAt: "",
    expiresAt: new Date(70_000).toISOString(),
    data: { refreshed: "true" },
  });

  now = new Date(80_000);
  const expired = await store.putAndCollectExpired({
    id: "four",
    createdAt: "",
    expiresAt: new Date(140_000).toISOString(),
  });
  assert.deepEqual(expired.sort(), ["one", "two"]);
  await assert.rejects(
    () =>
      store.put({
        id: "stale",
        createdAt: "",
        expiresAt: new Date(79_000).toISOString(),
      }),
    /session expired/,
  );
});

test("M3 initialize capacity refusal maps to CodeServerError without a session header", async () => {
  const sessionStore = new MemoryMcpSessionStore({ maxSessions: 1 });
  await sessionStore.put({
    id: "occupied",
    createdAt: "",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const server = createMcpServer("M3", "1", { sessionStore });
  const response = await post(server, rpc("init", "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers["mcp-session-id"], undefined);
  const body = await json(response);
  assert.equal(body.error.code, MCP_CODE_SERVER_ERROR);
  assert.equal(body.error.message, "Session capacity exceeded");
});

function m3StreamDb() {
  return fakeDb();
}

test("M3 dynamo aggregate enforces count, bytes, spill, and pre-aggregate refusal", async () => {
  const db = m3StreamDb();
  const model = defaultMcpStreamModel("m3-streams");
  const spill = {
    objects: new Map(),
    async put(key, data) {
      this.objects.set(key, Buffer.from(data));
    },
    async get(key) {
      const value = this.objects.get(key);
      if (!value) throw new Error("missing spill object");
      return value;
    },
    async delete(key) {
      this.objects.delete(key);
    },
  };
  const store = new DynamoMcpStreamStore(db, {
    model,
    idGenerator: sequenceIdGenerator(["stream-count"]),
    maxAggregateEvents: 3,
    maxAggregateBytes: 24,
    inlineMaxBytes: 4,
    spillStore: spill,
  });
  const streamId = await store.create("sess-count");
  const payload = Buffer.from("0123456789");
  assert.equal(await store.append("sess-count", streamId, payload), "1");
  assert.equal(await store.append("sess-count", streamId, payload), "2");
  await assert.rejects(
    () => store.append("sess-count", streamId, payload),
    McpStreamAggregateCapacityError,
  );
  assert.equal(spill.objects.size, 2);

  const stateKey = `${model.name}:sess-count:!session`;
  const state = db.items.get(stateKey);
  delete state.aggregateVersion;
  db.items.set(stateKey, state);
  await assert.rejects(
    () => store.append("sess-count", streamId, Buffer.from("z")),
    McpStreamAggregateBackfillError,
  );
});

test("M3 dynamo append requires a transaction and cleans refused spills", async () => {
  const db = m3StreamDb();
  const noTx = { ...db, transactWrite: undefined };
  const model = defaultMcpStreamModel("m3-no-tx");
  const store = new DynamoMcpStreamStore(noTx, {
    model,
    idGenerator: sequenceIdGenerator(["stream-no-tx"]),
  });
  const streamId = await store.create("sess-no-tx");
  await assert.rejects(
    () => store.append("sess-no-tx", streamId, Buffer.from("x")),
    McpStreamTransactionRequiredError,
  );

  const spill = {
    objects: new Map(),
    async put(key, data) {
      this.objects.set(key, Buffer.from(data));
    },
    async get() {
      throw new Error("unused");
    },
    async delete(key) {
      this.objects.delete(key);
    },
  };
  const txDb = m3StreamDb();
  const txModel = defaultMcpStreamModel("m3-refusal");
  const txStore = new DynamoMcpStreamStore(txDb, {
    model: txModel,
    idGenerator: sequenceIdGenerator(["stream-refusal"]),
    inlineMaxBytes: 4,
    spillStore: spill,
    appendRetries: 1,
  });
  const txStream = await txStore.create("sess-refusal");
  const original = txDb.transactWrite;
  txDb.transactWrite = async (actions) => {
    const stateKey = `${txModel.name}:sess-refusal:!session`;
    const state = txDb.items.get(stateKey);
    state.deleted = true;
    txDb.items.set(stateKey, state);
    return original(actions);
  };
  await assert.rejects(
    () => txStore.append("sess-refusal", txStream, Buffer.from("0123456789")),
    McpStreamNotFoundError,
  );
  assert.equal(spill.objects.size, 0);
});

test("M3 dynamo concurrent appends never overshoot the aggregate", async () => {
  const db = m3StreamDb();
  const model = defaultMcpStreamModel("m3-race");
  const store = new DynamoMcpStreamStore(db, {
    model,
    idGenerator: sequenceIdGenerator(["stream-race"]),
    maxAggregateEvents: 1,
    appendRetries: 16,
  });
  const streamId = await store.create("sess-race");
  const results = await Promise.allSettled([
    store.append("sess-race", streamId, Buffer.from("a")),
    store.append("sess-race", streamId, Buffer.from("b")),
  ]);
  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof McpStreamAggregateCapacityError);
  const state = db.items.get(`${model.name}:sess-race:!session`);
  assert.equal(state.eventCount, 1);
});

