import assert from "node:assert/strict";

import {
  createMcpTestHarness,
  sequenceIdGenerator,
} from "../../../ts/dist/index.js";

import { createToolsOnlyMcpServer } from "./server.mjs";

const server = createToolsOnlyMcpServer({
  idGenerator: sequenceIdGenerator(["sess-example"], "sess"),
});
const harness = createMcpTestHarness(server);

const init = await harness.initialize({ id: "init" });
assert.equal(init.response.status, 200);
assert.equal(init.response.headers["mcp-session-id"]?.[0], "sess-example");
assert.deepEqual(init.bodyJson.result.capabilities, { tools: {} });

const sessionId = init.response.headers["mcp-session-id"][0];
const call = await harness.call(
  sessionId,
  "tools/call",
  { name: "echo", arguments: { message: "hello TypeScript MCP" } },
  "call",
);
assert.equal(call.response.status, 200);
assert.deepEqual(call.bodyJson.result, {
  content: [{ type: "text", text: "hello TypeScript MCP" }],
});
