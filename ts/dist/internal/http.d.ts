import { Buffer } from "node:buffer";
import type { BodyStream, Headers, Query } from "../types.js";
export declare function normalizeMethod(method: unknown): string;
export declare function normalizePath(path: unknown): string;
export declare function splitPath(path: unknown): string[];
export declare function canonicalizeHeaders(headers: unknown): Headers;
export declare function cloneQuery(query: unknown): Query;
export declare function parseCookies(cookieHeaders: string[] | undefined): Record<string, string>;
export declare function toBuffer(body: Uint8Array | Buffer | string | null | undefined): Buffer;
export declare function normalizeBodyStream(bodyStream: BodyStream | null | undefined): AsyncIterable<Buffer>;
export declare function headersFromSingle(headers: Record<string, unknown> | null | undefined, ignoreCookieHeader: boolean): Headers;
export declare function queryFromSingle(params: Record<string, unknown> | null | undefined): Query;
export declare function parseRawQueryString(raw: string): Query;
export declare function firstQueryValues(query: Query | undefined): Record<string, string> | undefined;
export declare function splitPathAndQuery(path: string, query: Query | undefined): {
    rawPath: string;
    rawQueryString: string;
};
export declare function firstHeaderValue(headers: Headers | undefined, key: string): string;
