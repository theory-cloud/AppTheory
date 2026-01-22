import { Buffer } from "node:buffer";
import { type Clock } from "./clock.js";
import { type IdGenerator } from "./ids.js";
import type { Headers, Query, Response } from "./types.js";
export interface WebSocketManagementClientLike {
    postToConnection: (connectionId: string, data: Uint8Array) => void | Promise<void>;
    getConnection: (connectionId: string) => unknown | Promise<unknown>;
    deleteConnection: (connectionId: string) => void | Promise<void>;
}
export type WebSocketClientFactory = (endpoint: string, ctx: unknown | null) => WebSocketManagementClientLike | Promise<WebSocketManagementClientLike>;
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
    };
    readonly params: Record<string, string>;
    requestId: string;
    tenantId: string;
    authIdentity: string;
    remainingMs: number;
    middlewareTrace: string[];
    private readonly _clock;
    private readonly _ids;
    private readonly _webSocket;
    private readonly _values;
    constructor(options: {
        request: Context["request"];
        params?: Record<string, string>;
        clock?: Clock;
        ids?: IdGenerator;
        ctx?: unknown;
        requestId?: string;
        tenantId?: string;
        authIdentity?: string;
        remainingMs?: number;
        middlewareTrace?: string[];
        webSocket?: WebSocketContext | null;
    });
    now(): Date;
    newId(): string;
    param(name: string): string;
    set(key: string, value: unknown): void;
    get(key: string): unknown;
    jsonValue(): unknown;
    asWebSocket(): WebSocketContext | null;
}
export type Handler = (ctx: Context) => Response | Promise<Response>;
export type Middleware = (ctx: Context, next: Handler) => Response | Promise<Response>;
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
    now(): Date;
    newId(): string;
    set(key: string, value: unknown): void;
    get(key: string): unknown;
}
export type EventHandler = (ctx: EventContext, event: unknown) => unknown | Promise<unknown>;
export type EventMiddleware = (ctx: EventContext, event: unknown, next: () => unknown | Promise<unknown>) => unknown | Promise<unknown>;
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
    now(): Date;
    newId(): string;
    private _managementClient;
    sendMessage(data: Uint8Array): Promise<void>;
    sendJSONMessage(value: unknown): Promise<void>;
}
