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
  now(): Date;
  newId(): string;
  param(name: string): string;
  jsonValue(): unknown;
}

export type Handler = (ctx: Context) => Response | Promise<Response>;

export declare class App {
  constructor(options?: { clock?: Clock; ids?: IdGenerator });
  handle(method: string, pattern: string, handler: Handler): this;
  get(pattern: string, handler: Handler): this;
  post(pattern: string, handler: Handler): this;
  put(pattern: string, handler: Handler): this;
  delete(pattern: string, handler: Handler): this;
  serve(request: Request, ctx?: unknown): Promise<Response>;
}

export declare function createApp(options?: { clock?: Clock; ids?: IdGenerator }): App;

export declare function text(status: number, body: string): Response;
export declare function json(status: number, value: unknown): Response;
export declare function binary(status: number, body: Uint8Array, contentType?: string): Response;

export declare class TestEnv {
  readonly clock: ManualClock;
  readonly ids: ManualIdGenerator;
  constructor(options?: { now?: Date });
  app(options?: { clock?: Clock; ids?: IdGenerator }): App;
  invoke(app: App, request: Request, ctx?: unknown): Promise<Response>;
}

export declare function createTestEnv(options?: { now?: Date }): TestEnv;
