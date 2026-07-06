import { Buffer } from "node:buffer";
import { type App } from "../app.js";
import { type IdGenerator } from "../ids.js";
import { type McpServer } from "../mcp/index.js";
import type { Headers, Request, Response } from "../types.js";
export interface McpTestHarnessOptions {
    path?: string;
    appIdGenerator?: IdGenerator;
}
export interface McpTestInvokeOptions {
    method?: string;
    path?: string;
    headers?: Headers;
    body?: Uint8Array | string;
    bodyJson?: unknown;
    sessionId?: string;
    protocolVersion?: string;
    lastEventId?: string;
}
export interface McpTestResult {
    response: Response;
    body: Buffer;
    bodyJson?: unknown;
    sseFrames: McpTestSSEFrame[];
}
export interface McpTestSSEFrame {
    id: string;
    event?: string;
    data: string;
}
export declare class McpTestHarness {
    readonly app: App;
    readonly server: McpServer;
    readonly path: string;
    constructor(server: McpServer, options?: McpTestHarnessOptions);
    invoke(options?: McpTestInvokeOptions): Promise<McpTestResult>;
    initialize(options?: {
        id?: string | number;
        protocolVersion?: string;
    }): Promise<McpTestResult>;
    call(sessionId: string, method: string, params?: unknown, id?: string | number): Promise<McpTestResult>;
    request(options?: McpTestInvokeOptions): Request;
}
export declare function createMcpTestHarness(server: McpServer, options?: McpTestHarnessOptions): McpTestHarness;
export declare function fixedIdGenerator(id: string): IdGenerator;
export declare function sequenceIdGenerator(ids: string[], fallbackPrefix?: string): IdGenerator;
export declare function parseMcpTestSSEFrames(body: Uint8Array): McpTestSSEFrame[];
//# sourceMappingURL=mcp.d.ts.map