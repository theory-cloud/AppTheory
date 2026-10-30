import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { defineModel, } from "@theory-cloud/tabletheory-ts";
import { RandomIdGenerator } from "../ids.js";
import { getLogger } from "../logger.js";
import { bearerTokenClaimsFromContext } from "../oauth/index.js";
import { createS3ObjectStore } from "../objectstore.js";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_PROTOCOL_VERSION_2026_07_28 = "2026-07-28";
export const MCP_PROTOCOL_VERSION_PRIOR = "2025-06-18";
export const MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26";
export const MCP_PROTOCOL_SHAPE_2025_11_25 = MCP_PROTOCOL_VERSION;
export const MCP_PROTOCOL_SHAPE_2026_07_28 = MCP_PROTOCOL_VERSION_2026_07_28;
export const MCP_PROTOCOL_SHAPE_UNKNOWN = "unknown";
export const MCP_RESULT_TYPE_COMPLETE = "complete";
export const MCP_RESULT_TYPE_INPUT_REQUIRED = "input_required";
export const MCP_HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
export const MCP_HEADER_SESSION_ID = "mcp-session-id";
export const MCP_HEADER_METHOD = "mcp-method";
export const MCP_HEADER_NAME = "mcp-name";
export const MCP_HEADER_LAST_EVENT_ID = "last-event-id";
const JSONRPC_VERSION = "2.0";
const DEFAULT_SESSION_TTL_MINUTES = 60;
const DEFAULT_TASK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TASK_MAX_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;
const RELATED_TASK_METADATA_KEY = "io.modelcontextprotocol/related-task";
const MODEL_IMMEDIATE_RESPONSE_METADATA_KEY = "io.modelcontextprotocol/model-immediate-response";
const PROTOCOL_VERSION_METADATA_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_METADATA_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_METADATA_KEY = "io.modelcontextprotocol/serverInfo";
const TASK_CANCELED_MESSAGE = "task canceled";
const DEFAULT_TASK_TABLE_NAME = "mcp-tasks";
const DEFAULT_STREAM_TABLE_NAME = "mcp-streams";
const DEFAULT_STREAM_TTL_MINUTES = 60;
const DEFAULT_STREAM_MAX_EVENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STREAM_AGGREGATE_EVENTS = 10000;
const DEFAULT_STREAM_AGGREGATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_STREAM_AGGREGATE_VERSION = 1;
const DEFAULT_STREAM_SPILL_INLINE_MAX_BYTES = 32 * 1024;
const DEFAULT_STREAM_SPILL_PREFIX = "mcp-stream-events";
const STREAM_SESSION_ITEM_ID = "!session";
const STREAM_SESSION_DELETE_QUIET_PASSES = 2;
const STREAM_APPEND_RETRIES = 5;
const STREAM_EVENT_TOO_LARGE_MESSAGE = "stream event too large";
const STREAM_AGGREGATE_CAPACITY_MESSAGE = "stream aggregate capacity exceeded";
const STREAM_AGGREGATE_BACKFILL_MESSAGE = "stream aggregate backfill required";
const STREAM_TRANSACTION_REQUIRED_MESSAGE = "stream append requires a transactional backend";
const STREAM_APPEND_CONFLICT_MESSAGE = "stream append conflict";
const DEFAULT_MEMORY_SESSION_CAPACITY = 1000;
const SESSION_CAPACITY_EXCEEDED_MESSAGE = "Session capacity exceeded";
const SESSION_EXPIRED_MESSAGE = "session expired";
const DEFAULT_MEMORY_STREAM_MAX_EVENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MEMORY_STREAM_MAX_EVENTS_PER_SESSION = 10000;
const DEFAULT_MEMORY_STREAM_MAX_TOTAL_BYTES_PER_SESSION = 64 * 1024 * 1024;
const DEFAULT_MEMORY_TASK_MAX_PER_SESSION = 1000;
const TASK_CAPACITY_EXCEEDED_MESSAGE = "Task capacity exceeded";
export const MCP_CODE_PARSE_ERROR = -32700;
export const MCP_CODE_INVALID_REQUEST = -32600;
export const MCP_CODE_METHOD_NOT_FOUND = -32601;
export const MCP_CODE_INVALID_PARAMS = -32602;
export const MCP_CODE_INTERNAL_ERROR = -32603;
export const MCP_CODE_SERVER_ERROR = -32000;
export const MCP_CODE_HEADER_MISMATCH = -32020;
export const MCP_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const MCP_CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/**
 * Detects the MCP transport shape for one request.
 *
 * MCP-Protocol-Version takes precedence when present. Otherwise the detector
 * reads io.modelcontextprotocol/protocolVersion from params._meta.
 */
export function detectMcpProtocolVersion(headers, request) {
    const headerVersion = firstHeader(headers, MCP_HEADER_PROTOCOL_VERSION).trim();
    if (headerVersion) {
        return protocolShapeForVersion(headerVersion);
    }
    const record = protocolRequestRecord(request);
    if (!record) {
        return MCP_PROTOCOL_SHAPE_UNKNOWN;
    }
    return protocolShapeForParsedMessage(record);
}
/**
 * Detects the MCP transport shape for one already-parsed JSON-RPC message.
 *
 * MCP-Protocol-Version takes precedence when present. Otherwise the detector
 * reads io.modelcontextprotocol/protocolVersion from params._meta.
 */
