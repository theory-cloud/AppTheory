export type Headers = Record<string, string[]>;

export type Query = Record<string, string[]>;

export interface Request {
  method: string;
  path: string;
  query?: Query;
  headers?: Headers;
  body?: Uint8Array;
  isBase64?: boolean;
}

export interface Response {
  status: number;
  headers: Headers;
  cookies: string[];
  body: Uint8Array;
  bodyStream?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
  isBase64: boolean;
}

export interface APIGatewayV2HTTPRequest {
  version: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: { http: { method: string; path?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayV2HTTPResponse {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
  cookies: string[];
}

export interface LambdaFunctionURLRequest {
  version: string;
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: { http: { method: string; path?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface LambdaFunctionURLResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
  cookies: string[];
}

export interface APIGatewayProxyRequest {
  resource?: string;
  path: string;
  httpMethod: string;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  queryStringParameters?: Record<string, string>;
  multiValueQueryStringParameters?: Record<string, string[]>;
  pathParameters?: Record<string, string>;
  stageVariables?: Record<string, string>;
  requestContext?: Record<string, unknown>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

export interface APIGatewayWebSocketProxyRequest extends APIGatewayProxyRequest {
  requestContext?: {
    stage?: string;
    requestId?: string;
    connectionId?: string;
    domainName?: string;
    eventType?: string;
    routeKey?: string;
    [key: string]: unknown;
  };
}

export interface SQSEvent {
  Records: SQSMessage[];
}

export interface SQSMessage {
  messageId: string;
  body?: string;
  eventSource?: string;
  eventSourceARN?: string;
  [key: string]: unknown;
}

export interface SQSEventResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface DynamoDBStreamEvent {
  Records: DynamoDBStreamRecord[];
}

export interface DynamoDBStreamRecord {
  eventID: string;
  eventName?: string;
  eventSource?: string;
  eventSourceARN?: string;
  dynamodb?: unknown;
  [key: string]: unknown;
}

export interface DynamoDBStreamEventResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface EventBridgeEvent {
  version?: string;
  id?: string;
  "detail-type"?: string;
  detailType?: string;
  source?: string;
  resources?: string[];
  detail?: unknown;
  [key: string]: unknown;
}

export interface EventBridgeSelector {
  ruleName?: string;
  source?: string;
  detailType?: string;
}

export interface Clock {
  now(): Date;
}

export declare class RealClock implements Clock {
  now(): Date;
}

export declare class ManualClock implements Clock {
  constructor(now?: Date);
  now(): Date;
  set(now: Date): void;
  advance(ms: number): Date;
}

export interface IdGenerator {
  newId(): string;
}

export declare class RandomIdGenerator implements IdGenerator {
  newId(): string;
}

export declare class ManualIdGenerator implements IdGenerator {
  constructor(options?: { prefix?: string; start?: number });
  queue(...ids: string[]): void;
  reset(): void;
  newId(): string;
}

export declare class AppError extends Error {
  code: string;
  constructor(code: string, message: string);
}

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

export interface TimeoutConfig {
  defaultTimeoutMs?: number;
  operationTimeoutsMs?: Record<string, number>;
  tenantTimeoutsMs?: Record<string, number>;
  timeoutMessage?: string;
}

export type EventHandler = (ctx: EventContext, event: unknown) => unknown | Promise<unknown>;

export type EventMiddleware = (
  ctx: EventContext,
  event: unknown,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export declare class EventContext {
  readonly ctx: unknown | null;
  requestId: string;
  remainingMs: number;
  now(): Date;
  newId(): string;
  set(key: string, value: unknown): void;
  get(key: string): unknown;
}

export interface WebSocketManagementClientLike {
  postToConnection(connectionId: string, data: Uint8Array): void | Promise<void>;
  getConnection(connectionId: string): unknown | Promise<unknown>;
  deleteConnection(connectionId: string): void | Promise<void>;
}

export type WebSocketClientFactory = (
  endpoint: string,
  ctx: unknown | null,
) => WebSocketManagementClientLike | Promise<WebSocketManagementClientLike>;

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
  now(): Date;
  newId(): string;
  sendMessage(data: Uint8Array): Promise<void>;
  sendJSONMessage(value: unknown): Promise<void>;
}

export interface WebSocketCall {
  op: "post_to_connection" | "get_connection" | "delete_connection";
  connectionId: string;
  data: Uint8Array | null;
}

export declare class WebSocketManagementClient implements WebSocketManagementClientLike {
  readonly endpoint: string;
  readonly region: string;
  constructor(options?: { endpoint?: string; region?: string; credentials?: unknown });
  postToConnection(connectionId: string, data: Uint8Array): Promise<void>;
  getConnection(connectionId: string): Promise<unknown>;
  deleteConnection(connectionId: string): Promise<void>;
}

export declare class FakeWebSocketManagementClient implements WebSocketManagementClientLike {
  readonly endpoint: string;
  readonly calls: WebSocketCall[];
  readonly connections: Map<string, unknown>;
  postError: Error | null;
  getError: Error | null;
  deleteError: Error | null;
  constructor(options?: { endpoint?: string });
  postToConnection(connectionId: string, data: Uint8Array): Promise<void>;
  getConnection(connectionId: string): Promise<unknown>;
  deleteConnection(connectionId: string): Promise<void>;
}

export type SQSHandler = (ctx: EventContext, message: SQSMessage) => void | Promise<void>;

export type DynamoDBStreamHandler = (ctx: EventContext, record: DynamoDBStreamRecord) => void | Promise<void>;

export type EventBridgeHandler = (ctx: EventContext, event: EventBridgeEvent) => unknown | Promise<unknown>;

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

export declare class App {
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
  webSocket(routeKey: string, handler: Handler): this;
  sqs(queueName: string, handler: SQSHandler): this;
  eventBridge(selector: EventBridgeSelector, handler: EventBridgeHandler): this;
  dynamoDB(tableName: string, handler: DynamoDBStreamHandler): this;
  serve(request: Request, ctx?: unknown): Promise<Response>;
  serveAPIGatewayV2(event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
  serveLambdaFunctionURL(event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
  serveAPIGatewayProxy(event: APIGatewayProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
  serveWebSocket(event: APIGatewayWebSocketProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
  serveSQSEvent(event: SQSEvent, ctx?: unknown): Promise<SQSEventResponse>;
  serveEventBridge(event: EventBridgeEvent, ctx?: unknown): Promise<unknown>;
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

export declare function text(status: number, body: string): Response;
export declare function json(status: number, value: unknown): Response;
export declare function binary(status: number, body: Uint8Array, contentType?: string): Response;
export declare function html(status: number, body: Uint8Array | string): Response;
export declare function htmlStream(
  status: number,
  chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
): Response;
export declare function safeJSONForHTML(value: unknown): string;
export declare function cacheControlSSR(): string;
export declare function cacheControlSSG(): string;
export declare function cacheControlISR(revalidateSeconds: number, staleWhileRevalidateSeconds?: number): string;
export declare function etag(body: Uint8Array | string): string;
export declare function matchesIfNoneMatch(headers: Headers, etag: string): boolean;
export declare function vary(existing: string[] | null | undefined, ...add: string[]): string[];
export declare function originURL(headers: Headers): string;
export declare function clientIP(headers: Headers): string;

export interface SSEEvent {
  id?: string;
  event?: string;
  data?: unknown;
}

export declare function sse(status: number, events: SSEEvent[]): Response;

export declare function sseEventStream(
  events: AsyncIterable<SSEEvent> | Iterable<SSEEvent>,
): AsyncIterable<Uint8Array>;

export declare function normalizeStage(stage: string): string;

export declare function baseName(appName: string, stage: string, tenant?: string): string;

export declare function resourceName(appName: string, resource: string, stage: string, tenant?: string): string;

export declare function sanitizeLogString(value: string): string;

export declare function sanitizeFieldValue(key: string, value: unknown): unknown;

export declare function sanitizeJSON(jsonBytes: Uint8Array | string): string;

export interface XMLSanitizationPattern {
  name: string;
  pattern: RegExp;
  maskingFunc: (match: string) => string;
}

export declare function sanitizeXML(xmlString: string, patterns: XMLSanitizationPattern[]): string;

export declare const paymentXMLPatterns: XMLSanitizationPattern[];

export declare const rapidConnectXMLPatterns: XMLSanitizationPattern[];

export declare class TestEnv {
  readonly clock: ManualClock;
  readonly ids: ManualIdGenerator;
  constructor(options?: { now?: Date });
  app(options?: {
    clock?: Clock;
    ids?: IdGenerator;
    tier?: Tier;
    limits?: Limits;
    authHook?: AuthHook;
    policyHook?: PolicyHook;
    observability?: ObservabilityHooks;
    webSocketClientFactory?: WebSocketClientFactory;
  }): App;
  invoke(app: App, request: Request, ctx?: unknown): Promise<Response>;
  invokeStreaming(app: App, request: Request, ctx?: unknown): Promise<{
    status: number;
    headers: Headers;
    cookies: string[];
    chunks: Uint8Array[];
    body: Uint8Array;
    is_base64: boolean;
    stream_error_code: string;
  }>;
  invokeAPIGatewayV2(app: App, event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
  invokeLambdaFunctionURL(app: App, event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
  invokeLambdaFunctionURLStreaming(app: App, event: LambdaFunctionURLRequest, ctx?: unknown): Promise<{
    status: number;
    headers: Headers;
    cookies: string[];
    chunks: Uint8Array[];
    body: Uint8Array;
    is_base64: boolean;
    stream_error_code: string;
  }>;
  invokeAPIGatewayProxy(app: App, event: APIGatewayProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
  invokeSQS(app: App, event: SQSEvent, ctx?: unknown): Promise<SQSEventResponse>;
  invokeEventBridge(app: App, event: EventBridgeEvent, ctx?: unknown): Promise<unknown>;
  invokeDynamoDBStream(app: App, event: DynamoDBStreamEvent, ctx?: unknown): Promise<DynamoDBStreamEventResponse>;
  invokeLambda(app: App, event: unknown, ctx?: unknown): Promise<unknown>;
}

export declare function createTestEnv(options?: { now?: Date }): TestEnv;

export declare function buildAPIGatewayV2Request(
  method: string,
  path: string,
  options?: { query?: Query; headers?: Record<string, string>; cookies?: string[]; body?: Uint8Array | string; isBase64?: boolean },
): APIGatewayV2HTTPRequest;

export declare function buildLambdaFunctionURLRequest(
  method: string,
  path: string,
  options?: { query?: Query; headers?: Record<string, string>; cookies?: string[]; body?: Uint8Array | string; isBase64?: boolean },
): LambdaFunctionURLRequest;

export declare function buildSQSEvent(queueArn: string, records?: Array<Partial<SQSMessage>>): SQSEvent;

export declare function buildEventBridgeEvent(options?: {
  ruleArn?: string;
  resources?: string[];
  version?: string;
  id?: string;
  source?: string;
  detailType?: string;
  account?: string;
  time?: string;
  region?: string;
  detail?: unknown;
}): EventBridgeEvent;

export declare function buildDynamoDBStreamEvent(
  streamArn: string,
  records?: Array<Partial<DynamoDBStreamRecord>>,
): DynamoDBStreamEvent;
