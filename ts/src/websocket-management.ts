import {
  type AwsCredentials,
  isAwsCredentials,
  loadEnvCredentials,
  signedFetch,
} from "./internal/aws-sigv4.js";
import { toBuffer } from "./internal/http.js";

export interface WebSocketCall {
  op: "post_to_connection" | "get_connection" | "delete_connection";
  connectionId: string;
  data: Uint8Array | null;
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
  private readonly _credentials: AwsCredentials;

  constructor(
    options: { endpoint?: string; region?: string; credentials?: unknown } = {},
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

    this._credentials = isAwsCredentials(options.credentials)
      ? options.credentials
      : (() => {
          try {
            return loadEnvCredentials();
          } catch {
            throw new Error(
              "apptheory: missing aws credentials for websocket management client",
            );
          }
        })();
  }

  async postToConnection(
    connectionId: string,
    data: Uint8Array,
  ): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;
    const body = toBuffer(data);

    const resp = await signedFetch({
      method: "POST",
      url,
      region: this.region,
      service: "execute-api",
      credentials: this._credentials,
      headers: { "content-type": "application/octet-stream" },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `apptheory: post_to_connection failed (${resp.status}) ${text}`.trim(),
      );
    }
  }

  async getConnection(connectionId: string): Promise<unknown> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;

    const resp = await signedFetch({
      method: "GET",
      url,
      region: this.region,
      service: "execute-api",
      credentials: this._credentials,
      headers: {},
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `apptheory: get_connection failed (${resp.status}) ${text}`.trim(),
      );
    }

    return (await resp.json()) as unknown;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const id = String(connectionId ?? "").trim();
    if (!id) throw new Error("apptheory: websocket connection id is empty");

    const base = new URL(this.endpoint);
    const basePath = base.pathname.replace(/\/+$/, "");
    const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;

    const resp = await signedFetch({
      method: "DELETE",
      url,
      region: this.region,
      service: "execute-api",
      credentials: this._credentials,
      headers: {},
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `apptheory: delete_connection failed (${resp.status}) ${text}`.trim(),
      );
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
