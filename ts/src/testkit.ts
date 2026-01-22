import { Buffer } from "node:buffer";

import { createApp, type App } from "./app.js";
import type {
  ALBTargetGroupRequest,
  ALBTargetGroupResponse,
  APIGatewayProxyResponse,
  APIGatewayProxyRequest,
  APIGatewayV2HTTPRequest,
  APIGatewayV2HTTPResponse,
  DynamoDBStreamEvent,
  DynamoDBStreamEventResponse,
  DynamoDBStreamRecord,
  EventBridgeEvent,
  KinesisEventResponse,
  KinesisEvent,
  KinesisEventRecordInput,
  LambdaFunctionURLResponse,
  LambdaFunctionURLRequest,
  SNSEvent,
  SQSEventResponse,
  SNSEventRecordInput,
  SQSEvent,
  SQSMessage,
} from "./aws-types.js";
import { ManualClock } from "./clock.js";
import { AppError } from "./errors.js";
import { ManualIdGenerator } from "./ids.js";
import {
  CapturedHttpResponseStream,
  serveLambdaFunctionURLStreaming,
} from "./internal/aws-lambda-streaming.js";
import {
  cloneQuery,
  firstQueryValues,
  normalizeMethod,
  parseRawQueryString,
  splitPathAndQuery,
  toBuffer,
} from "./internal/http.js";
import type { Headers, Query, Request, Response } from "./types.js";

export class TestEnv {
  readonly clock: ManualClock;
  readonly ids: ManualIdGenerator;

  constructor(options: { now?: Date } = {}) {
    this.clock = new ManualClock(options.now ?? new Date(0));
    this.ids = new ManualIdGenerator();
  }

  app(options: Record<string, unknown> = {}): App {
    return createApp({ clock: this.clock, ids: this.ids, ...(options ?? {}) });
  }

  invoke(app: App, request: Request, ctx?: unknown): Promise<Response> {
    return app.serve(request, ctx);
  }

  async invokeStreaming(
    app: App,
    request: Request,
    ctx?: unknown,
  ): Promise<{
    status: number;
    headers: Headers;
    cookies: string[];
    chunks: Uint8Array[];
    body: Uint8Array;
    is_base64: boolean;
    stream_error_code: string;
  }> {
    const resp = await app.serve(request, ctx);

    const headers: Headers = {};
    for (const [key, values] of Object.entries(resp.headers ?? {})) {
      headers[key] = Array.isArray(values)
        ? values.map((v) => String(v))
        : [String(values)];
    }

    const cookies = Array.isArray(resp.cookies)
      ? resp.cookies.map((c) => String(c))
      : [];

    const chunks: Buffer[] = [];
    const buffers: Buffer[] = [];

    if (resp.body && Buffer.from(resp.body).length > 0) {
      const b = Buffer.from(resp.body);
      chunks.push(b);
      buffers.push(b);
    }

    let streamErrorCode = "";
    if (resp.bodyStream) {
      try {
        for await (const chunk of resp.bodyStream) {
          const b = Buffer.from(chunk ?? []);
          chunks.push(b);
          buffers.push(b);
        }
      } catch (err) {
        streamErrorCode =
          err instanceof AppError ? String(err.code ?? "") : "app.internal";
      }
    }

    return {
      status: Number(resp.status ?? 0),
      headers,
      cookies,
      chunks,
      body: Buffer.concat(buffers),
      is_base64: Boolean(resp.isBase64),
      stream_error_code: streamErrorCode,
    };
  }

  invokeAPIGatewayV2(
    app: App,
    event: APIGatewayV2HTTPRequest,
    ctx?: unknown,
  ): Promise<APIGatewayV2HTTPResponse> {
    return app.serveAPIGatewayV2(event, ctx);
  }

  invokeLambdaFunctionURL(
    app: App,
    event: LambdaFunctionURLRequest,
    ctx?: unknown,
  ): Promise<LambdaFunctionURLResponse> {
    return app.serveLambdaFunctionURL(event, ctx);
  }

