import { Buffer } from "node:buffer";
import type { AppSyncResolverEvent } from "./aws-types.js";
import { type Clock } from "./clock.js";
import { type IdGenerator } from "./ids.js";
import type { Headers, Query, Response, SourceProvenance } from "./types.js";
/** Client shape used by WebSocketContext to manage API Gateway WebSocket connections. */
export interface WebSocketManagementClientLike {
    postToConnection: (connectionId: string, data: Uint8Array) => void | Promise<void>;
    getConnection: (connectionId: string) => unknown | Promise<unknown>;
    deleteConnection: (connectionId: string) => void | Promise<void>;
}
/** Creates a WebSocket management client for an endpoint and Lambda context. */
export type WebSocketClientFactory = (endpoint: string, ctx: unknown | null) => WebSocketManagementClientLike | Promise<WebSocketManagementClientLike>;
/** AppSync resolver metadata exposed to AppTheory route handlers. */
export declare class AppSyncContext {
    readonly fieldName: string;
    readonly parentTypeName: string;
    readonly arguments: Record<string, unknown>;
    readonly identity: Record<string, unknown>;
    readonly source: Record<string, unknown>;
    readonly variables: Record<string, unknown>;
    readonly stash: Record<string, unknown>;
    readonly prev: unknown;
    readonly requestHeaders: Record<string, string>;
    readonly rawEvent: AppSyncResolverEvent;
    constructor(options: {
        fieldName?: string;
        parentTypeName?: string;
        arguments?: Record<string, unknown>;
        identity?: Record<string, unknown>;
        source?: Record<string, unknown>;
        variables?: Record<string, unknown>;
        stash?: Record<string, unknown>;
        prev?: unknown;
        requestHeaders?: Record<string, string>;
        rawEvent: AppSyncResolverEvent;
    });
}
/** Request-scoped context passed to HTTP, AppSync, and WebSocket handlers. */
export declare class Context {
    readonly ctx: unknown | null;
    readonly request: {
        method: string;
        path: string;
        query: Query;
        headers: Headers;
        cookies: Record<string, string>;
        body: Uint8Array;
        isBase64: boolean;
        sourceProvenance: SourceProvenance;
        traceId: string;
    };
    readonly params: Record<string, string>;
    requestId: string;
    traceId: string;
    tenantId: string;
    authIdentity: string;
    remainingMs: number;
    middlewareTrace: string[];
    private readonly _clock;
    private readonly _ids;
    private readonly _webSocket;
    private readonly _appSync;
    private readonly _values;
    constructor(options: {
        request: Context["request"];
        params?: Record<string, string>;
        clock?: Clock;
        ids?: IdGenerator;
        ctx?: unknown;
        requestId?: string;
        traceId?: string;
        tenantId?: string;
        authIdentity?: string;
        remainingMs?: number;
        middlewareTrace?: string[];
        webSocket?: WebSocketContext | null;
        appSync?: AppSyncContext | null;
    });
    /** Returns the request clock time using the configured clock. */
    now(): Date;
    /** Returns a deterministic or production ID from the configured generator. */
    newId(): string;
    /** Returns a route parameter by name, or an empty string when absent. */
    param(name: string): string;
    /** Stores request-scoped middleware state by key. */
    set(key: string, value: unknown): void;
    /** Returns request-scoped middleware state by key. */
    get(key: string): unknown;
    /** Returns normalized source-provenance metadata for the request. */
    sourceProvenance(): SourceProvenance;
    /** Returns the canonical source IP when the provider supplied one. */
    sourceIP(): string;
    /** Returns the extracted trace ID for correlation, if present. */
    traceContextId(): string;
    /** Decodes the request body as JSON after validating the content type. */
    jsonValue<T = unknown>(): T;
    /** Returns WebSocket trigger metadata for WebSocket routes. */
    asWebSocket(): WebSocketContext | null;
    /** Returns AppSync resolver metadata for AppSync routes. */
    asAppSync(): AppSyncContext | null;
}
/** AppTheory HTTP route handler. */
export type Handler = (ctx: Context) => Response | Promise<Response>;
/** Middleware that wraps an AppTheory HTTP handler. */
export type Middleware = (ctx: Context, next: Handler) => Response | Promise<Response>;
/** Context passed to non-HTTP event workload handlers. */
export declare class EventContext {
    readonly ctx: unknown | null;
    requestId: string;
    remainingMs: number;
    private readonly _clock;
    private readonly _ids;
    private readonly _values;
    constructor(options: {
        clock?: Clock;
        ids?: IdGenerator;
        ctx?: unknown;
        requestId?: string;
        remainingMs?: number;
    });
    /** Returns the event clock time using the configured clock. */
    now(): Date;
    /** Returns a deterministic or production ID from the configured generator. */
    newId(): string;
    /** Stores event-scoped middleware state by key. */
    set(key: string, value: unknown): void;
    /** Returns event-scoped middleware state by key. */
    get(key: string): unknown;
}
/** Event workload handler for AppTheory event dispatch. */
export type EventHandler = (ctx: EventContext, event: unknown) => unknown | Promise<unknown>;
/** Middleware that wraps an AppTheory event workload handler. */
export type EventMiddleware = (ctx: EventContext, event: unknown, next: () => unknown | Promise<unknown>) => unknown | Promise<unknown>;
/** WebSocket trigger metadata and connection-management helpers. */
export declare class WebSocketContext {
    readonly ctx: unknown | null;
    requestId: string;
    remainingMs: number;
    connectionId: string;
    routeKey: string;
    domainName: string;
    stage: string;
    eventType: string;
    managementEndpoint: string;
    body: Uint8Array;
    private readonly _clock;
    private readonly _ids;
    private readonly _clientFactory;
    private _client;
    private _clientError;
    constructor(options: {
        clock?: Clock;
        ids?: IdGenerator;
        ctx?: unknown;
        requestId?: string;
        remainingMs?: number;
        connectionId?: string;
        routeKey?: string;
        domainName?: string;
        stage?: string;
        eventType?: string;
        managementEndpoint?: string;
        body?: Uint8Array | Buffer | string | null;
        clientFactory?: WebSocketClientFactory | null;
    });
    /** Returns the WebSocket request clock time using the configured clock. */
    now(): Date;
    /** Returns a deterministic or production ID from the configured generator. */
    newId(): string;
    private _managementClient;
    /** Sends bytes to the active WebSocket connection. */
    sendMessage(data: Uint8Array): Promise<void>;
    /** Serializes a value as JSON and sends it to the connection. */
    sendJSONMessage(value: unknown): Promise<void>;
}
//# sourceMappingURL=context.d.ts.map