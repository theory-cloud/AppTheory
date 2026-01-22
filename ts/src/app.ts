import { Buffer } from "node:buffer";

import type {
  ALBTargetGroupRequest,
  ALBTargetGroupResponse,
  APIGatewayProxyRequest,
  APIGatewayProxyResponse,
  APIGatewayV2HTTPRequest,
  APIGatewayV2HTTPResponse,
  APIGatewayWebSocketProxyRequest,
  DynamoDBStreamEvent,
  DynamoDBStreamEventResponse,
  DynamoDBStreamRecord,
  EventBridgeEvent,
  EventBridgeSelector,
  KinesisEvent,
  KinesisEventResponse,
  KinesisEventRecord,
  LambdaFunctionURLRequest,
  LambdaFunctionURLResponse,
  SNSEvent,
  SNSEventRecord,
  SQSEvent,
  SQSEventResponse,
  SQSMessage,
} from "./aws-types.js";
import { RealClock, type Clock } from "./clock.js";
import { Context, EventContext, WebSocketContext } from "./context.js";
import type {
  EventMiddleware,
  Handler,
  Middleware,
  WebSocketClientFactory,
} from "./context.js";
import { AppError } from "./errors.js";
import { RandomIdGenerator, type IdGenerator } from "./ids.js";
import {
  albTargetGroupResponseFromResponse,
  apigatewayProxyResponseFromResponse,
  apigatewayV2ResponseFromResponse,
  lambdaFunctionURLResponseFromResponse,
  requestFromALBTargetGroup,
  requestFromAPIGatewayProxy,
  requestFromAPIGatewayV2,
  requestFromLambdaFunctionURL,
  requestFromWebSocketEvent,
} from "./internal/aws-http.js";
import {
  serveLambdaFunctionURLStreaming,
  type HttpResponseStreamLike,
} from "./internal/aws-lambda-streaming.js";
import {
  dynamoDBTableNameFromStreamArn,
  eventBridgeRuleNameFromArn,
  kinesisStreamNameFromArn,
  snsTopicNameFromArn,
  sqsQueueNameFromArn,
  webSocketManagementEndpoint,
} from "./internal/aws-names.js";
import {
  canonicalizeHeaders,
  cloneQuery,
  firstHeaderValue,
  normalizeMethod,
  normalizePath,
} from "./internal/http.js";
import { normalizeRequest } from "./internal/request.js";
import {
  errorResponse,
  errorResponseWithRequestId,
  normalizeResponse,
  responseForError,
  responseForErrorWithRequestId,
} from "./internal/response.js";
import { Router } from "./internal/router.js";
import { vary } from "./response.js";
import type { Headers, Query, Request, Response } from "./types.js";
import { WebSocketManagementClient } from "./websocket-management.js";

export type Tier = "p0" | "p1" | "p2";

export interface Limits {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface CORSConfig {
  allowedOrigins?: string[];
  allowCredentials?: boolean;
  allowHeaders?: string[];
}

export interface RouteOptions {
  authRequired?: boolean;
}

export type AuthHook = (ctx: Context) => string | Promise<string>;

export interface PolicyDecision {
  code: string;
  message?: string;
  headers?: Headers;
}

export type PolicyHook = (
  ctx: Context,
) =>
  | PolicyDecision
  | null
  | undefined
  | Promise<PolicyDecision | null | undefined>;

export interface LogRecord {
  level: string;
  event: string;
  requestId: string;
  tenantId: string;
  method: string;
  path: string;
  status: number;
  errorCode: string;
}

export interface MetricRecord {
  name: string;
  value: number;
  tags: Record<string, string>;
}

export interface SpanRecord {
  name: string;
  attributes: Record<string, string>;
}

export interface ObservabilityHooks {
  log?: (record: LogRecord) => void;
  metric?: (record: MetricRecord) => void;
  span?: (record: SpanRecord) => void;
}

export interface TimeoutConfig {
  defaultTimeoutMs?: number;
  operationTimeoutsMs?: Record<string, number>;
  tenantTimeoutsMs?: Record<string, number>;
  timeoutMessage?: string;
}

export type SQSHandler = (
  ctx: EventContext,
  message: SQSMessage,
) => void | Promise<void>;
export type KinesisHandler = (
  ctx: EventContext,
  record: KinesisEventRecord,
) => void | Promise<void>;
export type SNSHandler = (
  ctx: EventContext,
  record: SNSEventRecord,
) => unknown | Promise<unknown>;
export type DynamoDBStreamHandler = (
  ctx: EventContext,
  record: DynamoDBStreamRecord,
) => void | Promise<void>;
export type EventBridgeHandler = (
  ctx: EventContext,
  event: EventBridgeEvent,
) => unknown | Promise<unknown>;

type NormalizedLimits = {
  maxRequestBytes: number;
  maxResponseBytes: number;
};

type NormalizedCORSConfig = {
  allowedOrigins: string[] | null;
  allowCredentials: boolean;
  allowHeaders: string[] | null;
};

type WebSocketRoute = { routeKey: string; handler: Handler };
type SQSRoute = { queueName: string; handler: SQSHandler };
type KinesisRoute = { streamName: string; handler: KinesisHandler };
type SNSRoute = { topicName: string; handler: SNSHandler };
type EventBridgeRoute = {
  selector: EventBridgeSelector;
  handler: EventBridgeHandler;
};
type DynamoDBRoute = { tableName: string; handler: DynamoDBStreamHandler };

export class App {
  private readonly _router: Router<Handler>;
  private readonly _clock: Clock;
  private readonly _ids: IdGenerator;
  private readonly _tier: Tier;
  private readonly _limits: NormalizedLimits;
  private readonly _cors: NormalizedCORSConfig;
  private readonly _authHook: AuthHook | null;
  private readonly _policyHook: PolicyHook | null;
  private readonly _observability: ObservabilityHooks | null;
  private readonly _webSocketRoutes: WebSocketRoute[];
  private readonly _webSocketClientFactory: WebSocketClientFactory;
  private readonly _sqsRoutes: SQSRoute[];
  private readonly _kinesisRoutes: KinesisRoute[];
  private readonly _snsRoutes: SNSRoute[];
  private readonly _eventBridgeRoutes: EventBridgeRoute[];
  private readonly _dynamoDBRoutes: DynamoDBRoute[];
  private readonly _middlewares: Middleware[];
  private readonly _eventMiddlewares: EventMiddleware[];

