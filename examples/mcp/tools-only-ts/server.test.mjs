import assert from "node:assert/strict";

import {
  buildAPIGatewayV2Request,
  createMcpTestHarness,
  sequenceIdGenerator,
} from "../../../ts/dist/index.js";

import { createToolsOnlyMcpServer, handler } from "./server.mjs";

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

// Exercise the exported Lambda entry with a testkit-built API Gateway v2 event.
const lambdaEvent = buildAPIGatewayV2Request("POST", "/mcp", {
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
});
const lambdaResponse = await handler(lambdaEvent, {});
assert.equal(lambdaResponse.statusCode, 200);
assert.ok(lambdaResponse.headers["mcp-session-id"]?.[0], "expected an MCP session id");
assert.equal(JSON.parse(lambdaResponse.body).jsonrpc, "2.0");

console.log("examples/mcp/tools-only-ts/server.test.mjs: PASS");
