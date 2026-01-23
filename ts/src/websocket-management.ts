import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  GetConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

import { toBuffer } from "./internal/http.js";

export interface WebSocketCall {
  op: "post_to_connection" | "get_connection" | "delete_connection";
  connectionId: string;
  data: Uint8Array | null;
}

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function isAwsCredentials(value: unknown): value is AwsCredentials {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["accessKeyId"] === "string" &&
    typeof rec["secretAccessKey"] === "string"
  );
}

function awsStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  const meta = rec["$metadata"];
  if (!meta || typeof meta !== "object") return null;
  const code = (meta as Record<string, unknown>)["httpStatusCode"];
  return typeof code === "number" ? code : null;
}

function errorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err) {
    return String((err as Record<string, unknown>)["message"] ?? "");
  }
  return String(err);
}

function inferRegionFromDomainName(domainName: unknown): string {
  const host = String(domainName ?? "")
    .trim()
    .toLowerCase();
  const m = host.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/);
  return m ? (m[1] ?? "") : "";
}

function normalizeWebSocketManagementEndpoint(endpoint: unknown): string {
  const value = String(endpoint ?? "").trim();
  if (!value) return "";
  if (value.startsWith("wss://"))
    return `https://${value.slice("wss://".length)}`;
  if (value.startsWith("ws://")) return `http://${value.slice("ws://".length)}`;
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  return `https://${value}`;
}

export class WebSocketManagementClient {
  readonly endpoint: string;
  readonly region: string;
  private readonly _client: { send: ApiGatewayManagementApiClient["send"] };

  constructor(
    options: {
      endpoint?: string;
      region?: string;
      credentials?: unknown;
      client?: { send: ApiGatewayManagementApiClient["send"] };
    } = {},
  ) {
    this.endpoint = normalizeWebSocketManagementEndpoint(options.endpoint);
    if (!this.endpoint) {
      throw new Error("apptheory: websocket management endpoint is empty");
    }

    const host = new URL(this.endpoint).host;
    this.region =
      String(options.region ?? "").trim() ||
      String(
        process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "",
      ).trim() ||
      inferRegionFromDomainName(host);
    if (!this.region) {
      throw new Error("apptheory: aws region is empty");
    }

    const credentials = isAwsCredentials(options.credentials)
      ? options.credentials
      : undefined;
    this._client =
      options.client ??
      new ApiGatewayManagementApiClient({
        endpoint: this.endpoint,
        region: this.region,
        ...(credentials ? { credentials } : {}),
      });
  }

  async postToConnection(
    connectionId: string,
    data: Uint8Array,
  ): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    const body = toBuffer(data);

    try {
      await this._client.send(
        new PostToConnectionCommand({
          ConnectionId: id,
          Data: body,
        }),
      );
    } catch (err) {
      const status = awsStatusCode(err);
      const suffix = [status ? `(${status})` : "", errorMessage(err)]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      throw new Error(`apptheory: post_to_connection failed ${suffix}`.trim());
    }
  }

  async getConnection(connectionId: string): Promise<unknown> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    try {
      const resp = await this._client.send(
        new GetConnectionCommand({ ConnectionId: id }),
      );
      const { $metadata: _metadata, ...rest } = resp;
      return rest;
    } catch (err) {
      const status = awsStatusCode(err);
      const suffix = [status ? `(${status})` : "", errorMessage(err)]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      throw new Error(`apptheory: get_connection failed ${suffix}`.trim());
    }
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    try {
      await this._client.send(
        new DeleteConnectionCommand({ ConnectionId: id }),
      );
    } catch (err) {
      const status = awsStatusCode(err);
      const suffix = [status ? `(${status})` : "", errorMessage(err)]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ");
      throw new Error(`apptheory: delete_connection failed ${suffix}`.trim());
    }
  }
}

export class FakeWebSocketManagementClient {
  readonly endpoint: string;
  readonly calls: WebSocketCall[];
  readonly connections: Map<string, unknown>;

  postError: Error | null;
  getError: Error | null;
  deleteError: Error | null;

  constructor(options: { endpoint?: string } = {}) {
    this.endpoint = String(options.endpoint ?? "").trim();
    this.calls = [];
    this.connections = new Map();
    this.postError = null;
    this.getError = null;
    this.deleteError = null;
  }

  async postToConnection(
    connectionId: string,
    data: Uint8Array,
  ): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    this.calls.push({
      op: "post_to_connection",
      connectionId: id,
      data: toBuffer(data),
    });

    if (this.postError) throw this.postError;
  }

  async getConnection(connectionId: string): Promise<unknown> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    this.calls.push({ op: "get_connection", connectionId: id, data: null });

    if (this.getError) throw this.getError;
    if (!this.connections.has(id))
      throw new Error("apptheory: connection not found");
    return this.connections.get(id);
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    this.calls.push({ op: "delete_connection", connectionId: id, data: null });

    if (this.deleteError) throw this.deleteError;
    this.connections.delete(id);
  }
}
