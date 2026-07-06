import { Buffer } from "node:buffer";

import type {
  ALBTargetGroupRequest,
  ALBTargetGroupResponse,
  AppSyncResolverEvent,
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
import { AppError, AppTheoryError } from "./errors.js";
import {
  normalizeDynamoDBStreamRecord,
  normalizeEventBridgeWorkloadEnvelope,
} from "./event-workloads.js";
import {
  type HTTPErrorFormat,
  normalizeHTTPErrorFormat,
} from "./http-error-format.js";
import { RandomIdGenerator, type IdGenerator } from "./ids.js";
import {
  applyAppSyncContextValues,
  appSyncErrorResponse,
  appSyncPayloadFromResponse,
  appSyncRequestFromEvent,
  appSyncRequestIdFromContext,
  appSyncRequestIdFromResponse,
  createAppSyncContext,
  isAppSyncResolverEvent,
  requestFromAppSync,
} from "./internal/aws-appsync.js";
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
  normalizeBodyStream,
  normalizeMethod,
  normalizePath,
} from "./internal/http.js";
import { normalizeRequest } from "./internal/request.js";
import {
  errorResponse,
  errorResponseWithFormat,
  errorResponseWithRequestId,
  errorResponseWithRequestIdTraceIdAndFormat,
  normalizeResponse,
  responseForError,
  responseForErrorWithFormat,
  responseForErrorWithRequestId,
  responseForErrorWithRequestIdTraceIdAndFormat,
} from "./internal/response.js";
import { Router } from "./internal/router.js";
import { extractTraceIdFromHeaders } from "./internal/trace-context.js";
import { vary } from "./response.js";
import type { BodyStream, Headers, Query, Request, Response } from "./types.js";
import { WebSocketManagementClient } from "./websocket-management.js";

/** Runtime tier selected for AppTheory request handling. */
export type Tier = "p0" | "p1" | "p2";

/** Request and response byte guardrails for the runtime. */
export interface Limits {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

/** CORS policy applied by P1 and P2 HTTP response finalization. */
export interface CORSConfig {
  allowedOrigins?: string[];
  allowCredentials?: boolean;
  allowHeaders?: string[];
}

/** Per-route registration options. */
export interface RouteOptions {
  authRequired?: boolean;
}

/** Hook that resolves the authenticated identity for protected routes. */
export type AuthHook = (ctx: Context) => string | Promise<string>;

/** Decision returned by a P2 policy hook to fail a request closed. */
export interface PolicyDecision {
  code: string;
  message?: string;
  headers?: Headers;
}

function errorCodeFrom(err: unknown): string {
  if (err instanceof AppTheoryError) {
    const code = String(err.code ?? "").trim();
    return code || "app.internal";
  }
  if (err instanceof AppError) {
    const code = String(err.code ?? "").trim();
    return code || "app.internal";
  }
  return "app.internal";
}

/** P2 policy hook used for rate limiting or load shedding decisions. */
export type PolicyHook = (
  ctx: Context,
) =>
  | PolicyDecision
  | null
  | undefined
  | Promise<PolicyDecision | null | undefined>;

/** Portable P2 request log record emitted by observability hooks. */
export interface LogRecord {
  level: string;
  event: string;
  requestId: string;
  tenantId: string;
  method: string;
  path: string;
  status: number;
  errorCode: string;
  durationMs: number;
  traceId?: string;
  trigger?: string;
  correlationId?: string;
  source?: string;
  detailType?: string;
  tableName?: string;
  eventId?: string;
  eventName?: string;
}

/** Portable P2 metric record emitted by observability hooks. */
export interface MetricRecord {
  name: string;
  value: number;
  durationMs: number;
  tags: Record<string, string>;
}

/** Portable P2 span-shaped record emitted by observability hooks. */
export interface SpanRecord {
  name: string;
  attributes: Record<string, string>;
}

/** Callbacks that receive AppTheory P2 log, metric, and span records. */
export interface ObservabilityHooks {
  log?: (record: LogRecord) => void;
  metric?: (record: MetricRecord) => void;
  span?: (record: SpanRecord) => void;
}

/** Timeout middleware configuration for operations and tenants. */
export interface TimeoutConfig {
  defaultTimeoutMs?: number;
  operationTimeoutsMs?: Record<string, number>;
  tenantTimeoutsMs?: Record<string, number>;
  timeoutMessage?: string;
}

export type { HTTPErrorFormat } from "./http-error-format.js";
export {
  HTTP_ERROR_FORMAT_FLAT_LEGACY,
  HTTP_ERROR_FORMAT_NESTED,
} from "./http-error-format.js";

/** Handler for one SQS message in a batch. */
export type SQSHandler = (
  ctx: EventContext,
  message: SQSMessage,
) => void | Promise<void>;
/** Handler for one Kinesis record in a batch. */
export type KinesisHandler = (
  ctx: EventContext,
  record: KinesisEventRecord,
) => void | Promise<void>;
/** Handler for one SNS record. */
export type SNSHandler = (
  ctx: EventContext,
  record: SNSEventRecord,
) => unknown | Promise<unknown>;
/** Handler for one DynamoDB Streams record in a batch. */
export type DynamoDBStreamHandler = (
  ctx: EventContext,
  record: DynamoDBStreamRecord,
) => void | Promise<void>;
/** Handler for an EventBridge event. */
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
type RequestContextOptions = {
  appSync?: ReturnType<Context["asAppSync"]>;
  configure?: (requestCtx: Context) => void;
  errorResponder?: (
    err: unknown,
    request: Request,
    requestId: string,
    traceId?: string,
  ) => Response;
  fallbackRequestId?: string;
};

/** Contract-first application container for routes, middleware, and Lambda event dispatch. */
export class App {
  private readonly _router: Router<Handler>;
  private readonly _clock: Clock;
  private readonly _ids: IdGenerator;
  private readonly _tier: Tier;
  private readonly _httpErrorFormat: HTTPErrorFormat;
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
      httpErrorFormat?: HTTPErrorFormat;
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
    this._httpErrorFormat = normalizeHTTPErrorFormat(options.httpErrorFormat);
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

