import { Buffer } from "node:buffer";
import { RealClock } from "./clock.js";
import { AppError } from "./errors.js";
import { RandomIdGenerator } from "./ids.js";
import { toBuffer } from "./internal/http.js";
import { hasJSONContentType } from "./internal/response.js";
import { normalizeSourceProvenance } from "./internal/source-provenance.js";
/** AppSync resolver metadata exposed to AppTheory route handlers. */
export class AppSyncContext {
    fieldName;
    parentTypeName;
    arguments;
    identity;
    source;
    variables;
    stash;
    prev;
    requestHeaders;
    rawEvent;
    constructor(options) {
        this.fieldName = String(options.fieldName ?? "").trim();
        this.parentTypeName = String(options.parentTypeName ?? "").trim();
        this.arguments =
            options.arguments && typeof options.arguments === "object"
                ? { ...options.arguments }
                : {};
        this.identity =
            options.identity && typeof options.identity === "object"
                ? { ...options.identity }
                : {};
        this.source =
            options.source && typeof options.source === "object"
                ? { ...options.source }
                : {};
        this.variables =
            options.variables && typeof options.variables === "object"
                ? { ...options.variables }
                : {};
        this.stash =
            options.stash && typeof options.stash === "object"
                ? { ...options.stash }
                : {};
        this.prev = options.prev ?? null;
        this.requestHeaders =
            options.requestHeaders && typeof options.requestHeaders === "object"
                ? { ...options.requestHeaders }
                : {};
        const rawInfo = options.rawEvent.info ?? {};
        this.rawEvent = {
            ...options.rawEvent,
            arguments: options.rawEvent.arguments &&
                typeof options.rawEvent.arguments === "object"
                ? { ...options.rawEvent.arguments }
                : {},
            identity: options.rawEvent.identity &&
                typeof options.rawEvent.identity === "object"
                ? { ...options.rawEvent.identity }
                : {},
            source: options.rawEvent.source && typeof options.rawEvent.source === "object"
                ? { ...options.rawEvent.source }
                : {},
            stash: options.rawEvent.stash && typeof options.rawEvent.stash === "object"
                ? { ...options.rawEvent.stash }
                : {},
            ...(options.rawEvent.request &&
                typeof options.rawEvent.request === "object" &&
                options.rawEvent.request.headers &&
                typeof options.rawEvent.request.headers === "object"
                ? { request: { headers: { ...options.rawEvent.request.headers } } }
                : {}),
            info: {
                ...rawInfo,
                ...(rawInfo.variables && typeof rawInfo.variables === "object"
                    ? { variables: { ...rawInfo.variables } }
                    : {}),
                ...(Array.isArray(rawInfo.selectionSetList)
                    ? { selectionSetList: [...rawInfo.selectionSetList] }
                    : {}),
            },
        };
    }
}
/** Request-scoped context passed to HTTP, AppSync, and WebSocket handlers. */
export class Context {
    ctx;
    request;
    params;
    requestId;
    traceId;
    tenantId;
    authIdentity;
    remainingMs;
    middlewareTrace;
    _clock;
    _ids;
    _webSocket;
    _appSync;
    _values;
    constructor(options) {
        this.ctx = options.ctx ?? null;
        this.request = options.request;
        this.params = options.params ?? {};
        this._clock = options.clock ?? new RealClock();
        this._ids = options.ids ?? new RandomIdGenerator();
        this.requestId = options.requestId ?? "";
        this.traceId = options.traceId ?? this.request.traceId ?? "";
        this.tenantId = options.tenantId ?? "";
        this.authIdentity = options.authIdentity ?? "";
        this.remainingMs = Number(options.remainingMs ?? 0);
        this.middlewareTrace = Array.isArray(options.middlewareTrace)
            ? options.middlewareTrace
            : [];
        this._webSocket = options.webSocket ?? null;
        this._appSync = options.appSync ?? null;
        this._values = new Map();
    }
    /** Returns the request clock time using the configured clock. */
    now() {
        return this._clock.now();
    }
    /** Returns a deterministic or production ID from the configured generator. */
    newId() {
        return this._ids.newId();
    }
    /** Returns a route parameter by name, or an empty string when absent. */
    param(name) {
        return this.params[String(name)] ?? "";
    }
    /** Stores request-scoped middleware state by key. */
    set(key, value) {
        const k = String(key ?? "").trim();
        if (!k)
            return;
        this._values.set(k, value);
    }
    /** Returns request-scoped middleware state by key. */
    get(key) {
        const k = String(key ?? "").trim();
        if (!k)
            return undefined;
        return this._values.get(k);
    }
    /** Returns normalized source-provenance metadata for the request. */
    sourceProvenance() {
        return normalizeSourceProvenance(this.request.sourceProvenance);
    }
    /** Returns the canonical source IP when the provider supplied one. */
    sourceIP() {
        return this.sourceProvenance().sourceIP;
    }
    /** Returns the extracted trace ID for correlation, if present. */
    traceContextId() {
        return String(this.traceId ?? "").trim();
    }
    /** Decodes the request body as JSON after validating the content type. */
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
    /** Returns WebSocket trigger metadata for WebSocket routes. */
    asWebSocket() {
        return this._webSocket;
    }
    /** Returns AppSync resolver metadata for AppSync routes. */
    asAppSync() {
        return this._appSync;
    }
}
/** Context passed to non-HTTP event workload handlers. */
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
    /** Returns the event clock time using the configured clock. */
    now() {
        return this._clock.now();
    }
    /** Returns a deterministic or production ID from the configured generator. */
    newId() {
        return this._ids.newId();
    }
    /** Stores event-scoped middleware state by key. */
    set(key, value) {
        const k = String(key ?? "").trim();
        if (!k)
            return;
        this._values.set(k, value);
    }
    /** Returns event-scoped middleware state by key. */
    get(key) {
        const k = String(key ?? "").trim();
        if (!k)
            return undefined;
        return this._values.get(k);
    }
}
/** WebSocket trigger metadata and connection-management helpers. */
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
    /** Returns the WebSocket request clock time using the configured clock. */
    now() {
        return this._clock.now();
    }
    /** Returns a deterministic or production ID from the configured generator. */
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
    /** Sends bytes to the active WebSocket connection. */
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
    /** Serializes a value as JSON and sends it to the connection. */
    async sendJSONMessage(value) {
        await this.sendMessage(Buffer.from(JSON.stringify(value), "utf8"));
    }
}
//# sourceMappingURL=context.js.map