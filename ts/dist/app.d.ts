import type { ALBTargetGroupRequest, ALBTargetGroupResponse, AppSyncResolverEvent, APIGatewayProxyRequest, APIGatewayProxyResponse, APIGatewayV2HTTPRequest, APIGatewayV2HTTPResponse, APIGatewayWebSocketProxyRequest, DynamoDBStreamEvent, DynamoDBStreamEventResponse, DynamoDBStreamRecord, EventBridgeEvent, EventBridgeSelector, KinesisEvent, KinesisEventResponse, KinesisEventRecord, LambdaFunctionURLRequest, LambdaFunctionURLResponse, SNSEvent, SNSEventRecord, SQSEvent, SQSEventResponse, SQSMessage } from "./aws-types.js";
import { type Clock } from "./clock.js";
import { Context, EventContext } from "./context.js";
import type { EventMiddleware, Handler, Middleware, WebSocketClientFactory } from "./context.js";
import { type HTTPErrorFormat } from "./http-error-format.js";
import { type IdGenerator } from "./ids.js";
import type { Headers, Request, Response } from "./types.js";
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
/** P2 policy hook used for rate limiting or load shedding decisions. */
export type PolicyHook = (ctx: Context) => PolicyDecision | null | undefined | Promise<PolicyDecision | null | undefined>;
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
export { HTTP_ERROR_FORMAT_FLAT_LEGACY, HTTP_ERROR_FORMAT_NESTED, } from "./http-error-format.js";
/** Handler for one SQS message in a batch. */
export type SQSHandler = (ctx: EventContext, message: SQSMessage) => void | Promise<void>;
/** Handler for one Kinesis record in a batch. */
export type KinesisHandler = (ctx: EventContext, record: KinesisEventRecord) => void | Promise<void>;
/** Handler for one SNS record. */
export type SNSHandler = (ctx: EventContext, record: SNSEventRecord) => unknown | Promise<unknown>;
/** Handler for one DynamoDB Streams record in a batch. */
export type DynamoDBStreamHandler = (ctx: EventContext, record: DynamoDBStreamRecord) => void | Promise<void>;
/** Handler for an EventBridge event. */
export type EventBridgeHandler = (ctx: EventContext, event: EventBridgeEvent) => unknown | Promise<unknown>;
/** Contract-first application container for routes, middleware, and Lambda event dispatch. */
export declare class App {
    private readonly _router;
    private readonly _clock;
    private readonly _ids;
    private readonly _tier;
    private readonly _httpErrorFormat;
    private readonly _limits;
    private readonly _cors;
    private readonly _authHook;
    private readonly _policyHook;
    private readonly _observability;
    private readonly _webSocketRoutes;
    private readonly _webSocketClientFactory;
    private readonly _sqsRoutes;
    private readonly _kinesisRoutes;
    private readonly _snsRoutes;
    private readonly _eventBridgeRoutes;
    private readonly _dynamoDBRoutes;
    private readonly _middlewares;
    private readonly _eventMiddlewares;
    constructor(options?: {
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
    });
    /** Returns the configured HTTP error-envelope format. */
    getHTTPErrorFormat(): HTTPErrorFormat;
    /** Registers a handler for an HTTP method and route pattern. */
    handle(method: string, pattern: string, handler: Handler, options?: RouteOptions): this;
    /**
     * Registers a route and throws registration errors.
     *
     * @deprecated handle now fails closed on invalid registrations. Use handle
     * for normal application registration and catch errors during tests only when
     * required.
     */
    handleStrict(method: string, pattern: string, handler: Handler, options?: RouteOptions): this;
    /** Registers a GET route handler. */
    get(pattern: string, handler: Handler): this;
    /** Registers a POST route handler. */
    post(pattern: string, handler: Handler): this;
    /** Registers a PUT route handler. */
    put(pattern: string, handler: Handler): this;
    /** Registers a PATCH route handler. */
    patch(pattern: string, handler: Handler): this;
    /** Registers an OPTIONS route handler. */
    options(pattern: string, handler: Handler): this;
    /** Registers a DELETE route handler. */
    delete(pattern: string, handler: Handler): this;
    /** Appends HTTP middleware around route handlers. */
    use(middleware: Middleware): this;
    /** Appends event middleware around event workload handlers. */
    useEvents(middleware: EventMiddleware): this;
    private _applyMiddlewares;
    private _applyEventMiddlewares;
    private _httpErrorResponse;
    private _httpErrorResponseWithRequestIdTraceId;
    private _responseForHTTPError;
    private _responseForHTTPErrorWithRequestIdTraceId;
    /** Registers a WebSocket route handler by route key. */
    webSocket(routeKey: string, handler: Handler): this;
    /** Registers an SQS queue handler by queue name. */
    sqs(queueName: string, handler: SQSHandler): this;
    /** Registers a Kinesis stream handler by stream name. */
    kinesis(streamName: string, handler: KinesisHandler): this;
    /** Registers an SNS topic handler by topic name. */
    sns(topicName: string, handler: SNSHandler): this;
    /** Registers an EventBridge handler for a selector. */
    eventBridge(selector: EventBridgeSelector, handler: EventBridgeHandler): this;
    /** Registers a DynamoDB Streams handler by table name. */
    dynamoDB(tableName: string, handler: DynamoDBStreamHandler): this;
    /** Serves a normalized AppTheory request and returns a normalized response. */
    serve(request: Request, ctx?: unknown): Promise<Response>;
    private _serve;
    /** Serves an API Gateway HTTP API v2 event. */
    serveAPIGatewayV2(event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
    /** Serves a Lambda Function URL event. */
    serveLambdaFunctionURL(event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
    /** Serves an API Gateway REST proxy event. */
    serveAPIGatewayProxy(event: APIGatewayProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
    /** Serves an ALB target group event. */
    serveALB(event: ALBTargetGroupRequest, ctx?: unknown): Promise<ALBTargetGroupResponse>;
    /** Serves an AppSync direct Lambda resolver event. */
    serveAppSync(event: AppSyncResolverEvent, ctx?: unknown): Promise<unknown>;
    private _webSocketHandlerForEvent;
    /** Serves an API Gateway WebSocket event. */
    serveWebSocket(event: APIGatewayWebSocketProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
    private _eventContext;
    private _sqsHandlerForEvent;
    /** Serves an SQS event with partial-batch failure output. */
    serveSQSEvent(event: SQSEvent, ctx?: unknown): Promise<SQSEventResponse>;
    private _kinesisHandlerForEvent;
    /** Serves a Kinesis event with partial-batch failure output. */
    serveKinesisEvent(event: KinesisEvent, ctx?: unknown): Promise<KinesisEventResponse>;
    private _snsHandlerForEvent;
    /** Serves an SNS event through the registered topic handler. */
    serveSNSEvent(event: SNSEvent, ctx?: unknown): Promise<unknown[]>;
    private _eventBridgeHandlerForEvent;
    /** Serves an EventBridge event through registered selectors. */
    serveEventBridge(event: EventBridgeEvent, ctx?: unknown): Promise<unknown>;
    private _dynamoDBHandlerForEvent;
    /** Serves a DynamoDB Streams event with partial-batch failure output. */
    serveDynamoDBStream(event: DynamoDBStreamEvent, ctx?: unknown): Promise<DynamoDBStreamEventResponse>;
    /** Detects and dispatches a supported Lambda event shape through one entrypoint. */
    handleLambda(event: unknown, ctx?: unknown): Promise<unknown>;
}
/** Creates an AppTheory application with the provided runtime options. */
export declare function createApp(options?: {
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
}): App;
/** Lambda Function URL streaming handler produced for AWS Lambda runtimes. */
export type LambdaFunctionURLStreamingHandler = (event: LambdaFunctionURLRequest, ctx?: unknown) => Promise<unknown>;
/** Creates a Lambda Function URL streaming handler for an AppTheory app. */
export declare function createLambdaFunctionURLStreamingHandler(app: App): LambdaFunctionURLStreamingHandler;
/** Creates middleware that fails requests closed when timeout policy expires. */
export declare function timeoutMiddleware(config?: TimeoutConfig): Middleware;
//# sourceMappingURL=app.d.ts.map