  /** Returns the configured HTTP error-envelope format. */
  getHTTPErrorFormat(): HTTPErrorFormat {
    return this._httpErrorFormat;
  }

  /** Registers a handler for an HTTP method and route pattern. */
  handle(
    method: string,
    pattern: string,
    handler: Handler,
    options: RouteOptions = {},
  ): this {
    this._router.add(method, pattern, handler, options);
    return this;
  }

  /**
   * Registers a route and throws registration errors.
   *
   * @deprecated handle now fails closed on invalid registrations. Use handle
   * for normal application registration and catch errors during tests only when
   * required.
   */
  handleStrict(
    method: string,
    pattern: string,
    handler: Handler,
    options: RouteOptions = {},
  ): this {
    this._router.addStrict(method, pattern, handler, options);
    return this;
  }

  /** Registers a GET route handler. */
  get(pattern: string, handler: Handler): this {
    return this.handle("GET", pattern, handler);
  }

  /** Registers a POST route handler. */
  post(pattern: string, handler: Handler): this {
    return this.handle("POST", pattern, handler);
  }

  /** Registers a PUT route handler. */
  put(pattern: string, handler: Handler): this {
    return this.handle("PUT", pattern, handler);
  }

  /** Registers a PATCH route handler. */
  patch(pattern: string, handler: Handler): this {
    return this.handle("PATCH", pattern, handler);
  }

  /** Registers an OPTIONS route handler. */
  options(pattern: string, handler: Handler): this {
    return this.handle("OPTIONS", pattern, handler);
  }

  /** Registers a DELETE route handler. */
  delete(pattern: string, handler: Handler): this {
    return this.handle("DELETE", pattern, handler);
  }

  /** Appends HTTP middleware around route handlers. */
  use(middleware: Middleware): this {
    if (typeof middleware !== "function") return this;
    this._middlewares.push(middleware);
    return this;
  }

  /** Appends event middleware around event workload handlers. */
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

  private _httpErrorResponse(
    code: string,
    message: string,
    headers: Headers = {},
  ): Response {
    return errorResponseWithFormat(
      this._httpErrorFormat,
      code,
      message,
      headers,
    );
  }

  private _httpErrorResponseWithRequestIdTraceId(
    code: string,
    message: string,
    headers: Headers = {},
    requestId: string = "",
    traceId: string = "",
  ): Response {
    return errorResponseWithRequestIdTraceIdAndFormat(
      this._httpErrorFormat,
      code,
      message,
      headers,
      requestId,
      traceId,
    );
  }

  private _responseForHTTPError(err: unknown): Response {
    return responseForErrorWithFormat(this._httpErrorFormat, err);
  }

  private _responseForHTTPErrorWithRequestIdTraceId(
    err: unknown,
    requestId: string,
    traceId: string,
  ): Response {
    return responseForErrorWithRequestIdTraceIdAndFormat(
      this._httpErrorFormat,
      err,
      requestId,
      traceId,
    );
  }

  /** Registers a WebSocket route handler by route key. */
  webSocket(routeKey: string, handler: Handler): this {
    const key = String(routeKey ?? "").trim();
    if (!key || typeof handler !== "function") return this;
    this._webSocketRoutes.push({ routeKey: key, handler });
    return this;
  }

