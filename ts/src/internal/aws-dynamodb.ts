import { Buffer } from "node:buffer";

import {
  type AwsCredentials,
  isAwsCredentials,
  loadEnvCredentials,
  signedFetch,
} from "./aws-sigv4.js";

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { M: Record<string, AttributeValue> }
  | { L: AttributeValue[] };

export type DynamoDBKey = Record<string, AttributeValue>;
export type DynamoDBItem = Record<string, AttributeValue>;

export type GetItemInput = {
  TableName: string;
  Key: DynamoDBKey;
  ConsistentRead?: boolean;
};

export type GetItemOutput = {
  Item?: DynamoDBItem;
};

export type UpdateItemInput = {
  TableName: string;
  Key: DynamoDBKey;
  UpdateExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ConditionExpression?: string;
  ReturnValues?: "NONE" | "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW";
};

export type UpdateItemOutput = {
  Attributes?: DynamoDBItem;
};

export type PutItemInput = {
  TableName: string;
  Item: DynamoDBItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
};

export type TransactWriteItemsInput = {
  TransactItems: Array<Record<string, unknown>>;
};

function normalizeEndpoint(endpoint: unknown): string {
  const value = String(endpoint ?? "").trim();
  if (!value) return "";
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  return `https://${value}`;
}

function extractErrorName(payload: Record<string, unknown>): string {
  const raw = String(payload["__type"] ?? "").trim();
  if (!raw) return "DynamoDBError";
  const idx = raw.lastIndexOf("#");
  return idx !== -1 && idx < raw.length - 1 ? raw.slice(idx + 1) : raw;
}

function extractErrorMessage(payload: Record<string, unknown>): string {
  const msg = String(payload["message"] ?? payload["Message"] ?? "").trim();
  return msg;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export class DynamoDBClient {
  readonly endpoint: string;
  readonly region: string;
  private readonly _credentials: AwsCredentials;

  constructor(
    options: {
      endpoint?: unknown;
      region?: unknown;
      credentials?: unknown;
    } = {},
  ) {
    this.region =
      String(options.region ?? "").trim() ||
      String(
        process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "",
      ).trim();
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

  async getItem(input: GetItemInput): Promise<GetItemOutput> {
    return (await this._call("GetItem", input)) as GetItemOutput;
  }

  async updateItem(input: UpdateItemInput): Promise<UpdateItemOutput> {
    return (await this._call("UpdateItem", input)) as UpdateItemOutput;
  }

  async putItem(input: PutItemInput): Promise<Record<string, unknown>> {
    return await this._call("PutItem", input);
  }

  async transactWriteItems(
    input: TransactWriteItemsInput,
  ): Promise<Record<string, unknown>> {
    return await this._call("TransactWriteItems", input);
  }

  private async _call(
    op: "GetItem" | "UpdateItem" | "PutItem" | "TransactWriteItems",
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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
      const message =
        extractErrorMessage(payload) ||
        `apptheory: dynamodb ${op} failed (${resp.status})`;
      const err = new Error(message);
      (err as { name: string }).name = name;
      (err as { statusCode?: number }).statusCode = resp.status;
      throw err;
    }

    return payload;
  }
}
