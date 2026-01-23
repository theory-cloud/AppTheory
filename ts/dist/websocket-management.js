import { ApiGatewayManagementApiClient, DeleteConnectionCommand, GetConnectionCommand, PostToConnectionCommand, } from "@aws-sdk/client-apigatewaymanagementapi";
import { toBuffer } from "./internal/http.js";
function isAwsCredentials(value) {
    if (!value || typeof value !== "object")
        return false;
    const rec = value;
    return (typeof rec["accessKeyId"] === "string" &&
        typeof rec["secretAccessKey"] === "string");
}
function awsStatusCode(err) {
    if (!err || typeof err !== "object")
        return null;
    const rec = err;
    const meta = rec["$metadata"];
    if (!meta || typeof meta !== "object")
        return null;
    const code = meta["httpStatusCode"];
    return typeof code === "number" ? code : null;
}
function errorMessage(err) {
    if (!err)
        return "";
    if (err instanceof Error)
        return err.message;
    if (typeof err === "object" && "message" in err) {
        return String(err["message"] ?? "");
    }
    return String(err);
}
function inferRegionFromDomainName(domainName) {
    const host = String(domainName ?? "")
        .trim()
        .toLowerCase();
    const m = host.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/);
    return m ? (m[1] ?? "") : "";
}
function normalizeWebSocketManagementEndpoint(endpoint) {
    const value = String(endpoint ?? "").trim();
    if (!value)
        return "";
    if (value.startsWith("wss://"))
        return `https://${value.slice("wss://".length)}`;
    if (value.startsWith("ws://"))
        return `http://${value.slice("ws://".length)}`;
    if (value.startsWith("https://") || value.startsWith("http://"))
        return value;
    return `https://${value}`;
}
export class WebSocketManagementClient {
    endpoint;
    region;
    _client;
    constructor(options = {}) {
        this.endpoint = normalizeWebSocketManagementEndpoint(options.endpoint);
        if (!this.endpoint) {
            throw new Error("apptheory: websocket management endpoint is empty");
        }
        const host = new URL(this.endpoint).host;
        this.region =
            String(options.region ?? "").trim() ||
                String(process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "").trim() ||
                inferRegionFromDomainName(host);
        if (!this.region) {
            throw new Error("apptheory: aws region is empty");
        }
        const credentials = isAwsCredentials(options.credentials)
            ? options.credentials
            : undefined;
        this._client =
            options.client ??
                new ApiGatewayManagementApiClient({
                    endpoint: this.endpoint,
                    region: this.region,
                    ...(credentials ? { credentials } : {}),
                });
    }
    async postToConnection(connectionId, data) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        const body = toBuffer(data);
        try {
            await this._client.send(new PostToConnectionCommand({
                ConnectionId: id,
                Data: body,
            }));
        }
        catch (err) {
            const status = awsStatusCode(err);
            const suffix = [status ? `(${status})` : "", errorMessage(err)]
                .map((s) => s.trim())
                .filter(Boolean)
                .join(" ");
            throw new Error(`apptheory: post_to_connection failed ${suffix}`.trim());
        }
    }
    async getConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        try {
            const resp = await this._client.send(new GetConnectionCommand({ ConnectionId: id }));
            const { $metadata: _metadata, ...rest } = resp;
            return rest;
        }
        catch (err) {
            const status = awsStatusCode(err);
            const suffix = [status ? `(${status})` : "", errorMessage(err)]
                .map((s) => s.trim())
                .filter(Boolean)
                .join(" ");
            throw new Error(`apptheory: get_connection failed ${suffix}`.trim());
        }
    }
    async deleteConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        try {
            await this._client.send(new DeleteConnectionCommand({ ConnectionId: id }));
        }
        catch (err) {
            const status = awsStatusCode(err);
            const suffix = [status ? `(${status})` : "", errorMessage(err)]
                .map((s) => s.trim())
                .filter(Boolean)
                .join(" ");
            throw new Error(`apptheory: delete_connection failed ${suffix}`.trim());
        }
    }
}
export class FakeWebSocketManagementClient {
    endpoint;
    calls;
    connections;
    postError;
    getError;
    deleteError;
    constructor(options = {}) {
        this.endpoint = String(options.endpoint ?? "").trim();
        this.calls = [];
        this.connections = new Map();
        this.postError = null;
        this.getError = null;
        this.deleteError = null;
    }
    async postToConnection(connectionId, data) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({
            op: "post_to_connection",
            connectionId: id,
            data: toBuffer(data),
        });
        if (this.postError)
            throw this.postError;
    }
    async getConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({ op: "get_connection", connectionId: id, data: null });
        if (this.getError)
            throw this.getError;
        if (!this.connections.has(id))
            throw new Error("apptheory: connection not found");
        return this.connections.get(id);
    }
    async deleteConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({ op: "delete_connection", connectionId: id, data: null });
        if (this.deleteError)
            throw this.deleteError;
        this.connections.delete(id);
    }
}