  constructor(
    options: {
      clock?: Clock;
      ids?: IdGenerator;
      tier?: Tier;
      limits?: Limits;
      cors?: CORSConfig;
      authHook?: AuthHook;
      policyHook?: PolicyHook;
      observability?: ObservabilityHooks;
      webSocketClientFactory?: WebSocketClientFactory;
    } = {},
  ) {
    this._router = new Router();
    this._clock = options.clock ?? new RealClock();
    this._ids = options.ids ?? new RandomIdGenerator();
    this._tier =
      options.tier === "p0" || options.tier === "p1" || options.tier === "p2"
        ? options.tier
        : "p2";
    this._limits = {
      maxRequestBytes: Number(options.limits?.maxRequestBytes ?? 0),
      maxResponseBytes: Number(options.limits?.maxResponseBytes ?? 0),
    };
    this._cors = normalizeCorsConfig(options.cors);
    this._authHook = options.authHook ?? null;
    this._policyHook = options.policyHook ?? null;
    this._observability = options.observability ?? null;
    this._webSocketRoutes = [];
    this._webSocketClientFactory =
      typeof options.webSocketClientFactory === "function"
        ? options.webSocketClientFactory
        : (endpoint: string) => new WebSocketManagementClient({ endpoint });
    this._sqsRoutes = [];
    this._kinesisRoutes = [];
    this._snsRoutes = [];
    this._eventBridgeRoutes = [];
    this._dynamoDBRoutes = [];
    this._middlewares = [];
    this._eventMiddlewares = [];
  }