  async invokeLambdaFunctionURLStreaming(
    app: App,
    event: LambdaFunctionURLRequest,
    ctx?: unknown,
  ): Promise<{
    status: number;
    headers: Headers;
    cookies: string[];
    chunks: Uint8Array[];
    body: Uint8Array;
    is_base64: boolean;
    stream_error_code: string;
  }> {
    const stream = new CapturedHttpResponseStream();
    const streamErrorCode = await serveLambdaFunctionURLStreaming(
      app,
      event,
      stream,
      ctx,
    );

    const headers: Headers = {};
    for (const [key, value] of Object.entries(stream.headers ?? {})) {
      headers[key] = [String(value)];
    }

    const chunks = [...stream.chunks];
    return {
      status: Number(stream.statusCode ?? 0),
      headers,
      cookies: [...stream.cookies],
      chunks,
      body: Buffer.concat(chunks),
      is_base64: false,
      stream_error_code: streamErrorCode,
    };
  }

  invokeAPIGatewayProxy(
    app: App,
    event: APIGatewayProxyRequest,
    ctx?: unknown,
  ): Promise<APIGatewayProxyResponse> {
    return app.serveAPIGatewayProxy(event, ctx);
  }

  invokeALB(
    app: App,
    event: ALBTargetGroupRequest,
    ctx?: unknown,
  ): Promise<ALBTargetGroupResponse> {
    return app.serveALB(event, ctx);
  }

  invokeSQS(
    app: App,
    event: SQSEvent,
    ctx?: unknown,
  ): Promise<SQSEventResponse> {
    return app.serveSQSEvent(event, ctx);
  }

  invokeEventBridge(
    app: App,
    event: EventBridgeEvent,
    ctx?: unknown,
  ): Promise<unknown> {
    return app.serveEventBridge(event, ctx);
  }

  invokeDynamoDBStream(
    app: App,
    event: DynamoDBStreamEvent,
    ctx?: unknown,
  ): Promise<DynamoDBStreamEventResponse> {
    return app.serveDynamoDBStream(event, ctx);
  }

  invokeKinesis(
    app: App,
    event: KinesisEvent,
    ctx?: unknown,
  ): Promise<KinesisEventResponse> {
    return app.serveKinesisEvent(event, ctx);
  }

  invokeSNS(app: App, event: SNSEvent, ctx?: unknown): Promise<unknown[]> {
    return app.serveSNSEvent(event, ctx);
  }

  invokeLambda(app: App, event: unknown, ctx?: unknown): Promise<unknown> {
    return app.handleLambda(event, ctx);
  }
}

export function createTestEnv(options: { now?: Date } = {}): TestEnv {
  return new TestEnv(options);
}

export function buildAPIGatewayV2Request(
  method: string,
  path: string,
  options: {
    query?: Query;
    headers?: Record<string, string>;
    cookies?: string[];
    body?: Uint8Array | string;
    isBase64?: boolean;
  } = {},
): APIGatewayV2HTTPRequest {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);
  const queryStringParameters = firstQueryValues(options.query);

  const out: APIGatewayV2HTTPRequest = {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    cookies: Array.isArray(options.cookies) ? [...options.cookies] : [],
    headers: { ...(options.headers ?? {}) },
    requestContext: {
      http: {
        method: normalizedMethod,
        path: rawPath,
      },
    },
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
  if (queryStringParameters) {
    out.queryStringParameters = queryStringParameters;
  }
  return out;
}

export function buildLambdaFunctionURLRequest(
  method: string,
  path: string,
  options: {
    query?: Query;
    headers?: Record<string, string>;
    cookies?: string[];
    body?: Uint8Array | string;
    isBase64?: boolean;
  } = {},
): LambdaFunctionURLRequest {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);
  const queryStringParameters = firstQueryValues(options.query);

  const out: LambdaFunctionURLRequest = {
    version: "2.0",
    rawPath,
    rawQueryString,
    cookies: Array.isArray(options.cookies) ? [...options.cookies] : [],
    headers: { ...(options.headers ?? {}) },
    requestContext: {
      http: {
        method: normalizedMethod,
        path: rawPath,
      },
    },
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
  if (queryStringParameters) {
    out.queryStringParameters = queryStringParameters;
  }
  return out;
}

