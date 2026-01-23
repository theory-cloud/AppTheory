import { Buffer } from "node:buffer";
import { RealClock } from "./clock.js";
import { AppError } from "./errors.js";
import { RandomIdGenerator } from "./ids.js";
import { toBuffer } from "./internal/http.js";
import { hasJSONContentType } from "./internal/response.js";
export class Context {
    ctx;
    request;
    params;
    requestId;
    tenantId;
    authIdentity;
    remainingMs;
    middlewareTrace;
    _clock;
    _ids;
    _webSocket;
    _values;
    constructor(options) {
        this.ctx = options.ctx ?? null;
        this.request = options.request;
        this.params = options.params ?? {};
        this._clock = options.clock ?? new RealClock();
        this._ids = options.ids ?? new RandomIdGenerator();
        this.requestId = options.requestId ?? "";
        this.tenantId = options.tenantId ?? "";
        this.authIdentity = options.authIdentity ?? "";
        this.remainingMs = Number(options.remainingMs ?? 0);
        this.middlewareTrace = Array.isArray(options.middlewareTrace)
            ? options.middlewareTrace
            : [];
        this._webSocket = options.webSocket ?? null;
        this._values = new Map();
    }
    now() {
        return this._clock.now();
    }
    newId() {
        return this._ids.newId();
    }
    param(name) {
        return this.params[String(name)] ?? "";
    }
    set(key, value) {
        const k = String(key ?? "").trim();
        if (!k)
            return;
        this._values.set(k, value);
    }
    get(key) {
        const k = String(key ?? "").trim();
        if (!k)
            return undefined;
        return this._values.get(k);
    }
    jsonValue() {
        if (!hasJSONContentType(this.request.headers)) {
            throw new AppError("app.bad_request", "invalid json");
        }
        if (this.request.body.length === 0) {
            return null;
        }
        try {
            return JSON.parse(Buffer.from(this.request.body).toString("utf8"));
        }
        catch {
            throw new AppError("app.bad_request", "invalid json");
        }
    }
    asWebSocket() {
        return this._webSocket;
    }
}
export class EventContext {
    ctx;
    requestId;
    remainingMs;
    _clock;
    _ids;
    _values;
    constructor(options) {
        this.ctx = options.ctx ?? null;
        this._clock = options.clock ?? new RealClock();
        this._ids = options.ids ?? new RandomIdGenerator();
        this.requestId = options.requestId ?? "";
        this.remainingMs = Number(options.remainingMs ?? 0);
        this._values = new Map();
    }
    now() {
        return this._clock.now();
    }
    newId() {
        return this._ids.newId();
    }
    set(key, value) {
        const k = String(key ?? "").trim();
        if (!k)
            return;
        this._values.set(k, value);
    }
    get(key) {
        const k = String(key ?? "").trim();
        if (!k)
            return undefined;
        return this._values.get(k);
    }
}
export class WebSocketContext {
    ctx;
    requestId;
    remainingMs;
    connectionId;
    routeKey;
    domainName;
    stage;
    eventType;
    managementEndpoint;
    body;
    _clock;
    _ids;
    _clientFactory;
    _client;
    _clientError;
    constructor(options) {
        this.ctx = options.ctx ?? null;
        this._clock = options.clock ?? new RealClock();
        this._ids = options.ids ?? new RandomIdGenerator();
        this.requestId = options.requestId ?? "";
        this.remainingMs = Number(options.remainingMs ?? 0);
        this.connectionId = String(options.connectionId ?? "").trim();
        this.routeKey = String(options.routeKey ?? "").trim();
        this.domainName = String(options.domainName ?? "").trim();
        this.stage = String(options.stage ?? "").trim();
        this.eventType = String(options.eventType ?? "").trim();
        this.managementEndpoint = String(options.managementEndpoint ?? "").trim();
        this.body = toBuffer(options.body);
        this._clientFactory =
            typeof options.clientFactory === "function"
                ? options.clientFactory
                : null;
        this._client = null;
        this._clientError = null;
    }
    now() {
        return this._clock.now();
    }
    newId() {
        return this._ids.newId();
    }
    async _managementClient() {
        if (this._client || this._clientError) {
            if (this._clientError)
                throw this._clientError;
            return this._client;
        }
        if (!this._clientFactory) {
            this._clientError = new Error("apptheory: missing websocket client factory");
            throw this._clientError;
        }
        const client = await this._clientFactory(this.managementEndpoint, this.ctx);
        if (!client) {
            this._clientError = new Error("apptheory: websocket client factory returned null");
            throw this._clientError;
        }
        this._client = client;
        return client;
    }
    async sendMessage(data) {
        const id = String(this.connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        const client = await this._managementClient();
        if (typeof client.postToConnection !== "function") {
            throw new Error("apptheory: websocket client missing postToConnection");
        }
        await client.postToConnection(id, toBuffer(data));
    }
    async sendJSONMessage(value) {
        await this.sendMessage(Buffer.from(JSON.stringify(value), "utf8"));
    }
}