  handle(
    method: string,
    pattern: string,
    handler: Handler,
    options: RouteOptions = {},
  ): this {
    this._router.add(method, pattern, handler, options);
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.handle("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.handle("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.handle("PUT", pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.handle("DELETE", pattern, handler);
  }

  use(middleware: Middleware): this {
    if (typeof middleware !== "function") return this;
    this._middlewares.push(middleware);
    return this;
  }

  useEvents(middleware: EventMiddleware): this {
    if (typeof middleware !== "function") return this;
    this._eventMiddlewares.push(middleware);
    return this;
  }

  private _applyMiddlewares(handler: Handler): Handler;
  private _applyMiddlewares(handler: Handler | null): Handler | null;
  private _applyMiddlewares(handler: Handler | null): Handler | null {
    if (typeof handler !== "function" || this._middlewares.length === 0) {
      return handler;
    }
    let wrapped: Handler = handler;
    for (let i = this._middlewares.length - 1; i >= 0; i -= 1) {
      const mw = this._middlewares[i];
      if (typeof mw !== "function") continue;
      const next = wrapped;
      wrapped = async (ctx: Context) => mw(ctx, next);
    }
    return wrapped;
  }

  private _applyEventMiddlewares<TEvent>(
    handler:
      | ((ctx: EventContext, event: TEvent) => unknown | Promise<unknown>)
      | null,
  ): ((ctx: EventContext, event: TEvent) => Promise<unknown>) | null {
    if (typeof handler !== "function" || this._eventMiddlewares.length === 0) {
      return handler ? async (ctx, event) => handler(ctx, event) : null;
    }

    let wrapped: (
      ctx: EventContext,
      event: TEvent,
    ) => Promise<unknown> = async (ctx, event) => handler(ctx, event);

    for (let i = this._eventMiddlewares.length - 1; i >= 0; i -= 1) {
      const mw = this._eventMiddlewares[i];
      if (typeof mw !== "function") continue;
      const next = wrapped;
      wrapped = async (ctx, event) =>
        mw(ctx, event, async () => next(ctx, event));
    }

    return wrapped;
  }

  webSocket(routeKey: string, handler: Handler): this {
    const key = String(routeKey ?? "").trim();
    if (!key || typeof handler !== "function") return this;
    this._webSocketRoutes.push({ routeKey: key, handler });
    return this;
  }

  sqs(queueName: string, handler: SQSHandler): this {
    const name = String(queueName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._sqsRoutes.push({ queueName: name, handler });
    return this;
  }

  kinesis(streamName: string, handler: KinesisHandler): this {
    const name = String(streamName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._kinesisRoutes.push({ streamName: name, handler });
    return this;
  }

  sns(topicName: string, handler: SNSHandler): this {
    const name = String(topicName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._snsRoutes.push({ topicName: name, handler });
    return this;
  }

  eventBridge(
    selector: EventBridgeSelector,
    handler: EventBridgeHandler,
  ): this {
    if (typeof handler !== "function") return this;
    const sel: EventBridgeSelector = {
      ruleName: String(selector?.ruleName ?? "").trim(),
      source: String(selector?.source ?? "").trim(),
      detailType: String(selector?.detailType ?? "").trim(),
    };
    if (!sel.ruleName && !sel.source && !sel.detailType) return this;
    this._eventBridgeRoutes.push({ selector: sel, handler });
    return this;
  }

  dynamoDB(tableName: string, handler: DynamoDBStreamHandler): this {
    const name = String(tableName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._dynamoDBRoutes.push({ tableName: name, handler });
    return this;
  }

  async serve(request: Request, ctx?: unknown): Promise<Response> {
    if (this._tier === "p0") {
      let normalized: Context["request"];
      try {
        normalized = normalizeRequest(request);
      } catch (err) {
        return responseForError(err);
      }

      const { match, allowed } = this._router.match(
        normalized.method,
        normalized.path,
      );
      if (!match) {
        if (allowed.length > 0) {
          return errorResponse("app.method_not_allowed", "method not allowed", {
            allow: [formatAllowHeader(allowed)],
          });
        }
        return errorResponse("app.not_found", "not found");
      }

      const requestCtx = new Context({
        request: normalized,
        params: match.params,
        clock: this._clock,
        ids: this._ids,
        ctx,
      });

      try {
        const handler = this._applyMiddlewares(match.route.handler) as Handler;
        const out = await handler(requestCtx);
        return normalizeResponse(out);
      } catch (err) {
        return responseForError(err);
      }
    }

    const preHeaders = canonicalizeHeaders(request.headers);
    const preQuery = cloneQuery(request.query);
    let method = normalizeMethod(request.method);
    let path = normalizePath(request.path);

    let requestId = firstHeaderValue(preHeaders, "x-request-id");
    if (!requestId) {
      requestId = this._ids.newId();
    }
    const origin = firstHeaderValue(preHeaders, "origin");

    const middlewareTrace = ["request_id", "recovery", "logging"];
    if (origin) middlewareTrace.push("cors");

    const tenantId = extractTenantId(preHeaders, preQuery);
    const remainingMs = extractRemainingMs(ctx);
    const enableP2 = this._tier === "p2";

    const finish = (resp: Response, errCode?: string): Response => {
      const out = finalizeP1Response(resp, requestId, origin, this._cors);
      if (enableP2) {
        recordObservability(this._observability, {
          method,
          path,
          requestId,
          tenantId,
          status: out.status,
          errorCode: errCode ?? "",
        });
      }
      return out;
    };

    if (isCorsPreflight(method, preHeaders)) {
      const allow = firstHeaderValue(
        preHeaders,
        "access-control-request-method",
      );
      const resp = normalizeResponse({
        status: 204,
        headers: { "access-control-allow-methods": [allow] },
        cookies: [],
        body: Buffer.alloc(0),
        isBase64: false,
      });
      return finish(resp, "");
    }

    let normalized: Context["request"];
    try {
      normalized = normalizeRequest(request);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "app.internal";
      return finish(responseForErrorWithRequestId(err, requestId), code);
    }

    method = normalized.method;
    path = normalized.path;

    if (
      this._limits.maxRequestBytes > 0 &&
      Buffer.from(normalized.body).length > this._limits.maxRequestBytes
    ) {
      return finish(
        errorResponseWithRequestId(
          "app.too_large",
          "request too large",
          {},
          requestId,
        ),
        "app.too_large",
      );
    }

    const { match, allowed } = this._router.match(
      normalized.method,
      normalized.path,
    );
    if (!match) {
      if (allowed.length > 0) {
        return finish(
          errorResponseWithRequestId(
            "app.method_not_allowed",
            "method not allowed",
            { allow: [formatAllowHeader(allowed)] },
            requestId,
          ),
          "app.method_not_allowed",
        );
      }
      return finish(
        errorResponseWithRequestId("app.not_found", "not found", {}, requestId),
        "app.not_found",
      );
    }

    const requestCtx = new Context({
      request: normalized,
      params: match.params,
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      tenantId,
      authIdentity: "",
      remainingMs,
      middlewareTrace,
    });

    if (enableP2 && typeof this._policyHook === "function") {
      let decision: PolicyDecision | null | undefined;
      try {
        decision = await this._policyHook(requestCtx);
      } catch (err) {
        const code = err instanceof AppError ? err.code : "app.internal";
        return finish(responseForErrorWithRequestId(err, requestId), code);
      }

      const code = String(decision?.code ?? "").trim();
      if (code) {
        const message =
          String(decision?.message ?? "").trim() || defaultPolicyMessage(code);
        return finish(
          errorResponseWithRequestId(
            code,
            message,
            decision?.headers ?? {},
            requestId,
          ),
          code,
        );
      }
    }

    if (match.route.authRequired) {
      middlewareTrace.push("auth");
      try {
        if (!this._authHook) {
          throw new AppError("app.unauthorized", "unauthorized");
        }
        const identity = await this._authHook(requestCtx);
        if (!String(identity ?? "").trim()) {
          throw new AppError("app.unauthorized", "unauthorized");
        }
        requestCtx.authIdentity = String(identity);
      } catch (err) {
        const code = err instanceof AppError ? err.code : "app.internal";
        return finish(responseForErrorWithRequestId(err, requestId), code);
      }
    }

    middlewareTrace.push("handler");

    let out: Response | null;
    try {
      const handler = this._applyMiddlewares(match.route.handler) as Handler;
      out = await handler(requestCtx);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "app.internal";
      return finish(responseForErrorWithRequestId(err, requestId), code);
    }

    if (!out) {
      return finish(
        errorResponseWithRequestId(
          "app.internal",
          "internal error",
          {},
          requestId,
        ),
        "app.internal",
      );
    }

    let resp: Response;
    try {
      resp = normalizeResponse(out);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "app.internal";
      return finish(responseForErrorWithRequestId(err, requestId), code);
    }

    if (
      this._limits.maxResponseBytes > 0 &&
      Buffer.from(resp.body).length > this._limits.maxResponseBytes
    ) {
      return finish(
        errorResponseWithRequestId(
          "app.too_large",
          "response too large",
          {},
          requestId,
        ),
        "app.too_large",
      );
    }

    return finish(resp, "");
  }

  async serveAPIGatewayV2(
    event: APIGatewayV2HTTPRequest,
    ctx?: unknown,
  ): Promise<APIGatewayV2HTTPResponse> {
    let request: Request;
    try {
      request = requestFromAPIGatewayV2(event);
    } catch (err) {
      return apigatewayV2ResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return apigatewayV2ResponseFromResponse(resp);
  }

  async serveLambdaFunctionURL(
    event: LambdaFunctionURLRequest,
    ctx?: unknown,
  ): Promise<LambdaFunctionURLResponse> {
    let request: Request;
    try {
      request = requestFromLambdaFunctionURL(event);
    } catch (err) {
      return lambdaFunctionURLResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return lambdaFunctionURLResponseFromResponse(resp);
  }

  async serveAPIGatewayProxy(
    event: APIGatewayProxyRequest,
    ctx?: unknown,
  ): Promise<APIGatewayProxyResponse> {
    let request: Request;
    try {
      request = requestFromAPIGatewayProxy(event);
    } catch (err) {
      return apigatewayProxyResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return apigatewayProxyResponseFromResponse(resp);
  }

  async serveALB(
    event: ALBTargetGroupRequest,
    ctx?: unknown,
  ): Promise<ALBTargetGroupResponse> {
    let request: Request;
    try {
      request = requestFromALBTargetGroup(event);
    } catch (err) {
      return albTargetGroupResponseFromResponse(responseForError(err));
    }
    const resp = await this.serve(request, ctx);
    return albTargetGroupResponseFromResponse(resp);
  }

  private _webSocketHandlerForEvent(
    event: APIGatewayWebSocketProxyRequest,
  ): Handler | null {
    const routeKey = String(event?.requestContext?.routeKey ?? "").trim();
    if (!routeKey) return null;
    for (const route of this._webSocketRoutes) {
      if (route.routeKey === routeKey) return route.handler;
    }
    return null;
  }

  async serveWebSocket(
    event: APIGatewayWebSocketProxyRequest,
    ctx?: unknown,
  ): Promise<APIGatewayProxyResponse> {
    const handler = this._applyMiddlewares(
      this._webSocketHandlerForEvent(event),
    );

    let requestId = String(event?.requestContext?.requestId ?? "").trim();
    if (!requestId) {
      const awsRequestId =
        ctx &&
        typeof ctx === "object" &&
        typeof (ctx as Record<string, unknown>)["awsRequestId"] === "string"
          ? String((ctx as Record<string, unknown>)["awsRequestId"]).trim()
          : "";
      requestId = awsRequestId || this._ids.newId();
    }

    let request: Context["request"];
    try {
      request = requestFromWebSocketEvent(event);
    } catch (err) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(responseForError(err));
      }
      return apigatewayProxyResponseFromResponse(
        responseForErrorWithRequestId(err, requestId),
      );
    }

    const domainName = String(event?.requestContext?.domainName ?? "").trim();
    const stage = String(event?.requestContext?.stage ?? "").trim();

    const wsCtx = new WebSocketContext({
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      remainingMs: extractRemainingMs(ctx),
      connectionId: String(event?.requestContext?.connectionId ?? "").trim(),
      routeKey: String(event?.requestContext?.routeKey ?? "").trim(),
      domainName,
      stage,
      eventType: String(event?.requestContext?.eventType ?? "").trim(),
      managementEndpoint: webSocketManagementEndpoint(domainName, stage),
      body: request.body,
      clientFactory: this._webSocketClientFactory,
    });

    const requestCtx = new Context({
      request,
      params: {},
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      tenantId: extractTenantId(request.headers, request.query),
      authIdentity: "",
      remainingMs: extractRemainingMs(ctx),
      middlewareTrace: [],
      webSocket: wsCtx,
    });

    if (!handler) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(
          errorResponse("app.not_found", "not found"),
        );
      }
      return apigatewayProxyResponseFromResponse(
        errorResponseWithRequestId("app.not_found", "not found", {}, requestId),
      );
    }

    let resp: Response | null;
    try {
      resp = await handler(requestCtx);
    } catch (err) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(responseForError(err));
      }
      return apigatewayProxyResponseFromResponse(
        responseForErrorWithRequestId(err, requestId),
      );
    }

    if (!resp) {
      if (this._tier === "p0") {
        return apigatewayProxyResponseFromResponse(
          errorResponse("app.internal", "internal error"),
        );
      }
      return apigatewayProxyResponseFromResponse(
        errorResponseWithRequestId(
          "app.internal",
          "internal error",
          {},
          requestId,
        ),
      );
    }

    return apigatewayProxyResponseFromResponse(normalizeResponse(resp));
  }

  private _eventContext(ctx?: unknown): EventContext {
    const requestId =
      ctx &&
      typeof ctx === "object" &&
      typeof (ctx as Record<string, unknown>)["awsRequestId"] === "string" &&
      String((ctx as Record<string, unknown>)["awsRequestId"]).trim()
        ? String((ctx as Record<string, unknown>)["awsRequestId"]).trim()
        : this._ids.newId();

    return new EventContext({
      clock: this._clock,
      ids: this._ids,
      ctx,
      requestId,
      remainingMs: extractRemainingMs(ctx),
    });
  }

  private _sqsHandlerForEvent(event: SQSEvent): SQSHandler | null {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;
    const queueName = sqsQueueNameFromArn(
      String(records[0]?.eventSourceARN ?? ""),
    );
    if (!queueName) return null;
    for (const route of this._sqsRoutes) {
      if (route.queueName === queueName) return route.handler;
    }
    return null;
  }

  async serveSQSEvent(
    event: SQSEvent,
    ctx?: unknown,
  ): Promise<SQSEventResponse> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._sqsHandlerForEvent(event);
    if (!handler) {
      const failures = records
        .map((r) => String(r?.messageId ?? "").trim())
        .filter(Boolean)
        .map((id) => ({ itemIdentifier: id }));
      return { batchItemFailures: failures };
    }

    const eventCtx = this._eventContext(ctx);
    let failures: Array<{ itemIdentifier: string }> = [];

    const wrapped = this._applyEventMiddlewares(handler);
    for (const record of records) {
      let recordError: unknown = null;
      try {
        await (wrapped ?? handler)(eventCtx, record);
      } catch (err) {
        recordError = err;
      }
      if (recordError) {
        failures.push({
          itemIdentifier: String(record?.messageId ?? ""),
        });
      }
    }

    failures = failures.filter((f) => f.itemIdentifier);
    return { batchItemFailures: failures };
  }

  private _kinesisHandlerForEvent(event: KinesisEvent): KinesisHandler | null {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;
    const streamName = kinesisStreamNameFromArn(
      String(records[0]?.eventSourceARN ?? ""),
    );
    if (!streamName) return null;
    for (const route of this._kinesisRoutes) {
      if (route.streamName === streamName) return route.handler;
    }
    return null;
  }

  async serveKinesisEvent(
    event: KinesisEvent,
    ctx?: unknown,
  ): Promise<KinesisEventResponse> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._kinesisHandlerForEvent(event);
    if (!handler) {
      const failures = records
        .map((r) => String(r?.eventID ?? "").trim())
        .filter(Boolean)
        .map((id) => ({ itemIdentifier: id }));
      return { batchItemFailures: failures };
    }

    const eventCtx = this._eventContext(ctx);
    let failures: Array<{ itemIdentifier: string }> = [];

    const wrapped = this._applyEventMiddlewares(handler);
    for (const record of records) {
      let recordError: unknown = null;
      try {
        await (wrapped ?? handler)(eventCtx, record);
      } catch (err) {
        recordError = err;
      }
      if (recordError) {
        failures.push({
          itemIdentifier: String(record?.eventID ?? ""),
        });
      }
    }

    failures = failures.filter((f) => f.itemIdentifier);
    return { batchItemFailures: failures };
  }

  private _snsHandlerForEvent(event: SNSEvent): SNSHandler | null {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;

    const topicArn = String(records[0]?.Sns?.TopicArn ?? "").trim();
    const topicName = snsTopicNameFromArn(topicArn);
    if (!topicName) return null;

    for (const route of this._snsRoutes) {
      if (route.topicName === topicName) return route.handler;
    }
    return null;
  }

  async serveSNSEvent(event: SNSEvent, ctx?: unknown): Promise<unknown[]> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._snsHandlerForEvent(event);
    if (!handler) {
      return [];
    }

    const eventCtx = this._eventContext(ctx);
    const out: unknown[] = [];

    const wrapped = this._applyEventMiddlewares(handler);
    for (const record of records) {
      out.push(await (wrapped ?? handler)(eventCtx, record));
    }

    return out;
  }

