import { Buffer } from "node:buffer";

import {
  defineModel,
  type Model,
  type TheorydbClient,
} from "@theory-cloud/tabletheory-ts";

import type { Handler } from "../context.js";
import { RandomIdGenerator, type IdGenerator } from "../ids.js";
import type { Headers, Response } from "../types.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_PROTOCOL_VERSION_PRIOR = "2025-06-18";
export const MCP_PROTOCOL_VERSION_LEGACY = "2025-03-26";

export const MCP_HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
export const MCP_HEADER_SESSION_ID = "mcp-session-id";
export const MCP_HEADER_LAST_EVENT_ID = "last-event-id";

const JSONRPC_VERSION = "2.0";
const DEFAULT_SESSION_TTL_MINUTES = 60;
const DEFAULT_TASK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TASK_MAX_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;
const RELATED_TASK_METADATA_KEY = "io.modelcontextprotocol/related-task";
const MODEL_IMMEDIATE_RESPONSE_METADATA_KEY =
  "io.modelcontextprotocol/model-immediate-response";
const TASK_CANCELED_MESSAGE = "task canceled";
const DEFAULT_TASK_TABLE_NAME = "mcp-tasks";
const DEFAULT_STREAM_TABLE_NAME = "mcp-streams";

export const MCP_CODE_PARSE_ERROR = -32700;
export const MCP_CODE_INVALID_REQUEST = -32600;
export const MCP_CODE_METHOD_NOT_FOUND = -32601;
export const MCP_CODE_INVALID_PARAMS = -32602;
export const MCP_CODE_INTERNAL_ERROR = -32603;
export const MCP_CODE_SERVER_ERROR = -32000;

export type McpRequestID = string | number | boolean | null;
export type McpJSONValue =
  | string
  | number
  | boolean
  | null
  | McpJSONValue[]
  | { [key: string]: McpJSONValue };
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

export type McpToolHandler = (
  args: unknown,
  context: McpToolContext,
) => McpToolResult | Promise<McpToolResult>;

export interface McpSSEEvent {
  data?: unknown;
}

export type McpStreamingToolHandler = (
  args: unknown,
  emit: (event: McpSSEEvent) => void | Promise<void>,
  context: McpToolContext,
) => McpToolResult | Promise<McpToolResult>;

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

export type McpResourceHandler = (
  context: McpResourceContext,
) => McpResourceContent[] | Promise<McpResourceContent[]>;

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

export type McpPromptHandler = (
  args: unknown,
) => McpPromptResult | Promise<McpPromptResult>;

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
  append(
    sessionId: string,
    streamId: string,
    data?: Uint8Array,
  ): Promise<string>;
  close(sessionId: string, streamId: string): Promise<void>;
  subscribe(
    sessionId: string,
    streamId: string,
    afterEventId?: string,
  ): Promise<McpStreamEvent[]>;
  streamForEvent(sessionId: string, eventId: string): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
}

export type McpTaskSupport = "forbidden" | "optional" | "required";
export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled";

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

type RegisteredTool = {
  def: McpToolDef;
  handler: McpToolHandler;
  streamingHandler?: McpStreamingToolHandler;
};

type RegisteredResource = {
  def: McpResourceDef;
  handler: McpResourceHandler;
};

type RegisteredPrompt = {
  def: McpPromptDef;
  handler: McpPromptHandler;
};

type NormalizedTaskRuntime = {
  store: McpTaskStore | null;
  defaultTtlMs: number;
  maxTtlMs: number;
  pollIntervalMs: number;
  listLimit: number;
  modelImmediateResponse: string;
};

type ParsedRPCRequest = {
  id?: unknown;
  idPresent: boolean;
  method: string;
  params?: unknown;
};

