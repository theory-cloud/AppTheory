import { type Model, type TheorydbClient } from "@theory-cloud/tabletheory-ts";
import type { Handler } from "../context.js";
import { type IdGenerator } from "../ids.js";
import type { Headers, Response } from "../types.js";
export declare const MCP_PROTOCOL_VERSION = "2025-11-25";
export declare const MCP_PROTOCOL_VERSION_2026_07_28 = "2026-07-28";
export declare const MCP_PROTOCOL_VERSION_PRIOR = "2025-06-18";
export declare const MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26";
export declare const MCP_PROTOCOL_SHAPE_2025_11_25 = "2025-11-25";
export declare const MCP_PROTOCOL_SHAPE_2026_07_28 = "2026-07-28";
export declare const MCP_PROTOCOL_SHAPE_UNKNOWN = "unknown";
export declare const MCP_RESULT_TYPE_COMPLETE = "complete";
export declare const MCP_RESULT_TYPE_INPUT_REQUIRED = "input_required";
export type McpProtocolShape = typeof MCP_PROTOCOL_SHAPE_2025_11_25 | typeof MCP_PROTOCOL_SHAPE_2026_07_28 | typeof MCP_PROTOCOL_SHAPE_UNKNOWN;
export type McpResultType = typeof MCP_RESULT_TYPE_COMPLETE | typeof MCP_RESULT_TYPE_INPUT_REQUIRED;
export declare const MCP_HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
export declare const MCP_HEADER_SESSION_ID = "mcp-session-id";
export declare const MCP_HEADER_METHOD = "mcp-method";
export declare const MCP_HEADER_NAME = "mcp-name";
export declare const MCP_HEADER_LAST_EVENT_ID = "last-event-id";
declare const SERVER_INFO_METADATA_KEY = "io.modelcontextprotocol/serverInfo";
export declare const MCP_CODE_PARSE_ERROR = -32700;
export declare const MCP_CODE_INVALID_REQUEST = -32600;
export declare const MCP_CODE_METHOD_NOT_FOUND = -32601;
export declare const MCP_CODE_INVALID_PARAMS = -32602;
export declare const MCP_CODE_INTERNAL_ERROR = -32603;
export declare const MCP_CODE_SERVER_ERROR = -32000;
export declare const MCP_CODE_HEADER_MISMATCH = -32020;
export declare const MCP_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export declare const MCP_CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export type McpRequestID = string | number | boolean | null;
export type McpJSONValue = string | number | boolean | null | McpJSONValue[] | {
    [key: string]: McpJSONValue;
};
export type McpJSONRecord = Record<string, McpJSONValue>;
export type McpExtensionCapabilities = Record<string, McpJSONRecord>;
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
/**
 * Detects the MCP transport shape for one request.
 *
 * MCP-Protocol-Version takes precedence when present. Otherwise the detector
 * reads io.modelcontextprotocol/protocolVersion from params._meta.
 */
export declare function detectMcpProtocolVersion(headers: Headers, request: unknown): McpProtocolShape;
/**
 * Detects the MCP transport shape for one already-parsed JSON-RPC message.
 *
 * MCP-Protocol-Version takes precedence when present. Otherwise the detector
 * reads io.modelcontextprotocol/protocolVersion from params._meta.
 */
