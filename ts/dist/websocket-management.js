import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { toBuffer } from "./internal/http.js";
function inferRegionFromDomainName(domainName) {
    const host = String(domainName ?? "")
        .trim()
        .toLowerCase();
    const m = host.match(/\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/);
    return m ? (m[1] ?? "") : "";
}
function isAwsCredentials(value) {
    if (!value || typeof value !== "object")
        return false;
    const rec = value;
    return (typeof rec["accessKeyId"] === "string" &&
        typeof rec["secretAccessKey"] === "string");
}
function loadEnvCredentials() {
    const accessKeyId = String(process.env["AWS_ACCESS_KEY_ID"] ?? "").trim();
    const secretAccessKey = String(process.env["AWS_SECRET_ACCESS_KEY"] ?? "").trim();
    const sessionToken = String(process.env["AWS_SESSION_TOKEN"] ?? "").trim();
    if (!accessKeyId || !secretAccessKey) {
        throw new Error("apptheory: missing aws credentials for websocket management client");
    }
    const out = { accessKeyId, secretAccessKey };
    if (sessionToken)
        out.sessionToken = sessionToken;
    return out;
}
function normalizeWebSocketManagementEndpoint(endpoint) {
    const value = String(endpoint ?? "").trim();
    if (!value)
        return "";
    if (value.startsWith("wss://"))
        return `https://${value.slice("wss://".length)}`;
    if (value.startsWith("ws://"))
        return `http://${value.slice("ws://".length)}`;
    if (value.startsWith("https://") || value.startsWith("http://"))
        return value;
    return `https://${value}`;
}
function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
function hmacSha256(key, data) {
    return createHmac("sha256", key).update(data, "utf8").digest();
}
function signingKey(secretAccessKey, dateStamp, region, service) {
    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    return hmacSha256(kService, "aws4_request");
}
function amzDateNow(now = new Date()) {
    return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
async function signedFetch({ method, url, region, credentials, headers, body, }) {
    const u = new URL(url);
    const host = u.host;
    const canonicalUri = u.pathname || "/";
    const canonicalQueryString = u.searchParams.toString();
    const payloadHash = sha256Hex(body ?? "");
    const amzDate = amzDateNow();
    const dateStamp = amzDate.slice(0, 8);
    const merged = { host, "x-amz-date": amzDate };
    for (const [key, value] of Object.entries(headers ?? {})) {
        const k = String(key).trim().toLowerCase();
        if (k)
            merged[k] = String(value);
    }
    if (credentials.sessionToken) {
        merged["x-amz-security-token"] = credentials.sessionToken;
    }
    const sortedKeys = Object.keys(merged).sort();
    const canonicalHeaders = sortedKeys
        .map((k) => `${k}:${String(merged[k]).trim().replace(/\s+/g, " ")}\n`)
        .join("");
    const signedHeaders = sortedKeys.join(";");
    const canonicalRequest = [
        String(method).toUpperCase(),
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/execute-api/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
    ].join("\n");
    const kSigning = signingKey(credentials.secretAccessKey, dateStamp, region, "execute-api");
    const signature = createHmac("sha256", kSigning)
        .update(stringToSign, "utf8")
        .digest("hex");
    merged["authorization"] =
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const init = {
        method,
        headers: merged,
    };
    if (body) {
        init.body = Buffer.from(body);
    }
    return fetch(u.toString(), init);
}
export class WebSocketManagementClient {
    endpoint;
    region;
    _credentials;
    constructor(options = {}) {
        this.endpoint = normalizeWebSocketManagementEndpoint(options.endpoint);
        if (!this.endpoint) {
            throw new Error("apptheory: websocket management endpoint is empty");
        }
        const host = new URL(this.endpoint).host;
        this.region =
            String(options.region ?? "").trim() ||
                String(process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "").trim() ||
                inferRegionFromDomainName(host);
        if (!this.region) {
            throw new Error("apptheory: aws region is empty");
        }
        this._credentials = isAwsCredentials(options.credentials)
            ? options.credentials
            : loadEnvCredentials();
    }
    async postToConnection(connectionId, data) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        const base = new URL(this.endpoint);
        const basePath = base.pathname.replace(/\/+$/, "");
        const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;
        const body = toBuffer(data);
        const resp = await signedFetch({
            method: "POST",
            url,
            region: this.region,
            credentials: this._credentials,
            headers: { "content-type": "application/octet-stream" },
            body,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`apptheory: post_to_connection failed (${resp.status}) ${text}`.trim());
        }
    }
    async getConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        const base = new URL(this.endpoint);
        const basePath = base.pathname.replace(/\/+$/, "");
        const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;
        const resp = await signedFetch({
            method: "GET",
            url,
            region: this.region,
            credentials: this._credentials,
            headers: {},
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`apptheory: get_connection failed (${resp.status}) ${text}`.trim());
        }
        return (await resp.json());
    }
    async deleteConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        const base = new URL(this.endpoint);
        const basePath = base.pathname.replace(/\/+$/, "");
        const url = `${base.origin}${basePath}/@connections/${encodeURIComponent(id)}`;
        const resp = await signedFetch({
            method: "DELETE",
            url,
            region: this.region,
            credentials: this._credentials,
            headers: {},
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`apptheory: delete_connection failed (${resp.status}) ${text}`.trim());
        }
    }
}
export class FakeWebSocketManagementClient {
    endpoint;
    calls;
    connections;
    postError;
    getError;
    deleteError;
    constructor(options = {}) {
        this.endpoint = String(options.endpoint ?? "").trim();
        this.calls = [];
        this.connections = new Map();
        this.postError = null;
        this.getError = null;
        this.deleteError = null;
    }
    async postToConnection(connectionId, data) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({
            op: "post_to_connection",
            connectionId: id,
            data: toBuffer(data),
        });
        if (this.postError)
            throw this.postError;
    }
    async getConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({ op: "get_connection", connectionId: id, data: null });
        if (this.getError)
            throw this.getError;
        if (!this.connections.has(id))
            throw new Error("apptheory: connection not found");
        return this.connections.get(id);
    }
    async deleteConnection(connectionId) {
        const id = String(connectionId ?? "").trim();
        if (!id)
            throw new Error("apptheory: websocket connection id is empty");
        this.calls.push({ op: "delete_connection", connectionId: id, data: null });
        if (this.deleteError)
            throw this.deleteError;
        this.connections.delete(id);
    }
}
