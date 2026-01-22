import type { ALBTargetGroupRequest, ALBTargetGroupResponse, APIGatewayProxyRequest, APIGatewayProxyResponse, APIGatewayV2HTTPRequest, APIGatewayV2HTTPResponse, APIGatewayWebSocketProxyRequest, DynamoDBStreamEvent, DynamoDBStreamEventResponse, DynamoDBStreamRecord, EventBridgeEvent, EventBridgeSelector, KinesisEvent, KinesisEventResponse, KinesisEventRecord, LambdaFunctionURLRequest, LambdaFunctionURLResponse, SNSEvent, SNSEventRecord, SQSEvent, SQSEventResponse, SQSMessage } from "./aws-types.js";
import { type Clock } from "./clock.js";
import { Context, EventContext } from "./context.js";
import type { EventMiddleware, Handler, Middleware, WebSocketClientFactory } from "./context.js";
import { type IdGenerator } from "./ids.js";
import type { Headers, Request, Response } from "./types.js";
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
export type PolicyHook = (ctx: Context) => PolicyDecision | null | undefined | Promise<PolicyDecision | null | undefined>;
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
export type SQSHandler = (ctx: EventContext, message: SQSMessage) => void | Promise<void>;
export type KinesisHandler = (ctx: EventContext, record: KinesisEventRecord) => void | Promise<void>;
export type SNSHandler = (ctx: EventContext, record: SNSEventRecord) => unknown | Promise<unknown>;
export type DynamoDBStreamHandler = (ctx: EventContext, record: DynamoDBStreamRecord) => void | Promise<void>;
export type EventBridgeHandler = (ctx: EventContext, event: EventBridgeEvent) => unknown | Promise<unknown>;
export declare class App {
    private readonly _router;
    private readonly _clock;
    private readonly _ids;
    private readonly _tier;
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
        limits?: Limits;
        cors?: CORSConfig;
        authHook?: AuthHook;
        policyHook?: PolicyHook;
        observability?: ObservabilityHooks;
        webSocketClientFactory?: WebSocketClientFactory;
    });
    handle(method: string, pattern: string, handler: Handler, options?: RouteOptions): this;
    get(pattern: string, handler: Handler): this;
    post(pattern: string, handler: Handler): this;
    put(pattern: string, handler: Handler): this;
    delete(pattern: string, handler: Handler): this;
    use(middleware: Middleware): this;
    useEvents(middleware: EventMiddleware): this;
    private _applyMiddlewares;
    private _applyEventMiddlewares;
    webSocket(routeKey: string, handler: Handler): this;
    sqs(queueName: string, handler: SQSHandler): this;
    kinesis(streamName: string, handler: KinesisHandler): this;
    sns(topicName: string, handler: SNSHandler): this;
    eventBridge(selector: EventBridgeSelector, handler: EventBridgeHandler): this;
    dynamoDB(tableName: string, handler: DynamoDBStreamHandler): this;
    serve(request: Request, ctx?: unknown): Promise<Response>;
    serveAPIGatewayV2(event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
    serveLambdaFunctionURL(event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
    serveAPIGatewayProxy(event: APIGatewayProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
    serveALB(event: ALBTargetGroupRequest, ctx?: unknown): Promise<ALBTargetGroupResponse>;
    private _webSocketHandlerForEvent;
    serveWebSocket(event: APIGatewayWebSocketProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
    private _eventContext;
    private _sqsHandlerForEvent;
    serveSQSEvent(event: SQSEvent, ctx?: unknown): Promise<SQSEventResponse>;
    private _kinesisHandlerForEvent;
    serveKinesisEvent(event: KinesisEvent, ctx?: unknown): Promise<KinesisEventResponse>;
    private _snsHandlerForEvent;
    serveSNSEvent(event: SNSEvent, ctx?: unknown): Promise<unknown[]>;
    private _eventBridgeHandlerForEvent;
    serveEventBridge(event: EventBridgeEvent, ctx?: unknown): Promise<unknown>;
    private _dynamoDBHandlerForEvent;
    serveDynamoDBStream(event: DynamoDBStreamEvent, ctx?: unknown): Promise<DynamoDBStreamEventResponse>;
    handleLambda(event: unknown, ctx?: unknown): Promise<unknown>;
}
export declare function createApp(options?: {
    clock?: Clock;
    ids?: IdGenerator;
    tier?: Tier;
    limits?: Limits;
    cors?: CORSConfig;
    authHook?: AuthHook;
    policyHook?: PolicyHook;
    observability?: ObservabilityHooks;
    webSocketClientFactory?: WebSocketClientFactory;
}): App;
export type LambdaFunctionURLStreamingHandler = (event: LambdaFunctionURLRequest, ctx?: unknown) => Promise<unknown>;
export declare function createLambdaFunctionURLStreamingHandler(app: App): LambdaFunctionURLStreamingHandler;
export declare function timeoutMiddleware(config?: TimeoutConfig): Middleware;