export declare function detectMcpProtocolVersionForMessage(headers: Headers, message: unknown): McpProtocolShape;
export interface McpServerIdentity {
    name: string;
    version: string;
}
export interface McpDiscoverResult {
    supportedVersions: string[];
    capabilities: Record<string, unknown>;
    _meta?: {
        [SERVER_INFO_METADATA_KEY]: McpServerIdentity;
    };
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
export interface McpInputRequest {
    method: string;
    params?: unknown;
}
export interface McpInputRequiredResult {
    resultType: typeof MCP_RESULT_TYPE_INPUT_REQUIRED;
    inputRequests?: Record<string, McpInputRequest>;
    requestState?: string;
    _meta?: Record<string, unknown>;
}
export interface McpToolResult {
    content: McpContentBlock[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    resultType?: McpResultType;
    inputRequests?: Record<string, McpInputRequest>;
    requestState?: string;
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
export interface McpToolAuthContext {
    authIdentity: string;
    tenantId: string;
    tenantBound: boolean;
    scopes: string[];
}
export interface McpToolContext {
    sessionId: string;
    requestId: unknown;
    method: string;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
    auth?: McpToolAuthContext;
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
    principal?: string;
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
export type McpCacheScope = "private" | "public";
export interface McpCacheHint {
    /** Defaults to 0 (immediately stale); negative and non-finite values become 0. */
    ttlMs?: number;
    /** Defaults to private; public must be configured explicitly. */
    cacheScope?: McpCacheScope;
}
export interface McpCacheableResultConfig {
    serverDiscover?: McpCacheHint;
    toolsList?: McpCacheHint;
    promptsList?: McpCacheHint;
    resourcesList?: McpCacheHint;
    resourceTemplatesList?: McpCacheHint;
    resourcesRead?: McpCacheHint;
}
export interface McpServerOptions {
    idGenerator?: IdGenerator;
    sessionStore?: McpSessionStore;
    streamStore?: McpStreamStore;
    taskRuntime?: McpTaskRuntimeOptions;
    originValidator?: (origin: string) => boolean;
    sessionTtlMs?: number;
    /**
     * MCP extensions advertised by server/discover for protocol version
     * 2026-07-28. Invalid identifiers and non-JSON settings are omitted so
     * extension negotiation fails closed.
     */
    extensionCapabilities?: McpExtensionCapabilities;
    /**
     * Per-surface cache hints for MCP 2026-07-28 complete results. Omitted
     * surfaces emit ttlMs: 0 and cacheScope: private.
     */
    cacheableResults?: McpCacheableResultConfig;
    /**
     * Include server identity in every MCP 2026-07-28 result's _meta.
     * Defaults to true.
     */
    includeServerInfoMetadata?: boolean;
    /**
     * Return verbatim handler error messages on the JSON-RPC wire. Defaults to
     * false, which replaces generic tool/resource/prompt/task handler errors
     * with a client-safe message and logs the original.
     */
    verboseHandlerErrors?: boolean;
    /**
     * Serve the optional common stream on GET /mcp requests without
     * Last-Event-ID. Defaults to true. Set it to false on deployments whose HTTP
     * adapter cannot deliver a streaming response body (the buffered API Gateway
     * HTTP API v2 adapter): the server then declines the common stream with 405
     * Method Not Allowed after origin, session, and protocol validation, which
     * MCP clients such as Codex rmcp read as "no common stream". Last-Event-ID
     * replay requests are unaffected.
     */
    initialSessionListenerEnabled?: boolean;
}
export declare class McpSessionNotFoundError extends Error {
    constructor(message?: string);
}
export declare class McpSessionExpiredError extends McpSessionNotFoundError {
    constructor(message?: string);
}
export declare class McpSessionCapacityError extends Error {
    constructor(message?: string);
}
export declare class McpStreamAggregateCapacityError extends Error {
    constructor(message?: string);
}
export declare class McpStreamAggregateBackfillError extends Error {
    constructor(message?: string);
}
export declare class McpStreamTransactionRequiredError extends Error {
    constructor(message?: string);
}
export declare class McpStreamAppendConflictError extends Error {
    constructor(message?: string);
}
export declare class McpStreamEventTooLargeError extends Error {
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
    private readonly maxSessions;
    constructor(options?: {
        now?: () => Date;
        seed?: McpSession[];
        maxSessions?: number;
    });
    get(id: string): Promise<McpSession>;
    put(session: McpSession): Promise<void>;
    putAndCollectExpired(session: McpSession): Promise<string[]>;
    delete(id: string): Promise<void>;
}
export declare class MemoryMcpStreamStore implements McpStreamStore {
    private readonly sessions;
    private readonly idGenerator;
    private readonly maxEventBytes;
    private readonly maxEventsPerSession;
    private readonly maxTotalBytesPerSession;
    constructor(options?: {
        idGenerator?: IdGenerator;
        maxEventBytes?: number;
        maxEventsPerSession?: number;
        maxTotalBytesPerSession?: number;
    });
    create(sessionId: string): Promise<string>;
    append(sessionId: string, streamId: string, data?: Uint8Array): Promise<string>;
    close(sessionId: string, streamId: string): Promise<void>;
    subscribe(sessionId: string, streamId: string, afterEventId?: string): Promise<McpStreamEvent[]>;
    streamForEvent(sessionId: string, eventId: string): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
    private ensureSession;
    private evictOldest;
    private lookupSession;
    private lookupStream;
}
export declare class MemoryMcpTaskStore implements McpTaskStore {
    private readonly sessions;
    private readonly now;
    private readonly maxTasksPerSession;
    constructor(options?: {
        now?: () => Date;
        maxTasksPerSession?: number;
    });
    create(task: McpTaskRecord): Promise<McpTaskRecord>;
    get(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    update(task: McpTaskRecord): Promise<McpTaskRecord>;
    list(request: McpTaskListRequest): Promise<McpTaskListResult>;
    cancel(lookup: McpTaskLookup): Promise<McpTaskRecord>;
    deleteSession(sessionId: string): Promise<void>;
    private reapExpired;
    private expired;
    private evictOldestTerminal;
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
export interface McpStreamSpillStore {
    put(key: string, data: Uint8Array, expiresAt: number, sha256: string): Promise<void>;
    get(key: string, maxBytes: number): Promise<Uint8Array>;
    delete(key: string): Promise<void>;
}
export declare class DynamoMcpStreamStore implements McpStreamStore {
    private readonly db;
    private readonly model;
    private readonly idGenerator;
    private readonly now;
    private readonly streamTtlMs;
    private readonly maxEventBytes;
    private readonly maxAggregateEvents;
    private readonly maxAggregateBytes;
    private readonly inlineMaxBytes;
    private readonly spillStore;
    private readonly spillPrefix;
    private readonly appendRetries;
    constructor(db: TheorydbClient, options?: {
        model?: Model;
        idGenerator?: IdGenerator;
        now?: () => Date;
        streamTtlMinutes?: number;
        maxEventBytes?: number;
        maxAggregateEvents?: number;
        maxAggregateBytes?: number;
        inlineMaxBytes?: number;
        spillStore?: McpStreamSpillStore | null;
        spillPrefix?: string;
        appendRetries?: number;
    });
    create(sessionId: string): Promise<string>;
    private readSessionState;
    private ensureSessionState;
    private refreshSessionStateExpiry;
    append(sessionId: string, streamId: string, data?: Uint8Array): Promise<string>;
    private appendOnce;
    close(sessionId: string, streamId: string): Promise<void>;
    subscribe(sessionId: string, streamId: string, afterEventId?: string): Promise<McpStreamEvent[]>;
    streamForEvent(sessionId: string, eventId: string): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
    private streamRecord;
    private streamItemData;
    private spillKey;
    private eventRecords;
    private expiresAtUnix;
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
    private readonly extensionCapabilities;
    private readonly cacheableResults;
    private readonly includeServerInfoMetadata;
    private readonly verboseHandlerErrors;
    private readonly initialSessionListenerEnabled;
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
    private handleStatelessPostRequest;
    private handlePostResponse;
    private handleGet;
    private handleDelete;
    private cleanupSessionState;
    private handleInitializeHTTP;
    private handleNotification;
    private handleRequestHTTP;
    private dispatch;
    private finalizeResponseForProtocol;
    private dispatchTaskMethod;
    private handleInitialize;
    private handleDiscover;
    private initializeCapabilities;
    private handleToolsCall;
    private handleResourcesRead;
    private handlePromptsGet;
    private shouldStreamToolsCall;
    private handleToolsCallStream;
    private handleTaskToolsCall;
    private finishTask;
    private taskStoreError;
    private taskWireError;
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
    private handlerErrorMessage;
    private toolCallError;
    private marshalSingleResponse;
    private streamToSSE;
    private validateOrigin;
}
export declare function createMcpServer(name: string, version: string, options?: McpServerOptions): McpServer;
export declare function defaultMcpTaskModel(tableName?: string): Model;
export declare function defaultMcpStreamModel(tableName?: string): Model;
export {};
//# sourceMappingURL=index.d.ts.map