  /** Registers an SQS queue handler by queue name. */
  sqs(queueName: string, handler: SQSHandler): this {
    const name = String(queueName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._sqsRoutes.push({ queueName: name, handler });
    return this;
  }

  /** Registers a Kinesis stream handler by stream name. */
  kinesis(streamName: string, handler: KinesisHandler): this {
    const name = String(streamName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._kinesisRoutes.push({ streamName: name, handler });
    return this;
  }

  /** Registers an SNS topic handler by topic name. */
  sns(topicName: string, handler: SNSHandler): this {
    const name = String(topicName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._snsRoutes.push({ topicName: name, handler });
    return this;
  }

  /** Registers an EventBridge handler for a selector. */
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

  /** Registers a DynamoDB Streams handler by table name. */
  dynamoDB(tableName: string, handler: DynamoDBStreamHandler): this {
    const name = String(tableName ?? "").trim();
    if (!name || typeof handler !== "function") return this;
    this._dynamoDBRoutes.push({ tableName: name, handler });
    return this;
  }

  /** Serves a normalized AppTheory request and returns a normalized response. */
  async serve(request: Request, ctx?: unknown): Promise<Response> {
    return this._serve(request, ctx);
  }

  private async _serve(
    request: Request,
    ctx?: unknown,
    contextOptions?: RequestContextOptions,
  ): Promise<Response> {
    const respondToServeError = (
      err: unknown,
      errorRequest: Request,
      requestId: string,
      traceId = "",
    ): Response => {
      if (typeof contextOptions?.errorResponder === "function") {
        return contextOptions.errorResponder(
          err,
          errorRequest,
          requestId,
          traceId,
        );
      }
      if (requestId) {
        const resolvedTraceId =
          String(traceId ?? "").trim() ||
          String(errorRequest?.traceId ?? "").trim();
        return this._responseForHTTPErrorWithRequestIdTraceId(
          err,
          requestId,
          resolvedTraceId,
        );
      }
      return this._responseForHTTPError(err);
    };

    if (this._tier === "p0") {
      let normalized: Context["request"];
      try {
        normalized = normalizeRequest(request);
      } catch (err) {
        return respondToServeError(
          err,
          request,
          String(contextOptions?.fallbackRequestId ?? "").trim(),
        );
      }

      const { match, allowed } = this._router.match(
        normalized.method,
        normalized.path,
      );
      if (!match) {
        if (typeof contextOptions?.errorResponder === "function") {
          if (allowed.length > 0) {
            return respondToServeError(
              new AppError("app.method_not_allowed", "method not allowed"),
              normalized,
              String(contextOptions?.fallbackRequestId ?? "").trim(),
            );
          }
          return respondToServeError(
            new AppError("app.not_found", "not found"),
            normalized,
            String(contextOptions?.fallbackRequestId ?? "").trim(),
          );
        }
        if (allowed.length > 0) {
          return this._httpErrorResponse(
            "app.method_not_allowed",
            "method not allowed",
            {
              allow: [formatAllowHeader(allowed)],
            },
          );
        }
        return this._httpErrorResponse("app.not_found", "not found");
      }

      const requestCtx = new Context({
        request: normalized,
        params: match.params,
        clock: this._clock,
        ids: this._ids,
        ctx,
        traceId: normalized.traceId,
        appSync: contextOptions?.appSync ?? null,
      });
      contextOptions?.configure?.(requestCtx);

      try {
        const handler = this._applyMiddlewares(match.route.handler) as Handler;
        const out = await handler(requestCtx);
        if (!out) {
          return respondToServeError(
            new AppError("app.internal", "internal error"),
            normalized,
            String(contextOptions?.fallbackRequestId ?? "").trim(),
          );
        }
        return normalizeResponse(out);
      } catch (err) {
        return respondToServeError(
          err,
          normalized,
          String(contextOptions?.fallbackRequestId ?? "").trim(),
        );
      }
    }

    const startedAtMs = this._clock.now().valueOf();
    const preHeaders = canonicalizeHeaders(request.headers);
    const preQuery = cloneQuery(request.query);
    let traceId = extractTraceIdFromHeaders(preHeaders);
    let method = normalizeMethod(request.method);
    let path = normalizePath(request.path);

    let requestId = firstHeaderValue(preHeaders, "x-request-id");
    if (!requestId) {
      requestId = String(contextOptions?.fallbackRequestId ?? "").trim();
      if (!requestId) {
        requestId = this._ids.newId();
      }
    }
    const origin = firstHeaderValue(preHeaders, "origin");

    const middlewareTrace = ["request_id", "recovery", "logging"];
    if (origin) middlewareTrace.push("cors");

    const tenantId = extractTenantId(preHeaders, preQuery);
    const remainingMs = extractRemainingMs(ctx);
    const tier = this._tier;

    const finish = (resp: Response, errCode?: string): Response => {
      const out = finalizeP1Response(resp, requestId, origin, this._cors);
      if (tier === "p2") {
        recordObservability(this._observability, {
          method,
          path,
          requestId,
          tenantId,
          traceId,
          status: out.status,
          errorCode: errCode ?? "",
          durationMs: durationMs(startedAtMs, this._clock.now().valueOf()),
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
      normalized = normalizeRequest(request, this._limits.maxRequestBytes);
    } catch (err) {
      const code = errorCodeFrom(err);
      return finish(
        respondToServeError(err, request, requestId, traceId),
        code,
      );
    }

    method = normalized.method;
    path = normalized.path;
    traceId = normalized.traceId;

    if (
      this._limits.maxRequestBytes > 0 &&
      Buffer.from(normalized.body).length > this._limits.maxRequestBytes
    ) {
      if (typeof contextOptions?.errorResponder === "function") {
        return finish(
          respondToServeError(
            new AppError("app.too_large", "request too large"),
            normalized,
            requestId,
            traceId,
          ),
          "app.too_large",
        );
      }
      return finish(
        this._httpErrorResponseWithRequestIdTraceId(
          "app.too_large",
          "request too large",
          {},
          requestId,
          traceId,
        ),
        "app.too_large",
      );
    }

    const { match, allowed } = this._router.match(
      normalized.method,
      normalized.path,
    );
    if (!match) {
      if (typeof contextOptions?.errorResponder === "function") {
        if (allowed.length > 0) {
          return finish(
            respondToServeError(
              new AppError("app.method_not_allowed", "method not allowed"),
              normalized,
              requestId,
              traceId,
            ),
            "app.method_not_allowed",
          );
        }
        return finish(
          respondToServeError(
            new AppError("app.not_found", "not found"),
            normalized,
            requestId,
            traceId,
          ),
          "app.not_found",
        );
      }
      if (allowed.length > 0) {
        return finish(
          this._httpErrorResponseWithRequestIdTraceId(
            "app.method_not_allowed",
            "method not allowed",
            { allow: [formatAllowHeader(allowed)] },
            requestId,
            traceId,
          ),
          "app.method_not_allowed",
        );
      }
      return finish(
        this._httpErrorResponseWithRequestIdTraceId(
          "app.not_found",
          "not found",
          {},
          requestId,
          traceId,
        ),
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
      traceId,
      tenantId,
      authIdentity: "",
      remainingMs,
      middlewareTrace,
      appSync: contextOptions?.appSync ?? null,
    });
    contextOptions?.configure?.(requestCtx);

    if (tier === "p2" && typeof this._policyHook === "function") {
      let decision: PolicyDecision | null | undefined;
      try {
        decision = await this._policyHook(requestCtx);
      } catch (err) {
        const code = errorCodeFrom(err);
        return finish(
          respondToServeError(err, normalized, requestId, traceId),
          code,
        );
      }

      const code = String(decision?.code ?? "").trim();
      if (code) {
        const message =
          String(decision?.message ?? "").trim() || defaultPolicyMessage(code);
        if (typeof contextOptions?.errorResponder === "function") {
          return finish(
            respondToServeError(
              new AppError(code, message),
              normalized,
              requestId,
              traceId,
            ),
            code,
          );
        }
        return finish(
          this._httpErrorResponseWithRequestIdTraceId(
            code,
            message,
            decision?.headers ?? {},
            requestId,
            traceId,
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
        const code = errorCodeFrom(err);
        return finish(
          respondToServeError(err, normalized, requestId, traceId),
          code,
        );
      }
    }

    middlewareTrace.push("handler");

    let out: Response | null;
    try {
      const handler = this._applyMiddlewares(match.route.handler) as Handler;
      out = await handler(requestCtx);
    } catch (err) {
      const code = errorCodeFrom(err);
      return finish(
        respondToServeError(err, normalized, requestId, traceId),
        code,
      );
    }

    if (!out) {
      return finish(
        respondToServeError(
          new AppError("app.internal", "internal error"),
          normalized,
          requestId,
          traceId,
        ),
        "app.internal",
      );
    }

    let resp: Response;
    try {
      resp = normalizeResponse(out);
    } catch (err) {
      const code = errorCodeFrom(err);
      return finish(
        respondToServeError(err, normalized, requestId, traceId),
        code,
      );
    }

    if (
      this._limits.maxResponseBytes > 0 &&
      resp.body.length > this._limits.maxResponseBytes
    ) {
      if (typeof contextOptions?.errorResponder === "function") {
        return finish(
          respondToServeError(
            new AppError("app.too_large", "response too large"),
            normalized,
            requestId,
            traceId,
          ),
          "app.too_large",
        );
      }
      return finish(
        this._httpErrorResponseWithRequestIdTraceId(
          "app.too_large",
          "response too large",
          {},
          requestId,
          traceId,
        ),
        "app.too_large",
      );
    }

    if (this._limits.maxResponseBytes > 0 && resp.bodyStream) {
      resp = {
        ...resp,
        bodyStream: limitResponseBodyStream(
          resp.bodyStream,
          resp.body.length,
          this._limits.maxResponseBytes,
        ),
      };
    }

    return finish(resp, "");
  }

  /** Serves an API Gateway HTTP API v2 event. */
  async serveAPIGatewayV2(
    event: APIGatewayV2HTTPRequest,
    ctx?: unknown,
  ): Promise<APIGatewayV2HTTPResponse> {
    let request: Request;
    try {
      request = requestFromAPIGatewayV2(event);
    } catch (err) {
      return apigatewayV2ResponseFromResponse(this._responseForHTTPError(err));
    }
    const resp = await this.serve(request, ctx);
    return apigatewayV2ResponseFromResponse(resp);
  }

  /** Serves a Lambda Function URL event. */
  async serveLambdaFunctionURL(
    event: LambdaFunctionURLRequest,
    ctx?: unknown,
  ): Promise<LambdaFunctionURLResponse> {
    let request: Request;
    try {
      request = requestFromLambdaFunctionURL(event);
    } catch (err) {
      return lambdaFunctionURLResponseFromResponse(
        this._responseForHTTPError(err),
      );
    }
    const resp = await this.serve(request, ctx);
    return lambdaFunctionURLResponseFromResponse(resp);
  }

  /** Serves an API Gateway REST proxy event. */
  async serveAPIGatewayProxy(
    event: APIGatewayProxyRequest,
    ctx?: unknown,
  ): Promise<APIGatewayProxyResponse> {
    let request: Request;
    try {
      request = requestFromAPIGatewayProxy(event);
    } catch (err) {
      return apigatewayProxyResponseFromResponse(
        this._responseForHTTPError(err),
      );
    }
    const resp = await this.serve(request, ctx);
    return apigatewayProxyResponseFromResponse(resp);
  }

  /** Serves an ALB target group event. */
  async serveALB(
    event: ALBTargetGroupRequest,
    ctx?: unknown,
  ): Promise<ALBTargetGroupResponse> {
    let request: Request;
    try {
      request = requestFromALBTargetGroup(event);
    } catch (err) {
      return albTargetGroupResponseFromResponse(
        this._responseForHTTPError(err),
      );
    }
    const resp = await this.serve(request, ctx);
    return albTargetGroupResponseFromResponse(resp);
  }

  /** Serves an AppSync direct Lambda resolver event. */
  async serveAppSync(
    event: AppSyncResolverEvent,
    ctx?: unknown,
  ): Promise<unknown> {
    const fallbackRequestId = appSyncRequestIdFromContext(ctx);
    const requestMetadata = appSyncRequestFromEvent(event);
    let request: Request;
    try {
      request = requestFromAppSync(event);
    } catch (err) {
      return appSyncPayloadFromResponse(
        appSyncErrorResponse(err, requestMetadata, fallbackRequestId),
      );
    }

    let resp: Response | null = null;
    try {
      resp = await this._serve(request, ctx, {
        appSync: createAppSyncContext(event),
        fallbackRequestId,
        configure: (requestCtx) => {
          applyAppSyncContextValues(requestCtx, event);
        },
        errorResponder: (err, errorRequest, requestId) =>
          appSyncErrorResponse(err, errorRequest, requestId),
      });
      return appSyncPayloadFromResponse(resp);
    } catch (err) {
      return appSyncPayloadFromResponse(
        appSyncErrorResponse(
          err,
          requestMetadata,
          resp
            ? appSyncRequestIdFromResponse(resp, fallbackRequestId)
            : fallbackRequestId,
        ),
      );
    }
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

  /** Serves an API Gateway WebSocket event. */
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
      managementEndpoint: webSocketManagementEndpoint(
        domainName,
        stage,
        String(event?.path ?? "").trim(),
      ),
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

  /** Serves an SQS event with partial-batch failure output. */
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

  /** Serves a Kinesis event with partial-batch failure output. */
  async serveKinesisEvent(
    event: KinesisEvent,
    ctx?: unknown,
  ): Promise<KinesisEventResponse> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._kinesisHandlerForEvent(event);
    if (!handler) {
      const failures = records
        .map(kinesisRecordSequenceNumber)
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
          itemIdentifier: kinesisRecordSequenceNumber(record),
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

  /** Serves an SNS event through the registered topic handler. */
  async serveSNSEvent(event: SNSEvent, ctx?: unknown): Promise<unknown[]> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._snsHandlerForEvent(event);
    if (!handler) {
      throw new Error("apptheory: unrecognized sns topic");
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

    const source = String(event?.source ?? "").trim();
    const detailType = String(
      (event as Record<string, unknown>)["detail-type"] ??
        event?.detailType ??
        "",
    ).trim();

    if (resources.length === 0 && !source && !detailType) return null;

    for (const route of this._eventBridgeRoutes) {
      const sel = route.selector ?? {};
      if (sel.ruleName) {
        let matched = false;
        for (const resource of resources) {
          if (eventBridgeRuleNameFromArn(resource) === sel.ruleName) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
        return route.handler;
      }

      if (sel.source && sel.source !== source) continue;
      if (sel.detailType && sel.detailType !== detailType) continue;
      return route.handler;
    }
    return null;
  }

  /** Serves an EventBridge event through registered selectors. */
  async serveEventBridge(
    event: EventBridgeEvent,
    ctx?: unknown,
  ): Promise<unknown> {
    const handler = this._eventBridgeHandlerForEvent(event);
    if (!handler) {
      return null;
    }
    const eventCtx = this._eventContext(ctx);
    const observation = eventBridgeObservation(eventCtx, event);
    const wrapped = this._applyEventMiddlewares(handler);
    try {
      const out = await (wrapped ?? handler)(eventCtx, event);
      recordEventObservability(this._observability, observation, "success", "");
      return out;
    } catch (err) {
      recordEventObservability(
        this._observability,
        observation,
        "error",
        "app.internal",
      );
      throw sanitizeEventWorkloadError(err);
    }
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

  /** Serves a DynamoDB Streams event with partial-batch failure output. */
  async serveDynamoDBStream(
    event: DynamoDBStreamEvent,
    ctx?: unknown,
  ): Promise<DynamoDBStreamEventResponse> {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    const handler = this._dynamoDBHandlerForEvent(event);
    const eventCtx = this._eventContext(ctx);
    let failures: Array<{ itemIdentifier: string }> = [];

    const wrapped = this._applyEventMiddlewares(handler);
    for (const record of records) {
      let recordError: unknown = null;
      try {
        if (!handler) {
          throw eventWorkloadFailedError();
        }
        await (wrapped ?? handler)(eventCtx, record);
      } catch (err) {
        recordError = err;
      }

      const observation = dynamoDBStreamObservation(eventCtx, record);
      if (recordError) {
        failures.push({
          itemIdentifier: dynamoDBStreamSequenceNumber(record),
        });
        recordEventObservability(
          this._observability,
          observation,
          "error",
          "app.internal",
        );
        continue;
      }
      recordEventObservability(this._observability, observation, "success", "");
    }

    failures = failures.filter((f) => f.itemIdentifier);
    return { batchItemFailures: failures };
  }

  /** Detects and dispatches a supported Lambda event shape through one entrypoint. */
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
    if (isAppSyncResolverEvent(event)) {
      return this.serveAppSync(event as AppSyncResolverEvent, ctx);
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

/** Creates an AppTheory application with the provided runtime options. */
export function createApp(
  options: {
    clock?: Clock;
    ids?: IdGenerator;
    tier?: Tier;
    httpErrorFormat?: HTTPErrorFormat;
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

/** Lambda Function URL streaming handler produced for AWS Lambda runtimes. */
export type LambdaFunctionURLStreamingHandler = (
  event: LambdaFunctionURLRequest,
  ctx?: unknown,
) => Promise<unknown>;

/** Creates a Lambda Function URL streaming handler for an AppTheory app. */
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

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

function abortSignalFromTimeoutCarrier(value: unknown): AbortSignal | null {
  if (isAbortSignalLike(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const signal = (value as { signal?: unknown }).signal;
    if (isAbortSignalLike(signal)) {
      return signal;
    }
  }
  return null;
}

function timeoutContextCarrier(parent: unknown, signal: AbortSignal): unknown {
  if (parent == null) {
    return signal;
  }
  if (typeof parent === "object") {
    return { ...parent, signal };
  }
  return { parent, signal };
}

function cloneContextWithTimeoutCarrier(
  ctx: Context,
  carrier: unknown,
): Context {
  const ctxInternal = ctx as unknown as {
    _clock: Clock;
    _ids: IdGenerator;
    _values: Map<string, unknown>;
  };
  const clone = new Context({
    request: ctx.request,
    params: ctx.params,
    clock: ctxInternal._clock,
    ids: ctxInternal._ids,
    ctx: carrier,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    tenantId: ctx.tenantId,
    authIdentity: ctx.authIdentity,
    remainingMs: ctx.remainingMs,
    middlewareTrace: ctx.middlewareTrace,
    webSocket: ctx.asWebSocket(),
    appSync: ctx.asAppSync(),
  });
  const cloneInternal = clone as unknown as { _values: Map<string, unknown> };
  cloneInternal._values = ctxInternal._values;
  return clone;
}

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

/** Creates middleware that fails requests closed when timeout policy expires. */
export function timeoutMiddleware(config: TimeoutConfig = {}): Middleware {
  const cfg = normalizeTimeoutConfig(config);

  return async (ctx: Context, next: Handler) => {
    const timeoutMs = timeoutForContext(ctx, cfg);
    if (timeoutMs <= 0) {
      return next(ctx);
    }

    const controller = new AbortController();
    const parentSignal = abortSignalFromTimeoutCarrier(ctx?.ctx ?? null);
    let removeParentAbortListener = () => {};
    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        const onParentAbort = () => controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        removeParentAbortListener = () =>
          parentSignal.removeEventListener("abort", onParentAbort);
      }
    }

    const handlerCtx = cloneContextWithTimeoutCarrier(
      ctx,
      timeoutContextCarrier(ctx?.ctx ?? null, controller.signal),
    );

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      controller.abort(cfg.timeoutMessage);
    }, timeoutMs);

    let removeTimeoutAbortListener = () => {};
    const timeoutPromise = new Promise<Response>((_resolve, reject) => {
      void _resolve;
      const onAbort = () =>
        reject(new AppError("app.timeout", cfg.timeoutMessage));
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeTimeoutAbortListener = () =>
        controller.signal.removeEventListener("abort", onAbort);
    });

    try {
      const run = Promise.resolve().then(() => next(handlerCtx));
      return await Promise.race([run, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      removeTimeoutAbortListener();
      removeParentAbortListener();
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
    return !cors.allowCredentials;
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

function limitResponseBodyStream(
  bodyStream: BodyStream,
  initialBytes: number,
  maxResponseBytes: number,
): AsyncIterable<Uint8Array> {
  return (async function* () {
    let emitted = Math.max(0, Number(initialBytes) || 0);
    for await (const chunk of normalizeBodyStream(bodyStream)) {
      const bytes = Buffer.from(chunk ?? []);
      if (bytes.length === 0) {
        yield bytes;
        continue;
      }
      if (emitted + bytes.length > maxResponseBytes) {
        throw new AppError("app.too_large", "response too large");
      }
      emitted += bytes.length;
      yield bytes;
    }
  })();
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

type EventObservation = {
  trigger: string;
  requestId: string;
  correlationId: string;
  source: string;
  detailType: string;
  tableName: string;
  eventId: string;
  eventName: string;
};

const EVENT_WORKLOAD_FAILED_MESSAGE = "apptheory: event workload failed";
const EVENT_TRIGGER_EVENTBRIDGE = "eventbridge";
const EVENT_TRIGGER_DYNAMODB_STREAM = "dynamodb_stream";

function eventWorkloadFailedError(): Error {
  return new Error(EVENT_WORKLOAD_FAILED_MESSAGE);
}

function kinesisRecordSequenceNumber(record: KinesisEventRecord): string {
  return String(record?.kinesis?.sequenceNumber ?? "").trim();
}

function dynamoDBStreamSequenceNumber(record: DynamoDBStreamRecord): string {
  const change = record?.dynamodb;
  if (!change || typeof change !== "object") return "";
  return String(
    (change as Record<string, unknown>)["SequenceNumber"] ?? "",
  ).trim();
}

function sanitizeEventWorkloadError(err: unknown): Error {
  if (isSafeEventError(err)) {
    return err;
  }
  return eventWorkloadFailedError();
}

function isSafeEventError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  return (err as Error & { safeEventError?: unknown }).safeEventError === true;
}

function eventBridgeObservation(
  ctx: EventContext,
  event: EventBridgeEvent,
): EventObservation {
  const envelope = normalizeEventBridgeWorkloadEnvelope(ctx, event);
  return {
    trigger: EVENT_TRIGGER_EVENTBRIDGE,
    requestId: envelope.request_id,
    correlationId: envelope.correlation_id,
    source: envelope.source,
    detailType: envelope.detail_type,
    tableName: "",
    eventId: "",
    eventName: "",
  };
}

function dynamoDBStreamObservation(
  ctx: EventContext,
  record: DynamoDBStreamRecord,
): EventObservation {
  const summary = normalizeDynamoDBStreamRecord(record);
  return {
    trigger: EVENT_TRIGGER_DYNAMODB_STREAM,
    requestId: eventContextRequestId(ctx),
    correlationId: summary.event_id,
    source: "",
    detailType: "",
    tableName: summary.table_name,
    eventId: summary.event_id,
    eventName: summary.event_name,
  };
}

function eventContextRequestId(ctx: EventContext | null | undefined): string {
  return typeof ctx?.requestId === "string" ? ctx.requestId.trim() : "";
}

function recordEventObservability(
  hooks: ObservabilityHooks | null,
  observation: EventObservation,
  outcome: string,
  errorCode: string,
): void {
  if (!hooks) return;

  const level = errorCode || outcome === "error" ? "error" : "info";

  if (typeof hooks.log === "function") {
    const record: LogRecord = {
      level,
      event: "event.completed",
      requestId: observation.requestId,
      tenantId: "",
      method: "",
      path: "",
      status: 0,
      errorCode,
      durationMs: 0,
    };
    addNonEmptyLogField(record, "trigger", observation.trigger);
    addNonEmptyLogField(record, "correlationId", observation.correlationId);
    addNonEmptyLogField(record, "source", observation.source);
    addNonEmptyLogField(record, "detailType", observation.detailType);
    addNonEmptyLogField(record, "tableName", observation.tableName);
    addNonEmptyLogField(record, "eventId", observation.eventId);
    addNonEmptyLogField(record, "eventName", observation.eventName);
    hooks.log(record);
  }

  if (typeof hooks.metric === "function") {
    hooks.metric({
      name: "apptheory.event",
      value: 1,
      durationMs: 0,
      tags: eventMetricTags(observation, outcome, errorCode),
    });
  }

  if (typeof hooks.span === "function") {
    hooks.span({
      name: eventSpanName(observation),
      attributes: eventSpanAttributes(observation, outcome, errorCode),
    });
  }
}

function addNonEmptyLogField(
  record: LogRecord,
  field: keyof LogRecord,
  value: string,
): void {
  const normalized = String(value ?? "").trim();
  if (!normalized) return;
  (record as unknown as Record<string, unknown>)[field] = normalized;
}

function eventMetricTags(
  observation: EventObservation,
  outcome: string,
  errorCode: string,
): Record<string, string> {
  const tags: Record<string, string> = {
    correlation_id: observation.correlationId,
    error_code: errorCode,
    outcome,
    trigger: observation.trigger,
  };
  if (observation.trigger === EVENT_TRIGGER_EVENTBRIDGE) {
    tags["detail_type"] = observation.detailType;
    tags["source"] = observation.source;
  } else if (observation.trigger === EVENT_TRIGGER_DYNAMODB_STREAM) {
    tags["event_name"] = observation.eventName;
    tags["table_name"] = observation.tableName;
  }
  return tags;
}

function eventSpanName(observation: EventObservation): string {
  if (observation.trigger === EVENT_TRIGGER_EVENTBRIDGE) {
    return `${EVENT_TRIGGER_EVENTBRIDGE} ${observation.source} ${observation.detailType}`;
  }
  if (observation.trigger === EVENT_TRIGGER_DYNAMODB_STREAM) {
    return `${EVENT_TRIGGER_DYNAMODB_STREAM} ${observation.tableName} ${observation.eventName}`;
  }
  return observation.trigger;
}

function eventSpanAttributes(
  observation: EventObservation,
  outcome: string,
  errorCode: string,
): Record<string, string> {
  const attrs: Record<string, string> = {
    "correlation.id": observation.correlationId,
    "error.code": errorCode,
    outcome,
    trigger: observation.trigger,
  };
  if (observation.trigger === EVENT_TRIGGER_EVENTBRIDGE) {
    attrs["event.detail_type"] = observation.detailType;
    attrs["event.source"] = observation.source;
  } else if (observation.trigger === EVENT_TRIGGER_DYNAMODB_STREAM) {
    attrs["dynamodb.event_id"] = observation.eventId;
    attrs["dynamodb.event_name"] = observation.eventName;
    attrs["dynamodb.table_name"] = observation.tableName;
  }
  return attrs;
}

function recordObservability(
  hooks: ObservabilityHooks | null,
  {
    method,
    path,
    requestId,
    tenantId,
    traceId,
    status,
    errorCode,
    durationMs: requestDurationMs,
  }: {
    method: string;
    path: string;
    requestId: string;
    tenantId: string;
    traceId: string;
    status: number;
    errorCode: string;
    durationMs: number;
  },
): void {
  if (!hooks) return;

  const observedDurationMs = Math.max(0, Math.trunc(requestDurationMs));

  let level = "info";
  if (status >= 500) {
    level = "error";
  } else if (status >= 400) {
    level = "warn";
  }

  if (typeof hooks.log === "function") {
    const logRecord: LogRecord = {
      level,
      event: "request.completed",
      requestId,
      tenantId,
      method,
      path,
      status,
      errorCode,
      durationMs: observedDurationMs,
    };
    const resolvedTraceId = String(traceId ?? "").trim();
    if (resolvedTraceId) {
      logRecord.traceId = resolvedTraceId;
    }
    hooks.log(logRecord);
  }

  if (typeof hooks.metric === "function") {
    hooks.metric({
      name: "apptheory.request",
      value: 1,
      durationMs: observedDurationMs,
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
    const attributes: Record<string, string> = {
      "http.method": method,
      "http.route": path,
      "http.status_code": String(status),
      "request.id": requestId,
      "tenant.id": tenantId,
      "error.code": errorCode,
    };
    const resolvedTraceId = String(traceId ?? "").trim();
    if (resolvedTraceId) {
      attributes["trace.id"] = resolvedTraceId;
    }
    hooks.span({
      name: `http ${method} ${path}`,
      attributes,
    });
  }
}

function durationMs(startedAtMs: number, finishedAtMs: number): number {
  const delta = Math.trunc(finishedAtMs - startedAtMs);
  return delta > 0 ? delta : 0;
}

function formatAllowHeader(methods: string[]): string {
  const unique = new Set<string>();
  for (const m of methods ?? []) {
    const normalized = normalizeMethod(m);
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort().join(", ");
}
