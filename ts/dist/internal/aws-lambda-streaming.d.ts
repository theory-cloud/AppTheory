import { Buffer } from "node:buffer";
import type { LambdaFunctionURLRequest } from "../aws-types.js";
import type { Request, Response } from "../types.js";
type LambdaResponseMeta = {
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
};
export type HttpResponseStreamLike = {
    init?: (meta: LambdaResponseMeta) => void;
    write: (chunk: Uint8Array) => unknown;
    end: (chunk?: Uint8Array) => unknown;
};
type AppLike = {
    serve: (request: Request, ctx?: unknown) => Promise<Response>;
};
export declare function serveLambdaFunctionURLStreaming(app: AppLike, event: LambdaFunctionURLRequest, responseStream: HttpResponseStreamLike, ctx?: unknown): Promise<string>;
export declare class CapturedHttpResponseStream implements HttpResponseStreamLike {
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
    chunks: Buffer[];
    ended: boolean;
    init(meta: LambdaResponseMeta): void;
    write(chunk: Uint8Array): true;
    end(chunk?: Uint8Array): void;
}
export {};
