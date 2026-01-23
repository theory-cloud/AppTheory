import { Buffer } from "node:buffer";
import type { Request } from "../types.js";
export interface NormalizedRequest {
    method: string;
    path: string;
    query: Record<string, string[]>;
    headers: Record<string, string[]>;
    cookies: Record<string, string>;
    body: Buffer;
    isBase64: boolean;
}
export declare function normalizeRequest(request: Request): NormalizedRequest;