export function detectMcpProtocolVersionForMessage(headers, message) {
    const headerVersion = firstHeader(headers, MCP_HEADER_PROTOCOL_VERSION).trim();
    if (headerVersion) {
        return protocolShapeForVersion(headerVersion);
    }
    if (!isRecord(message)) {
        return MCP_PROTOCOL_SHAPE_UNKNOWN;
    }
    return protocolShapeForParsedMessage(message);
}
function protocolShapeForParsedMessage(record) {
    const params = isRecord(record["params"]) ? record["params"] : null;
    const meta = params && isRecord(params["_meta"]) ? params["_meta"] : null;
    const metaVersion = typeof meta?.[PROTOCOL_VERSION_METADATA_KEY] === "string"
        ? String(meta[PROTOCOL_VERSION_METADATA_KEY]).trim()
        : "";
    return protocolShapeForVersion(metaVersion);
}
export class McpSessionNotFoundError extends Error {
    constructor(message = "session not found") {
        super(message);
        this.name = "McpSessionNotFoundError";
    }
}
export class McpSessionExpiredError extends Error {
    constructor(message = SESSION_EXPIRED_MESSAGE) {
        super(message);
        this.name = "McpSessionExpiredError";
    }
}
export class McpSessionCapacityError extends Error {
    constructor(message = SESSION_CAPACITY_EXCEEDED_MESSAGE) {
        super(message);
        this.name = "McpSessionCapacityError";
    }
}
export class McpStreamAggregateCapacityError extends Error {
    constructor(message = STREAM_AGGREGATE_CAPACITY_MESSAGE) {
        super(message);
        this.name = "McpStreamAggregateCapacityError";
    }
}
export class McpStreamAggregateBackfillError extends Error {
    constructor(message = STREAM_AGGREGATE_BACKFILL_MESSAGE) {
        super(message);
        this.name = "McpStreamAggregateBackfillError";
    }
}
export class McpStreamTransactionRequiredError extends Error {
    constructor(message = STREAM_TRANSACTION_REQUIRED_MESSAGE) {
        super(message);
        this.name = "McpStreamTransactionRequiredError";
    }
}
export class McpStreamAppendConflictError extends Error {
    constructor(message = STREAM_APPEND_CONFLICT_MESSAGE) {
        super(message);
        this.name = "McpStreamAppendConflictError";
    }
}
export class McpStreamEventTooLargeError extends Error {
    constructor(message = STREAM_EVENT_TOO_LARGE_MESSAGE) {
        super(message);
        this.name = "McpStreamEventTooLargeError";
    }
}
export class McpStreamNotFoundError extends Error {
    constructor(message = "stream not found") {
        super(message);
        this.name = "McpStreamNotFoundError";
    }
}
export class McpEventNotFoundError extends Error {
    constructor(message = "event not found") {
        super(message);
        this.name = "McpEventNotFoundError";
    }
}
export class McpTaskNotFoundError extends Error {
    constructor(message = "task not found") {
        super(message);
        this.name = "McpTaskNotFoundError";
    }
}
export class McpTaskTerminalError extends Error {
    constructor(message = "task already terminal") {
        super(message);
        this.name = "McpTaskTerminalError";
    }
}
export class McpTaskInvalidCursorError extends Error {
    constructor(message = "invalid task list cursor") {
        super(message);
        this.name = "McpTaskInvalidCursorError";
    }
}
export class McpToolRegistry {
    tools = [];
    index = new Map();
    registerTool(definition, handler) {
        const name = String(definition.name ?? "").trim();
        if (!name) {
            throw new Error("tool name must not be empty");
        }
        if (this.index.has(name)) {
            throw new Error(`tool already registered: ${name}`);
        }
        if (typeof handler !== "function") {
            throw new Error("tool handler must not be nil");
        }
        const def = normalizeToolDef({ ...definition, name });
        this.index.set(name, this.tools.length);
        this.tools.push({ def, handler });
    }
    registerStreamingTool(definition, handler) {
        const name = String(definition.name ?? "").trim();
        if (!name) {
            throw new Error("tool name must not be empty");
        }
        if (this.index.has(name)) {
            throw new Error(`tool already registered: ${name}`);
        }
        if (typeof handler !== "function") {
            throw new Error("streaming tool handler must not be nil");
        }
        const def = normalizeToolDef({ ...definition, name });
        const wrapped = (args, context) => handler(args, () => undefined, context);
        this.index.set(name, this.tools.length);
        this.tools.push({ def, handler: wrapped, streamingHandler: handler });
    }
    list() {
        return this.tools.map((entry) => cloneToolDef(entry.def));
    }
    len() {
        return this.tools.length;
    }
    supportsStreaming(name) {
        const entry = this.entry(name);
        return Boolean(entry?.streamingHandler);
    }
    supportsTasks() {
        return this.tools.some((entry) => {
            const support = entry.def.execution?.taskSupport ?? "forbidden";
            return support === "optional" || support === "required";
        });
    }
    taskSupport(name) {
        const entry = this.entry(name);
        const support = entry?.def.execution?.taskSupport ?? "forbidden";
        if (support === "optional" || support === "required") {
            return support;
        }
        return "forbidden";
    }
    async call(name, args, context) {
        const entry = this.entry(name);
        if (!entry) {
            throw new Error(`tool not found: ${name}`);
        }
        return normalizeToolResult(await entry.handler(args, context));
    }
    async callStreaming(name, args, emit, context) {
        const entry = this.entry(name);
        if (!entry) {
            throw new Error(`tool not found: ${name}`);
        }
        if (entry.streamingHandler) {
            return normalizeToolResult(await entry.streamingHandler(args, emit, context));
        }
        return normalizeToolResult(await entry.handler(args, context));
    }
    entry(name) {
        const idx = this.index.get(String(name ?? ""));
        if (idx === undefined) {
            return null;
        }
        return this.tools[idx] ?? null;
    }
}
export class McpResourceRegistry {
    resources = [];
    index = new Map();
    templates = [];
    templateIndex = new Map();
    registerResource(definition, handler) {
        const uri = String(definition.uri ?? "").trim();
        if (!uri) {
            throw new Error("resource uri must not be empty");
        }
        if (!validResourceURI(uri)) {
            throw new Error(`resource uri must be absolute: ${uri}`);
        }
        if (!String(definition.name ?? "").trim()) {
            throw new Error("resource name must not be empty");
        }
        if (typeof handler !== "function") {
            throw new Error("resource handler must not be nil");
        }
        if (this.index.has(uri)) {
            throw new Error(`resource already registered: ${uri}`);
        }
        const def = normalizeResourceDef({ ...definition, uri });
        this.index.set(uri, this.resources.length);
        this.resources.push({ def, handler });
    }
    registerResourceTemplate(definition) {
        const uriTemplate = String(definition.uriTemplate ?? "").trim();
        if (!uriTemplate) {
            throw new Error("resource template uriTemplate must not be empty");
        }
        if (!validResourceURI(uriTemplate)) {
            throw new Error(`resource template uriTemplate must be absolute: ${uriTemplate}`);
        }
        if (!String(definition.name ?? "").trim()) {
            throw new Error("resource template name must not be empty");
        }
        if (this.templateIndex.has(uriTemplate)) {
            throw new Error(`resource template already registered: ${uriTemplate}`);
        }
        const def = normalizeResourceTemplateDef({ ...definition, uriTemplate });
        this.templateIndex.set(uriTemplate, this.templates.length);
        this.templates.push(def);
    }
    list() {
        return this.resources.map((entry) => cloneResourceDef(entry.def));
    }
    listTemplates() {
        return this.templates.map((entry) => cloneResourceTemplateDef(entry));
    }
    len() {
        return this.resources.length;
    }
    templateLen() {
        return this.templates.length;
    }
    async read(uri) {
        const key = String(uri ?? "");
        const idx = this.index.get(key);
        if (idx === undefined) {
            throw new Error(`resource not found: ${key}`);
        }
        const entry = this.resources[idx];
        if (!entry) {
            throw new Error(`resource not found: ${key}`);
        }
        const contents = await entry.handler({ uri: key });
        return Array.isArray(contents)
            ? contents.map(normalizeResourceContent)
            : [];
    }
}
export class McpPromptRegistry {
    prompts = [];
    index = new Map();
    registerPrompt(definition, handler) {
        const name = String(definition.name ?? "").trim();
        if (!name) {
            throw new Error("prompt name must not be empty");
        }
        if (typeof handler !== "function") {
            throw new Error("prompt handler must not be nil");
        }
        if (this.index.has(name)) {
            throw new Error(`prompt already registered: ${name}`);
        }
        const def = normalizePromptDef({ ...definition, name });
        this.index.set(name, this.prompts.length);
        this.prompts.push({ def, handler });
    }
    list() {
        return this.prompts.map((entry) => clonePromptDef(entry.def));
    }
    len() {
        return this.prompts.length;
    }
    async get(name, args) {
        const key = String(name ?? "");
        const idx = this.index.get(key);
        if (idx === undefined) {
            throw new Error(`prompt not found: ${key}`);
        }
        const entry = this.prompts[idx];
        if (!entry) {
            throw new Error(`prompt not found: ${key}`);
        }
        return normalizePromptResult(await entry.handler(args));
    }
}
export class MemoryMcpSessionStore {
    sessions = new Map();
    now;
    maxSessions;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MEMORY_SESSION_CAPACITY);
        for (const session of options.seed ?? []) {
            this.sessions.set(session.id, cloneSession(session));
        }
    }
    async get(id) {
        const key = String(id ?? "").trim();
        const session = this.sessions.get(key);
        if (!session) {
            throw new McpSessionNotFoundError();
        }
        if (sessionExpiredAt(this.now(), session)) {
            this.sessions.delete(key);
            throw new McpSessionNotFoundError();
        }
        return cloneSession(session);
    }
    async put(session) {
        await this.putAndCollectExpired(session);
    }
    // putAndCollectExpired performs the atomic sweep/count/insert and returns the
    // expired session IDs so the server can clean their associated stream, task,
    // replay, and cancellation state.
    async putAndCollectExpired(session) {
        const normalized = cloneSession(session);
        if (!normalized.id) {
            throw new Error("missing session id");
        }
        const now = this.now();
        if (sessionExpiredAt(now, normalized)) {
            throw new McpSessionExpiredError();
        }
        const expired = [];
        for (const [id, existing] of this.sessions) {
            if (sessionExpiredAt(now, existing)) {
                this.sessions.delete(id);
                expired.push(id);
            }
        }
        if (!this.sessions.has(normalized.id) &&
            this.sessions.size >= this.maxSessions) {
            throw new McpSessionCapacityError();
        }
        this.sessions.set(normalized.id, normalized);
        return expired;
    }
    async delete(id) {
        this.sessions.delete(String(id ?? "").trim());
    }
}
export class MemoryMcpStreamStore {
    sessions = new Map();
    idGenerator;
    maxEventBytes;
    maxEventsPerSession;
    maxTotalBytesPerSession;
    constructor(options = {}) {
        this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
        this.maxEventBytes = positiveInteger(options.maxEventBytes, DEFAULT_MEMORY_STREAM_MAX_EVENT_BYTES);
        this.maxEventsPerSession = positiveInteger(options.maxEventsPerSession, DEFAULT_MEMORY_STREAM_MAX_EVENTS_PER_SESSION);
        this.maxTotalBytesPerSession = positiveInteger(options.maxTotalBytesPerSession, DEFAULT_MEMORY_STREAM_MAX_TOTAL_BYTES_PER_SESSION);
    }
    async create(sessionId) {
        const sid = normalizeRequired(sessionId, "missing session id");
        const session = this.ensureSession(sid);
        const streamId = String(this.idGenerator.newId() ?? "").trim();
        if (!streamId) {
            throw new Error("stream id generator returned empty id");
        }
        session.streams.set(streamId, { events: [], closed: false });
        return streamId;
    }
    async append(sessionId, streamId, data) {
        const payload = cloneBytes(data);
        if (payload.length > this.maxEventBytes) {
            throw new Error(STREAM_EVENT_TOO_LARGE_MESSAGE);
        }
        const session = this.lookupSession(sessionId);
        const stream = this.lookupStream(session, streamId);
        session.nextSeq += 1;
        const eventId = String(session.nextSeq);
        stream.events.push({ id: eventId, data: payload });
        session.eventToStream.set(eventId, String(streamId ?? "").trim());
        session.eventOrder.push(eventId);
        session.eventCount += 1;
        session.totalBytes += payload.length;
        while (session.eventCount > this.maxEventsPerSession ||
            session.totalBytes > this.maxTotalBytesPerSession) {
            this.evictOldest(session);
        }
        return eventId;
    }
    async close(sessionId, streamId) {
        const session = this.lookupSession(sessionId);
        const stream = this.lookupStream(session, streamId);
        stream.closed = true;
    }
    async subscribe(sessionId, streamId, afterEventId = "") {
        const session = this.lookupSession(sessionId);
        const stream = this.lookupStream(session, streamId);
        const after = String(afterEventId ?? "").trim();
        if (after) {
            const eventStream = session.eventToStream.get(after);
            if (eventStream !== String(streamId ?? "").trim()) {
                throw new McpEventNotFoundError();
            }
        }
        const afterNumber = Number(after || 0);
        return stream.events
            .filter((event) => Number(event.id) > afterNumber)
            .map((event) => ({ id: event.id, data: cloneBytes(event.data) }));
    }
    async streamForEvent(sessionId, eventId) {
        const session = this.lookupSession(sessionId);
        const streamId = session.eventToStream.get(String(eventId ?? "").trim());
        if (!streamId) {
            throw new McpEventNotFoundError();
        }
        return streamId;
    }
    async deleteSession(sessionId) {
        this.sessions.delete(String(sessionId ?? "").trim());
    }
    ensureSession(sessionId) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                nextSeq: 0,
                eventToStream: new Map(),
                eventOrder: [],
                eventCount: 0,
                totalBytes: 0,
                streams: new Map(),
            };
            this.sessions.set(sessionId, session);
        }
        return session;
    }
    evictOldest(session) {
        while (session.eventOrder.length > 0) {
            const eventId = session.eventOrder.shift();
            if (eventId === undefined) {
                return;
            }
            const streamId = session.eventToStream.get(eventId);
            if (!streamId) {
                continue;
            }
            session.eventToStream.delete(eventId);
            const stream = session.streams.get(streamId);
            if (!stream) {
                continue;
            }
            const index = stream.events.findIndex((event) => event.id === eventId);
            if (index < 0) {
                continue;
            }
            const [removed] = stream.events.splice(index, 1);
            session.eventCount -= 1;
            session.totalBytes -= removed?.data.length ?? 0;
            return;
        }
    }
    lookupSession(sessionId) {
        const sid = normalizeRequired(sessionId, "missing session id");
        const session = this.sessions.get(sid);
        if (!session) {
            throw new McpStreamNotFoundError();
        }
        return session;
    }
    lookupStream(session, streamId) {
        const key = normalizeRequired(streamId, "missing stream id");
        const stream = session.streams.get(key);
        if (!stream) {
            throw new McpStreamNotFoundError();
        }
        return stream;
    }
}
export class MemoryMcpTaskStore {
    sessions = new Map();
    now;
    maxTasksPerSession;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.maxTasksPerSession = positiveInteger(options.maxTasksPerSession, DEFAULT_MEMORY_TASK_MAX_PER_SESSION);
    }
    async create(task) {
        const record = cloneTaskRecord(task);
        record.sessionId = normalizeRequired(record.sessionId, "missing session id");
        record.task.taskId = normalizeRequired(record.task.taskId, "missing task id");
        let session = this.sessions.get(record.sessionId);
        if (!session) {
            session = new Map();
            this.sessions.set(record.sessionId, session);
        }
        if (session.has(record.task.taskId)) {
            throw new Error("task already exists");
        }
        if (session.size >= this.maxTasksPerSession) {
            this.reapExpired(session);
            while (session.size >= this.maxTasksPerSession &&
                this.evictOldestTerminal(session)) {
                // Keep evicting terminal tasks until the incoming task fits.
            }
            if (session.size >= this.maxTasksPerSession) {
                throw new Error(TASK_CAPACITY_EXCEEDED_MESSAGE);
            }
        }
        session.set(record.task.taskId, record);
        return cloneTaskRecord(record);
    }
    async get(lookup) {
        const record = this.record(lookup);
        if (!record) {
            throw new McpTaskNotFoundError();
        }
        return cloneTaskRecord(record);
    }
    async update(task) {
        const record = this.record({
            sessionId: task.sessionId,
            taskId: task.task.taskId,
        });
        if (!record) {
            throw new McpTaskNotFoundError();
        }
        if (taskStatusTerminal(record.task.status)) {
            throw new McpTaskTerminalError();
        }
        const next = cloneTaskRecord(task);
        const session = this.sessions.get(next.sessionId);
        if (!session) {
            throw new McpTaskNotFoundError();
        }
        session.set(next.task.taskId, next);
        return cloneTaskRecord(next);
    }
    async list(request) {
        const sessionId = String(request.sessionId ?? "").trim();
        if (!sessionId) {
            return { tasks: [] };
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { tasks: [] };
        }
        const cursor = parseTaskCursor(request.cursor);
        const limit = taskListLimit(request.limit);
        const records = [...session.values()].sort(compareTaskRecords);
        const slice = records.slice(cursor, cursor + limit);
        const result = {
            tasks: slice.map((record) => cloneTask(record.task)),
        };
        if (cursor + limit < records.length) {
            result.nextCursor = String(cursor + limit);
        }
        return result;
    }
    async cancel(lookup) {
        const record = this.record(lookup);
        if (!record) {
            throw new McpTaskNotFoundError();
        }
        if (taskStatusTerminal(record.task.status)) {
            throw new McpTaskTerminalError();
        }
        record.task.status = "canceled";
        record.task.statusMessage = TASK_CANCELED_MESSAGE;
        record.task.lastUpdatedAt = isoNoMillis(this.now());
        record.error = {
            code: MCP_CODE_SERVER_ERROR,
            message: TASK_CANCELED_MESSAGE,
        };
        return cloneTaskRecord(record);
    }
    async deleteSession(sessionId) {
        this.sessions.delete(String(sessionId ?? "").trim());
    }
    reapExpired(session) {
        const now = this.now();
        for (const [taskId, record] of session) {
            if (this.expired(record, now)) {
                session.delete(taskId);
            }
        }
    }
    expired(record, now) {
        const createdAt = Date.parse(String(record.task.createdAt ?? ""));
        if (!Number.isFinite(createdAt)) {
            return false;
        }
        const ttl = Number(record.task.ttl ?? 0);
        const duration = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TASK_MAX_TTL_MS;
        return now.getTime() >= createdAt + duration;
    }
    evictOldestTerminal(session) {
        const terminal = [...session.values()]
            .filter((record) => taskStatusTerminal(record.task.status))
            .sort(compareTaskRecords);
        const oldest = terminal[0];
        if (!oldest) {
            return false;
        }
        session.delete(oldest.task.taskId);
        return true;
    }
    record(lookup) {
        const sessionId = String(lookup.sessionId ?? "").trim();
        const taskId = String(lookup.taskId ?? "").trim();
        if (!sessionId || !taskId) {
            return null;
        }
        return this.sessions.get(sessionId)?.get(taskId) ?? null;
    }
}
export class DynamoMcpTaskStore {
    db;
    model;
    now;
    constructor(db, options = {}) {
        this.db = db;
        this.model = options.model ?? defaultMcpTaskModel();
        this.now = options.now ?? (() => new Date());
        this.db.register(this.model);
    }
    async create(task) {
        const item = taskRecordToItem(task);
        await this.db.create(this.model.name, item, { ifNotExists: true });
        return itemToTaskRecord(item);
    }
    async get(lookup) {
        try {
            const item = await this.db.get(this.model.name, taskKey(lookup));
            if (taskItemExpired(item, this.now())) {
                throw new McpTaskNotFoundError();
            }
            return itemToTaskRecord(item);
        }
        catch (err) {
            if (err instanceof McpTaskNotFoundError) {
                throw err;
            }
            if (isNotFoundError(err)) {
                throw new McpTaskNotFoundError();
            }
            throw err;
        }
    }
    async update(task) {
        const existing = await this.get({
            sessionId: task.sessionId,
            taskId: task.task.taskId,
        });
        if (taskStatusTerminal(existing.task.status)) {
            throw new McpTaskTerminalError();
        }
        const item = taskRecordToItem(task);
        await this.db.save(this.model.name, item);
        return itemToTaskRecord(item);
    }
    async list(request) {
        const sessionId = String(request.sessionId ?? "").trim();
        if (!sessionId) {
            return { tasks: [] };
        }
        try {
            const page = await this.db
                .query(this.model.name)
                .partitionKey(sessionId)
                .sort("ASC")
                .limit(taskListLimit(request.limit))
                .cursor(String(request.cursor ?? ""))
                .page();
            const now = this.now();
            const records = page.items
                .filter((item) => !taskItemExpired(item, now))
                .map(itemToTaskRecord)
                .sort(compareTaskRecords);
            const result = {
                tasks: records.map((record) => cloneTask(record.task)),
            };
            if (page.cursor) {
                result.nextCursor = page.cursor;
            }
            return result;
        }
        catch (err) {
            if (isNotFoundError(err)) {
                return { tasks: [] };
            }
            throw err;
        }
    }
    async cancel(lookup) {
        const record = await this.get(lookup);
        if (taskStatusTerminal(record.task.status)) {
            throw new McpTaskTerminalError();
        }
        record.task.status = "canceled";
        record.task.statusMessage = TASK_CANCELED_MESSAGE;
        record.task.lastUpdatedAt = isoNoMillis(this.now());
        record.error = {
            code: MCP_CODE_SERVER_ERROR,
            message: TASK_CANCELED_MESSAGE,
        };
        return this.update(record);
    }
    async deleteSession(sessionId) {
        const sid = String(sessionId ?? "").trim();
        if (!sid) {
            return;
        }
        // Collect every page before deleting: the cursor is an offset, so deleting
        // as we page would shift the remaining items under the cursor and leak
        // tasks. Expired items are deleted too, so this bypasses `list`.
        const keys = [];
        let cursor = "";
        for (;;) {
            const page = await this.db
                .query(this.model.name)
                .partitionKey(sid)
                .sort("ASC")
                .limit(MAX_TASK_LIST_LIMIT)
                .cursor(cursor)
                .page();
            for (const item of page.items) {
                keys.push({
                    sessionId: String(item["sessionId"] ?? sid),
                    taskId: String(item["taskId"] ?? ""),
                });
            }
            if (!page.cursor) {
                break;
            }
            cursor = String(page.cursor);
        }
        await Promise.all(keys.map((key) => this.db.delete(this.model.name, key)));
    }
}
class S3McpStreamSpillStore {
    bucket;
    store;
    constructor(bucket) {
        this.bucket = bucket;
    }
    objectStore() {
        this.store ??= createS3ObjectStore();
        return this.store;
    }
    async put(key, data, expiresAt, sha256) {
        const store = await this.objectStore();
        await store.put({
            ref: { bucket: this.bucket, key },
            payload: data,
            contentType: "application/json",
            metadata: { "expires-at": String(expiresAt), sha256 },
        });
    }
    async get(key, maxBytes) {
        const store = await this.objectStore();
        const out = await store.get({
            ref: { bucket: this.bucket, key },
            maxBytes,
        });
        return out.payload;
    }
    async delete(key) {
        const store = await this.objectStore();
        await store.delete({ ref: { bucket: this.bucket, key } });
    }
}
function defaultDynamoStreamSpillStore() {
    const bucket = String(process.env["MCP_STREAM_SPILL_BUCKET"] ?? "").trim();
    if (!bucket) {
        return null;
    }
    return new S3McpStreamSpillStore(bucket);
}
export class DynamoMcpStreamStore {
    db;
    model;
    idGenerator;
    now;
    streamTtlMs;
    maxEventBytes;
    maxAggregateEvents;
    maxAggregateBytes;
    inlineMaxBytes;
    spillStore;
    spillPrefix;
    appendRetries;
    constructor(db, options = {}) {
        this.db = db;
        this.model = options.model ?? defaultMcpStreamModel();
        this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
        this.now = options.now ?? (() => new Date());
        this.streamTtlMs =
            positiveInteger(options.streamTtlMinutes, envPositiveInteger("MCP_STREAM_TTL_MINUTES", DEFAULT_STREAM_TTL_MINUTES)) *
                60 *
                1000;
        this.maxEventBytes = positiveInteger(options.maxEventBytes, envPositiveInteger("MCP_STREAM_MAX_EVENT_BYTES", DEFAULT_STREAM_MAX_EVENT_BYTES));
        this.maxAggregateEvents = positiveInteger(options.maxAggregateEvents, DEFAULT_STREAM_AGGREGATE_EVENTS);
        this.maxAggregateBytes = positiveInteger(options.maxAggregateBytes, DEFAULT_STREAM_AGGREGATE_BYTES);
        this.inlineMaxBytes = positiveInteger(options.inlineMaxBytes, envPositiveInteger("MCP_STREAM_SPILL_INLINE_MAX_BYTES", DEFAULT_STREAM_SPILL_INLINE_MAX_BYTES));
        this.spillStore =
            options.spillStore === undefined
                ? defaultDynamoStreamSpillStore()
                : options.spillStore;
        this.spillPrefix = String(options.spillPrefix ??
            process.env["MCP_STREAM_SPILL_PREFIX"] ??
            DEFAULT_STREAM_SPILL_PREFIX)
            .trim()
            .replace(/^\/+|\/+$/g, "");
        this.appendRetries = positiveInteger(options.appendRetries, STREAM_APPEND_RETRIES);
        this.db.register(this.model);
    }
    async create(sessionId) {
        const sid = normalizeRequired(sessionId, "missing session id");
        const streamId = normalizeRequired(this.idGenerator.newId(), "stream id generator returned empty id");
        const expiresAt = this.expiresAtUnix(this.now());
        await this.ensureSessionState(sid, expiresAt);
        await this.db.create(this.model.name, {
            sessionId: sid,
            itemId: `STREAM#${streamId}`,
            streamId,
            kind: "stream",
            closed: false,
            sequence: 0,
            eventId: "",
            data: "",
            expiresAt,
        });
        return streamId;
    }
    async readSessionState(sessionId) {
        try {
            return await this.db.get(this.model.name, {
                sessionId,
                itemId: STREAM_SESSION_ITEM_ID,
            });
        }
        catch (err) {
            if (isNotFoundError(err)) {
                return null;
            }
            throw err;
        }
    }
    async ensureSessionState(sessionId, expiresAt) {
        const existing = await this.readSessionState(sessionId);
        if (existing) {
            if (existing["deleted"]) {
                throw new McpStreamNotFoundError();
            }
            await this.refreshSessionStateExpiry(sessionId, existing, expiresAt);
            return;
        }
        try {
            await this.db.create(this.model.name, {
                sessionId,
                itemId: STREAM_SESSION_ITEM_ID,
                streamId: "",
                kind: "session",
                closed: false,
                sequence: 0,
                eventId: "",
                aggregateVersion: DEFAULT_STREAM_AGGREGATE_VERSION,
                eventCount: 0,
                aggregateBytes: 0,
                deleted: false,
                expiresAt,
            }, { ifNotExists: true });
        }
        catch (err) {
            const raced = await this.readSessionState(sessionId);
            if (!raced) {
                throw err;
            }
            if (raced["deleted"]) {
                throw new McpStreamNotFoundError();
            }
        }
    }
    // refreshSessionStateExpiry updates only the expiry of an existing aggregate
    // record. It never rewrites aggregate counters and needs no version role: the
    // conditional model update is the same pinned operation appendOnce uses.
    async refreshSessionStateExpiry(sessionId, existing, expiresAt) {
        if (typeof this.db.transactWrite !==
            "function") {
            throw new McpStreamTransactionRequiredError();
        }
        try {
            await this.db.transactWrite([
                {
                    kind: "update",
                    model: this.model.name,
                    item: { ...existing, expiresAt },
                    fields: ["expiresAt"],
                    conditionExpression: "#deleted = :deleted",
                    expressionAttributeNames: { "#deleted": "deleted" },
                    expressionAttributeValues: { ":deleted": { BOOL: false } },
                },
            ]);
        }
        catch (err) {
            if (!isConditionalCheckFailedError(err)) {
                throw err;
            }
            const latest = await this.readSessionState(sessionId);
            if (!latest || latest["deleted"]) {
                throw new McpStreamNotFoundError();
            }
        }
    }
    async append(sessionId, streamId, data) {
        const sid = normalizeRequired(sessionId, "missing session id");
        const payload = cloneBytes(data);
        if (payload.length > this.maxEventBytes) {
            throw new McpStreamEventTooLargeError();
        }
        const stream = await this.streamRecord(sid, streamId);
        if (typeof this.db.transactWrite !==
            "function") {
            throw new McpStreamTransactionRequiredError();
        }
        for (let attempt = 0; attempt < this.appendRetries; attempt += 1) {
            const result = await this.appendOnce(sid, stream, payload);
            if (typeof result === "string") {
                return result;
            }
        }
        throw new McpStreamAppendConflictError();
    }
    async appendOnce(sessionId, stream, payload) {
        let state;
        try {
            state = await this.db.get(this.model.name, {
                sessionId,
                itemId: STREAM_SESSION_ITEM_ID,
            });
        }
        catch (err) {
            if (isNotFoundError(err)) {
                throw new McpStreamNotFoundError();
            }
            throw err;
        }
        if (state["deleted"]) {
            throw new McpStreamNotFoundError();
        }
        if (Number(state["aggregateVersion"] ?? 0) !==
            DEFAULT_STREAM_AGGREGATE_VERSION) {
            throw new McpStreamAggregateBackfillError();
        }
        const eventCount = Number(state["eventCount"] ?? 0);
        const aggregateBytes = Number(state["aggregateBytes"] ?? 0);
        if (eventCount + 1 > this.maxAggregateEvents) {
            throw new McpStreamAggregateCapacityError();
        }
        if (aggregateBytes + payload.length > this.maxAggregateBytes) {
            throw new McpStreamAggregateCapacityError();
        }
        const sequence = Number(state["sequence"] ?? 0) + 1;
        const eventId = String(sequence);
        const expiresAt = this.expiresAtUnix(this.now());
        const sha256 = sha256Hex(payload);
        const eventItem = {
            sessionId,
            itemId: `EVENT#${eventId}`,
            streamId: String(stream["streamId"] ?? ""),
            kind: "event",
            closed: false,
            sequence,
            eventId,
            expiresAt,
            dataBytes: payload.length,
            dataSha256: sha256,
        };
        let spilledRef = "";
        if (this.spillStore && payload.length > this.inlineMaxBytes) {
            spilledRef = this.spillKey(sessionId, eventId);
            await this.spillStore.put(spilledRef, payload, expiresAt, sha256);
            eventItem["dataStorage"] = "s3";
            eventItem["dataRef"] = spilledRef;
        }
        else {
            eventItem["data"] = Buffer.from(payload).toString("base64");
        }
        const nextState = {
            ...state,
            sequence,
            eventCount: eventCount + 1,
            aggregateBytes: aggregateBytes + payload.length,
            expiresAt,
        };
        const actions = [
            {
                kind: "update",
                model: this.model.name,
                item: nextState,
                fields: ["sequence", "eventCount", "aggregateBytes", "expiresAt"],
                conditionExpression: "#deleted = :deleted AND #aggregateVersion = :version AND #sequence = :sequence AND #eventCount = :eventCount AND #aggregateBytes = :aggregateBytes AND #eventCount <= :maxEvents AND #aggregateBytes <= :maxBytes",
                expressionAttributeNames: {
                    "#deleted": "deleted",
                    "#aggregateVersion": "aggregateVersion",
                    "#sequence": "sequence",
                    "#eventCount": "eventCount",
                    "#aggregateBytes": "aggregateBytes",
                },
                expressionAttributeValues: {
                    ":deleted": { BOOL: false },
                    ":version": { N: String(DEFAULT_STREAM_AGGREGATE_VERSION) },
                    ":sequence": { N: String(Number(state["sequence"] ?? 0)) },
                    ":eventCount": { N: String(eventCount) },
                    ":aggregateBytes": { N: String(aggregateBytes) },
                    ":maxEvents": { N: String(this.maxAggregateEvents - 1) },
                    ":maxBytes": {
                        N: String(this.maxAggregateBytes - payload.length),
                    },
                },
            },
            {
                kind: "put",
                model: this.model.name,
                item: { ...stream, expiresAt },
            },
            {
                kind: "put",
                model: this.model.name,
                item: eventItem,
            },
        ];
        try {
            await this.db.transactWrite(actions);
            return eventId;
        }
        catch (err) {
            let failure = err;
            if (spilledRef && this.spillStore) {
                try {
                    await this.spillStore.delete(spilledRef);
                }
                catch (cleanupErr) {
                    failure = new AggregateError([err, cleanupErr], "spill cleanup failed");
                }
            }
            if (!isConditionalCheckFailedError(err)) {
                throw failure;
            }
            const latest = await this.readSessionState(sessionId).catch(() => null);
            if (!latest) {
                throw new McpStreamNotFoundError();
            }
            if (latest["deleted"]) {
                throw new McpStreamNotFoundError();
            }
            if (Number(latest["aggregateVersion"] ?? 0) !==
                DEFAULT_STREAM_AGGREGATE_VERSION) {
                throw new McpStreamAggregateBackfillError();
            }
            return { retry: true };
        }
    }
    async close(sessionId, streamId) {
        const stream = await this.streamRecord(sessionId, streamId);
        stream["closed"] = true;
        stream["expiresAt"] = this.expiresAtUnix(this.now());
        await this.db.save(this.model.name, stream);
    }
    async subscribe(sessionId, streamId, afterEventId = "") {
        const sid = normalizeRequired(sessionId, "missing session id");
        const stream = String(streamId ?? "").trim();
        await this.streamRecord(sid, stream);
        const after = Number(String(afterEventId ?? "").trim() || 0);
        const events = await this.eventRecords(sid);
        if (after > 0 &&
            !events.some((item) => String(item["eventId"]) === String(after) &&
                String(item["streamId"]) === stream)) {
            throw new McpEventNotFoundError();
        }
        return await Promise.all(events
            .filter((item) => String(item["streamId"]) === stream)
            .filter((item) => Number(item["sequence"] ?? 0) > after)
            .sort(compareStreamItems)
            .map(async (item) => ({
            id: String(item["eventId"] ?? ""),
            data: await this.streamItemData(item),
        })));
    }
    async streamForEvent(sessionId, eventId) {
        const sid = normalizeRequired(sessionId, "missing session id");
        const wanted = String(eventId ?? "").trim();
        const events = await this.eventRecords(sid);
        const found = events.find((item) => String(item["eventId"] ?? "") === wanted);
        if (!found) {
            throw new McpEventNotFoundError();
        }
        return String(found["streamId"] ?? "");
    }
    async deleteSession(sessionId) {
        const sid = String(sessionId ?? "").trim();
        if (!sid) {
            return;
        }
        const expiresAt = this.expiresAtUnix(this.now());
        const existing = await this.readSessionState(sid);
        if (existing) {
            await this.db.save(this.model.name, {
                ...existing,
                deleted: true,
                expiresAt,
            });
        }
        else {
            await this.db.create(this.model.name, {
                sessionId: sid,
                itemId: STREAM_SESSION_ITEM_ID,
                streamId: "",
                kind: "session",
                closed: false,
                sequence: 0,
                eventId: "",
                aggregateVersion: DEFAULT_STREAM_AGGREGATE_VERSION,
                eventCount: 0,
                aggregateBytes: 0,
                deleted: true,
                expiresAt,
            }, { ifNotExists: true });
        }
        let quietPasses = 0;
        for (;;) {
            const items = await this.sessionItems(sid);
            let deletedAny = false;
            for (const item of items) {
                const itemId = String(item["itemId"] ?? "");
                if (itemId === STREAM_SESSION_ITEM_ID) {
                    continue;
                }
                const dataRef = String(item["dataRef"] ?? "");
                if (dataRef && this.spillStore) {
                    await this.spillStore.delete(dataRef);
                }
                await this.db.delete(this.model.name, { sessionId: sid, itemId });
                deletedAny = true;
            }
            if (deletedAny) {
                quietPasses = 0;
                continue;
            }
            quietPasses += 1;
            if (quietPasses >= STREAM_SESSION_DELETE_QUIET_PASSES) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    async streamRecord(sessionId, streamId) {
        try {
            const state = await this.readSessionState(sessionId);
            if (state && state["deleted"]) {
                throw new McpStreamNotFoundError();
            }
            const record = await this.db.get(this.model.name, {
                sessionId: String(sessionId ?? "").trim(),
                itemId: `STREAM#${String(streamId ?? "").trim()}`,
            });
            if (streamItemExpired(record, this.now())) {
                throw new McpStreamNotFoundError();
            }
            return record;
        }
        catch (err) {
            if (err instanceof McpStreamNotFoundError) {
                throw err;
            }
            if (isNotFoundError(err)) {
                throw new McpStreamNotFoundError();
            }
            throw err;
        }
    }
    async streamItemData(item) {
        const dataRef = String(item["dataRef"] ?? "");
        if (String(item["dataStorage"] ?? "") === "s3" || dataRef) {
            if (!this.spillStore) {
                throw new Error("stream spill store not configured");
            }
            const payload = await this.spillStore.get(dataRef, positiveInteger(Number(item["dataBytes"] ?? 0), this.maxEventBytes));
            const expectedBytes = Number(item["dataBytes"] ?? 0);
            if (expectedBytes > 0 && payload.length !== expectedBytes) {
                throw new Error("stream spill payload size mismatch");
            }
            const expectedHash = String(item["dataSha256"] ?? "");
            if (expectedHash && sha256Hex(payload) !== expectedHash) {
                throw new Error("stream spill payload hash mismatch");
            }
            return payload;
        }
        return Buffer.from(String(item["data"] ?? ""), "base64");
    }
    spillKey(sessionId, eventId) {
        const name = `sessions/${sha256Hex(Buffer.from(sessionId, "utf8"))}/events/${eventId}.json`;
        const prefix = this.spillPrefix.replace(/^\/+|\/+$/g, "");
        return prefix ? `${prefix}/${name}` : name;
    }
    async eventRecords(sessionId) {
        const now = this.now();
        return (await this.sessionItems(sessionId)).filter((item) => String(item["kind"] ?? "") === "event" && !streamItemExpired(item, now));
    }
    expiresAtUnix(now) {
        return Math.floor((now.getTime() + this.streamTtlMs) / 1000);
    }
    async sessionItems(sessionId) {
        try {
            const items = [];
            let cursor = "";
            for (;;) {
                const page = await this.db
                    .query(this.model.name)
                    .partitionKey(sessionId)
                    .limit(1000)
                    .cursor(cursor)
                    .page();
                items.push(...page.items);
                if (!page.cursor) {
                    break;
                }
                cursor = String(page.cursor);
            }
            return items;
        }
        catch (err) {
            if (isNotFoundError(err)) {
                return [];
            }
            throw err;
        }
    }
}
export class McpServer {
    name;
    version;
    idGenerator;
    sessionStore;
    streamStore;
    sessionTtlMs;
    originValidator;
    taskRuntime;
    extensionCapabilities;
    cacheableResults;
    includeServerInfoMetadata;
    verboseHandlerErrors;
    initialSessionListenerEnabled;
    toolRegistry = new McpToolRegistry();
    resourceRegistry = new McpResourceRegistry();
    promptRegistry = new McpPromptRegistry();
    constructor(name, version, options = {}) {
        this.name = String(name ?? "").trim() || "AppTheoryMCP";
        this.version = String(version ?? "").trim() || "0.0.0";
        this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
        this.sessionStore = options.sessionStore ?? new MemoryMcpSessionStore();
        this.streamStore = options.streamStore ?? new MemoryMcpStreamStore();
        this.sessionTtlMs = normalizeSessionTtlMs(options.sessionTtlMs);
        this.originValidator =
            options.originValidator ??
                ((origin) => origin === "https://claude.ai" || origin === "https://claude.com");
        this.taskRuntime = normalizeTaskRuntime(options.taskRuntime);
        this.extensionCapabilities = normalizeExtensionCapabilities(options.extensionCapabilities);
        this.cacheableResults = normalizeCacheableResultConfig(options.cacheableResults);
        this.includeServerInfoMetadata =
            options.includeServerInfoMetadata !== false;
        this.verboseHandlerErrors = options.verboseHandlerErrors === true;
        this.initialSessionListenerEnabled =
            options.initialSessionListenerEnabled !== false;
    }
    registry() {
        return this.toolRegistry;
    }
    resources() {
        return this.resourceRegistry;
    }
    prompts() {
        return this.promptRegistry;
    }
    handler() {
        return async (ctx) => this.handle(ctx.request.method, ctx.request.headers, ctx.request.body, ctx);
    }
    async serve(request) {
        return this.handle(request.method, request.headers ?? {}, toBytes(request.body));
    }
    async handle(method, headers, body, ctx) {
        const normalizedMethod = String(method ?? "")
            .trim()
            .toUpperCase();
        if (normalizedMethod === "POST") {
            return this.handlePost(headers, body, ctx);
        }
        if (normalizedMethod === "GET") {
            return this.handleGet(headers, ctx);
        }
        if (normalizedMethod === "DELETE") {
            return this.handleDelete(headers, body, ctx);
        }
        return methodNotAllowedResponse("DELETE, GET, POST");
    }
    async handlePost(headers, body, ctx) {
        const originResponse = this.validateOrigin(headers);
        if (originResponse) {
            return originResponse;
        }
        const headerResponse = validatePostHeaders(headers);
        if (headerResponse) {
            return headerResponse;
        }
        let raw;
        try {
            raw = parseJsonObject(body);
        }
        catch (err) {
            return this.marshalSingleResponse(newErrorResponse(null, MCP_CODE_PARSE_ERROR, `Parse error: ${errorMessage(err)}`));
        }
        const shape = detectMcpProtocolVersion(headers, body);
        if (Object.prototype.hasOwnProperty.call(raw, "method")) {
            return this.handlePostRequest(headers, body, shape, ctx);
        }
        if (Object.prototype.hasOwnProperty.call(raw, "result") ||
            Object.prototype.hasOwnProperty.call(raw, "error")) {
            return this.handlePostResponse(headers, body, shape, ctx);
        }
        return badRequest("invalid JSON-RPC message");
    }
    async handlePostRequest(headers, body, shape, ctx) {
        let request;
        try {
            request = parseRequest(body);
        }
        catch (err) {
            return this.marshalSingleResponse(newErrorResponse(null, MCP_CODE_PARSE_ERROR, `Parse error: ${errorMessage(err)}`));
        }
        const protocolValidation = validatePostRequestProtocol(headers, request, shape);
        if (protocolValidation.response) {
            return protocolValidation.response;
        }
        shape = protocolValidation.shape;
        if (shape === MCP_PROTOCOL_SHAPE_2026_07_28) {
            return this.handleStatelessPostRequest(request, ctx);
        }
        if (request.method === "server/discover") {
            if (!request.idPresent) {
                return emptyResponse(202);
            }
            return this.marshalSingleResponse(await this.dispatch(request, MCP_PROTOCOL_VERSION, "", ctx));
        }
        if (request.method === "initialize") {
            return this.handleInitializeHTTP(request, ctx);
        }
        const sessionResult = await this.requireSession(headers, ctx);
        if (sessionResult.response) {
            return sessionResult.response;
        }
        const session = sessionResult.session;
        const sessionId = sessionResult.sessionId;
        if (!session || !sessionId) {
            return internalServerError();
        }
        const protocolResponse = this.requireProtocolVersion(headers, session);
        if (protocolResponse) {
            return protocolResponse;
        }
        if (!request.idPresent) {
            await this.handleNotification(session, request);
            return emptyResponse(202);
        }
        return this.handleRequestHTTP(sessionId, session, request, headers, ctx);
    }
    async handleStatelessPostRequest(request, ctx) {
        if (!request.idPresent) {
            return emptyResponse(202);
        }
        const response = await this.dispatch(request, MCP_PROTOCOL_VERSION_2026_07_28, "", ctx);
        const missing = missingRequiredClientCapabilities(request, response);
        if (Object.keys(missing).length > 0) {
            return protocolErrorResponse(request.id, MCP_CODE_MISSING_REQUIRED_CLIENT_CAPABILITY, "Missing required client capability", { requiredCapabilities: missing });
        }
        return this.marshalSingleResponse(response, "", false, MCP_PROTOCOL_VERSION_2026_07_28);
    }
    async handlePostResponse(headers, body, shape, ctx) {
        let rpcResponse;
        try {
            rpcResponse = parseResponse(body);
        }
        catch {
            return badRequest("invalid JSON-RPC response");
        }
        const validationResponse = validatePostResponseProtocol(headers, rpcResponse, shape);
        if (validationResponse) {
            return validationResponse;
        }
        const sessionResult = await this.requireSession(headers, ctx);
        if (sessionResult.response) {
            return sessionResult.response;
        }
        if (sessionResult.session) {
            const protocolResponse = this.requireProtocolVersion(headers, sessionResult.session);
            if (protocolResponse) {
                return protocolResponse;
            }
        }
        return emptyResponse(202);
    }
    async handleGet(headers, ctx) {
        const originResponse = this.validateOrigin(headers);
        if (originResponse) {
            return originResponse;
        }
        if (detectMcpProtocolVersion(headers, new Uint8Array()) ===
            MCP_PROTOCOL_SHAPE_2026_07_28) {
            return methodNotAllowedResponse("POST");
        }
        const headerResponse = validateGetHeaders(headers);
        if (headerResponse) {
            return headerResponse;
        }
        const sessionResult = await this.requireSession(headers, ctx);
        if (sessionResult.response) {
            return sessionResult.response;
        }
        const session = sessionResult.session;
        const sessionId = sessionResult.sessionId;
        if (!session || !sessionId) {
            return internalServerError();
        }
        const protocolResponse = this.requireProtocolVersion(headers, session);
        if (protocolResponse) {
            return protocolResponse;
        }
        const lastEventId = firstHeader(headers, MCP_HEADER_LAST_EVENT_ID);
        if (!lastEventId) {
            // A server may decline the optional common stream with 405 Method Not
            // Allowed; GET stays allowed for Last-Event-ID replay.
            if (!this.initialSessionListenerEnabled) {
                return methodNotAllowedResponse("DELETE, GET, POST");
            }
            return sseBytesResponse(200, [Buffer.from(": keepalive\n\n", "utf8")], sessionId);
        }
        try {
            const streamId = await this.streamStore.streamForEvent(sessionId, lastEventId);
            const events = await this.streamStore.subscribe(sessionId, streamId, lastEventId);
            return this.streamToSSE(sessionId, events);
        }
        catch (err) {
            if (err instanceof McpEventNotFoundError) {
                return notFound("event not found");
            }
            if (err instanceof McpStreamNotFoundError) {
                return notFound("stream not found");
            }
            return internalServerError();
        }
    }
    async handleDelete(headers, body, ctx) {
        const originResponse = this.validateOrigin(headers);
        if (originResponse) {
            return originResponse;
        }
        if (detectMcpProtocolVersion(headers, body) === MCP_PROTOCOL_SHAPE_2026_07_28) {
            return methodNotAllowedResponse("POST");
        }
        const sessionId = firstHeader(headers, MCP_HEADER_SESSION_ID);
        if (!sessionId) {
            return badRequest("missing Mcp-Session-Id");
        }
        let session;
        try {
            session = await this.getSession(sessionId, ctx);
        }
        catch (err) {
            if (err instanceof McpSessionNotFoundError) {
                return notFound("session not found");
            }
            return internalServerError();
        }
        const protocolResponse = this.requireProtocolVersion(headers, session);
        if (protocolResponse) {
            return protocolResponse;
        }
        await this.sessionStore.delete(sessionId);
        await this.cleanupSessionState(sessionId);
        return emptyResponse(202);
    }
    async cleanupSessionState(sessionId) {
        const id = String(sessionId ?? "").trim();
        if (!id) {
            return;
        }
        const failures = [];
        try {
            await this.streamStore.deleteSession(id);
        }
        catch (err) {
            failures.push(err);
        }
        if (this.taskRuntime.store) {
            try {
                await this.taskRuntime.store.deleteSession(id);
            }
            catch (err) {
                failures.push(err);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "failed to clean session state");
        }
    }
    async handleInitializeHTTP(request, ctx) {
        const negotiated = negotiateProtocolVersion(request.params);
        let session;
        try {
            session = await this.createSession(negotiated, principalFromContext(ctx));
        }
        catch (err) {
            if (err instanceof McpSessionCapacityError) {
                return this.marshalSingleResponse(newErrorResponse(request.id, MCP_CODE_SERVER_ERROR, SESSION_CAPACITY_EXCEEDED_MESSAGE));
            }
            getLogger().error("mcp session create failed", {
                error: errorMessage(err),
            });
            return this.marshalSingleResponse(newErrorResponse(request.id, MCP_CODE_INTERNAL_ERROR, "session error"));
        }
        const response = this.handleInitialize(request, negotiated);
        return this.marshalSingleResponse(response, session.id, true);
    }
    async handleNotification(session, request) {
        if (request.method !== "notifications/initialized") {
            return;
        }
        const data = { ...(session.data ?? {}) };
        data["initialized"] = "true";
        await this.sessionStore.put({ ...session, data });
    }
    async handleRequestHTTP(sessionId, session, request, headers, ctx) {
        const protocol = sessionProtocolVersion(session);
        if (request.method === "tools/call" &&
            acceptsEventStream(headers) &&
            this.shouldStreamToolsCall(request)) {
            return this.handleToolsCallStream(sessionId, request, ctx);
        }
        const response = await this.dispatch(request, protocol, sessionId, ctx);
        return this.marshalSingleResponse(response);
    }
    async dispatch(request, protocolVersion, sessionId, ctx) {
        if (!methodAllowedForProtocol(protocolVersion, request.method)) {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
        }
        if (protocolVersion === MCP_PROTOCOL_VERSION_2026_07_28 &&
            statelessRequestRequiresSession(request)) {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
        }
        if (isTaskMethod(request.method)) {
            return this.finalizeResponseForProtocol(request, await this.dispatchTaskMethod(request, sessionId), protocolVersion);
        }
        if (!this.methodCapabilityEnabled(request.method)) {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
        }
        let response;
        switch (request.method) {
            case "server/discover":
                response = this.handleDiscover(request, protocolVersion);
                break;
            case "initialize":
                response = this.handleInitialize(request, negotiateProtocolVersion(request.params));
                break;
            case "ping":
                response = newResultResponse(request.id, {});
                break;
            case "tools/list":
                response = newResultResponse(request.id, {
                    tools: this.toolRegistry.list(),
                });
                break;
            case "tools/call":
                response = await this.handleToolsCall(request, sessionId, protocolVersion, ctx);
                break;
            case "resources/list":
                response = newResultResponse(request.id, {
                    resources: this.resourceRegistry.list(),
                });
                break;
            case "resources/read":
                response = await this.handleResourcesRead(request);
                break;
            case "resources/templates/list":
                response = newResultResponse(request.id, {
                    resourceTemplates: this.resourceRegistry.listTemplates(),
                });
                break;
            case "prompts/list":
                response = newResultResponse(request.id, {
                    prompts: this.promptRegistry.list(),
                });
                break;
            case "prompts/get":
                response = await this.handlePromptsGet(request);
                break;
            default:
                response = newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
                break;
        }
        return this.finalizeResponseForProtocol(request, response, protocolVersion);
    }
    finalizeResponseForProtocol(request, response, protocolVersion) {
        const prepared = responseForProtocol(response, protocolVersion, this.includeServerInfoMetadata
            ? { name: this.name, version: this.version }
            : null);
        if (protocolVersion !== MCP_PROTOCOL_VERSION_2026_07_28 ||
            prepared.error ||
            !isRecord(prepared.result) ||
            prepared.result["resultType"] !== MCP_RESULT_TYPE_COMPLETE) {
            return prepared;
        }
        const hint = cacheHintForMethod(this.cacheableResults, request.method);
        if (!hint) {
            return prepared;
        }
        const appliedHint = requestIsMultiRoundTripRetry(request)
            ? { ttlMs: 0, cacheScope: "private" }
            : hint;
        return {
            ...prepared,
            result: {
                ...prepared.result,
                ttlMs: appliedHint.ttlMs,
                cacheScope: appliedHint.cacheScope,
            },
        };
    }
    async dispatchTaskMethod(request, sessionId) {
        if (!this.tasksEnabled()) {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
        }
        switch (request.method) {
            case "tasks/get":
                return this.handleTasksGet(request, sessionId);
            case "tasks/result":
                return this.handleTasksResult(request, sessionId);
            case "tasks/list":
                return this.handleTasksList(request, sessionId);
            case "tasks/cancel":
                return this.handleTasksCancel(request, sessionId);
            default:
                return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, `Method not found: ${request.method}`);
        }
    }
    handleInitialize(request, protocolVersion) {
        return newResultResponse(request.id, {
            protocolVersion,
            capabilities: this.initializeCapabilities(protocolVersion),
            serverInfo: { name: this.name, version: this.version },
        });
    }
    handleDiscover(request, protocolVersion) {
        const result = {
            supportedVersions: supportedProtocolVersions(),
            capabilities: this.initializeCapabilities(protocolVersion),
        };
        if (protocolVersion !== MCP_PROTOCOL_VERSION_2026_07_28) {
            result._meta = {
                [SERVER_INFO_METADATA_KEY]: {
                    name: this.name,
                    version: this.version,
                },
            };
        }
        return newResultResponse(request.id, result);
    }
    initializeCapabilities(protocolVersion) {
        const capabilities = {};
        if (this.resourceRegistry.len() > 0 ||
            this.resourceRegistry.templateLen() > 0) {
            capabilities["resources"] = {};
        }
        if (this.toolRegistry.len() > 0) {
            capabilities["tools"] = {};
        }
        if (this.promptRegistry.len() > 0) {
            capabilities["prompts"] = {};
        }
        if (protocolVersion === MCP_PROTOCOL_VERSION && this.tasksEnabled()) {
            capabilities["tasks"] = {
                cancel: {},
                list: {},
                requests: { tools: { call: {} } },
            };
        }
        if (protocolVersion === MCP_PROTOCOL_VERSION_2026_07_28 &&
            Object.keys(this.extensionCapabilities).length > 0) {
            capabilities["extensions"] = cloneExtensionCapabilities(this.extensionCapabilities);
        }
        return capabilities;
    }
    async handleToolsCall(request, sessionId, protocolVersion, ctx) {
        const params = paramsRecord(request.params);
        const name = String(params["name"] ?? "").trim();
        if (!name) {
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, "Invalid params: missing tool name");
        }
        const taskSupport = this.toolRegistry.taskSupport(name);
        if (Object.prototype.hasOwnProperty.call(params, "task")) {
            // Task-augmented tools/call is part of the 2025-11-25 protocol surface
            // only; earlier versions use the disabled-task error for the same rule.
            if (protocolVersion !== MCP_PROTOCOL_VERSION || !this.tasksEnabled()) {
                return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tasks not enabled");
            }
            return this.handleTaskToolsCall(request, sessionId, name, params, ctx);
        }
        if (taskSupport === "required") {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tool requires task execution");
        }
        try {
            const toolContext = {
                sessionId,
                requestId: request.id,
                method: request.method,
            };
            if (isRecord(params["inputResponses"])) {
                toolContext.inputResponses = { ...params["inputResponses"] };
            }
            if (typeof params["requestState"] === "string") {
                toolContext.requestState = params["requestState"];
            }
            const auth = authFromContext(ctx);
            if (auth) {
                toolContext.auth = auth;
            }
            const result = await this.toolRegistry.call(name, params["arguments"], toolContext);
            return newResultResponse(request.id, result);
        }
        catch (err) {
            return this.toolCallError(request.id, name, err);
        }
    }
    async handleResourcesRead(request) {
        const params = paramsRecord(request.params);
        const uri = String(params["uri"] ?? "");
        try {
            const contents = await this.resourceRegistry.read(uri);
            return newResultResponse(request.id, { contents });
        }
        catch (err) {
            const message = errorMessage(err);
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, message.startsWith("resource not found:")
                ? message
                : this.handlerErrorMessage(err, "resources/read"));
        }
    }
    async handlePromptsGet(request) {
        const params = paramsRecord(request.params);
        const name = String(params["name"] ?? "");
        try {
            const result = await this.promptRegistry.get(name, params["arguments"]);
            return newResultResponse(request.id, result);
        }
        catch (err) {
            const message = errorMessage(err);
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, message.startsWith("prompt not found:")
                ? message
                : this.handlerErrorMessage(err, "prompts/get"));
        }
    }
    shouldStreamToolsCall(request) {
        if (!this.methodCapabilityEnabled("tools/call")) {
            return false;
        }
        const params = paramsRecord(request.params);
        const name = String(params["name"] ?? "").trim();
        if (!name || Object.prototype.hasOwnProperty.call(params, "task")) {
            return false;
        }
        if (this.toolRegistry.taskSupport(name) === "required") {
            return false;
        }
        return this.toolRegistry.supportsStreaming(name);
    }
    async handleToolsCallStream(sessionId, request, ctx) {
        let streamId = "";
        try {
            streamId = await this.streamStore.create(sessionId);
            await this.streamStore.append(sessionId, streamId);
            const params = paramsRecord(request.params);
            const name = String(params["name"] ?? "").trim();
            const progressToken = normalizeProgressToken(paramsRecord(params["_meta"])["progressToken"]);
            let progressSequence = 0;
            const emit = async (event) => {
                if (progressToken === undefined) {
                    return;
                }
                progressSequence += 1;
                const progress = progressFromSSEEvent(event, progressSequence);
                const notification = {
                    jsonrpc: JSONRPC_VERSION,
                    method: "notifications/progress",
                    params: {
                        message: progress.message,
                        progress: progress.progress,
                        progressToken,
                        total: progress.total,
                    },
                };
                await this.streamStore.append(sessionId, streamId, Buffer.from(JSON.stringify(notification), "utf8"));
            };
            const streamingContext = {
                sessionId,
                requestId: request.id,
                method: request.method,
            };
            const auth = authFromContext(ctx);
            if (auth) {
                streamingContext.auth = auth;
            }
            const result = await this.toolRegistry.callStreaming(name, params["arguments"], emit, streamingContext);
            await this.streamStore.append(sessionId, streamId, Buffer.from(JSON.stringify(newResultResponse(request.id, result)), "utf8"));
            await this.streamStore.close(sessionId, streamId);
            const events = await this.streamStore.subscribe(sessionId, streamId);
            return this.streamToSSE(sessionId, events);
        }
        catch (err) {
            if (streamId) {
                await this.streamStore
                    .close(sessionId, streamId)
                    .catch(() => undefined);
            }
            return this.marshalSingleResponse(this.toolCallError(request.id, "", err));
        }
    }
    async handleTaskToolsCall(request, sessionId, name, params, ctx) {
        const store = this.taskRuntime.store;
        if (!store) {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tasks not enabled");
        }
        const support = this.toolRegistry.taskSupport(name);
        if (support !== "optional" && support !== "required") {
            return newErrorResponse(request.id, MCP_CODE_METHOD_NOT_FOUND, "Method not found: tool does not support task execution");
        }
        const ttl = taskTTL(this.taskRuntime, paramsRecord(params["task"]));
        if (ttl.error) {
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, ttl.error);
        }
        const taskId = normalizeRequired(this.idGenerator.newId(), "task id generator returned empty id");
        const now = isoNoMillis(new Date());
        const record = {
            sessionId,
            method: "tools/call",
            toolName: name,
            task: {
                taskId,
                status: "working",
                createdAt: now,
                lastUpdatedAt: now,
                ttl: ttl.value,
                pollInterval: this.taskRuntime.pollIntervalMs,
            },
        };
        const created = await store.create(record);
        // The body runs to completion inside this tools/call invocation, so the
        // reply describes the task's terminal state. A task left running in a
        // detached promise could stay `working` forever, lose its result, or
        // half-apply its writes: the Lambda execution environment is frozen once the
        // handler returns, so the work resumes at an unpredictable time (or never).
        const finished = await this.finishTask(store, created, params["arguments"], ctx);
        const meta = {
            [RELATED_TASK_METADATA_KEY]: { taskId: finished.task.taskId },
        };
        if (this.taskRuntime.modelImmediateResponse) {
            meta[MODEL_IMMEDIATE_RESPONSE_METADATA_KEY] =
                this.taskRuntime.modelImmediateResponse;
        }
        return newResultResponse(request.id, {
            _meta: meta,
            task: cloneTask(finished.task),
        });
    }
    async finishTask(store, record, args, ctx) {
        const next = cloneTaskRecord(record);
        next.task.lastUpdatedAt = isoNoMillis(new Date());
        const toolContext = {
            sessionId: record.sessionId,
            requestId: record.task.taskId,
            method: record.method,
        };
        const auth = authFromContext(ctx);
        if (auth) {
            toolContext.auth = auth;
        }
        try {
            const result = await this.toolRegistry.call(String(record.toolName ?? ""), args, toolContext);
            next.result = result;
            next.task.status = result.isError ? "failed" : "completed";
            if (result.isError) {
                next.task.statusMessage = "tool returned isError result";
            }
        }
        catch (err) {
            const message = this.handlerErrorMessage(err, "tasks/call");
            next.error = { code: MCP_CODE_SERVER_ERROR, message };
            next.task.status = "failed";
            next.task.statusMessage = message;
        }
        try {
            return await store.update(next);
        }
        catch (err) {
            if (!(err instanceof McpTaskTerminalError)) {
                throw err;
            }
            // A concurrent tasks/cancel won the race and the store already holds a
            // terminal state for this task; that state is authoritative.
            const current = await store.get({
                sessionId: next.sessionId,
                taskId: next.task.taskId,
            });
            return current ?? next;
        }
    }
    taskStoreError(id, err) {
        if (err instanceof McpTaskNotFoundError ||
            err instanceof McpTaskTerminalError ||
            err instanceof McpTaskInvalidCursorError) {
            return newErrorResponse(id, MCP_CODE_INVALID_PARAMS, err.message);
        }
        const message = errorMessage(err);
        if (taskControlErrorMessage(message)) {
            return newErrorResponse(id, MCP_CODE_SERVER_ERROR, message);
        }
        return newErrorResponse(id, MCP_CODE_SERVER_ERROR, this.handlerErrorMessage(err, "task store"));
    }
    taskWireError(record, rpcErr) {
        if (this.verboseHandlerErrors || !taskErrorNeedsRedaction(rpcErr)) {
            return rpcErr;
        }
        getLogger().error("mcp task error", {
            taskId: record.task.taskId,
            tool: record.toolName ?? "",
            error: rpcErr.message,
        });
        return { code: rpcErr.code, message: "internal error" };
    }
    async handleTasksGet(request, sessionId) {
        const lookup = taskLookupFromRequest(request, sessionId);
        if (lookup.error) {
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, lookup.error);
        }
        try {
            const record = await this.requireTaskStore().get(lookup.value);
            return newResultResponse(request.id, cloneTask(record.task));
        }
        catch (err) {
            return this.taskStoreError(request.id, err);
        }
    }
    async handleTasksResult(request, sessionId) {
        const lookup = taskLookupFromRequest(request, sessionId);
        if (lookup.error) {
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, lookup.error);
        }
        try {
            const record = await this.requireTaskStore().get(lookup.value);
            if (record.error) {
                return {
                    jsonrpc: JSONRPC_VERSION,
                    id: request.id,
                    error: this.taskWireError(record, record.error),
                };
            }
            if (record.task.status === "canceled" && record.result === undefined) {
                return newErrorResponse(request.id, MCP_CODE_SERVER_ERROR, TASK_CANCELED_MESSAGE);
            }
            if (record.result === undefined) {
                return newErrorResponse(request.id, MCP_CODE_INTERNAL_ERROR, "task result not available");
            }
            return newResultResponse(request.id, taskResultWithRelatedMetadata(record.result, record.task.taskId));
        }
        catch (err) {
            return this.taskStoreError(request.id, err);
        }
    }
    async handleTasksList(request, sessionId) {
        const params = paramsRecord(request.params);
        try {
            const result = await this.requireTaskStore().list({
                sessionId,
                cursor: String(params["cursor"] ?? ""),
                limit: this.taskRuntime.listLimit,
            });
            return newResultResponse(request.id, result);
        }
        catch (err) {
            return this.taskStoreError(request.id, err);
        }
    }
    async handleTasksCancel(request, sessionId) {
        const lookup = taskLookupFromRequest(request, sessionId);
        if (lookup.error) {
            return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, lookup.error);
        }
        try {
            const record = await this.requireTaskStore().cancel(lookup.value);
            return newResultResponse(request.id, cloneTask(record.task));
        }
        catch (err) {
            return this.taskStoreError(request.id, err);
        }
    }
    requireTaskStore() {
        const store = this.taskRuntime.store;
        if (!store) {
            throw new Error("tasks not enabled");
        }
        return store;
    }
    tasksEnabled() {
        return Boolean(this.taskRuntime.store) && this.toolRegistry.supportsTasks();
    }
    methodCapabilityEnabled(method) {
        switch (method) {
            case "tools/list":
            case "tools/call":
                return this.toolRegistry.len() > 0;
            case "resources/list":
            case "resources/read":
                return this.resourceRegistry.len() > 0;
            case "resources/templates/list":
                return this.resourceRegistry.templateLen() > 0;
            case "prompts/list":
            case "prompts/get":
                return this.promptRegistry.len() > 0;
            default:
                return true;
        }
    }
    async getSession(sessionId, ctx) {
        let session;
        try {
            session = await this.sessionStore.get(sessionId);
        }
        catch (err) {
            if (err instanceof McpSessionNotFoundError) {
                await this.cleanupSessionState(sessionId).catch((cleanupErr) => {
                    getLogger().warn("mcp session cleanup failed", {
                        sessionId,
                        error: errorMessage(cleanupErr),
                    });
                });
            }
            throw err;
        }
        if (sessionExpiredAt(new Date(), session)) {
            await this.sessionStore.delete(sessionId);
            await this.cleanupSessionState(sessionId).catch((cleanupErr) => {
                getLogger().warn("mcp expired session cleanup failed", {
                    sessionId,
                    error: errorMessage(cleanupErr),
                });
            });
            throw new McpSessionNotFoundError();
        }
        const storedPrincipal = String(session.principal ?? "").trim();
        if (storedPrincipal && storedPrincipal !== principalFromContext(ctx)) {
            throw new McpSessionNotFoundError();
        }
        const refreshed = cloneSession(session);
        refreshed.expiresAt = isoNoMillis(new Date(Date.now() + this.sessionTtlMs));
        if (!refreshed.createdAt) {
            refreshed.createdAt = isoNoMillis(new Date());
        }
        await this.sessionStore.put(refreshed);
        return refreshed;
    }
    async requireSession(headers, ctx) {
        const sessionId = firstHeader(headers, MCP_HEADER_SESSION_ID);
        if (!sessionId) {
            return {
                sessionId: "",
                session: null,
                response: badRequest("missing Mcp-Session-Id"),
            };
        }
        try {
            return {
                sessionId,
                session: await this.getSession(sessionId, ctx),
                response: null,
            };
        }
        catch (err) {
            if (err instanceof McpSessionNotFoundError) {
                return {
                    sessionId: "",
                    session: null,
                    response: notFound("session not found"),
                };
            }
            return { sessionId: "", session: null, response: internalServerError() };
        }
    }
    requireProtocolVersion(headers, session) {
        const value = firstHeader(headers, MCP_HEADER_PROTOCOL_VERSION);
        if (!value) {
            return null;
        }
        if (!isSupportedProtocolVersion(value)) {
            return badRequest("unsupported MCP-Protocol-Version");
        }
        const expected = String(session.data?.["protocolVersion"] ?? "").trim();
        if (expected && expected !== value) {
            return badRequest("MCP-Protocol-Version mismatch");
        }
        return null;
    }
    async createSession(protocolVersion, principal) {
        const now = new Date();
        const session = {
            id: normalizeRequired(this.idGenerator.newId(), "session id generator returned empty id"),
            createdAt: isoNoMillis(now),
            expiresAt: isoNoMillis(new Date(now.valueOf() + this.sessionTtlMs)),
            data: { protocolVersion },
        };
        if (principal) {
            session.principal = principal;
        }
        const sweeper = this.sessionStore;
        if (typeof sweeper.putAndCollectExpired === "function") {
            const expired = await sweeper.putAndCollectExpired(session);
            for (const expiredId of expired) {
                try {
                    await this.cleanupSessionState(expiredId);
                }
                catch (err) {
                    await this.sessionStore.delete(session.id).catch(() => undefined);
                    throw err;
                }
            }
            return session;
        }
        await this.sessionStore.put(session);
        return session;
    }
    handlerErrorMessage(err, surface) {
        const message = errorMessage(err);
        if (this.verboseHandlerErrors) {
            return message;
        }
        getLogger().error("mcp handler error", { surface, error: message });
        return "internal error";
    }
    toolCallError(id, toolName, err) {
        const message = errorMessage(err);
        if (message.startsWith("tool not found:")) {
            return newErrorResponse(id, MCP_CODE_INVALID_PARAMS, message);
        }
        if (!this.verboseHandlerErrors) {
            getLogger().error("mcp tool handler error", {
                tool: toolName,
                error: message,
            });
            return newErrorResponse(id, MCP_CODE_SERVER_ERROR, "internal error");
        }
        const resolved = toolName ? message : message || "internal error";
        return newErrorResponse(id, MCP_CODE_SERVER_ERROR, resolved);
    }
    marshalSingleResponse(response, sessionId = "", includeSession = false, protocolVersion = "") {
        const headers = { "content-type": ["application/json"] };
        if (includeSession && sessionId) {
            headers[MCP_HEADER_SESSION_ID] = [sessionId];
        }
        const status = protocolVersion === MCP_PROTOCOL_VERSION_2026_07_28 &&
            response.error?.code === MCP_CODE_METHOD_NOT_FOUND
            ? 404
            : 200;
        return {
            status,
            headers,
            cookies: [],
            body: Buffer.from(JSON.stringify(response), "utf8"),
            isBase64: false,
        };
    }
    streamToSSE(sessionId, events) {
        const chunks = events.map((event) => formatMcpSSEFrame(event));
        return sseBytesResponse(200, chunks, sessionId);
    }
    validateOrigin(headers) {
        const origin = firstHeader(headers, "origin");
        if (!origin) {
            return null;
        }
        if (!this.originValidator(origin)) {
            return jsonBytesResponse(403, { error: "forbidden" });
        }
        return null;
    }
}
export function createMcpServer(name, version, options = {}) {
    return new McpServer(name, version, options);
}
export function defaultMcpTaskModel(tableName) {
    return defineModel({
        name: "AppTheoryMcpTask",
        table: {
            name: tableName ?? process.env["MCP_TASK_TABLE"] ?? DEFAULT_TASK_TABLE_NAME,
        },
        keys: {
            partition: { attribute: "sessionId", type: "S" },
            sort: { attribute: "taskId", type: "S" },
        },
        attributes: [
            { attribute: "sessionId", type: "S", required: true },
            { attribute: "taskId", type: "S", required: true },
            { attribute: "method", type: "S", required: true },
            { attribute: "toolName", type: "S", optional: true },
            { attribute: "status", type: "S", required: true },
            { attribute: "statusMessage", type: "S", optional: true },
            { attribute: "createdAt", type: "S", required: true },
            { attribute: "lastUpdatedAt", type: "S", required: true },
            { attribute: "expiresAt", type: "N", optional: true, roles: ["ttl"] },
            { attribute: "ttl", type: "N", optional: true },
            { attribute: "pollInterval", type: "N", optional: true },
            { attribute: "result", type: "M", optional: true, json: true },
            { attribute: "error", type: "M", optional: true, json: true },
        ],
    });
}
export function defaultMcpStreamModel(tableName) {
    return defineModel({
        name: "AppTheoryMcpStream",
        table: {
            name: tableName ??
                process.env["MCP_STREAM_TABLE"] ??
                DEFAULT_STREAM_TABLE_NAME,
        },
        keys: {
            partition: { attribute: "sessionId", type: "S" },
            sort: { attribute: "itemId", type: "S" },
        },
        attributes: [
            { attribute: "sessionId", type: "S", required: true },
            { attribute: "itemId", type: "S", required: true },
            { attribute: "streamId", type: "S", required: true },
            { attribute: "kind", type: "S", required: true },
            { attribute: "closed", type: "BOOL", optional: true },
            { attribute: "sequence", type: "N", optional: true },
            { attribute: "eventId", type: "S", optional: true },
            { attribute: "data", type: "S", optional: true },
            { attribute: "aggregateVersion", type: "N", optional: true },
            { attribute: "eventCount", type: "N", optional: true },
            { attribute: "aggregateBytes", type: "N", optional: true },
            { attribute: "deleted", type: "BOOL", optional: true },
            { attribute: "dataStorage", type: "S", optional: true },
            { attribute: "dataRef", type: "S", optional: true },
            { attribute: "dataBytes", type: "N", optional: true },
            { attribute: "dataSha256", type: "S", optional: true },
            { attribute: "expiresAt", type: "N", optional: true, roles: ["ttl"] },
        ],
    });
}
function normalizeSessionTtlMs(value) {
    const fromOption = Number(value ?? 0);
    if (Number.isFinite(fromOption) && fromOption > 0) {
        return Math.floor(fromOption);
    }
    const raw = String(process.env["MCP_SESSION_TTL_MINUTES"] ?? "").trim();
    const minutes = Number(raw || DEFAULT_SESSION_TTL_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0) {
        return Math.floor(minutes * 60 * 1000);
    }
    return DEFAULT_SESSION_TTL_MINUTES * 60 * 1000;
}
function normalizeTaskRuntime(options) {
    if (!options?.store) {
        return {
            store: null,
            defaultTtlMs: DEFAULT_TASK_TTL_MS,
            maxTtlMs: DEFAULT_TASK_MAX_TTL_MS,
            pollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS,
            listLimit: DEFAULT_TASK_LIST_LIMIT,
            modelImmediateResponse: "",
        };
    }
    let maxTtlMs = positiveInteger(options.maxTtlMs, DEFAULT_TASK_MAX_TTL_MS);
    let defaultTtlMs = positiveInteger(options.defaultTtlMs, DEFAULT_TASK_TTL_MS);
    if (defaultTtlMs > maxTtlMs) {
        defaultTtlMs = maxTtlMs;
    }
    const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_TASK_POLL_INTERVAL_MS);
    let listLimit = positiveInteger(options.listLimit, DEFAULT_TASK_LIST_LIMIT);
    if (listLimit > MAX_TASK_LIST_LIMIT) {
        listLimit = MAX_TASK_LIST_LIMIT;
    }
    maxTtlMs = Math.max(maxTtlMs, 1);
    return {
        store: options.store,
        defaultTtlMs,
        maxTtlMs,
        pollIntervalMs,
        listLimit,
        modelImmediateResponse: String(options.modelImmediateResponse ?? "").trim(),
    };
}
function normalizeCacheableResultConfig(config) {
    return {
        serverDiscover: normalizeCacheHint(config?.serverDiscover),
        toolsList: normalizeCacheHint(config?.toolsList),
        promptsList: normalizeCacheHint(config?.promptsList),
        resourcesList: normalizeCacheHint(config?.resourcesList),
        resourceTemplatesList: normalizeCacheHint(config?.resourceTemplatesList),
        resourcesRead: normalizeCacheHint(config?.resourcesRead),
    };
}
function normalizeCacheHint(hint) {
    const rawTtlMs = Number(hint?.ttlMs ?? 0);
    return {
        ttlMs: Number.isFinite(rawTtlMs) && rawTtlMs >= 0 ? Math.floor(rawTtlMs) : 0,
        cacheScope: hint?.cacheScope === "public" ? "public" : "private",
    };
}
function cacheHintForMethod(config, method) {
    switch (method) {
        case "server/discover":
            return config.serverDiscover;
        case "tools/list":
            return config.toolsList;
        case "prompts/list":
            return config.promptsList;
        case "resources/list":
            return config.resourcesList;
        case "resources/templates/list":
            return config.resourceTemplatesList;
        case "resources/read":
            return config.resourcesRead;
        default:
            return null;
    }
}
function requestIsMultiRoundTripRetry(request) {
    if (!isRecord(request.params)) {
        return false;
    }
    return (Object.prototype.hasOwnProperty.call(request.params, "inputResponses") ||
        Object.prototype.hasOwnProperty.call(request.params, "requestState"));
}
function normalizeExtensionCapabilities(capabilities) {
    if (!isRecord(capabilities)) {
        return {};
    }
    const normalized = {};
    for (const [rawIdentifier, rawSettings] of Object.entries(capabilities)) {
        const identifier = rawIdentifier;
        if (!validExtensionIdentifier(identifier) || !isRecord(rawSettings)) {
            continue;
        }
        try {
            const cloned = JSON.parse(JSON.stringify(rawSettings));
            if (isRecord(cloned)) {
                normalized[identifier] = cloned;
            }
        }
        catch {
            // Invalid JSON settings are not advertised so negotiation fails closed.
        }
    }
    return normalized;
}
function cloneExtensionCapabilities(capabilities) {
    const cloned = {};
    for (const [identifier, settings] of Object.entries(capabilities)) {
        cloned[identifier] = JSON.parse(JSON.stringify(settings));
    }
    return cloned;
}
function validExtensionIdentifier(identifier) {
    const slash = identifier.indexOf("/");
    if (slash <= 0 ||
        slash !== identifier.lastIndexOf("/") ||
        identifier !== identifier.trim()) {
        return false;
    }
    const prefix = identifier.slice(0, slash);
    const name = identifier.slice(slash + 1);
    const validLabel = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
    const validName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
    return (prefix.split(".").every((label) => validLabel.test(label)) &&
        (name === "" || validName.test(name)));
}
function positiveInteger(value, fallback) {
    const n = Number(value ?? 0);
    if (Number.isFinite(n) && n > 0) {
        return Math.floor(n);
    }
    return fallback;
}
function protocolShapeForVersion(value) {
    if (value === MCP_PROTOCOL_VERSION) {
        return MCP_PROTOCOL_SHAPE_2025_11_25;
    }
    if (value === MCP_PROTOCOL_VERSION_2026_07_28) {
        return MCP_PROTOCOL_SHAPE_2026_07_28;
    }
    return MCP_PROTOCOL_SHAPE_UNKNOWN;
}
function protocolRequestRecord(request) {
    let value = request;
    if (value instanceof Uint8Array) {
        value = Buffer.from(value).toString("utf8");
    }
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    return isRecord(value) ? value : null;
}
function isSupportedProtocolVersion(value) {
    return (value === MCP_PROTOCOL_VERSION ||
        value === MCP_PROTOCOL_VERSION_PRIOR ||
        value === MCP_PROTOCOL_VERSION_LEGACY);
}
function negotiateProtocolVersion(params) {
    const requested = String(paramsRecord(params)["protocolVersion"] ?? "").trim();
    if (!requested) {
        return MCP_PROTOCOL_VERSION;
    }
    return isSupportedProtocolVersion(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
}
function sessionProtocolVersion(session) {
    const value = String(session.data?.["protocolVersion"] ?? "").trim();
    return isSupportedProtocolVersion(value)
        ? value
        : MCP_PROTOCOL_VERSION_LEGACY;
}
function methodAllowedForProtocol(protocolVersion, method) {
    if (protocolVersion === MCP_PROTOCOL_VERSION_2026_07_28) {
        return new Set([
            "server/discover",
            "tools/list",
            "tools/call",
            "resources/list",
            "resources/read",
            "resources/templates/list",
            "completion/complete",
            "prompts/list",
            "prompts/get",
        ]).has(method);
    }
    if (!isSupportedProtocolVersion(protocolVersion)) {
        return false;
    }
    if (isTaskMethod(method)) {
        return protocolVersion === MCP_PROTOCOL_VERSION;
    }
    return new Set([
        "initialize",
        "server/discover",
        "notifications/initialized",
        "notifications/cancelled",
        "ping",
        "tools/list",
        "tools/call",
        "resources/list",
        "resources/read",
        "resources/templates/list",
        "resources/subscribe",
        "resources/unsubscribe",
        "logging/setLevel",
        "completion/complete",
        "prompts/list",
        "prompts/get",
    ]).has(method);
}
function isTaskMethod(method) {
    return new Set([
        "tasks/get",
        "tasks/result",
        "tasks/list",
        "tasks/cancel",
    ]).has(method);
}
function statelessRequestRequiresSession(request) {
    return (request.method === "tools/call" &&
        Object.prototype.hasOwnProperty.call(paramsRecord(request.params), "task"));
}
function parseRequest(body) {
    const raw = parseJsonObject(body);
    if (!Object.prototype.hasOwnProperty.call(raw, "jsonrpc")) {
        throw new Error("missing required field: jsonrpc");
    }
    if (!Object.prototype.hasOwnProperty.call(raw, "method")) {
        throw new Error("missing required field: method");
    }
    const idPresent = Object.prototype.hasOwnProperty.call(raw, "id");
    const id = raw["id"];
    if (idPresent && id === null) {
        throw new Error("id must not be null");
    }
    const jsonrpc = String(raw["jsonrpc"] ?? "");
    if (jsonrpc !== JSONRPC_VERSION) {
        throw new Error(`unsupported jsonrpc version: ${jsonrpc}`);
    }
    const method = String(raw["method"] ?? "");
    if (!method) {
        throw new Error("method must not be empty");
    }
    const out = { method, idPresent };
    if (idPresent) {
        out.id = id;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "params")) {
        out.params = raw["params"];
    }
    return out;
}
function parseResponse(body) {
    const raw = parseJsonObject(body);
    if (!Object.prototype.hasOwnProperty.call(raw, "jsonrpc")) {
        throw new Error("missing required field: jsonrpc");
    }
    if (!Object.prototype.hasOwnProperty.call(raw, "id")) {
        throw new Error("missing required field: id");
    }
    const hasResult = Object.prototype.hasOwnProperty.call(raw, "result");
    const hasError = Object.prototype.hasOwnProperty.call(raw, "error");
    if (hasResult === hasError) {
        throw new Error("response must have exactly one of result or error");
    }
    if (String(raw["jsonrpc"] ?? "") !== JSONRPC_VERSION) {
        throw new Error(`unsupported jsonrpc version: ${String(raw["jsonrpc"] ?? "")}`);
    }
    return raw;
}
function parseJsonObject(body) {
    if (body.length === 0) {
        throw new Error("empty request body");
    }
    const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!isRecord(parsed)) {
        throw new Error("invalid JSON object");
    }
    return parsed;
}
function validatePostHeaders(headers) {
    if (!contentTypeIsJSON(headers)) {
        return badRequest("POST /mcp requires Content-Type: application/json");
    }
    if (!acceptsJSON(headers) || !acceptsEventStream(headers)) {
        return badRequest("POST /mcp requires Accept: application/json and text/event-stream");
    }
    return null;
}
function validateGetHeaders(headers) {
    if (!acceptsEventStream(headers)) {
        return badRequest("GET /mcp requires Accept: text/event-stream");
    }
    return null;
}
function contentTypeIsJSON(headers) {
    const media = parseMediaRange(firstHeader(headers, "content-type"));
    return Boolean(media && media.type === "application" && media.subtype === "json");
}
function acceptsJSON(headers) {
    return headerIncludesMediaType(headers, "accept", "application/json");
}
function acceptsEventStream(headers) {
    return headerIncludesMediaType(headers, "accept", "text/event-stream");
}
function headerIncludesMediaType(headers, key, want) {
    const wantMedia = parseMediaRange(want);
    if (!wantMedia) {
        return false;
    }
    for (const value of headerValues(headers, key)) {
        for (const part of String(value).split(",")) {
            const media = parseMediaRange(part);
            if (!media) {
                continue;
            }
            const typeMatches = media.type === "*" || media.type === wantMedia.type;
            const subtypeMatches = media.subtype === "*" || media.subtype === wantMedia.subtype;
            if (typeMatches && subtypeMatches) {
                return true;
            }
        }
    }
    return false;
}
function parseMediaRange(raw) {
    const parts = String(raw ?? "").split(";");
    const mediaType = String(parts[0] ?? "")
        .trim()
        .toLowerCase();
    if (!mediaType || !mediaType.includes("/")) {
        return null;
    }
    const [typePart, subtypePart] = mediaType.split("/", 2);
    const type = String(typePart ?? "").trim();
    const subtype = String(subtypePart ?? "").trim();
    if (!type || !subtype) {
        return null;
    }
    for (const param of parts.slice(1)) {
        const [name, value] = String(param).split("=", 2);
        if (String(name ?? "")
            .trim()
            .toLowerCase() !== "q") {
            continue;
        }
        const q = Number(String(value ?? "")
            .trim()
            .replace(/^"|"$/g, ""));
        if (Number.isFinite(q) && q <= 0) {
            return null;
        }
    }
    return { type, subtype };
}
function firstHeader(headers, key) {
    const values = headerValues(headers, key);
    return values.length > 0 ? String(values[0] ?? "") : "";
}
function validatePostRequestProtocol(headers, request, detectedShape) {
    if (conflictingHeaderValues(headers, MCP_HEADER_PROTOCOL_VERSION)) {
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: conflicting MCP-Protocol-Version header values"),
        };
    }
    const headerVersion = firstHeader(headers, MCP_HEADER_PROTOCOL_VERSION).trim();
    const metaVersion = requestProtocolVersionMetadata(request);
    if (headerVersion && !isAdvertisedProtocolVersion(headerVersion)) {
        if (!metaVersion &&
            (firstHeader(headers, MCP_HEADER_SESSION_ID).trim() ||
                request.method === "initialize")) {
            return { shape: detectedShape, response: null };
        }
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: unsupportedProtocolVersionResponse(request.id, headerVersion),
        };
    }
    if (metaVersion && !isAdvertisedProtocolVersion(metaVersion)) {
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: unsupportedProtocolVersionResponse(request.id, metaVersion),
        };
    }
    const modernClaim = headerVersion === MCP_PROTOCOL_VERSION_2026_07_28 ||
        metaVersion === MCP_PROTOCOL_VERSION_2026_07_28;
    if (modernClaim &&
        headerVersion &&
        metaVersion &&
        headerVersion !== metaVersion) {
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version does not match request metadata"),
        };
    }
    if (metaVersion === MCP_PROTOCOL_VERSION_2026_07_28 && !headerVersion) {
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: missing required MCP-Protocol-Version header"),
        };
    }
    if (!modernClaim) {
        return { shape: detectedShape, response: null };
    }
    const metadataResponse = validate20260728RequestMetadata(request);
    if (metadataResponse) {
        return {
            shape: MCP_PROTOCOL_SHAPE_UNKNOWN,
            response: metadataResponse,
        };
    }
    return {
        shape: MCP_PROTOCOL_SHAPE_2026_07_28,
        response: validate20260728RoutingHeaders(headers, request),
    };
}
function validatePostResponseProtocol(headers, response, detectedShape) {
    if (conflictingHeaderValues(headers, MCP_HEADER_PROTOCOL_VERSION)) {
        return protocolErrorResponse(response["id"], MCP_CODE_HEADER_MISMATCH, "Header mismatch: conflicting MCP-Protocol-Version header values");
    }
    const headerVersion = firstHeader(headers, MCP_HEADER_PROTOCOL_VERSION).trim();
    if (headerVersion && !isAdvertisedProtocolVersion(headerVersion)) {
        if (firstHeader(headers, MCP_HEADER_SESSION_ID).trim()) {
            return null;
        }
        return unsupportedProtocolVersionResponse(response["id"], headerVersion);
    }
    if (detectedShape !== MCP_PROTOCOL_SHAPE_2026_07_28) {
        return null;
    }
    return protocolErrorResponse(response["id"], MCP_CODE_INVALID_REQUEST, "Invalid Request: clients must not send JSON-RPC responses");
}
function validate20260728RequestMetadata(request) {
    if (!isRecord(request.params) || !isRecord(request.params["_meta"])) {
        return protocolErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, "Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion");
    }
    const meta = request.params["_meta"];
    const protocolVersion = meta[PROTOCOL_VERSION_METADATA_KEY];
    if (typeof protocolVersion !== "string" ||
        protocolVersion.trim() !== MCP_PROTOCOL_VERSION_2026_07_28) {
        return protocolErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, "Invalid params: missing or invalid io.modelcontextprotocol/protocolVersion");
    }
    if (!isRecord(meta[CLIENT_CAPABILITIES_METADATA_KEY])) {
        return protocolErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, "Invalid params: missing or invalid io.modelcontextprotocol/clientCapabilities");
    }
    return null;
}
function validate20260728RoutingHeaders(headers, request) {
    if (conflictingHeaderValues(headers, MCP_HEADER_METHOD)) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: conflicting Mcp-Method header values");
    }
    if (conflictingHeaderValues(headers, MCP_HEADER_NAME)) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: conflicting Mcp-Name header values");
    }
    const method = firstHeader(headers, MCP_HEADER_METHOD).trim();
    if (!method) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: missing required Mcp-Method header");
    }
    if (method !== request.method) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: Mcp-Method does not match request method");
    }
    const routingName = requestRoutingName(request);
    if (routingName.invalidMessage) {
        return protocolErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, routingName.invalidMessage);
    }
    if (!routingName.required) {
        return null;
    }
    let name = firstHeader(headers, MCP_HEADER_NAME).trim();
    if (!name) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: missing required Mcp-Name header");
    }
    const decodedName = decodeRoutingHeaderName(name);
    if (decodedName.malformed) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: malformed Mcp-Name Base64 encoding");
    }
    name = decodedName.value;
    if (name !== routingName.value) {
        return protocolErrorResponse(request.id, MCP_CODE_HEADER_MISMATCH, "Header mismatch: Mcp-Name does not match request parameters");
    }
    return null;
}
function decodeRoutingHeaderName(value) {
    const prefix = "=?base64?";
    const suffix = "?=";
    if (!value.startsWith(prefix)) {
        return { value, malformed: false };
    }
    if (value.length < prefix.length + suffix.length || !value.endsWith(suffix)) {
        return { value: "", malformed: true };
    }
    const encoded = value.slice(prefix.length, -suffix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return { value: "", malformed: true };
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) {
        return { value: "", malformed: true };
    }
    const text = decoded.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(decoded)) {
        return { value: "", malformed: true };
    }
    return { value: text, malformed: false };
}
function requestRoutingName(request) {
    let field;
    switch (request.method) {
        case "tools/call":
        case "prompts/get":
            field = "name";
            break;
        case "resources/read":
            field = "uri";
            break;
        default:
            return { value: "", required: false, invalidMessage: "" };
    }
    const invalidMessage = `Invalid params: params.${field} must be a non-empty string`;
    if (!isRecord(request.params)) {
        return { value: "", required: true, invalidMessage };
    }
    const params = request.params;
    const value = params[field];
    if (typeof value !== "string" || !value.trim()) {
        return { value: "", required: true, invalidMessage };
    }
    return {
        value,
        required: true,
        invalidMessage: "",
    };
}
function conflictingHeaderValues(headers, key) {
    const lower = String(key ?? "").toLowerCase();
    let first;
    for (const [name, rawValues] of Object.entries(headers ?? {})) {
        if (name.toLowerCase() !== lower) {
            continue;
        }
        const values = Array.isArray(rawValues)
            ? rawValues
            : [rawValues];
        for (const raw of values) {
            const value = String(raw ?? "").trim();
            if (first === undefined) {
                first = value;
            }
            else if (value !== first) {
                return true;
            }
        }
    }
    return false;
}
function requestMetadata(request) {
    const params = isRecord(request.params) ? request.params : null;
    return params && isRecord(params["_meta"]) ? params["_meta"] : {};
}
function requestProtocolVersionMetadata(request) {
    const value = requestMetadata(request)[PROTOCOL_VERSION_METADATA_KEY];
    return typeof value === "string" ? value.trim() : "";
}
function isAdvertisedProtocolVersion(version) {
    return supportedProtocolVersions().includes(version);
}
function supportedProtocolVersions() {
    return [
        MCP_PROTOCOL_VERSION_2026_07_28,
        MCP_PROTOCOL_VERSION,
        MCP_PROTOCOL_VERSION_PRIOR,
        MCP_PROTOCOL_VERSION_LEGACY,
    ];
}
function unsupportedProtocolVersionResponse(id, requested) {
    return protocolErrorResponse(id, MCP_CODE_UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: supportedProtocolVersions(), requested });
}
function protocolErrorResponse(id, code, message, data) {
    return jsonBytesResponse(400, newErrorResponse(id, code, message, data));
}
function missingRequiredClientCapabilities(request, response) {
    const required = requiredClientCapabilities(response);
    const declared = requestMetadata(request)[CLIENT_CAPABILITIES_METADATA_KEY];
    const capabilities = isRecord(declared) ? declared : {};
    return missingCapabilityTree(required, capabilities);
}
function requiredClientCapabilities(response) {
    if (response.error || !isRecord(response.result)) {
        return {};
    }
    if (response.result["resultType"] !== MCP_RESULT_TYPE_INPUT_REQUIRED) {
        return {};
    }
    const inputRequests = response.result["inputRequests"];
    if (!isRecord(inputRequests)) {
        return {};
    }
    const required = {};
    for (const inputRequest of Object.values(inputRequests)) {
        if (!isRecord(inputRequest) || typeof inputRequest["method"] !== "string") {
            continue;
        }
        const method = inputRequest["method"].trim();
        const firstSlash = method.indexOf("/");
        if (firstSlash <= 0) {
            continue;
        }
        const lastSlash = method.lastIndexOf("/");
        if (firstSlash === lastSlash) {
            required[method.slice(0, firstSlash)] = {};
            continue;
        }
        const identifier = method.slice(0, lastSlash);
        if (validExtensionIdentifier(identifier)) {
            const extensions = isRecord(required["extensions"])
                ? required["extensions"]
                : {};
            extensions[identifier] = {};
            required["extensions"] = extensions;
        }
    }
    return required;
}
function missingCapabilityTree(required, declared) {
    const missing = {};
    for (const [capability, rawRequired] of Object.entries(required)) {
        const requiredChildren = isRecord(rawRequired) ? rawRequired : {};
        const declaredChildren = declared[capability];
        if (!isRecord(declaredChildren)) {
            missing[capability] = cloneCapabilityRequirement(requiredChildren);
            continue;
        }
        const childMissing = missingCapabilityTree(requiredChildren, declaredChildren);
        if (Object.keys(childMissing).length > 0) {
            missing[capability] = childMissing;
        }
    }
    return missing;
}
function cloneCapabilityRequirement(required) {
    const cloned = {};
    for (const [key, rawChildren] of Object.entries(required)) {
        cloned[key] = cloneCapabilityRequirement(isRecord(rawChildren) ? rawChildren : {});
    }
    return cloned;
}
function headerValues(headers, key) {
    const lower = String(key ?? "").toLowerCase();
    const direct = headers[lower];
    if (Array.isArray(direct)) {
        return direct.map((value) => String(value));
    }
    for (const [name, values] of Object.entries(headers ?? {})) {
        if (name.toLowerCase() === lower && Array.isArray(values)) {
            return values.map((value) => String(value));
        }
    }
    return [];
}
function newErrorResponse(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) {
        error.data = data;
    }
    return {
        jsonrpc: JSONRPC_VERSION,
        id: id ?? null,
        error,
    };
}
function newResultResponse(id, result) {
    return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result };
}
function responseForProtocol(response, protocolVersion, serverInfo) {
    if (response.error || response.result === undefined) {
        return response;
    }
    if (!isRecord(response.result)) {
        return newErrorResponse(response.id, MCP_CODE_INTERNAL_ERROR, "internal error");
    }
    const result = response.result;
    const declared = result["resultType"];
    if (declared === MCP_RESULT_TYPE_INPUT_REQUIRED) {
        if (protocolVersion !== MCP_PROTOCOL_VERSION_2026_07_28) {
            return newErrorResponse(response.id, MCP_CODE_INVALID_REQUEST, "input_required results require MCP protocol version 2026-07-28");
        }
        const inputRequests = isRecord(result["inputRequests"])
            ? { ...result["inputRequests"] }
            : undefined;
        const requestState = typeof result["requestState"] === "string" ? result["requestState"] : "";
        if ((!inputRequests || Object.keys(inputRequests).length === 0) &&
            !requestState.trim()) {
            return newErrorResponse(response.id, MCP_CODE_INTERNAL_ERROR, "internal error");
        }
        const inputRequired = {
            resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
        };
        if (inputRequests && Object.keys(inputRequests).length > 0) {
            inputRequired.inputRequests = inputRequests;
        }
        if (requestState.trim()) {
            inputRequired.requestState = requestState;
        }
        if (isRecord(result["_meta"])) {
            inputRequired._meta = { ...result["_meta"] };
        }
        return withServerInfoMetadata({ ...response, result: inputRequired }, protocolVersion, serverInfo);
    }
    if (declared !== undefined &&
        declared !== "" &&
        declared !== MCP_RESULT_TYPE_COMPLETE) {
        return newErrorResponse(response.id, MCP_CODE_INTERNAL_ERROR, "internal error");
    }
    if (Object.prototype.hasOwnProperty.call(result, "inputRequests") ||
        Object.prototype.hasOwnProperty.call(result, "requestState")) {
        return newErrorResponse(response.id, MCP_CODE_INTERNAL_ERROR, "internal error");
    }
    const complete = { ...result };
    if (protocolVersion === MCP_PROTOCOL_VERSION_2026_07_28) {
        complete["resultType"] = MCP_RESULT_TYPE_COMPLETE;
    }
    else {
        delete complete["resultType"];
    }
    return withServerInfoMetadata({ ...response, result: complete }, protocolVersion, serverInfo);
}
function withServerInfoMetadata(response, protocolVersion, serverInfo) {
    if (protocolVersion !== MCP_PROTOCOL_VERSION_2026_07_28 ||
        !serverInfo ||
        !isRecord(response.result)) {
        return response;
    }
    const meta = isRecord(response.result["_meta"])
        ? { ...response.result["_meta"] }
        : {};
    meta[SERVER_INFO_METADATA_KEY] = { ...serverInfo };
    return {
        ...response,
        result: {
            ...response.result,
            _meta: meta,
        },
    };
}
function badRequest(message) {
    return jsonBytesResponse(400, { error: message });
}
function notFound(message) {
    return jsonBytesResponse(404, { error: message });
}
function internalServerError() {
    return jsonBytesResponse(500, { error: "internal server error" });
}
function jsonBytesResponse(status, value, headers) {
    return {
        status,
        headers: { "content-type": ["application/json"], ...(headers ?? {}) },
        cookies: [],
        body: Buffer.from(JSON.stringify(value), "utf8"),
        isBase64: false,
    };
}
// methodNotAllowedResponse builds the 405 response for the MCP endpoint. Per
// RFC 9110 section 15.5.5 a method-not-allowed response must carry an Allow
// header listing the methods the target resource supports; the caller supplies
// the allowed set (all transport methods, or only POST for the stateless
// 2026-07-28 shape). The header value follows the framework's Allow formatting
// (uppercase, sorted, comma-space joined).
function methodNotAllowedResponse(allow) {
    return jsonBytesResponse(405, { error: "method not allowed" }, {
        allow: [allow],
    });
}
function emptyResponse(status) {
    return {
        status,
        headers: {},
        cookies: [],
        body: Buffer.alloc(0),
        isBase64: false,
    };
}
function sseBytesResponse(status, chunks, sessionId) {
    return {
        status,
        headers: {
            "content-type": ["text/event-stream"],
            "cache-control": ["no-cache"],
            connection: ["keep-alive"],
            [MCP_HEADER_SESSION_ID]: [sessionId],
        },
        cookies: [],
        body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        isBase64: false,
    };
}
function formatMcpSSEFrame(event) {
    const lines = [];
    const id = String(event.id ?? "").trim();
    if (id) {
        lines.push(`id: ${id}`);
    }
    if (event.data.length > 0) {
        lines.push("event: message");
    }
    const data = event.data.length > 0 ? Buffer.from(event.data).toString("utf8") : "";
    const dataLines = data
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");
    for (const line of dataLines) {
        lines.push(`data: ${line}`);
    }
    return Buffer.from(`${lines.join("\n")}\n\n`, "utf8");
}
function normalizeToolDef(definition) {
    const out = {
        name: String(definition.name ?? "").trim(),
        inputSchema: definition.inputSchema ?? {},
    };
    copyOptionalString(out, "title", definition.title);
    copyOptionalString(out, "description", definition.description);
    if (definition.outputSchema !== undefined) {
        out.outputSchema = definition.outputSchema;
    }
    const taskSupport = definition.execution?.taskSupport;
    if (taskSupport === "optional" || taskSupport === "required") {
        out.execution = { taskSupport };
    }
    return out;
}
function cloneToolDef(definition) {
    return JSON.parse(JSON.stringify(definition));
}
function normalizeToolResult(result) {
    const resultType = result?.resultType;
    if (resultType !== undefined &&
        resultType !== MCP_RESULT_TYPE_COMPLETE &&
        resultType !== MCP_RESULT_TYPE_INPUT_REQUIRED) {
        throw new Error(`unsupported MCP resultType: ${String(resultType)}`);
    }
    if (resultType === MCP_RESULT_TYPE_INPUT_REQUIRED) {
        const inputRequests = isRecord(result?.inputRequests)
            ? { ...result.inputRequests }
            : undefined;
        const requestState = String(result?.requestState ?? "");
        if ((!inputRequests || Object.keys(inputRequests).length === 0) &&
            !requestState.trim()) {
            throw new Error("input_required result requires inputRequests or requestState");
        }
        const out = {
            content: [],
            resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
        };
        if (inputRequests && Object.keys(inputRequests).length > 0) {
            out.inputRequests = inputRequests;
        }
        if (requestState.trim()) {
            out.requestState = requestState;
        }
        return out;
    }
    if (result?.inputRequests !== undefined ||
        String(result?.requestState ?? "").trim()) {
        throw new Error("inputRequests and requestState require resultType input_required");
    }
    const out = {
        content: Array.isArray(result?.content)
            ? result.content.map(normalizeContentBlock)
            : [],
    };
    if (result?.isError) {
        out.isError = true;
    }
    if (result?.structuredContent && isRecord(result.structuredContent)) {
        out.structuredContent = { ...result.structuredContent };
    }
    if (resultType === MCP_RESULT_TYPE_COMPLETE) {
        out.resultType = MCP_RESULT_TYPE_COMPLETE;
    }
    return out;
}
function normalizeContentBlock(block) {
    const out = { type: String(block?.type ?? "") };
    copyOptionalString(out, "text", block?.text);
    copyOptionalString(out, "data", block?.data);
    copyOptionalString(out, "mimeType", block?.mimeType);
    copyOptionalString(out, "uri", block?.uri);
    copyOptionalString(out, "name", block?.name);
    copyOptionalString(out, "title", block?.title);
    copyOptionalString(out, "description", block?.description);
    if (typeof block?.size === "number" && Number.isFinite(block.size)) {
        out.size = block.size;
    }
    if (block?.resource) {
        out.resource = normalizeResourceContent(block.resource);
    }
    return out;
}
function normalizeResourceDef(definition) {
    const out = {
        uri: String(definition.uri ?? "").trim(),
        name: String(definition.name ?? "").trim(),
    };
    copyOptionalString(out, "title", definition.title);
    copyOptionalString(out, "description", definition.description);
    copyOptionalString(out, "mimeType", definition.mimeType);
    if (typeof definition.size === "number" && Number.isFinite(definition.size)) {
        out.size = definition.size;
    }
    return out;
}
function cloneResourceDef(definition) {
    return JSON.parse(JSON.stringify(definition));
}
function normalizeResourceTemplateDef(definition) {
    const out = {
        uriTemplate: String(definition.uriTemplate ?? "").trim(),
        name: String(definition.name ?? "").trim(),
    };
    copyOptionalString(out, "title", definition.title);
    copyOptionalString(out, "description", definition.description);
    copyOptionalString(out, "mimeType", definition.mimeType);
    return out;
}
function cloneResourceTemplateDef(definition) {
    return JSON.parse(JSON.stringify(definition));
}
function normalizeResourceContent(content) {
    const out = { uri: String(content?.uri ?? "") };
    copyOptionalString(out, "mimeType", content?.mimeType);
    copyOptionalString(out, "text", content?.text);
    copyOptionalString(out, "blob", content?.blob);
    return out;
}
function normalizePromptDef(definition) {
    const out = { name: String(definition.name ?? "").trim() };
    copyOptionalString(out, "title", definition.title);
    copyOptionalString(out, "description", definition.description);
    if (Array.isArray(definition.arguments)) {
        out.arguments = definition.arguments.map(normalizePromptArgument);
    }
    return out;
}
function normalizePromptArgument(argument) {
    const out = { name: String(argument.name ?? "") };
    copyOptionalString(out, "title", argument.title);
    copyOptionalString(out, "description", argument.description);
    if (argument.required) {
        out.required = true;
    }
    return out;
}
function clonePromptDef(definition) {
    return JSON.parse(JSON.stringify(definition));
}
function normalizePromptResult(result) {
    const out = {
        messages: Array.isArray(result?.messages)
            ? result.messages.map((message) => ({
                role: String(message.role ?? ""),
                content: normalizeContentBlock(message.content),
            }))
            : [],
    };
    copyOptionalString(out, "description", result?.description);
    return out;
}
function copyOptionalString(out, key, value) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
        out[key] = normalized;
    }
}
function validResourceURI(uri) {
    const value = String(uri ?? "").trim();
    if (!value || /\s/.test(value)) {
        return false;
    }
    try {
        return Boolean(new URL(value).protocol);
    }
    catch {
        return false;
    }
}
function paramsRecord(params) {
    return isRecord(params) ? params : {};
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toBytes(value) {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    return Buffer.from(String(value ?? ""), "utf8");
}
function cloneBytes(value) {
    return value ? Buffer.from(value) : Buffer.alloc(0);
}
function cloneSession(session) {
    const out = {
        id: String(session.id ?? "").trim(),
        createdAt: String(session.createdAt ?? ""),
        expiresAt: String(session.expiresAt ?? ""),
    };
    if (session.principal) {
        out.principal = String(session.principal);
    }
    if (session.data) {
        out.data = { ...session.data };
    }
    return out;
}
function sessionExpiredAt(now, session) {
    const expires = Date.parse(String(session.expiresAt ?? ""));
    if (!Number.isFinite(expires) || expires <= 0) {
        return false;
    }
    return expires <= now.valueOf();
}
function streamItemExpired(item, now) {
    const expiresAt = Number(item["expiresAt"] ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        return false;
    }
    return now.getTime() >= expiresAt * 1000;
}
function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
function isConditionalCheckFailedError(err) {
    if (!(err instanceof Error)) {
        return false;
    }
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return (name.includes("condition") ||
        message.includes("condition") ||
        message.includes("conditional"));
}
function envPositiveInteger(name, fallback) {
    const raw = String(process.env[name] ?? "").trim();
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.floor(value);
}
function isoNoMillis(date) {
    return date.toISOString().replace(/\.000Z$/, "Z");
}
function errorMessage(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
function principalFromContext(ctx) {
    if (!ctx) {
        return "";
    }
    const authIdentity = String(ctx.authIdentity ?? "").trim();
    if (authIdentity) {
        return authIdentity;
    }
    const principalIdentity = String(ctx.securePrincipal()?.identity ?? "").trim();
    if (principalIdentity) {
        return principalIdentity;
    }
    const subject = String(bearerTokenClaimsFromContext(ctx)?.subject ?? "").trim();
    if (subject) {
        return subject;
    }
    if (ctx.tenantBound === true) {
        return String(ctx.tenantId ?? "").trim();
    }
    return "";
}
function authFromContext(ctx) {
    if (!ctx) {
        return undefined;
    }
    const principal = ctx.securePrincipal();
    const claims = bearerTokenClaimsFromContext(ctx);
    const authIdentity = String(ctx.authIdentity ?? "").trim() ||
        String(principal?.identity ?? "").trim() ||
        String(claims?.subject ?? "").trim();
    const tenantId = String(ctx.tenantId ?? "").trim();
    const tenantBound = ctx.tenantBound === true;
    const scopes = [
        ...(principal?.scopes ?? claims?.scopes ?? []).map((scope) => String(scope ?? "").trim()),
    ].filter((scope) => scope.length > 0);
    if (!authIdentity && !tenantId && scopes.length === 0) {
        return undefined;
    }
    return { authIdentity, tenantId, tenantBound, scopes };
}
function normalizeRequired(value, message) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        throw new Error(message);
    }
    return normalized;
}
function normalizeProgressToken(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    return undefined;
}
function progressFromSSEEvent(event, fallbackProgress) {
    const data = event.data;
    if (isRecord(data)) {
        const progress = numberFromUnknown(data["progress"] ?? data["seq"]);
        return {
            progress: progress ?? fallbackProgress,
            total: data["total"],
            message: typeof data["message"] === "string" ? data["message"] : "",
        };
    }
    if (typeof data === "string") {
        return { progress: fallbackProgress, total: undefined, message: data };
    }
    return { progress: fallbackProgress, total: undefined, message: "" };
}
function numberFromUnknown(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function taskTTL(runtime, meta) {
    let ttl = runtime.defaultTtlMs;
    if (Object.prototype.hasOwnProperty.call(meta, "ttl")) {
        const candidate = Number(meta["ttl"]);
        if (!Number.isFinite(candidate) || candidate <= 0) {
            return { value: 0, error: "Invalid params: task.ttl must be positive" };
        }
        ttl = Math.floor(candidate);
    }
    if (ttl > runtime.maxTtlMs) {
        return { value: 0, error: "Invalid params: task.ttl exceeds maximum" };
    }
    return { value: ttl };
}
function taskLookupFromRequest(request, sessionId) {
    const params = paramsRecord(request.params);
    const taskId = String(params["taskId"] ?? "").trim();
    if (!taskId) {
        return {
            value: { sessionId, taskId: "" },
            error: "Invalid params: missing taskId",
        };
    }
    return { value: { sessionId, taskId } };
}
function taskControlErrorMessage(message) {
    const trimmed = message.trim();
    switch (trimmed) {
        case "":
        case "internal error":
        case TASK_CANCELED_MESSAGE:
        case TASK_CAPACITY_EXCEEDED_MESSAGE:
        case "task capacity exceeded":
        case "task result wait timeout":
        case "context canceled":
        case "context deadline exceeded":
            return true;
        default:
            return trimmed.endsWith(" timed out");
    }
}
function taskErrorNeedsRedaction(error) {
    if (error.code !== MCP_CODE_SERVER_ERROR) {
        return false;
    }
    return !taskControlErrorMessage(String(error.message ?? ""));
}
function taskStatusTerminal(status) {
    return status === "completed" || status === "failed" || status === "canceled";
}
function taskListLimit(value) {
    let limit = positiveInteger(value, DEFAULT_TASK_LIST_LIMIT);
    if (limit > MAX_TASK_LIST_LIMIT) {
        limit = MAX_TASK_LIST_LIMIT;
    }
    return limit;
}
function parseTaskCursor(value) {
    const cursor = String(value ?? "").trim();
    if (!cursor) {
        return 0;
    }
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new McpTaskInvalidCursorError();
    }
    return parsed;
}
function compareTaskRecords(a, b) {
    const time = a.task.createdAt.localeCompare(b.task.createdAt);
    if (time !== 0) {
        return time;
    }
    return a.task.taskId.localeCompare(b.task.taskId);
}
function compareStreamItems(a, b) {
    return Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0);
}
function cloneTask(task) {
    const out = {
        taskId: String(task.taskId ?? ""),
        status: task.status,
        createdAt: String(task.createdAt ?? ""),
        lastUpdatedAt: String(task.lastUpdatedAt ?? ""),
        ttl: Number(task.ttl ?? 0),
    };
    if (task.statusMessage) {
        out.statusMessage = String(task.statusMessage);
    }
    if (task.pollInterval !== undefined) {
        out.pollInterval = Number(task.pollInterval);
    }
    return out;
}
function cloneTaskRecord(record) {
    const out = {
        sessionId: String(record.sessionId ?? ""),
        method: String(record.method ?? ""),
        task: cloneTask(record.task),
    };
    if (record.toolName) {
        out.toolName = String(record.toolName);
    }
    if (record.result !== undefined) {
        out.result = JSON.parse(JSON.stringify(record.result));
    }
    if (record.error) {
        out.error = { ...record.error };
    }
    return out;
}
function taskResultWithRelatedMetadata(result, taskId) {
    const out = isRecord(result) ? { ...result } : {};
    const existingMeta = isRecord(out["_meta"]) ? { ...out["_meta"] } : {};
    existingMeta[RELATED_TASK_METADATA_KEY] = { taskId };
    out["_meta"] = existingMeta;
    return out;
}
function taskKey(lookup) {
    return {
        sessionId: String(lookup.sessionId ?? "").trim(),
        taskId: String(lookup.taskId ?? "").trim(),
    };
}
function taskExpiresAtEpochSeconds(createdAt, ttlMs) {
    const parsed = Date.parse(String(createdAt ?? ""));
    const base = Number.isFinite(parsed) ? parsed : Date.now();
    const duration = ttlMs > 0 ? ttlMs : DEFAULT_TASK_MAX_TTL_MS;
    return Math.floor((base + duration) / 1000);
}
function taskItemExpiresAt(item) {
    const value = Number(item["expiresAt"] ?? 0);
    return Number.isFinite(value) ? value : 0;
}
function taskItemExpired(item, now) {
    const expiresAt = taskItemExpiresAt(item);
    return expiresAt > 0 && now.getTime() >= expiresAt * 1000;
}
function taskRecordToItem(record) {
    const item = {
        sessionId: String(record.sessionId ?? "").trim(),
        taskId: String(record.task.taskId ?? "").trim(),
        method: String(record.method ?? ""),
        status: record.task.status,
        createdAt: record.task.createdAt,
        lastUpdatedAt: record.task.lastUpdatedAt,
        // Epoch-seconds attribute consumed by the DynamoDB TTL setting configured on
        // the task table. `ttl` below stays the duration in milliseconds.
        expiresAt: taskExpiresAtEpochSeconds(record.task.createdAt, Number(record.task.ttl ?? 0)),
        ttl: record.task.ttl,
    };
    if (record.toolName) {
        item["toolName"] = record.toolName;
    }
    if (record.task.statusMessage) {
        item["statusMessage"] = record.task.statusMessage;
    }
    if (record.task.pollInterval !== undefined) {
        item["pollInterval"] = record.task.pollInterval;
    }
    if (record.result !== undefined) {
        item["result"] = record.result;
    }
    if (record.error) {
        item["error"] = record.error;
    }
    return item;
}
function itemToTaskRecord(item) {
    const task = {
        taskId: String(item["taskId"] ?? ""),
        status: normalizeTaskStatus(item["status"]),
        createdAt: String(item["createdAt"] ?? ""),
        lastUpdatedAt: String(item["lastUpdatedAt"] ?? ""),
        ttl: Number(item["ttl"] ?? 0),
    };
    if (item["statusMessage"] !== undefined) {
        task.statusMessage = String(item["statusMessage"]);
    }
    if (item["pollInterval"] !== undefined) {
        task.pollInterval = Number(item["pollInterval"]);
    }
    const record = {
        sessionId: String(item["sessionId"] ?? ""),
        method: String(item["method"] ?? ""),
        task,
    };
    if (item["toolName"] !== undefined) {
        record.toolName = String(item["toolName"]);
    }
    if (item["result"] !== undefined) {
        record.result = item["result"];
    }
    if (isRecord(item["error"])) {
        record.error = {
            code: Number(item["error"]["code"] ?? 0),
            message: String(item["error"]["message"] ?? ""),
            ...(item["error"]["data"] !== undefined
                ? { data: item["error"]["data"] }
                : {}),
        };
    }
    return record;
}
function normalizeTaskStatus(value) {
    const status = String(value ?? "");
    if (status === "working" ||
        status === "input_required" ||
        status === "completed" ||
        status === "failed" ||
        status === "canceled") {
        return status;
    }
    return "working";
}
function isNotFoundError(err) {
    if (err instanceof McpTaskNotFoundError ||
        err instanceof McpStreamNotFoundError) {
        return true;
    }
    if (err instanceof Error) {
        const name = err.name.toLowerCase();
        const message = err.message.toLowerCase();
        return name.includes("notfound") || message.includes("not found");
    }
    return false;
}
//# sourceMappingURL=index.js.map