export class McpSessionNotFoundError extends Error {
  constructor(message = "session not found") {
    super(message);
    this.name = "McpSessionNotFoundError";
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
  private readonly tools: RegisteredTool[] = [];
  private readonly index = new Map<string, number>();

  registerTool(definition: McpToolDef, handler: McpToolHandler): void {
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

  registerStreamingTool(
    definition: McpToolDef,
    handler: McpStreamingToolHandler,
  ): void {
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
    const wrapped: McpToolHandler = (args, context) =>
      handler(args, () => undefined, context);
    this.index.set(name, this.tools.length);
    this.tools.push({ def, handler: wrapped, streamingHandler: handler });
  }

  list(): McpToolDef[] {
    return this.tools.map((entry) => cloneToolDef(entry.def));
  }

  len(): number {
    return this.tools.length;
  }

  supportsStreaming(name: string): boolean {
    const entry = this.entry(name);
    return Boolean(entry?.streamingHandler);
  }

  supportsTasks(): boolean {
    return this.tools.some((entry) => {
      const support = entry.def.execution?.taskSupport ?? "forbidden";
      return support === "optional" || support === "required";
    });
  }

  taskSupport(name: string): McpTaskSupport {
    const entry = this.entry(name);
    const support = entry?.def.execution?.taskSupport ?? "forbidden";
    if (support === "optional" || support === "required") {
      return support;
    }
    return "forbidden";
  }

  async call(
    name: string,
    args: unknown,
    context: McpToolContext,
  ): Promise<McpToolResult> {
    const entry = this.entry(name);
    if (!entry) {
      throw new Error(`tool not found: ${name}`);
    }
    return normalizeToolResult(await entry.handler(args, context));
  }

  async callStreaming(
    name: string,
    args: unknown,
    emit: (event: McpSSEEvent) => void | Promise<void>,
    context: McpToolContext,
  ): Promise<McpToolResult> {
    const entry = this.entry(name);
    if (!entry) {
      throw new Error(`tool not found: ${name}`);
    }
    if (entry.streamingHandler) {
      return normalizeToolResult(
        await entry.streamingHandler(args, emit, context),
      );
    }
    return normalizeToolResult(await entry.handler(args, context));
  }

  private entry(name: string): RegisteredTool | null {
    const idx = this.index.get(String(name ?? ""));
    if (idx === undefined) {
      return null;
    }
    return this.tools[idx] ?? null;
  }
}

export class McpResourceRegistry {
  private readonly resources: RegisteredResource[] = [];
  private readonly index = new Map<string, number>();
  private readonly templates: McpResourceTemplateDef[] = [];
  private readonly templateIndex = new Map<string, number>();

  registerResource(
    definition: McpResourceDef,
    handler: McpResourceHandler,
  ): void {
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

  registerResourceTemplate(definition: McpResourceTemplateDef): void {
    const uriTemplate = String(definition.uriTemplate ?? "").trim();
    if (!uriTemplate) {
      throw new Error("resource template uriTemplate must not be empty");
    }
    if (!validResourceURI(uriTemplate)) {
      throw new Error(
        `resource template uriTemplate must be absolute: ${uriTemplate}`,
      );
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

  list(): McpResourceDef[] {
    return this.resources.map((entry) => cloneResourceDef(entry.def));
  }

  listTemplates(): McpResourceTemplateDef[] {
    return this.templates.map((entry) => cloneResourceTemplateDef(entry));
  }

  len(): number {
    return this.resources.length;
  }

  templateLen(): number {
    return this.templates.length;
  }

  async read(uri: string): Promise<McpResourceContent[]> {
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
  private readonly prompts: RegisteredPrompt[] = [];
  private readonly index = new Map<string, number>();

  registerPrompt(definition: McpPromptDef, handler: McpPromptHandler): void {
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

  list(): McpPromptDef[] {
    return this.prompts.map((entry) => clonePromptDef(entry.def));
  }

  len(): number {
    return this.prompts.length;
  }

  async get(name: string, args: unknown): Promise<McpPromptResult> {
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

export class MemoryMcpSessionStore implements McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date; seed?: McpSession[] } = {}) {
    this.now = options.now ?? (() => new Date());
    for (const session of options.seed ?? []) {
      this.sessions.set(session.id, cloneSession(session));
    }
  }

  async get(id: string): Promise<McpSession> {
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

  async put(session: McpSession): Promise<void> {
    const normalized = cloneSession(session);
    if (!normalized.id) {
      throw new Error("missing session id");
    }
    this.sessions.set(normalized.id, normalized);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(String(id ?? "").trim());
  }
}

export class MemoryMcpStreamStore implements McpStreamStore {
  private readonly sessions = new Map<string, MemoryStreamSession>();
  private readonly idGenerator: IdGenerator;

  constructor(options: { idGenerator?: IdGenerator } = {}) {
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
  }

  async create(sessionId: string): Promise<string> {
    const sid = normalizeRequired(sessionId, "missing session id");
    const session = this.ensureSession(sid);
    const streamId = String(this.idGenerator.newId() ?? "").trim();
    if (!streamId) {
      throw new Error("stream id generator returned empty id");
    }
    session.streams.set(streamId, { events: [], closed: false });
    return streamId;
  }

  async append(
    sessionId: string,
    streamId: string,
    data?: Uint8Array,
  ): Promise<string> {
    const session = this.lookupSession(sessionId);
    const stream = this.lookupStream(session, streamId);
    session.nextSeq += 1;
    const eventId = String(session.nextSeq);
    stream.events.push({ id: eventId, data: cloneBytes(data) });
    session.eventToStream.set(eventId, String(streamId ?? "").trim());
    return eventId;
  }

  async close(sessionId: string, streamId: string): Promise<void> {
    const session = this.lookupSession(sessionId);
    const stream = this.lookupStream(session, streamId);
    stream.closed = true;
  }

  async subscribe(
    sessionId: string,
    streamId: string,
    afterEventId: string = "",
  ): Promise<McpStreamEvent[]> {
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

  async streamForEvent(sessionId: string, eventId: string): Promise<string> {
    const session = this.lookupSession(sessionId);
    const streamId = session.eventToStream.get(String(eventId ?? "").trim());
    if (!streamId) {
      throw new McpEventNotFoundError();
    }
    return streamId;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(String(sessionId ?? "").trim());
  }

  private ensureSession(sessionId: string): MemoryStreamSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { nextSeq: 0, eventToStream: new Map(), streams: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private lookupSession(sessionId: string): MemoryStreamSession {
    const sid = normalizeRequired(sessionId, "missing session id");
    const session = this.sessions.get(sid);
    if (!session) {
      throw new McpStreamNotFoundError();
    }
    return session;
  }

  private lookupStream(
    session: MemoryStreamSession,
    streamId: string,
  ): MemoryStream {
    const key = normalizeRequired(streamId, "missing stream id");
    const stream = session.streams.get(key);
    if (!stream) {
      throw new McpStreamNotFoundError();
    }
    return stream;
  }
}

type MemoryStreamSession = {
  nextSeq: number;
  eventToStream: Map<string, string>;
  streams: Map<string, MemoryStream>;
};

type MemoryStream = {
  events: McpStreamEvent[];
  closed: boolean;
};

export class MemoryMcpTaskStore implements McpTaskStore {
  private readonly sessions = new Map<string, Map<string, McpTaskRecord>>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async create(task: McpTaskRecord): Promise<McpTaskRecord> {
    const record = cloneTaskRecord(task);
    record.sessionId = normalizeRequired(
      record.sessionId,
      "missing session id",
    );
    record.task.taskId = normalizeRequired(
      record.task.taskId,
      "missing task id",
    );
    let session = this.sessions.get(record.sessionId);
    if (!session) {
      session = new Map();
      this.sessions.set(record.sessionId, session);
    }
    if (session.has(record.task.taskId)) {
      throw new Error("task already exists");
    }
    session.set(record.task.taskId, record);
    return cloneTaskRecord(record);
  }

  async get(lookup: McpTaskLookup): Promise<McpTaskRecord> {
    const record = this.record(lookup);
    if (!record) {
      throw new McpTaskNotFoundError();
    }
    return cloneTaskRecord(record);
  }

  async update(task: McpTaskRecord): Promise<McpTaskRecord> {
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

  async list(request: McpTaskListRequest): Promise<McpTaskListResult> {
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
    const result: McpTaskListResult = {
      tasks: slice.map((record) => cloneTask(record.task)),
    };
    if (cursor + limit < records.length) {
      result.nextCursor = String(cursor + limit);
    }
    return result;
  }

  async cancel(lookup: McpTaskLookup): Promise<McpTaskRecord> {
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

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(String(sessionId ?? "").trim());
  }

  private record(lookup: McpTaskLookup): McpTaskRecord | null {
    const sessionId = String(lookup.sessionId ?? "").trim();
    const taskId = String(lookup.taskId ?? "").trim();
    if (!sessionId || !taskId) {
      return null;
    }
    return this.sessions.get(sessionId)?.get(taskId) ?? null;
  }
}

export class DynamoMcpTaskStore implements McpTaskStore {
  private readonly db: TheorydbClient;
  private readonly model: Model;
  private readonly now: () => Date;

  constructor(
    db: TheorydbClient,
    options: { model?: Model; now?: () => Date } = {},
  ) {
    this.db = db;
    this.model = options.model ?? defaultMcpTaskModel();
    this.now = options.now ?? (() => new Date());
    this.db.register(this.model);
  }

  async create(task: McpTaskRecord): Promise<McpTaskRecord> {
    const item = taskRecordToItem(task);
    await this.db.create(this.model.name, item, { ifNotExists: true });
    return itemToTaskRecord(item);
  }

  async get(lookup: McpTaskLookup): Promise<McpTaskRecord> {
    try {
      const item = await this.db.get(this.model.name, taskKey(lookup));
      return itemToTaskRecord(item);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new McpTaskNotFoundError();
      }
      throw err;
    }
  }

  async update(task: McpTaskRecord): Promise<McpTaskRecord> {
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

  async list(request: McpTaskListRequest): Promise<McpTaskListResult> {
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
      const records = page.items.map(itemToTaskRecord).sort(compareTaskRecords);
      const result: McpTaskListResult = {
        tasks: records.map((record) => cloneTask(record.task)),
      };
      if (page.cursor) {
        result.nextCursor = page.cursor;
      }
      return result;
    } catch (err) {
      if (isNotFoundError(err)) {
        return { tasks: [] };
      }
      throw err;
    }
  }

  async cancel(lookup: McpTaskLookup): Promise<McpTaskRecord> {
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

  async deleteSession(sessionId: string): Promise<void> {
    const sid = String(sessionId ?? "").trim();
    if (!sid) {
      return;
    }
    const records = await this.list({
      sessionId: sid,
      limit: MAX_TASK_LIST_LIMIT,
    });
    await Promise.all(
      records.tasks.map((task) =>
        this.db.delete(this.model.name, {
          sessionId: sid,
          taskId: task.taskId,
        }),
      ),
    );
  }
}

export class DynamoMcpStreamStore implements McpStreamStore {
  private readonly db: TheorydbClient;
  private readonly model: Model;
  private readonly idGenerator: IdGenerator;

  constructor(
    db: TheorydbClient,
    options: { model?: Model; idGenerator?: IdGenerator } = {},
  ) {
    this.db = db;
    this.model = options.model ?? defaultMcpStreamModel();
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
    this.db.register(this.model);
  }

  async create(sessionId: string): Promise<string> {
    const sid = normalizeRequired(sessionId, "missing session id");
    const streamId = normalizeRequired(
      this.idGenerator.newId(),
      "stream id generator returned empty id",
    );
    await this.db.create(this.model.name, {
      sessionId: sid,
      itemId: `STREAM#${streamId}`,
      streamId,
      kind: "stream",
      closed: false,
      sequence: 0,
      eventId: "",
      data: "",
    });
    return streamId;
  }

  async append(
    sessionId: string,
    streamId: string,
    data?: Uint8Array,
  ): Promise<string> {
    const sid = normalizeRequired(sessionId, "missing session id");
    const stream = await this.streamRecord(sid, streamId);
    const sequence = Number(stream["sequence"] ?? 0) + 1;
    const eventId = String(sequence);
    stream["sequence"] = sequence;
    await this.db.save(this.model.name, stream);
    await this.db.create(this.model.name, {
      sessionId: sid,
      itemId: `EVENT#${eventId}`,
      streamId: String(streamId ?? "").trim(),
      kind: "event",
      closed: false,
      sequence,
      eventId,
      data: Buffer.from(cloneBytes(data)).toString("base64"),
    });
    return eventId;
  }

  async close(sessionId: string, streamId: string): Promise<void> {
    const stream = await this.streamRecord(sessionId, streamId);
    stream["closed"] = true;
    await this.db.save(this.model.name, stream);
  }

  async subscribe(
    sessionId: string,
    streamId: string,
    afterEventId: string = "",
  ): Promise<McpStreamEvent[]> {
    const sid = normalizeRequired(sessionId, "missing session id");
    const stream = String(streamId ?? "").trim();
    const after = Number(String(afterEventId ?? "").trim() || 0);
    const events = await this.eventRecords(sid);
    if (
      after > 0 &&
      !events.some(
        (item) =>
          String(item["eventId"]) === String(after) &&
          String(item["streamId"]) === stream,
      )
    ) {
      throw new McpEventNotFoundError();
    }
    return events
      .filter((item) => String(item["streamId"]) === stream)
      .filter((item) => Number(item["sequence"] ?? 0) > after)
      .sort(compareStreamItems)
      .map((item) => ({
        id: String(item["eventId"] ?? ""),
        data: Buffer.from(String(item["data"] ?? ""), "base64"),
      }));
  }

  async streamForEvent(sessionId: string, eventId: string): Promise<string> {
    const sid = normalizeRequired(sessionId, "missing session id");
    const wanted = String(eventId ?? "").trim();
    const events = await this.eventRecords(sid);
    const found = events.find(
      (item) => String(item["eventId"] ?? "") === wanted,
    );
    if (!found) {
      throw new McpEventNotFoundError();
    }
    return String(found["streamId"] ?? "");
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sid = String(sessionId ?? "").trim();
    if (!sid) {
      return;
    }
    const items = await this.sessionItems(sid);
    await Promise.all(
      items.map((item) =>
        this.db.delete(this.model.name, {
          sessionId: sid,
          itemId: String(item["itemId"] ?? ""),
        }),
      ),
    );
  }

  private async streamRecord(
    sessionId: string,
    streamId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.db.get(this.model.name, {
        sessionId: String(sessionId ?? "").trim(),
        itemId: `STREAM#${String(streamId ?? "").trim()}`,
      });
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new McpStreamNotFoundError();
      }
      throw err;
    }
  }

  private async eventRecords(
    sessionId: string,
  ): Promise<Record<string, unknown>[]> {
    return (await this.sessionItems(sessionId)).filter(
      (item) => String(item["kind"] ?? "") === "event",
    );
  }

  private async sessionItems(
    sessionId: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const page = await this.db
        .query(this.model.name)
        .partitionKey(sessionId)
        .limit(1000)
        .page();
      return page.items;
    } catch (err) {
      if (isNotFoundError(err)) {
        return [];
      }
      throw err;
    }
  }
}

export class McpServer {
  private readonly name: string;
  private readonly version: string;
  private readonly idGenerator: IdGenerator;
  private readonly sessionStore: McpSessionStore;
  private readonly streamStore: McpStreamStore;
  private readonly sessionTtlMs: number;
  private readonly originValidator: (origin: string) => boolean;
  private readonly taskRuntime: NormalizedTaskRuntime;
  private readonly toolRegistry = new McpToolRegistry();
  private readonly resourceRegistry = new McpResourceRegistry();
  private readonly promptRegistry = new McpPromptRegistry();

  constructor(name: string, version: string, options: McpServerOptions = {}) {
    this.name = String(name ?? "").trim() || "AppTheoryMCP";
    this.version = String(version ?? "").trim() || "0.0.0";
    this.idGenerator = options.idGenerator ?? new RandomIdGenerator();
    this.sessionStore = options.sessionStore ?? new MemoryMcpSessionStore();
    this.streamStore = options.streamStore ?? new MemoryMcpStreamStore();
    this.sessionTtlMs = normalizeSessionTtlMs(options.sessionTtlMs);
    this.originValidator =
      options.originValidator ??
      ((origin: string) =>
        origin === "https://claude.ai" || origin === "https://claude.com");
    this.taskRuntime = normalizeTaskRuntime(options.taskRuntime);
  }

  registry(): McpToolRegistry {
    return this.toolRegistry;
  }

  resources(): McpResourceRegistry {
    return this.resourceRegistry;
  }

  prompts(): McpPromptRegistry {
    return this.promptRegistry;
  }

  handler(): Handler {
    return async (ctx) =>
      this.handle(ctx.request.method, ctx.request.headers, ctx.request.body);
  }

  async serve(request: {
    method: string;
    headers?: Headers;
    body?: Uint8Array | string;
  }): Promise<Response> {
    return this.handle(
      request.method,
      request.headers ?? {},
      toBytes(request.body),
    );
  }

  private async handle(
    method: string,
    headers: Headers,
    body: Uint8Array,
  ): Promise<Response> {
    const normalizedMethod = String(method ?? "")
      .trim()
      .toUpperCase();
    if (normalizedMethod === "POST") {
      return this.handlePost(headers, body);
    }
    if (normalizedMethod === "GET") {
      return this.handleGet(headers);
    }
    if (normalizedMethod === "DELETE") {
      return this.handleDelete(headers);
    }
    return jsonBytesResponse(405, { error: "method not allowed" });
  }

  private async handlePost(
    headers: Headers,
    body: Uint8Array,
  ): Promise<Response> {
    const originResponse = this.validateOrigin(headers);
    if (originResponse) {
      return originResponse;
    }
    const headerResponse = validatePostHeaders(headers);
    if (headerResponse) {
      return headerResponse;
    }

    let raw: Record<string, unknown>;
    try {
      raw = parseJsonObject(body);
    } catch (err) {
      return this.marshalSingleResponse(
        newErrorResponse(
          null,
          MCP_CODE_PARSE_ERROR,
          `Parse error: ${errorMessage(err)}`,
        ),
      );
    }

    if (Object.prototype.hasOwnProperty.call(raw, "method")) {
      return this.handlePostRequest(headers, body);
    }
    if (
      Object.prototype.hasOwnProperty.call(raw, "result") ||
      Object.prototype.hasOwnProperty.call(raw, "error")
    ) {
      return this.handlePostResponse(headers, body);
    }
    return badRequest("invalid JSON-RPC message");
  }

  private async handlePostRequest(
    headers: Headers,
    body: Uint8Array,
  ): Promise<Response> {
    let request: ParsedRPCRequest;
    try {
      request = parseRequest(body);
    } catch (err) {
      return this.marshalSingleResponse(
        newErrorResponse(
          null,
          MCP_CODE_PARSE_ERROR,
          `Parse error: ${errorMessage(err)}`,
        ),
      );
    }

    if (request.method === "initialize") {
      return this.handleInitializeHTTP(request);
    }

    const sessionResult = await this.requireSession(headers);
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
    return this.handleRequestHTTP(sessionId, session, request, headers);
  }

  private async handlePostResponse(
    headers: Headers,
    body: Uint8Array,
  ): Promise<Response> {
    try {
      parseResponse(body);
    } catch {
      return badRequest("invalid JSON-RPC response");
    }
    const sessionResult = await this.requireSession(headers);
    if (sessionResult.response) {
      return sessionResult.response;
    }
    if (sessionResult.session) {
      const protocolResponse = this.requireProtocolVersion(
        headers,
        sessionResult.session,
      );
      if (protocolResponse) {
        return protocolResponse;
      }
    }
    return emptyResponse(202);
  }

  private async handleGet(headers: Headers): Promise<Response> {
    const originResponse = this.validateOrigin(headers);
    if (originResponse) {
      return originResponse;
    }
    const headerResponse = validateGetHeaders(headers);
    if (headerResponse) {
      return headerResponse;
    }
    const sessionResult = await this.requireSession(headers);
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
      return sseBytesResponse(
        200,
        [Buffer.from(": keepalive\n\n", "utf8")],
        sessionId,
      );
    }

    try {
      const streamId = await this.streamStore.streamForEvent(
        sessionId,
        lastEventId,
      );
      const events = await this.streamStore.subscribe(
        sessionId,
        streamId,
        lastEventId,
      );
      return this.streamToSSE(sessionId, events);
    } catch (err) {
      if (err instanceof McpEventNotFoundError) {
        return notFound("event not found");
      }
      if (err instanceof McpStreamNotFoundError) {
        return notFound("stream not found");
      }
      return internalServerError();
    }
  }

  private async handleDelete(headers: Headers): Promise<Response> {
    const originResponse = this.validateOrigin(headers);
    if (originResponse) {
      return originResponse;
    }
    const sessionId = firstHeader(headers, MCP_HEADER_SESSION_ID);
    if (!sessionId) {
      return badRequest("missing Mcp-Session-Id");
    }
    let session: McpSession;
    try {
      session = await this.getSession(sessionId);
    } catch (err) {
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
    await this.streamStore.deleteSession(sessionId);
    if (this.taskRuntime.store) {
      await this.taskRuntime.store.deleteSession(sessionId);
    }
    return emptyResponse(202);
  }

  private async handleInitializeHTTP(
    request: ParsedRPCRequest,
  ): Promise<Response> {
    const negotiated = negotiateProtocolVersion(request.params);
    const session = await this.createSession(negotiated);
    const response = this.handleInitialize(request, negotiated);
    return this.marshalSingleResponse(response, session.id, true);
  }

  private async handleNotification(
    session: McpSession,
    request: ParsedRPCRequest,
  ): Promise<void> {
    if (request.method !== "notifications/initialized") {
      return;
    }
    const data = { ...(session.data ?? {}) };
    data["initialized"] = "true";
    await this.sessionStore.put({ ...session, data });
  }

  private async handleRequestHTTP(
    sessionId: string,
    session: McpSession,
    request: ParsedRPCRequest,
    headers: Headers,
  ): Promise<Response> {
    const protocol = sessionProtocolVersion(session);
    if (
      request.method === "tools/call" &&
      acceptsEventStream(headers) &&
      this.shouldStreamToolsCall(request)
    ) {
      return this.handleToolsCallStream(sessionId, request);
    }
    const response = await this.dispatch(request, protocol, sessionId);
    return this.marshalSingleResponse(response);
  }

  private async dispatch(
    request: ParsedRPCRequest,
    protocolVersion: string,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    if (!methodAllowedForProtocol(protocolVersion, request.method)) {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      );
    }
    if (isTaskMethod(request.method)) {
      return this.dispatchTaskMethod(request, sessionId);
    }
    if (!this.methodCapabilityEnabled(request.method)) {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      );
    }

    switch (request.method) {
      case "initialize":
        return this.handleInitialize(
          request,
          negotiateProtocolVersion(request.params),
        );
      case "ping":
        return newResultResponse(request.id, {});
      case "tools/list":
        return newResultResponse(request.id, {
          tools: this.toolRegistry.list(),
        });
      case "tools/call":
        return this.handleToolsCall(request, sessionId);
      case "resources/list":
        return newResultResponse(request.id, {
          resources: this.resourceRegistry.list(),
        });
      case "resources/read":
        return this.handleResourcesRead(request);
      case "resources/templates/list":
        return newResultResponse(request.id, {
          resourceTemplates: this.resourceRegistry.listTemplates(),
        });
      case "prompts/list":
        return newResultResponse(request.id, {
          prompts: this.promptRegistry.list(),
        });
      case "prompts/get":
        return this.handlePromptsGet(request);
      default:
        return newErrorResponse(
          request.id,
          MCP_CODE_METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  private async dispatchTaskMethod(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    if (!this.tasksEnabled()) {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        `Method not found: ${request.method}`,
      );
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
        return newErrorResponse(
          request.id,
          MCP_CODE_METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
  }

  private handleInitialize(
    request: ParsedRPCRequest,
    protocolVersion: string,
  ): McpRPCResponse {
    return newResultResponse(request.id, {
      protocolVersion,
      capabilities: this.initializeCapabilities(protocolVersion),
      serverInfo: { name: this.name, version: this.version },
    });
  }

  private initializeCapabilities(
    protocolVersion: string,
  ): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {};
    if (
      this.resourceRegistry.len() > 0 ||
      this.resourceRegistry.templateLen() > 0
    ) {
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
    return capabilities;
  }

  private async handleToolsCall(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    const params = paramsRecord(request.params);
    const name = String(params["name"] ?? "").trim();
    if (!name) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        "Invalid params: missing tool name",
      );
    }
    const taskSupport = this.toolRegistry.taskSupport(name);
    if (Object.prototype.hasOwnProperty.call(params, "task")) {
      if (!this.tasksEnabled()) {
        return newErrorResponse(
          request.id,
          MCP_CODE_METHOD_NOT_FOUND,
          "Method not found: tasks not enabled",
        );
      }
      return this.handleTaskToolsCall(request, sessionId, name, params);
    }
    if (taskSupport === "required") {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        "Method not found: tool requires task execution",
      );
    }
    try {
      const result = await this.toolRegistry.call(name, params["arguments"], {
        sessionId,
        requestId: request.id,
        method: request.method,
      });
      return newResultResponse(request.id, result);
    } catch (err) {
      return toolCallError(request.id, name, err);
    }
  }

  private async handleResourcesRead(
    request: ParsedRPCRequest,
  ): Promise<McpRPCResponse> {
    const params = paramsRecord(request.params);
    const uri = String(params["uri"] ?? "");
    try {
      const contents = await this.resourceRegistry.read(uri);
      return newResultResponse(request.id, { contents });
    } catch (err) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        errorMessage(err),
      );
    }
  }

  private async handlePromptsGet(
    request: ParsedRPCRequest,
  ): Promise<McpRPCResponse> {
    const params = paramsRecord(request.params);
    const name = String(params["name"] ?? "");
    try {
      const result = await this.promptRegistry.get(name, params["arguments"]);
      return newResultResponse(request.id, result);
    } catch (err) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        errorMessage(err),
      );
    }
  }

  private shouldStreamToolsCall(request: ParsedRPCRequest): boolean {
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

  private async handleToolsCallStream(
    sessionId: string,
    request: ParsedRPCRequest,
  ): Promise<Response> {
    let streamId = "";
    try {
      streamId = await this.streamStore.create(sessionId);
      await this.streamStore.append(sessionId, streamId);
      const params = paramsRecord(request.params);
      const name = String(params["name"] ?? "").trim();
      const progressToken = normalizeProgressToken(
        paramsRecord(params["_meta"])["progressToken"],
      );
      let progressSequence = 0;
      const emit = async (event: McpSSEEvent): Promise<void> => {
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
        await this.streamStore.append(
          sessionId,
          streamId,
          Buffer.from(JSON.stringify(notification), "utf8"),
        );
      };
      const result = await this.toolRegistry.callStreaming(
        name,
        params["arguments"],
        emit,
        { sessionId, requestId: request.id, method: request.method },
      );
      await this.streamStore.append(
        sessionId,
        streamId,
        Buffer.from(
          JSON.stringify(newResultResponse(request.id, result)),
          "utf8",
        ),
      );
      await this.streamStore.close(sessionId, streamId);
      const events = await this.streamStore.subscribe(sessionId, streamId);
      return this.streamToSSE(sessionId, events);
    } catch (err) {
      if (streamId) {
        await this.streamStore
          .close(sessionId, streamId)
          .catch(() => undefined);
      }
      return this.marshalSingleResponse(toolCallError(request.id, "", err));
    }
  }

  private async handleTaskToolsCall(
    request: ParsedRPCRequest,
    sessionId: string,
    name: string,
    params: Record<string, unknown>,
  ): Promise<McpRPCResponse> {
    const store = this.taskRuntime.store;
    if (!store) {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        "Method not found: tasks not enabled",
      );
    }
    const support = this.toolRegistry.taskSupport(name);
    if (support !== "optional" && support !== "required") {
      return newErrorResponse(
        request.id,
        MCP_CODE_METHOD_NOT_FOUND,
        "Method not found: tool does not support task execution",
      );
    }
    const ttl = taskTTL(this.taskRuntime, paramsRecord(params["task"]));
    if (ttl.error) {
      return newErrorResponse(request.id, MCP_CODE_INVALID_PARAMS, ttl.error);
    }
    const taskId = normalizeRequired(
      this.idGenerator.newId(),
      "task id generator returned empty id",
    );
    const now = isoNoMillis(new Date());
    const record: McpTaskRecord = {
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
    await this.finishTask(store, created, params["arguments"]);
    const meta: Record<string, unknown> = {
      [RELATED_TASK_METADATA_KEY]: { taskId: created.task.taskId },
    };
    if (this.taskRuntime.modelImmediateResponse) {
      meta[MODEL_IMMEDIATE_RESPONSE_METADATA_KEY] =
        this.taskRuntime.modelImmediateResponse;
    }
    return newResultResponse(request.id, {
      _meta: meta,
      task: cloneTask(created.task),
    });
  }

  private async finishTask(
    store: McpTaskStore,
    record: McpTaskRecord,
    args: unknown,
  ): Promise<void> {
    const next = cloneTaskRecord(record);
    next.task.lastUpdatedAt = isoNoMillis(new Date());
    try {
      const result = await this.toolRegistry.call(
        String(record.toolName ?? ""),
        args,
        {
          sessionId: record.sessionId,
          requestId: record.task.taskId,
          method: record.method,
        },
      );
      next.result = result;
      next.task.status = result.isError ? "failed" : "completed";
      if (result.isError) {
        next.task.statusMessage = "tool returned isError result";
      }
    } catch (err) {
      next.error = { code: MCP_CODE_SERVER_ERROR, message: errorMessage(err) };
      next.task.status = "failed";
      next.task.statusMessage = errorMessage(err);
    }
    await store.update(next).catch((err: unknown) => {
      if (!(err instanceof McpTaskTerminalError)) {
        throw err;
      }
    });
  }

  private async handleTasksGet(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    const lookup = taskLookupFromRequest(request, sessionId);
    if (lookup.error) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        lookup.error,
      );
    }
    try {
      const record = await this.requireTaskStore().get(lookup.value);
      return newResultResponse(request.id, cloneTask(record.task));
    } catch (err) {
      return taskStoreError(request.id, err);
    }
  }

  private async handleTasksResult(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    const lookup = taskLookupFromRequest(request, sessionId);
    if (lookup.error) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        lookup.error,
      );
    }
    try {
      const record = await this.requireTaskStore().get(lookup.value);
      if (record.error) {
        return {
          jsonrpc: JSONRPC_VERSION,
          id: request.id,
          error: record.error,
        };
      }
      if (record.task.status === "canceled" && record.result === undefined) {
        return newErrorResponse(
          request.id,
          MCP_CODE_SERVER_ERROR,
          TASK_CANCELED_MESSAGE,
        );
      }
      if (record.result === undefined) {
        return newErrorResponse(
          request.id,
          MCP_CODE_INTERNAL_ERROR,
          "task result not available",
        );
      }
      return newResultResponse(
        request.id,
        taskResultWithRelatedMetadata(record.result, record.task.taskId),
      );
    } catch (err) {
      return taskStoreError(request.id, err);
    }
  }

  private async handleTasksList(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    const params = paramsRecord(request.params);
    try {
      const result = await this.requireTaskStore().list({
        sessionId,
        cursor: String(params["cursor"] ?? ""),
        limit: this.taskRuntime.listLimit,
      });
      return newResultResponse(request.id, result);
    } catch (err) {
      return taskStoreError(request.id, err);
    }
  }

  private async handleTasksCancel(
    request: ParsedRPCRequest,
    sessionId: string,
  ): Promise<McpRPCResponse> {
    const lookup = taskLookupFromRequest(request, sessionId);
    if (lookup.error) {
      return newErrorResponse(
        request.id,
        MCP_CODE_INVALID_PARAMS,
        lookup.error,
      );
    }
    try {
      const record = await this.requireTaskStore().cancel(lookup.value);
      return newResultResponse(request.id, cloneTask(record.task));
    } catch (err) {
      return taskStoreError(request.id, err);
    }
  }

  private requireTaskStore(): McpTaskStore {
    const store = this.taskRuntime.store;
    if (!store) {
      throw new Error("tasks not enabled");
    }
    return store;
  }

  private tasksEnabled(): boolean {
    return Boolean(this.taskRuntime.store) && this.toolRegistry.supportsTasks();
  }

  private methodCapabilityEnabled(method: string): boolean {
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

  private async getSession(sessionId: string): Promise<McpSession> {
    const session = await this.sessionStore.get(sessionId);
    if (sessionExpiredAt(new Date(), session)) {
      await this.sessionStore.delete(sessionId);
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

  private async requireSession(headers: Headers): Promise<{
    sessionId: string;
    session: McpSession | null;
    response: Response | null;
  }> {
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
        session: await this.getSession(sessionId),
        response: null,
      };
    } catch (err) {
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

  private requireProtocolVersion(
    headers: Headers,
    session: McpSession,
  ): Response | null {
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

  private async createSession(protocolVersion: string): Promise<McpSession> {
    const now = new Date();
    const session: McpSession = {
      id: normalizeRequired(
        this.idGenerator.newId(),
        "session id generator returned empty id",
      ),
      createdAt: isoNoMillis(now),
      expiresAt: isoNoMillis(new Date(now.valueOf() + this.sessionTtlMs)),
      data: { protocolVersion },
    };
    await this.sessionStore.put(session);
    return session;
  }

  private marshalSingleResponse(
    response: McpRPCResponse,
    sessionId = "",
    includeSession = false,
  ): Response {
    const headers: Headers = { "content-type": ["application/json"] };
    if (includeSession && sessionId) {
      headers[MCP_HEADER_SESSION_ID] = [sessionId];
    }
    return {
      status: 200,
      headers,
      cookies: [],
      body: Buffer.from(JSON.stringify(response), "utf8"),
      isBase64: false,
    };
  }

  private streamToSSE(sessionId: string, events: McpStreamEvent[]): Response {
    const chunks = events.map((event) => formatMcpSSEFrame(event));
    return sseBytesResponse(200, chunks, sessionId);
  }

  private validateOrigin(headers: Headers): Response | null {
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

export function createMcpServer(
  name: string,
  version: string,
  options: McpServerOptions = {},
): McpServer {
  return new McpServer(name, version, options);
}

export function defaultMcpTaskModel(tableName?: string): Model {
  return defineModel({
    name: "AppTheoryMcpTask",
    table: {
      name:
        tableName ?? process.env["MCP_TASK_TABLE"] ?? DEFAULT_TASK_TABLE_NAME,
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
      { attribute: "ttl", type: "N", optional: true },
      { attribute: "pollInterval", type: "N", optional: true },
      { attribute: "result", type: "M", optional: true, json: true },
      { attribute: "error", type: "M", optional: true, json: true },
    ],
  });
}

export function defaultMcpStreamModel(tableName?: string): Model {
  return defineModel({
    name: "AppTheoryMcpStream",
    table: {
      name:
        tableName ??
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
    ],
  });
}

function normalizeSessionTtlMs(value: number | undefined): number {
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

function normalizeTaskRuntime(
  options: McpTaskRuntimeOptions | undefined,
): NormalizedTaskRuntime {
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
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs,
    DEFAULT_TASK_POLL_INTERVAL_MS,
  );
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

function positiveInteger(value: number | undefined, fallback: number): number {
  const n = Number(value ?? 0);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return fallback;
}

function isSupportedProtocolVersion(value: string): boolean {
  return (
    value === MCP_PROTOCOL_VERSION ||
    value === MCP_PROTOCOL_VERSION_PRIOR ||
    value === MCP_PROTOCOL_VERSION_LEGACY
  );
}

function negotiateProtocolVersion(params: unknown): string {
  const requested = String(
    paramsRecord(params)["protocolVersion"] ?? "",
  ).trim();
  if (!requested) {
    return MCP_PROTOCOL_VERSION;
  }
  return isSupportedProtocolVersion(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

function sessionProtocolVersion(session: McpSession): string {
  const value = String(session.data?.["protocolVersion"] ?? "").trim();
  return isSupportedProtocolVersion(value)
    ? value
    : MCP_PROTOCOL_VERSION_LEGACY;
}

function methodAllowedForProtocol(
  protocolVersion: string,
  method: string,
): boolean {
  if (!isSupportedProtocolVersion(protocolVersion)) {
    return false;
  }
  if (isTaskMethod(method)) {
    return protocolVersion === MCP_PROTOCOL_VERSION;
  }
  return new Set([
    "initialize",
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

function isTaskMethod(method: string): boolean {
  return new Set([
    "tasks/get",
    "tasks/result",
    "tasks/list",
    "tasks/cancel",
  ]).has(method);
}

function parseRequest(body: Uint8Array): ParsedRPCRequest {
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
  const out: ParsedRPCRequest = { method, idPresent };
  if (idPresent) {
    out.id = id;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "params")) {
    out.params = raw["params"];
  }
  return out;
}

function parseResponse(body: Uint8Array): void {
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
    throw new Error(
      `unsupported jsonrpc version: ${String(raw["jsonrpc"] ?? "")}`,
    );
  }
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> {
  if (body.length === 0) {
    throw new Error("empty request body");
  }
  const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("invalid JSON object");
  }
  return parsed;
}

function validatePostHeaders(headers: Headers): Response | null {
  if (!contentTypeIsJSON(headers)) {
    return badRequest("POST /mcp requires Content-Type: application/json");
  }
  if (!acceptsJSON(headers) || !acceptsEventStream(headers)) {
    return badRequest(
      "POST /mcp requires Accept: application/json and text/event-stream",
    );
  }
  return null;
}

function validateGetHeaders(headers: Headers): Response | null {
  if (!acceptsEventStream(headers)) {
    return badRequest("GET /mcp requires Accept: text/event-stream");
  }
  return null;
}

function contentTypeIsJSON(headers: Headers): boolean {
  const media = parseMediaRange(firstHeader(headers, "content-type"));
  return Boolean(
    media && media.type === "application" && media.subtype === "json",
  );
}

function acceptsJSON(headers: Headers): boolean {
  return headerIncludesMediaType(headers, "accept", "application/json");
}

function acceptsEventStream(headers: Headers): boolean {
  return headerIncludesMediaType(headers, "accept", "text/event-stream");
}

function headerIncludesMediaType(
  headers: Headers,
  key: string,
  want: string,
): boolean {
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
      const subtypeMatches =
        media.subtype === "*" || media.subtype === wantMedia.subtype;
      if (typeMatches && subtypeMatches) {
        return true;
      }
    }
  }
  return false;
}

function parseMediaRange(
  raw: string,
): { type: string; subtype: string } | null {
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
    if (
      String(name ?? "")
        .trim()
        .toLowerCase() !== "q"
    ) {
      continue;
    }
    const q = Number(
      String(value ?? "")
        .trim()
        .replace(/^"|"$/g, ""),
    );
    if (Number.isFinite(q) && q <= 0) {
      return null;
    }
  }
  return { type, subtype };
}

function firstHeader(headers: Headers, key: string): string {
  const values = headerValues(headers, key);
  return values.length > 0 ? String(values[0] ?? "") : "";
}

function headerValues(headers: Headers, key: string): string[] {
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

function newErrorResponse(
  id: unknown,
  code: number,
  message: string,
): McpRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: { code, message },
  };
}

function newResultResponse(id: unknown, result: unknown): McpRPCResponse {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result };
}

function badRequest(message: string): Response {
  return jsonBytesResponse(400, { error: message });
}

function notFound(message: string): Response {
  return jsonBytesResponse(404, { error: message });
}

function internalServerError(): Response {
  return jsonBytesResponse(500, { error: "internal server error" });
}

function jsonBytesResponse(status: number, value: unknown): Response {
  return {
    status,
    headers: { "content-type": ["application/json"] },
    cookies: [],
    body: Buffer.from(JSON.stringify(value), "utf8"),
    isBase64: false,
  };
}

function emptyResponse(status: number): Response {
  return {
    status,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function sseBytesResponse(
  status: number,
  chunks: Uint8Array[],
  sessionId: string,
): Response {
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

function formatMcpSSEFrame(event: McpStreamEvent): Uint8Array {
  const lines: string[] = [];
  const id = String(event.id ?? "").trim();
  if (id) {
    lines.push(`id: ${id}`);
  }
  if (event.data.length > 0) {
    lines.push("event: message");
  }
  const data =
    event.data.length > 0 ? Buffer.from(event.data).toString("utf8") : "";
  const dataLines = data
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }
  return Buffer.from(`${lines.join("\n")}\n\n`, "utf8");
}

function normalizeToolDef(definition: McpToolDef): McpToolDef {
  const out: McpToolDef = {
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

function cloneToolDef(definition: McpToolDef): McpToolDef {
  return JSON.parse(JSON.stringify(definition)) as McpToolDef;
}

function normalizeToolResult(result: McpToolResult): McpToolResult {
  const out: McpToolResult = {
    content: Array.isArray(result?.content)
      ? result.content.map(normalizeContentBlock)
      : [],
  };
  if (Boolean(result?.isError)) {
    out.isError = true;
  }
  if (result?.structuredContent && isRecord(result.structuredContent)) {
    out.structuredContent = { ...result.structuredContent };
  }
  return out;
}

function normalizeContentBlock(block: McpContentBlock): McpContentBlock {
  const out: McpContentBlock = { type: String(block?.type ?? "") };
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

function normalizeResourceDef(definition: McpResourceDef): McpResourceDef {
  const out: McpResourceDef = {
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

function cloneResourceDef(definition: McpResourceDef): McpResourceDef {
  return JSON.parse(JSON.stringify(definition)) as McpResourceDef;
}

function normalizeResourceTemplateDef(
  definition: McpResourceTemplateDef,
): McpResourceTemplateDef {
  const out: McpResourceTemplateDef = {
    uriTemplate: String(definition.uriTemplate ?? "").trim(),
    name: String(definition.name ?? "").trim(),
  };
  copyOptionalString(out, "title", definition.title);
  copyOptionalString(out, "description", definition.description);
  copyOptionalString(out, "mimeType", definition.mimeType);
  return out;
}

function cloneResourceTemplateDef(
  definition: McpResourceTemplateDef,
): McpResourceTemplateDef {
  return JSON.parse(JSON.stringify(definition)) as McpResourceTemplateDef;
}

function normalizeResourceContent(
  content: McpResourceContent,
): McpResourceContent {
  const out: McpResourceContent = { uri: String(content?.uri ?? "") };
  copyOptionalString(out, "mimeType", content?.mimeType);
  copyOptionalString(out, "text", content?.text);
  copyOptionalString(out, "blob", content?.blob);
  return out;
}

function normalizePromptDef(definition: McpPromptDef): McpPromptDef {
  const out: McpPromptDef = { name: String(definition.name ?? "").trim() };
  copyOptionalString(out, "title", definition.title);
  copyOptionalString(out, "description", definition.description);
  if (Array.isArray(definition.arguments)) {
    out.arguments = definition.arguments.map(normalizePromptArgument);
  }
  return out;
}

function normalizePromptArgument(
  argument: McpPromptArgument,
): McpPromptArgument {
  const out: McpPromptArgument = { name: String(argument.name ?? "") };
  copyOptionalString(out, "title", argument.title);
  copyOptionalString(out, "description", argument.description);
  if (argument.required) {
    out.required = true;
  }
  return out;
}

function clonePromptDef(definition: McpPromptDef): McpPromptDef {
  return JSON.parse(JSON.stringify(definition)) as McpPromptDef;
}

function normalizePromptResult(result: McpPromptResult): McpPromptResult {
  const out: McpPromptResult = {
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

function copyOptionalString(out: object, key: string, value: unknown): void {
  const normalized = String(value ?? "").trim();
  if (normalized) {
    (out as Record<string, unknown>)[key] = normalized;
  }
}

function validResourceURI(uri: string): boolean {
  const value = String(uri ?? "").trim();
  if (!value || /\s/.test(value)) {
    return false;
  }
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function paramsRecord(params: unknown): Record<string, unknown> {
  return isRecord(params) ? params : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toBytes(value: Uint8Array | string | undefined): Uint8Array {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return Buffer.from(String(value ?? ""), "utf8");
}

function cloneBytes(value: Uint8Array | undefined): Uint8Array {
  return value ? Buffer.from(value) : Buffer.alloc(0);
}

function cloneSession(session: McpSession): McpSession {
  const out: McpSession = {
    id: String(session.id ?? "").trim(),
    createdAt: String(session.createdAt ?? ""),
    expiresAt: String(session.expiresAt ?? ""),
  };
  if (session.data) {
    out.data = { ...session.data };
  }
  return out;
}

function sessionExpiredAt(now: Date, session: McpSession): boolean {
  const expires = Date.parse(String(session.expiresAt ?? ""));
  if (!Number.isFinite(expires) || expires <= 0) {
    return false;
  }
  return expires <= now.valueOf();
}

function isoNoMillis(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, "Z");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function normalizeRequired(value: unknown, message: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function toolCallError(
  id: unknown,
  toolName: string,
  err: unknown,
): McpRPCResponse {
  const message = errorMessage(err);
  if (message.startsWith("tool not found:")) {
    return newErrorResponse(id, MCP_CODE_INVALID_PARAMS, message);
  }
  const resolved = toolName ? message : message || "internal error";
  return newErrorResponse(id, MCP_CODE_SERVER_ERROR, resolved);
}

function normalizeProgressToken(value: unknown): string | number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function progressFromSSEEvent(
  event: McpSSEEvent,
  fallbackProgress: number,
): { progress: number; total: unknown; message: string } {
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

function numberFromUnknown(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function taskTTL(
  runtime: NormalizedTaskRuntime,
  meta: Record<string, unknown>,
): { value: number; error?: string } {
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

function taskLookupFromRequest(
  request: ParsedRPCRequest,
  sessionId: string,
): { value: McpTaskLookup; error?: string } {
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

function taskStoreError(id: unknown, err: unknown): McpRPCResponse {
  if (
    err instanceof McpTaskNotFoundError ||
    err instanceof McpTaskTerminalError ||
    err instanceof McpTaskInvalidCursorError
  ) {
    return newErrorResponse(id, MCP_CODE_INVALID_PARAMS, err.message);
  }
  return newErrorResponse(id, MCP_CODE_SERVER_ERROR, errorMessage(err));
}

function taskStatusTerminal(status: McpTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function taskListLimit(value: number | undefined): number {
  let limit = positiveInteger(value, DEFAULT_TASK_LIST_LIMIT);
  if (limit > MAX_TASK_LIST_LIMIT) {
    limit = MAX_TASK_LIST_LIMIT;
  }
  return limit;
}

function parseTaskCursor(value: string | undefined): number {
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

function compareTaskRecords(a: McpTaskRecord, b: McpTaskRecord): number {
  const time = a.task.createdAt.localeCompare(b.task.createdAt);
  if (time !== 0) {
    return time;
  }
  return a.task.taskId.localeCompare(b.task.taskId);
}

function compareStreamItems(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  return Number(a["sequence"] ?? 0) - Number(b["sequence"] ?? 0);
}

function cloneTask(task: McpTask): McpTask {
  const out: McpTask = {
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

function cloneTaskRecord(record: McpTaskRecord): McpTaskRecord {
  const out: McpTaskRecord = {
    sessionId: String(record.sessionId ?? ""),
    method: String(record.method ?? ""),
    task: cloneTask(record.task),
  };
  if (record.toolName) {
    out.toolName = String(record.toolName);
  }
  if (record.result !== undefined) {
    out.result = JSON.parse(JSON.stringify(record.result)) as unknown;
  }
  if (record.error) {
    out.error = { ...record.error };
  }
  return out;
}

function taskResultWithRelatedMetadata(
  result: unknown,
  taskId: string,
): unknown {
  const out = isRecord(result) ? { ...result } : {};
  const existingMeta = isRecord(out["_meta"]) ? { ...out["_meta"] } : {};
  existingMeta[RELATED_TASK_METADATA_KEY] = { taskId };
  out["_meta"] = existingMeta;
  return out;
}

function taskKey(lookup: McpTaskLookup): Record<string, unknown> {
  return {
    sessionId: String(lookup.sessionId ?? "").trim(),
    taskId: String(lookup.taskId ?? "").trim(),
  };
}

function taskRecordToItem(record: McpTaskRecord): Record<string, unknown> {
  const item: Record<string, unknown> = {
    sessionId: String(record.sessionId ?? "").trim(),
    taskId: String(record.task.taskId ?? "").trim(),
    method: String(record.method ?? ""),
    status: record.task.status,
    createdAt: record.task.createdAt,
    lastUpdatedAt: record.task.lastUpdatedAt,
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

function itemToTaskRecord(item: Record<string, unknown>): McpTaskRecord {
  const task: McpTask = {
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
  const record: McpTaskRecord = {
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

function normalizeTaskStatus(value: unknown): McpTaskStatus {
  const status = String(value ?? "");
  if (
    status === "working" ||
    status === "input_required" ||
    status === "completed" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return status;
  }
  return "working";
}

function isNotFoundError(err: unknown): boolean {
  if (
    err instanceof McpTaskNotFoundError ||
    err instanceof McpStreamNotFoundError
  ) {
    return true;
  }
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return name.includes("notfound") || message.includes("not found");
  }
  return false;
}
