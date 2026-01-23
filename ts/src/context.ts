import { Buffer } from "node:buffer";

import { RealClock, type Clock } from "./clock.js";
import { AppError } from "./errors.js";
import { RandomIdGenerator, type IdGenerator } from "./ids.js";
import { toBuffer } from "./internal/http.js";
import { hasJSONContentType } from "./internal/response.js";
import type { Headers, Query, Response } from "./types.js";

export interface WebSocketManagementClientLike {
  postToConnection: (
    connectionId: string,
    data: Uint8Array,
  ) => void | Promise<void>;
  getConnection: (connectionId: string) => unknown | Promise<unknown>;
  deleteConnection: (connectionId: string) => void | Promise<void>;
}

export type WebSocketClientFactory = (
  endpoint: string,
  ctx: unknown | null,
) => WebSocketManagementClientLike | Promise<WebSocketManagementClientLike>;

export class Context {
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

  private readonly _clock: Clock;
  private readonly _ids: IdGenerator;
  private readonly _webSocket: WebSocketContext | null;
  private readonly _values: Map<string, unknown>;

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
  }) {
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

  now(): Date {
    return this._clock.now();
  }

  newId(): string {
    return this._ids.newId();
  }

  param(name: string): string {
    return this.params[String(name)] ?? "";
  }

  set(key: string, value: unknown): void {
    const k = String(key ?? "").trim();
    if (!k) return;
    this._values.set(k, value);
  }

  get(key: string): unknown {
    const k = String(key ?? "").trim();
    if (!k) return undefined;
    return this._values.get(k);
  }

  jsonValue(): unknown {
    if (!hasJSONContentType(this.request.headers)) {
      throw new AppError("app.bad_request", "invalid json");
    }
    if (this.request.body.length === 0) {
      return null;
    }
    try {
      return JSON.parse(Buffer.from(this.request.body).toString("utf8"));
    } catch {
      throw new AppError("app.bad_request", "invalid json");
    }
  }

  asWebSocket(): WebSocketContext | null {
    return this._webSocket;
  }
}

export type Handler = (ctx: Context) => Response | Promise<Response>;

export type Middleware = (
  ctx: Context,
  next: Handler,
) => Response | Promise<Response>;

export class EventContext {
  readonly ctx: unknown | null;
  requestId: string;
  remainingMs: number;

  private readonly _clock: Clock;
  private readonly _ids: IdGenerator;
  private readonly _values: Map<string, unknown>;

  constructor(options: {
    clock?: Clock;
    ids?: IdGenerator;
    ctx?: unknown;
    requestId?: string;
    remainingMs?: number;
  }) {
    this.ctx = options.ctx ?? null;
    this._clock = options.clock ?? new RealClock();
    this._ids = options.ids ?? new RandomIdGenerator();
    this.requestId = options.requestId ?? "";
    this.remainingMs = Number(options.remainingMs ?? 0);
    this._values = new Map();
  }

  now(): Date {
    return this._clock.now();
  }

  newId(): string {
    return this._ids.newId();
  }

  set(key: string, value: unknown): void {
    const k = String(key ?? "").trim();
    if (!k) return;
    this._values.set(k, value);
  }

  get(key: string): unknown {
    const k = String(key ?? "").trim();
    if (!k) return undefined;
    return this._values.get(k);
  }
}

export type EventHandler = (
  ctx: EventContext,
  event: unknown,
) => unknown | Promise<unknown>;

export type EventMiddleware = (
  ctx: EventContext,
  event: unknown,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export class WebSocketContext {
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

  private readonly _clock: Clock;
  private readonly _ids: IdGenerator;
  private readonly _clientFactory: WebSocketClientFactory | null;
  private _client: WebSocketManagementClientLike | null;
  private _clientError: Error | null;

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
  }) {
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

  now(): Date {
    return this._clock.now();
  }

  newId(): string {
    return this._ids.newId();
  }

  private async _managementClient(): Promise<WebSocketManagementClientLike> {
    if (this._client || this._clientError) {
      if (this._clientError) throw this._clientError;
      return this._client as WebSocketManagementClientLike;
    }

    if (!this._clientFactory) {
      this._clientError = new Error(
        "apptheory: missing websocket client factory",
      );
      throw this._clientError;
    }

    const client = await this._clientFactory(this.managementEndpoint, this.ctx);
    if (!client) {
      this._clientError = new Error(
        "apptheory: websocket client factory returned null",
      );
      throw this._clientError;
    }

    this._client = client;
    return client;
  }

  async sendMessage(data: Uint8Array): Promise<void> {
    const id = String(this.connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    const client = await this._managementClient();
    if (typeof client.postToConnection !== "function") {
      throw new Error("apptheory: websocket client missing postToConnection");
    }

    await client.postToConnection(id, toBuffer(data));
  }

  async sendJSONMessage(value: unknown): Promise<void> {
    await this.sendMessage(Buffer.from(JSON.stringify(value), "utf8"));
  }
}
