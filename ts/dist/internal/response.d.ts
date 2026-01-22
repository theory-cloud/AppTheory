import { Buffer } from "node:buffer";
import type { Headers, Response } from "../types.js";
export interface NormalizedResponse {
    status: number;
    headers: Headers;
    cookies: string[];
    body: Buffer;
    bodyStream: AsyncIterable<Buffer> | null;
    isBase64: boolean;
}
export declare function normalizeResponse(response: Response | null | undefined): NormalizedResponse;
export declare function hasJSONContentType(headers: Headers): boolean;
export declare function errorResponse(code: string, message: string, headers?: Headers): NormalizedResponse;
export declare function errorResponseWithRequestId(code: string, message: string, headers?: Headers, requestId?: string): NormalizedResponse;
export declare function responseForError(err: unknown): NormalizedResponse;
export declare function responseForErrorWithRequestId(err: unknown, requestId: string): NormalizedResponse;