export function buildALBTargetGroupRequest(
  method: string,
  path: string,
  options: {
    query?: Query;
    headers?: Record<string, string>;
    multiHeaders?: Headers;
    body?: Uint8Array | string;
    isBase64?: boolean;
    targetGroupArn?: string;
  } = {},
): ALBTargetGroupRequest {
  const normalizedMethod = normalizeMethod(method);
  const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);

  let query: Query = {};
  if (options.query && Object.keys(options.query).length > 0) {
    query = cloneQuery(options.query);
  } else if (rawQueryString) {
    query = parseRawQueryString(rawQueryString);
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const multiValueHeaders: Headers = {};
  for (const [key, values] of Object.entries(options.multiHeaders ?? {})) {
    multiValueHeaders[key] = Array.isArray(values)
      ? values.map((v) => String(v))
      : [];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key in multiValueHeaders) continue;
    multiValueHeaders[key] = [String(value)];
  }
  for (const [key, values] of Object.entries(multiValueHeaders)) {
    if (key in headers) continue;
    if (Array.isArray(values) && values.length > 0) {
      headers[key] = String(values[0]);
    }
  }

  const bodyBytes = toBuffer(options.body);
  const isBase64Encoded = Boolean(options.isBase64);

  const out: ALBTargetGroupRequest = {
    httpMethod: normalizedMethod,
    path: rawPath,
    headers,
    requestContext: {
      elb: {
        targetGroupArn: String(
          options.targetGroupArn ??
            "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000",
        ),
      },
    },
    body: isBase64Encoded
      ? bodyBytes.toString("base64")
      : bodyBytes.toString("utf8"),
    isBase64Encoded,
  };
  const queryStringParameters = firstQueryValues(query);
  if (queryStringParameters) {
    out.queryStringParameters = queryStringParameters;
  }
  if (Object.keys(query).length > 0) {
    out.multiValueQueryStringParameters = cloneQuery(query);
  }
  if (Object.keys(multiValueHeaders).length > 0) {
    out.multiValueHeaders = multiValueHeaders;
  }
  return out;
}

export function buildSQSEvent(
  queueArn: string,
  records: Array<Partial<SQSMessage>> = [],
): SQSEvent {
  const arn = String(queueArn ?? "").trim();
  return {
    Records: records.map((r, idx) => ({
      messageId: String(r?.messageId ?? `msg-${idx + 1}`),
      receiptHandle: String(
        (r as Record<string, unknown>)["receiptHandle"] ?? "",
      ),
      body: String(r?.body ?? ""),
      attributes: (r as Record<string, unknown>)["attributes"] ?? {},
      messageAttributes:
        (r as Record<string, unknown>)["messageAttributes"] ?? {},
      md5OfBody: String((r as Record<string, unknown>)["md5OfBody"] ?? ""),
      eventSource: "aws:sqs",
      eventSourceARN: String(r?.eventSourceARN ?? arn),
      awsRegion: String(
        (r as Record<string, unknown>)["awsRegion"] ?? "us-east-1",
      ),
    })),
  };
}

export function buildEventBridgeEvent(
  options: {
    ruleArn?: string;
    resources?: string[];
    version?: string;
    id?: string;
    source?: string;
    detailType?: string;
    account?: string;
    time?: string;
    region?: string;
    detail?: unknown;
  } = {},
): EventBridgeEvent {
  const ruleArn = String(options.ruleArn ?? "").trim();
  const resources = Array.isArray(options.resources)
    ? [...options.resources]
    : [];
  if (ruleArn) resources.push(ruleArn);

  return {
    version: String(options.version ?? "0"),
    id: String(options.id ?? "evt-1"),
    "detail-type": String(options.detailType ?? "Scheduled Event"),
    source: String(options.source ?? "aws.events"),
    account: String(options.account ?? "000000000000"),
    time: String(options.time ?? "1970-01-01T00:00:00Z"),
    region: String(options.region ?? "us-east-1"),
    resources,
    detail: options.detail ?? {},
  };
}

