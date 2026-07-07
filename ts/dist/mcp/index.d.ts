import { type Model, type TheorydbClient } from "@theory-cloud/tabletheory-ts";
import type { Handler } from "../context.js";
import { type IdGenerator } from "../ids.js";
import type { Headers, Response } from "../types.js";
export declare const MCP_PROTOCOL_VERSION = "2025-11-25";
export declare const MCP_PROTOCOL_VERSION_PRIOR = "2025-06-18";
export declare const MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26";
export declare const MCP_HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
export declare const MCP_HEADER_SESSION_ID = "mcp-session-id";
export declare const MCP_HEADER_LAST_EVENT_ID = "last-event-id";
export declare const MCP_CODE_PARSE_ERROR = -32700;
export declare const MCP_CODE_INVALID_REQUEST = -32600;
export declare const MCP_CODE_METHOD_NOT_FOUND = -32601;
export declare const MCP_CODE_INVALID_PARAMS = -32602;
export declare const MCP_CODE_INTERNAL_ERROR = -32603;
export declare const MCP_CODE_SERVER_ERROR = -32000;
export type McpRequestID = string | number | boolean | null;
export type McpJSONValue = string | number | boolean | null | McpJSONValue[] | {
    [key: string]: McpJSONValue;
};
export type McpJSONRecord = Record<string, McpJSONValue>;
export interface McpRPCError {
    code: number;
    message: string;
    data?: unknown;
}
export interface McpRPCResponse {
    jsonrpc: "2.0";
    id: unknown;
    result?: unknown;
    error?: McpRPCError;
}
export interface McpRPCRequest {
    jsonrpc: "2.0";
    id?: unknown;
    method: string;
    params?: unknown;
}
export interface McpContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    title?: string;
    description?: string;
    size?: number;
    resource?: McpResourceContent;
}
export interface McpToolResult {
    content: McpContentBlock[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}
export interface McpToolExecution {
    taskSupport?: McpTaskSupport;
}
export interface McpToolDef {
    name: string;
    title?: string;
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
    execution?: McpToolExecution;
}
export type McpToolHandler = (args: unknown, context: McpToolContext) => McpToolResult | Promise<McpToolResult>;
export interface McpSSEEvent {
    data?: unknown;
}
export type McpStreamingToolHandler = (args: unknown, emit: (event: McpSSEEvent) => void | Promise<void>, context: McpToolContext) => McpToolResult | Promise<McpToolResult>;
export interface McpToolContext {
    sessionId: string;
    requestId: unknown;
    method: string;
}
export interface McpResourceDef {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
}
export interface McpResourceTemplateDef {
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
}
export interface McpResourceContent {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}
export type McpResourceHandler = (context: McpResourceContext) => McpResourceContent[] | Promise<McpResourceContent[]>;
export interface McpResourceContext {
    uri: string;
}
export interface McpPromptArgument {
    name: string;
    title?: string;
    description?: string;
    required?: boolean;
}
export interface McpPromptDef {
    name: string;
    title?: string;
    description?: string;
    arguments?: McpPromptArgument[];
}
export interface McpPromptMessage {
    role: string;
    content: McpContentBlock;
}
export interface McpPromptResult {
    description?: string;
    messages: McpPromptMessage[];
}
export type McpPromptHandler = (args: unknown) => McpPromptResult | Promise<McpPromptResult>;
export interface McpSession {
    id: string;
    createdAt: string;
    expiresAt: string;
    data?: Record<string, string>;
}
export interface McpSessionStore {
    get(id: string): Promise<McpSession>;
    put(session: McpSession): Promise<void>;
    delete(id: string): Promise<void>;
}
export interface McpStreamEvent {
    id: string;
    data: Uint8Array;
}
export interface McpStreamStore {
    create(sessionId: string): Promise<string>;
    append(sessionId: string, streamId: string, data?: Uint8Array): Promise<string>;
    close(sessionId: string, streamId: string): Promise<void>;
    subscribe(sessionId: string, streamId: string, afterEventId?: string): Promise<McpStreamEvent[]>;
    streamForEvent(sessionId: string, eventId: string): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
}
export type McpTaskSupport = "forbidden" | "optional" | "required";
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "canceled";
export interface McpTaskMetadata {
    ttl?: number;
}
export interface McpTask {
    taskId: string;
    status: McpTaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttl: number;
    pollInterval?: number;
}
export interface McpTaskRecord {
    sessionId: string;
    method: string;
    toolName?: string;
    task: McpTask;
    result?: unknown;
    error?: McpRPCError;
}
export interface McpTaskLookup {
    sessionId: string;
    taskId: string;
}
export interface McpTaskListRequest {
    sessionId: string;
    cursor?: string;
    limit?: number;
}
export interface McpTaskListResult {
    tasks: McpTask[];
    nextCursor?: string;
}
export interface McpTaskStore {
    create(task: McpTaskRecord): Promise<McpTaskRecord>;
    get(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    update(task: McpTaskRecord): Promise<McpTaskRecord>;
    list(request: McpTaskListRequest): Promise<McpTaskListResult>;
    cancel(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    deleteSession(sessionId: string): Promise<void>;
}
export interface McpTaskRuntimeOptions {
    store: McpTaskStore;
    defaultTtlMs?: number;
    maxTtlMs?: number;
    pollIntervalMs?: number;
    listLimit?: number;
    modelImmediateResponse?: string;
}
export interface McpServerOptions {
    idGenerator?: IdGenerator;
    sessionStore?: McpSessionStore;
    streamStore?: McpStreamStore;
    taskRuntime?: McpTaskRuntimeOptions;
    originValidator?: (origin: string) => boolean;
    sessionTtlMs?: number;
}
export declare class McpSessionNotFoundError extends Error {
    constructor(message?: string);
}
export declare class McpStreamNotFoundError extends Error {
    constructor(message?: string);
}
export declare class McpEventNotFoundError extends Error {
    constructor(message?: string);
}
export declare class McpTaskNotFoundError extends Error {
    constructor(message?: string);
}
export declare class McpTaskTerminalError extends Error {
    constructor(message?: string);
}
export declare class McpTaskInvalidCursorError extends Error {
    constructor(message?: string);
}
export declare class McpToolRegistry {
    private readonly tools;
    private readonly index;
    registerTool(definition: McpToolDef, handler: McpToolHandler): void;
    registerStreamingTool(definition: McpToolDef, handler: McpStreamingToolHandler): void;
    list(): McpToolDef[];
    len(): number;
    supportsStreaming(name: string): boolean;
    supportsTasks(): boolean;
    taskSupport(name: string): McpTaskSupport;
    call(name: string, args: unknown, context: McpToolContext): Promise<McpToolResult>;
    callStreaming(name: string, args: unknown, emit: (event: McpSSEEvent) => void | Promise<void>, context: McpToolContext): Promise<McpToolResult>;
    private entry;
}
export declare class McpResourceRegistry {
    private readonly resources;
    private readonly index;
    private readonly templates;
    private readonly templateIndex;
    registerResource(definition: McpResourceDef, handler: McpResourceHandler): void;
    registerResourceTemplate(definition: McpResourceTemplateDef): void;
    list(): McpResourceDef[];
    listTemplates(): McpResourceTemplateDef[];
    len(): number;
    templateLen(): number;
    read(uri: string): Promise<McpResourceContent[]>;
}
export declare class McpPromptRegistry {
    private readonly prompts;
    private readonly index;
    registerPrompt(definition: McpPromptDef, handler: McpPromptHandler): void;
    list(): McpPromptDef[];
    len(): number;
    get(name: string, args: unknown): Promise<McpPromptResult>;
}
export declare class MemoryMcpSessionStore implements McpSessionStore {
    private readonly sessions;
    private readonly now;
    constructor(options?: {
        now?: () => Date;
        seed?: McpSession[];
    });
    get(id: string): Promise<McpSession>;
    put(session: McpSession): Promise<void>;
    delete(id: string): Promise<void>;
}
export declare class MemoryMcpStreamStore implements McpStreamStore {
    private readonly sessions;
    private readonly idGenerator;
    constructor(options?: {
        idGenerator?: IdGenerator;
    });
    create(sessionId: string): Promise<string>;
    append(sessionId: string, streamId: string, data?: Uint8Array): Promise<string>;
    close(sessionId: string, streamId: string): Promise<void>;
    subscribe(sessionId: string, streamId: string, afterEventId?: string): Promise<McpStreamEvent[]>;
    streamForEvent(sessionId: string, eventId: string): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
    private ensureSession;
    private lookupSession;
    private lookupStream;
}
export declare class MemoryMcpTaskStore implements McpTaskStore {
    private readonly sessions;
    private readonly now;
    constructor(options?: {
        now?: () => Date;
    });
    create(task: McpTaskRecord): Promise<McpTaskRecord>;
    get(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    update(task: McpTaskRecord): Promise<McpTaskRecord>;
    list(request: McpTaskListRequest): Promise<McpTaskListResult>;
    cancel(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    deleteSession(sessionId: string): Promise<void>;
    private record;
}
export declare class DynamoMcpTaskStore implements McpTaskStore {
    private readonly db;
    private readonly model;
    private readonly now;
    constructor(db: TheorydbClient, options?: {
        model?: Model;
        now?: () => Date;
    });
    create(task: McpTaskRecord): Promise<McpTaskRecord>;
    get(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    update(task: McpTaskRecord): Promise<McpTaskRecord>;
    list(request: McpTaskListRequest): Promise<McpTaskListResult>;
    cancel(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    deleteSession(sessionId: string): Promise<void>;
}
export declare class DynamoMcpStreamStore implements McpStreamStore {
    private readonly db;
    private readonly model;
    private readonly idGenerator;
    constructor(db: TheorydbClient, options?: {
        model?: Model;
        idGenerator?: IdGenerator;
    });
    create(sessionId: string): Promise<string>;
    append(sessionId: string, streamId: string, data?: Uint8Array): Promise<string>;
    close(sessionId: string, streamId: string): Promise<void>;
    subscribe(sessionId: string, streamId: string, afterEventId?: string): Promise<McpStreamEvent[]>;
    streamForEvent(sessionId: string, eventId: string): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
    private streamRecord;
    private eventRecords;
    private sessionItems;
}
export declare class McpServer {
    private readonly name;
    private readonly version;
    private readonly idGenerator;
    private readonly sessionStore;
    private readonly streamStore;
    private readonly sessionTtlMs;
    private readonly originValidator;
    private readonly taskRuntime;
    private readonly toolRegistry;
    private readonly resourceRegistry;
    private readonly promptRegistry;
    constructor(name: string, version: string, options?: McpServerOptions);
    registry(): McpToolRegistry;
    resources(): McpResourceRegistry;
    prompts(): McpPromptRegistry;
    handler(): Handler;
    serve(request: {
        method: string;
        headers?: Headers;
        body?: Uint8Array | string;
    }): Promise<Response>;
    private handle;
    private handlePost;
    private handlePostRequest;
    private handlePostResponse;
    private handleGet;
    private handleDelete;
    private handleInitializeHTTP;
    private handleNotification;
    private handleRequestHTTP;
    private dispatch;
    private dispatchTaskMethod;
    private handleInitialize;
    private initializeCapabilities;
    private handleToolsCall;
    private handleResourcesRead;
    private handlePromptsGet;
    private shouldStreamToolsCall;
    private handleToolsCallStream;
    private handleTaskToolsCall;
    private finishTask;
    private handleTasksGet;
    private handleTasksResult;
    private handleTasksList;
    private handleTasksCancel;
    private requireTaskStore;
    private tasksEnabled;
    private methodCapabilityEnabled;
    private getSession;
    private requireSession;
    private requireProtocolVersion;
    private createSession;
    private marshalSingleResponse;
    private streamToSSE;
    private validateOrigin;
}
export declare function createMcpServer(name: string, version: string, options?: McpServerOptions): McpServer;
export declare function defaultMcpTaskModel(tableName?: string): Model;
export declare function defaultMcpStreamModel(tableName?: string): Model;
//# sourceMappingURL=index.d.ts.map