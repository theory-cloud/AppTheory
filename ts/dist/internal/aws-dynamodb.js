import { Buffer } from "node:buffer";
import { isAwsCredentials, loadEnvCredentials, signedFetch, } from "./aws-sigv4.js";
function normalizeEndpoint(endpoint) {
    const value = String(endpoint ?? "").trim();
    if (!value)
        return "";
    if (value.startsWith("https://") || value.startsWith("http://"))
        return value;
    return `https://${value}`;
}
function extractErrorName(payload) {
    const raw = String(payload["__type"] ?? "").trim();
    if (!raw)
        return "DynamoDBError";
    const idx = raw.lastIndexOf("#");
    return idx !== -1 && idx < raw.length - 1 ? raw.slice(idx + 1) : raw;
}
function extractErrorMessage(payload) {
    const msg = String(payload["message"] ?? payload["Message"] ?? "").trim();
    return msg;
}
function asObject(value) {
    if (!value || typeof value !== "object")
        return {};
    return value;
}
export class DynamoDBClient {
    endpoint;
    region;
    _credentials;
    constructor(options = {}) {
        this.region =
            String(options.region ?? "").trim() ||
                String(process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "").trim();
        if (!this.region) {
            throw new Error("apptheory: aws region is empty");
        }
        this.endpoint =
            normalizeEndpoint(options.endpoint) ||
                `https://dynamodb.${this.region}.amazonaws.com`;
        this._credentials = isAwsCredentials(options.credentials)
            ? options.credentials
            : loadEnvCredentials();
    }
    async getItem(input) {
        return (await this._call("GetItem", input));
    }
    async updateItem(input) {
        return (await this._call("UpdateItem", input));
    }
    async putItem(input) {
        return await this._call("PutItem", input);
    }
    async transactWriteItems(input) {
        return await this._call("TransactWriteItems", input);
    }
    async _call(op, input) {
        const body = Buffer.from(JSON.stringify(input), "utf8");
        const resp = await signedFetch({
            method: "POST",
            url: this.endpoint,
            region: this.region,
            service: "dynamodb",
            credentials: this._credentials,
            headers: {
                "content-type": "application/x-amz-json-1.0",
                "x-amz-target": `DynamoDB_20120810.${op}`,
            },
            body,
        });
        const text = await resp.text().catch(() => "");
        const payload = text ? asObject(JSON.parse(text)) : {};
        if (!resp.ok) {
            const name = extractErrorName(payload);
            const message = extractErrorMessage(payload) ||
                `apptheory: dynamodb ${op} failed (${resp.status})`;
            const err = new Error(message);
            err.name = name;
            err.statusCode = resp.status;
            throw err;
        }
        return payload;
    }
}
