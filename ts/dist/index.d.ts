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
  jsonValue(): unknown;
}

export type Handler = (ctx: Context) => Response | Promise<Response>;

export type Tier = "p0" | "p1" | "p2";

export interface Limits {
  maxRequestBytes?: number;
  maxResponseBytes?: number;
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
    authHook?: AuthHook;
    policyHook?: PolicyHook;
    observability?: ObservabilityHooks;
  });
  handle(method: string, pattern: string, handler: Handler, options?: RouteOptions): this;
  get(pattern: string, handler: Handler): this;
  post(pattern: string, handler: Handler): this;
  put(pattern: string, handler: Handler): this;
  delete(pattern: string, handler: Handler): this;
  serve(request: Request, ctx?: unknown): Promise<Response>;
  serveAPIGatewayV2(event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
  serveLambdaFunctionURL(event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
}

export declare function createApp(options?: {
  clock?: Clock;
  ids?: IdGenerator;
  tier?: Tier;
  limits?: Limits;
  authHook?: AuthHook;
  policyHook?: PolicyHook;
  observability?: ObservabilityHooks;
}): App;

export declare function text(status: number, body: string): Response;
export declare function json(status: number, value: unknown): Response;
export declare function binary(status: number, body: Uint8Array, contentType?: string): Response;

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
  }): App;
  invoke(app: App, request: Request, ctx?: unknown): Promise<Response>;
  invokeAPIGatewayV2(app: App, event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
  invokeLambdaFunctionURL(app: App, event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
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