export function buildDynamoDBStreamEvent(
  streamArn: string,
  records: Array<Partial<DynamoDBStreamRecord>> = [],
): DynamoDBStreamEvent {
  const arn = String(streamArn ?? "").trim();
  return {
    Records: records.map((r, idx) => ({
      eventID: String(r?.eventID ?? `evt-${idx + 1}`),
      eventName: String(r?.eventName ?? "MODIFY"),
      eventVersion: String(
        (r as Record<string, unknown>)["eventVersion"] ?? "1.1",
      ),
      eventSource: "aws:dynamodb",
      awsRegion: String(
        (r as Record<string, unknown>)["awsRegion"] ?? "us-east-1",
      ),
      dynamodb:
        r?.dynamodb ??
        ({
          SequenceNumber: String(idx + 1),
          SizeBytes: 1,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        } as unknown),
      eventSourceARN: String(r?.eventSourceARN ?? arn),
    })),
  };
}

export function buildKinesisEvent(
  streamArn: string,
  records: Array<KinesisEventRecordInput> = [],
): KinesisEvent {
  const arn = String(streamArn ?? "").trim();
  return {
    Records: records.map((r, idx) => {
      const data = r?.kinesis?.data ?? r?.data ?? "";
      let dataB64 = "";
      if (typeof data === "string") {
        dataB64 = data;
      } else {
        const buf = Buffer.from(data ?? []);
        if (buf.length > 0) {
          dataB64 = buf.toString("base64");
        }
      }
      return {
        eventID: String(r?.eventID ?? `kin-${idx + 1}`),
        eventName: String(r?.eventName ?? "aws:kinesis:record"),
        eventSource: "aws:kinesis",
        eventSourceARN: String(r?.eventSourceARN ?? arn),
        eventVersion: String(r?.eventVersion ?? "1.0"),
        awsRegion: String(r?.awsRegion ?? "us-east-1"),
        invokeIdentityArn: String(r?.invokeIdentityArn ?? ""),
        kinesis: {
          data: dataB64,
          partitionKey: String(
            r?.kinesis?.partitionKey ?? r?.partitionKey ?? `pk-${idx + 1}`,
          ),
          sequenceNumber: String(
            r?.kinesis?.sequenceNumber ?? r?.sequenceNumber ?? String(idx + 1),
          ),
          kinesisSchemaVersion: String(
            r?.kinesis?.kinesisSchemaVersion ?? "1.0",
          ),
        },
      };
    }),
  };
}

export function buildSNSEvent(
  topicArn: string,
  records: Array<SNSEventRecordInput> = [],
): SNSEvent {
  const arn = String(topicArn ?? "").trim();
  return {
    Records: records.map((r, idx) => {
      const sns = r.Sns ?? r.sns;
      return {
        EventSource: "aws:sns",
        EventVersion: String(r.EventVersion ?? r.eventVersion ?? "1.0"),
        EventSubscriptionArn: String(
          r.EventSubscriptionArn ?? r.eventSubscriptionArn ?? "",
        ),
        Sns: {
          MessageId: String(sns?.MessageId ?? r.messageId ?? `sns-${idx + 1}`),
          TopicArn: String(sns?.TopicArn ?? r.topicArn ?? arn),
          Subject: String(sns?.Subject ?? r.subject ?? ""),
          Message: String(sns?.Message ?? r.message ?? ""),
          Timestamp: String(sns?.Timestamp ?? "1970-01-01T00:00:00Z"),
        },
      };
    }),
  };
}

export function stepFunctionsTaskToken(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;

  const direct = (key: string): string => {
    const value = record[key];
    return typeof value === "string" ? value.trim() : "";
  };

  return direct("taskToken") || direct("TaskToken") || direct("task_token");
}

export function buildStepFunctionsTaskTokenEvent(
  taskToken: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      out[key] = value;
    }
  }
  out["taskToken"] = String(taskToken ?? "").trim();
  return out;
}
