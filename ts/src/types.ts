export type Headers = Record<string, string[]>;

export type Query = Record<string, string[]>;

export type BodyStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

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
  bodyStream?: BodyStream | null;
  isBase64: boolean;
}