  private _eventBridgeHandlerForEvent(
    event: EventBridgeEvent,
  ): EventBridgeHandler | null {
    const resources = Array.isArray(event?.resources) ? event.resources : [];
    if (resources.length === 0) return null;

    const ruleName = resources
      .map((r) => String(r ?? "").trim())
      .filter(Boolean)
      .map((r) => eventBridgeRuleNameFromArn(r))
      .filter(Boolean)[0];

    const source = String(event?.source ?? "").trim();
    const detailType = String(
      (event as Record<string, unknown>)["detail-type"] ??
        event?.detailType ??
        "",
    ).trim();

    if (!ruleName && !source && !detailType) return null;

    for (const route of this._eventBridgeRoutes) {
      const sel = route.selector ?? {};
      if (sel.ruleName && ruleName) {
        let matched = false;
        for (const resource of resources) {
          if (eventBridgeRuleNameFromArn(resource) === sel.ruleName) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
      }
      if (sel.source && source && sel.source !== source) continue;
      if (sel.detailType && detailType && sel.detailType !== detailType)
        continue;
      return route.handler;
    }
    return null;
  }

  async serveEventBridge(
    event: EventBridgeEvent,
    ctx?: unknown,
  ): Promise<unknown> {
    const handler = this._eventBridgeHandlerForEvent(event);
    if (!handler) {
      return null;
    }
    const eventCtx = this._eventContext(ctx);
    const wrapped = this._applyEventMiddlewares(handler);
    return await (wrapped ?? handler)(eventCtx, event);
  }

  private _dynamoDBHandlerForEvent(
    event: DynamoDBStreamEvent,
  ): DynamoDBStreamHandler | null {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    if (records.length === 0) return null;
    const tableName = dynamoDBTableNameFromStreamArn(
      String(records[0]?.eventSourceARN ?? ""),
    );
    if (!tableName) return null;
    for (const route of this._dynamoDBRoutes) {
      if (route.tableName === tableName) return route.handler;
    }
    return null;
  }

  async serveDynamoDBStream(
    event: DynamoDBStreamEvent,
    ctx?: unknown,
  ): Promise<DynamoDBStreamEventResponse> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._dynamoDBHandlerForEvent(event);
    if (!handler) {
      const failures = records
        .map((r) => String(r?.eventID ?? "").trim())
        .filter(Boolean)
        .map((id) => ({ itemIdentifier: id }));
      return { batchItemFailures: failures };
    }

    const eventCtx = this._eventContext(ctx);
    let failures: Array<{ itemIdentifier: string }> = [];

    const wrapped = this._applyEventMiddlewares(handler);
    for (const record of records) {
      let recordError: unknown = null;
      try {
        await (wrapped ?? handler)(eventCtx, record);
      } catch (err) {
        recordError = err;
      }
      if (recordError) {
        failures.push({
          itemIdentifier: String(record?.eventID ?? ""),
        });
      }
    }

    failures = failures.filter((f) => f.itemIdentifier);
    return { batchItemFailures: failures };
  }

