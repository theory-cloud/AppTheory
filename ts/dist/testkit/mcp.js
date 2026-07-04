import { Buffer } from "node:buffer";
import { createApp } from "../app.js";
import { ManualIdGenerator } from "../ids.js";
import { MCP_HEADER_LAST_EVENT_ID, MCP_HEADER_PROTOCOL_VERSION, MCP_HEADER_SESSION_ID, MCP_PROTOCOL_VERSION, } from "../mcp/index.js";
export class McpTestHarness {
    app;
    server;
    path;
    constructor(server, options = {}) {
        this.server = server;
        this.path = normalizeMcpPath(options.path);
        this.app = createApp({
            ids: options.appIdGenerator ?? fixedIdGenerator("req_mcp_test"),
        });
        const handler = server.handler();
        this.app.post(this.path, handler);
        this.app.get(this.path, handler);
        this.app.delete(this.path, handler);
    }
    async invoke(options = {}) {
        const response = await this.app.serve(this.request(options));
        const body = await responseBodyBytes(response);
        const result = {
            response,
            body,
            sseFrames: parseMcpTestSSEFrames(body),
        };
        if (hasJsonResponse(response) && body.length > 0) {
            result.bodyJson = JSON.parse(body.toString("utf8"));
        }
        return result;
    }
    async initialize(options = {}) {
        return this.invoke({
            bodyJson: {
                jsonrpc: "2.0",
                id: options.id ?? "init",
                method: "initialize",
                params: {
                    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
                },
            },
        });
    }
    async call(sessionId, method, params = {}, id = "call") {
        return this.invoke({
            sessionId,
            bodyJson: { jsonrpc: "2.0", id, method, params },
        });
    }
    request(options = {}) {
        const method = String(options.method ?? "POST").toUpperCase();
        const headers = canonicalHeaders(options.headers ?? {});
        if (method === "POST") {
            setDefaultHeader(headers, "content-type", "application/json");
            setDefaultHeader(headers, "accept", "application/json, text/event-stream");
        }
        if (method === "GET") {
            setDefaultHeader(headers, "accept", "text/event-stream");
        }
        if (options.sessionId) {
            headers[MCP_HEADER_SESSION_ID] = [String(options.sessionId)];
        }
        headers[MCP_HEADER_PROTOCOL_VERSION] = [
            String(options.protocolVersion ?? MCP_PROTOCOL_VERSION),
        ];
        if (options.lastEventId) {
            headers[MCP_HEADER_LAST_EVENT_ID] = [String(options.lastEventId)];
        }
        let body = Buffer.alloc(0);
        if (options.bodyJson !== undefined) {
            body = Buffer.from(JSON.stringify(options.bodyJson), "utf8");
        }
        else if (options.body !== undefined) {
            body = Buffer.isBuffer(options.body)
                ? Buffer.from(options.body)
                : Buffer.from(String(options.body), "utf8");
        }
        return {
            method,
            path: normalizeMcpPath(options.path ?? this.path),
            headers,
            query: {},
            body,
            isBase64: false,
        };
    }
}
export function createMcpTestHarness(server, options = {}) {
    return new McpTestHarness(server, options);
}
export function fixedIdGenerator(id) {
    return { newId: () => String(id) };
}
export function sequenceIdGenerator(ids, fallbackPrefix = "mcp-id") {
    const generator = new ManualIdGenerator({ prefix: fallbackPrefix });
    generator.queue(...ids);
    return generator;
}
function normalizeMcpPath(path) {
    const value = String(path ?? "/mcp").trim();
    if (!value) {
        return "/mcp";
    }
    return value.startsWith("/") ? value : `/${value}`;
}
function canonicalHeaders(headers) {
    const out = {};
    for (const [key, values] of Object.entries(headers ?? {})) {
        const normalized = String(key ?? "")
            .trim()
            .toLowerCase();
        if (!normalized) {
            continue;
        }
        out[normalized] = Array.isArray(values)
            ? values.map((value) => String(value))
            : [String(values)];
    }
    return out;
}
function setDefaultHeader(headers, key, value) {
    const normalized = key.toLowerCase();
    if (!headers[normalized] || headers[normalized].length === 0) {
        headers[normalized] = [value];
    }
}
async function responseBodyBytes(response) {
    const buffers = [];
    if (response.body) {
        buffers.push(Buffer.from(response.body));
    }
    if (response.bodyStream) {
        for await (const chunk of response.bodyStream) {
            buffers.push(Buffer.from(chunk));
        }
    }
    return Buffer.concat(buffers);
}
function hasJsonResponse(response) {
    for (const value of response.headers?.["content-type"] ?? []) {
        if (String(value).toLowerCase().startsWith("application/json")) {
            return true;
        }
    }
    return false;
}
export function parseMcpTestSSEFrames(body) {
    const text = Buffer.from(body).toString("utf8");
    if (!text.includes("data: ") && !text.includes("id: ")) {
        return [];
    }
    const frames = [];
    for (const rawChunk of text.split("\n\n")) {
        const chunk = rawChunk.replace(/^\n+|\n+$/g, "");
        if (!chunk.trim()) {
            continue;
        }
        const frame = { id: "", data: "" };
        const dataLines = [];
        for (const line of chunk.split("\n")) {
            if (line.startsWith(":")) {
                continue;
            }
            if (line.startsWith("id: ")) {
                frame.id = line.slice(4).trim();
            }
            else if (line.startsWith("event: ")) {
                frame.event = line.slice(7).trim();
            }
            else if (line.startsWith("data: ")) {
                dataLines.push(line.slice(6));
            }
        }
        frame.data = dataLines.join("\n");
        frames.push(frame);
    }
    return frames;
}
//# sourceMappingURL=mcp.js.map