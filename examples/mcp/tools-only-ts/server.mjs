import { createApp, createMcpServer } from "../../../ts/dist/index.js";

export function createToolsOnlyMcpServer(options = {}) {
  const server = createMcpServer("ToolsOnlyTS", "example", options);

  server.registry().registerTool(
    {
      name: "echo",
      description: "Echo text back to the caller",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    (args) => {
      const payload = args && typeof args === "object" ? args : {};
      const message = String(payload.message ?? "").trim();
      if (!message) {
        throw new Error("missing message");
      }
      return { content: [{ type: "text", text: message }] };
    },
  );

  return server;
}

export function createToolsOnlyApp(options = {}) {
  const app = createApp(options.appOptions ?? {});
  const handler = createToolsOnlyMcpServer(options.serverOptions ?? {}).handler();
  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);
  return app;
}