  async handleLambda(event: unknown, ctx?: unknown): Promise<unknown> {
    if (!event || typeof event !== "object") {
      throw new Error("apptheory: event must be an object");
    }

    const record = event as Record<string, unknown>;

    const records = Array.isArray(record["Records"])
      ? (record["Records"] as unknown[])
      : [];
    if (records.length > 0 && records[0] && typeof records[0] === "object") {
      const first = records[0] as Record<string, unknown>;
      if ("Sns" in first) {
        return this.serveSNSEvent(event as SNSEvent, ctx);
      }

      const src = String(first["eventSource"] ?? "").trim();
      if (src === "aws:sqs") {
        return this.serveSQSEvent(event as SQSEvent, ctx);
      }
      if (src === "aws:kinesis") {
        return this.serveKinesisEvent(event as KinesisEvent, ctx);
      }
      if (src === "aws:dynamodb") {
        return this.serveDynamoDBStream(event as DynamoDBStreamEvent, ctx);
      }
    }

    if (typeof (record["detail-type"] ?? undefined) === "string") {
      return this.serveEventBridge(event as EventBridgeEvent, ctx);
    }
    if (typeof record["detailType"] === "string") {
      return this.serveEventBridge(event as EventBridgeEvent, ctx);
    }

    if (
      record["requestContext"] &&
      typeof record["requestContext"] === "object"
    ) {
      const rc = record["requestContext"] as Record<string, unknown>;

      if (
        typeof rc["connectionId"] === "string" &&
        String(rc["connectionId"]).trim()
      ) {
        return this.serveWebSocket(
          event as APIGatewayWebSocketProxyRequest,
          ctx,
        );
      }
      if (rc["http"] && typeof rc["http"] === "object") {
        if ("routeKey" in record) {
          return this.serveAPIGatewayV2(event as APIGatewayV2HTTPRequest, ctx);
        }
        return this.serveLambdaFunctionURL(
          event as LambdaFunctionURLRequest,
          ctx,
        );
      }
      if (rc["elb"] && typeof rc["elb"] === "object") {
        const elb = rc["elb"] as Record<string, unknown>;
        if (
          typeof elb["targetGroupArn"] === "string" &&
          String(elb["targetGroupArn"]).trim()
        ) {
          return this.serveALB(event as ALBTargetGroupRequest, ctx);
        }
      }
      if (
        typeof record["httpMethod"] === "string" &&
        String(record["httpMethod"]).trim()
      ) {
        return this.serveAPIGatewayProxy(event as APIGatewayProxyRequest, ctx);
      }
    }

    throw new Error("apptheory: unknown event type");
  }
}

export function createApp(
  options: {
    clock?: Clock;
    ids?: IdGenerator;
    tier?: Tier;
    limits?: Limits;
    cors?: CORSConfig;
    authHook?: AuthHook;
    policyHook?: PolicyHook;
    observability?: ObservabilityHooks;
    webSocketClientFactory?: WebSocketClientFactory;
  } = {},
): App {
  return new App(options);
}

export type LambdaFunctionURLStreamingHandler = (
  event: LambdaFunctionURLRequest,
  ctx?: unknown,
) => Promise<unknown>;

export function createLambdaFunctionURLStreamingHandler(
  app: App,
): LambdaFunctionURLStreamingHandler {
  const aws = (globalThis as unknown as { awslambda?: unknown }).awslambda;
  if (aws && typeof aws === "object" && "streamifyResponse" in aws) {
    type StreamifyResponse = (
      handler: (
        event: LambdaFunctionURLRequest,
        responseStream: HttpResponseStreamLike,
        ctx: unknown,
      ) => unknown,
    ) => unknown;
    const streamify = (aws as { streamifyResponse?: StreamifyResponse })
      .streamifyResponse;
    if (streamify) {
      return streamify(
        (
          event: LambdaFunctionURLRequest,
          responseStream: HttpResponseStreamLike,
          ctx: unknown,
        ) => serveLambdaFunctionURLStreaming(app, event, responseStream, ctx),
      ) as unknown as LambdaFunctionURLStreamingHandler;
    }
  }

  return async (event: LambdaFunctionURLRequest, ctx?: unknown) =>
    app.serveLambdaFunctionURL(event, ctx);
}

type NormalizedTimeoutConfig = {
  defaultTimeoutMs: number;
  operationTimeoutsMs: Record<string, number> | null;
  tenantTimeoutsMs: Record<string, number> | null;
  timeoutMessage: string;
};

function normalizeTimeoutConfig(
  config: TimeoutConfig,
): NormalizedTimeoutConfig {
  let defaultTimeoutMs = Number(config?.defaultTimeoutMs ?? 0);
  if (!Number.isFinite(defaultTimeoutMs)) defaultTimeoutMs = 0;
  defaultTimeoutMs = Math.floor(defaultTimeoutMs);
  if (defaultTimeoutMs === 0) defaultTimeoutMs = 30_000;

  const timeoutMessage =
    String(config?.timeoutMessage ?? "").trim() || "request timeout";

  const operationTimeoutsMs =
    config?.operationTimeoutsMs &&
    typeof config.operationTimeoutsMs === "object"
      ? config.operationTimeoutsMs
      : null;
  const tenantTimeoutsMs =
    config?.tenantTimeoutsMs && typeof config.tenantTimeoutsMs === "object"
      ? config.tenantTimeoutsMs
      : null;

  return {
    defaultTimeoutMs,
    operationTimeoutsMs,
    tenantTimeoutsMs,
    timeoutMessage,
  };
}

function timeoutForContext(
  ctx: Context,
  config: NormalizedTimeoutConfig,
): number {
  let timeoutMs = Number(config?.defaultTimeoutMs ?? 0);
  if (!Number.isFinite(timeoutMs)) timeoutMs = 0;

  const tenant = String(ctx?.tenantId ?? "").trim();
  if (tenant && config?.tenantTimeoutsMs && tenant in config.tenantTimeoutsMs) {
    const override = Number(config.tenantTimeoutsMs[tenant]);
    if (Number.isFinite(override)) {
      timeoutMs = override;
    }
  }

  const method = String(ctx?.request?.method ?? "")
    .trim()
    .toUpperCase();
  const path = String(ctx?.request?.path ?? "").trim() || "/";
  const op = `${method}:${path}`;
  if (config?.operationTimeoutsMs && op in config.operationTimeoutsMs) {
    const override = Number(config.operationTimeoutsMs[op]);
    if (Number.isFinite(override)) {
      timeoutMs = override;
    }
  }

  const remainingMs = Number(ctx?.remainingMs ?? 0);
  if (
    Number.isFinite(remainingMs) &&
    remainingMs > 0 &&
    remainingMs < timeoutMs
  ) {
    timeoutMs = remainingMs;
  }

  timeoutMs = Math.floor(timeoutMs);
  return timeoutMs;
}

export function timeoutMiddleware(config: TimeoutConfig = {}): Middleware {
  const cfg = normalizeTimeoutConfig(config);

  return async (ctx: Context, next: Handler) => {
    const timeoutMs = timeoutForContext(ctx, cfg);
    if (timeoutMs <= 0) {
      return next(ctx);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Response>((_resolve, reject) => {
      void _resolve;
      timer = setTimeout(
        () => reject(new AppError("app.timeout", cfg.timeoutMessage)),
        timeoutMs,
      );
    });

    try {
      const run = Promise.resolve().then(() => next(ctx));
      return await Promise.race([run, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}

function extractTenantId(headers: Headers, query: Query): string {
  const headerTenant = firstHeaderValue(headers, "x-tenant-id");
  if (headerTenant) return headerTenant;
  const values = query["tenant"] ?? [];
  return values.length > 0 ? String(values[0]) : "";
}

function isCorsPreflight(method: string, headers: Headers): boolean {
  return (
    normalizeMethod(method) === "OPTIONS" &&
    Boolean(firstHeaderValue(headers, "access-control-request-method"))
  );
}

function normalizeCorsConfig(
  cors: CORSConfig | undefined,
): NormalizedCORSConfig {
  const allowCredentials = Boolean(cors?.allowCredentials);

  let allowedOrigins: string[] | null = null;
  if (cors && typeof cors === "object" && "allowedOrigins" in cors) {
    const raw = (cors as { allowedOrigins?: unknown }).allowedOrigins;
    if (Array.isArray(raw)) {
      const normalized: string[] = [];
      for (const origin of raw) {
        const trimmed = String(origin ?? "").trim();
        if (!trimmed) continue;
        if (trimmed === "*") {
          allowedOrigins = ["*"];
          break;
        }
        normalized.push(trimmed);
      }
      if (!allowedOrigins) {
        allowedOrigins = normalized;
      }
    }
  }

  let allowHeaders: string[] | null = null;
  if (cors && typeof cors === "object" && "allowHeaders" in cors) {
    const raw = (cors as { allowHeaders?: unknown }).allowHeaders;
    if (Array.isArray(raw)) {
      const normalized: string[] = [];
      for (const header of raw) {
        const trimmed = String(header ?? "").trim();
        if (!trimmed) continue;
        normalized.push(trimmed);
      }
      allowHeaders = normalized;
    }
  }

  return { allowedOrigins, allowCredentials, allowHeaders };
}

function corsOriginAllowed(
  origin: string,
  cors: NormalizedCORSConfig,
): boolean {
  const originValue = String(origin ?? "").trim();
  if (!originValue) return false;

  const allowed = cors.allowedOrigins;
  if (allowed === null) {
    return true;
  }
  if (!Array.isArray(allowed) || allowed.length === 0) {
    return false;
  }
  return allowed.some((entry) => entry === "*" || entry === originValue);
}

function corsAllowHeadersValue(cors: NormalizedCORSConfig): string {
  const headers = Array.isArray(cors.allowHeaders) ? cors.allowHeaders : [];
  if (headers.length > 0) {
    return headers.join(", ");
  }
  if (cors.allowCredentials) {
    return "Content-Type, Authorization";
  }
  return "";
}

function finalizeP1Response(
  resp: Response,
  requestId: string,
  origin: string,
  cors: NormalizedCORSConfig,
): Response {
  const headers = canonicalizeHeaders(resp.headers ?? {});
  if (requestId) {
    headers["x-request-id"] = [String(requestId)];
  }
  if (origin && corsOriginAllowed(origin, cors)) {
    headers["access-control-allow-origin"] = [String(origin)];
    headers["vary"] = vary(headers["vary"], "origin");
    if (cors.allowCredentials) {
      headers["access-control-allow-credentials"] = ["true"];
    }
    const allowHeaders = corsAllowHeadersValue(cors);
    if (allowHeaders) {
      headers["access-control-allow-headers"] = [allowHeaders];
    }
  }
  return { ...resp, headers };
}

function defaultPolicyMessage(code: string): string {
  switch (String(code ?? "").trim()) {
    case "app.rate_limited":
      return "rate limited";
    case "app.overloaded":
      return "overloaded";
    default:
      return "internal error";
  }
}

function extractRemainingMs(ctx: unknown): number {
  if (ctx && typeof ctx === "object") {
    if (
      typeof (ctx as { getRemainingTimeInMillis?: unknown })
        .getRemainingTimeInMillis === "function"
    ) {
      const value = Number(
        (
          ctx as { getRemainingTimeInMillis: () => unknown }
        ).getRemainingTimeInMillis(),
      );
      if (Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
      return 0;
    }
    if ("remaining_ms" in ctx) {
      const value = Number((ctx as Record<string, unknown>)["remaining_ms"]);
      if (Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
      return 0;
    }
  }
  return 0;
}

function recordObservability(
  hooks: ObservabilityHooks | null,
  {
    method,
    path,
    requestId,
    tenantId,
    status,
    errorCode,
  }: {
    method: string;
    path: string;
    requestId: string;
    tenantId: string;
    status: number;
    errorCode: string;
  },
): void {
  if (!hooks) return;

  let level = "info";
  if (status >= 500) {
    level = "error";
  } else if (status >= 400) {
    level = "warn";
  }

  if (typeof hooks.log === "function") {
    hooks.log({
      level,
      event: "request.completed",
      requestId,
      tenantId,
      method,
      path,
      status,
      errorCode,
    });
  }

  if (typeof hooks.metric === "function") {
    hooks.metric({
      name: "apptheory.request",
      value: 1,
      tags: {
        method,
        path,
        status: String(status),
        error_code: errorCode,
        tenant_id: tenantId,
      },
    });
  }

  if (typeof hooks.span === "function") {
    hooks.span({
      name: `http ${method} ${path}`,
      attributes: {
        "http.method": method,
        "http.route": path,
        "http.status_code": String(status),
        "request.id": requestId,
        "tenant.id": tenantId,
        "error.code": errorCode,
      },
    });
  }
}

function formatAllowHeader(methods: string[]): string {
  const unique = new Set<string>();
  for (const m of methods ?? []) {
    const normalized = normalizeMethod(m);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort().join(", ");
}
