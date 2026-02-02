import { Buffer } from "node:buffer";
import { createApp } from "./app.js";
import { ManualClock } from "./clock.js";
import { AppError, AppTheoryError } from "./errors.js";
import { ManualIdGenerator } from "./ids.js";
import { CapturedHttpResponseStream, serveLambdaFunctionURLStreaming, } from "./internal/aws-lambda-streaming.js";
import { cloneQuery, firstQueryValues, normalizeMethod, parseRawQueryString, splitPathAndQuery, toBuffer, } from "./internal/http.js";
function streamErrorCodeFrom(err) {
    if (err instanceof AppTheoryError) {
        const code = String(err.code ?? "");
        return code || "app.internal";
    }
    if (err instanceof AppError) {
        const code = String(err.code ?? "");
        return code || "app.internal";
    }
    return "app.internal";
}
export class TestEnv {
    clock;
    ids;
    constructor(options = {}) {
        this.clock = new ManualClock(options.now ?? new Date(0));
        this.ids = new ManualIdGenerator();
    }
    app(options = {}) {
        return createApp({ clock: this.clock, ids: this.ids, ...(options ?? {}) });
    }
    invoke(app, request, ctx) {
        return app.serve(request, ctx);
    }
    async invokeStreaming(app, request, ctx) {
        const resp = await app.serve(request, ctx);
        const headers = {};
        for (const [key, values] of Object.entries(resp.headers ?? {})) {
            headers[key] = Array.isArray(values)
                ? values.map((v) => String(v))
                : [String(values)];
        }
        const cookies = Array.isArray(resp.cookies)
            ? resp.cookies.map((c) => String(c))
            : [];
        const chunks = [];
        const buffers = [];
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
            }
            catch (err) {
                streamErrorCode = streamErrorCodeFrom(err);
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
    invokeAPIGatewayV2(app, event, ctx) {
        return app.serveAPIGatewayV2(event, ctx);
    }
    invokeLambdaFunctionURL(app, event, ctx) {
        return app.serveLambdaFunctionURL(event, ctx);
    }
    async invokeLambdaFunctionURLStreaming(app, event, ctx) {
        const stream = new CapturedHttpResponseStream();
        const streamErrorCode = await serveLambdaFunctionURLStreaming(app, event, stream, ctx);
        const headers = {};
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
    invokeAPIGatewayProxy(app, event, ctx) {
        return app.serveAPIGatewayProxy(event, ctx);
    }
    invokeALB(app, event, ctx) {
        return app.serveALB(event, ctx);
    }
    invokeSQS(app, event, ctx) {
        return app.serveSQSEvent(event, ctx);
    }
    invokeEventBridge(app, event, ctx) {
        return app.serveEventBridge(event, ctx);
    }
    invokeDynamoDBStream(app, event, ctx) {
        return app.serveDynamoDBStream(event, ctx);
    }
    invokeKinesis(app, event, ctx) {
        return app.serveKinesisEvent(event, ctx);
    }
    invokeSNS(app, event, ctx) {
        return app.serveSNSEvent(event, ctx);
    }
    invokeLambda(app, event, ctx) {
        return app.handleLambda(event, ctx);
    }
}
export function createTestEnv(options = {}) {
    return new TestEnv(options);
}
export function buildAPIGatewayV2Request(method, path, options = {}) {
    const normalizedMethod = normalizeMethod(method);
    const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
    const bodyBytes = toBuffer(options.body);
    const isBase64Encoded = Boolean(options.isBase64);
    const queryStringParameters = firstQueryValues(options.query);
    const out = {
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
export function buildLambdaFunctionURLRequest(method, path, options = {}) {
    const normalizedMethod = normalizeMethod(method);
    const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
    const bodyBytes = toBuffer(options.body);
    const isBase64Encoded = Boolean(options.isBase64);
    const queryStringParameters = firstQueryValues(options.query);
    const out = {
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
export function buildALBTargetGroupRequest(method, path, options = {}) {
    const normalizedMethod = normalizeMethod(method);
    const { rawPath, rawQueryString } = splitPathAndQuery(path, options.query);
    let query = {};
    if (options.query && Object.keys(options.query).length > 0) {
        query = cloneQuery(options.query);
    }
    else if (rawQueryString) {
        query = parseRawQueryString(rawQueryString);
    }
    const headers = { ...(options.headers ?? {}) };
    const multiValueHeaders = {};
    for (const [key, values] of Object.entries(options.multiHeaders ?? {})) {
        multiValueHeaders[key] = Array.isArray(values)
            ? values.map((v) => String(v))
            : [];
    }
    for (const [key, value] of Object.entries(headers)) {
        if (key in multiValueHeaders)
            continue;
        multiValueHeaders[key] = [String(value)];
    }
    for (const [key, values] of Object.entries(multiValueHeaders)) {
        if (key in headers)
            continue;
        if (Array.isArray(values) && values.length > 0) {
            headers[key] = String(values[0]);
        }
    }
    const bodyBytes = toBuffer(options.body);
    const isBase64Encoded = Boolean(options.isBase64);
    const out = {
        httpMethod: normalizedMethod,
        path: rawPath,
        headers,
        requestContext: {
            elb: {
                targetGroupArn: String(options.targetGroupArn ??
                    "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000"),
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
export function buildSQSEvent(queueArn, records = []) {
    const arn = String(queueArn ?? "").trim();
    return {
        Records: records.map((r, idx) => ({
            messageId: String(r?.messageId ?? `msg-${idx + 1}`),
            receiptHandle: String(r["receiptHandle"] ?? ""),
            body: String(r?.body ?? ""),
            attributes: r["attributes"] ?? {},
            messageAttributes: r["messageAttributes"] ?? {},
            md5OfBody: String(r["md5OfBody"] ?? ""),
            eventSource: "aws:sqs",
            eventSourceARN: String(r?.eventSourceARN ?? arn),
            awsRegion: String(r["awsRegion"] ?? "us-east-1"),
        })),
    };
}
export function buildEventBridgeEvent(options = {}) {
    const ruleArn = String(options.ruleArn ?? "").trim();
    const resources = Array.isArray(options.resources)
        ? [...options.resources]
        : [];
    if (ruleArn)
        resources.push(ruleArn);
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
export function buildDynamoDBStreamEvent(streamArn, records = []) {
    const arn = String(streamArn ?? "").trim();
    return {
        Records: records.map((r, idx) => ({
            eventID: String(r?.eventID ?? `evt-${idx + 1}`),
            eventName: String(r?.eventName ?? "MODIFY"),
            eventVersion: String(r["eventVersion"] ?? "1.1"),
            eventSource: "aws:dynamodb",
            awsRegion: String(r["awsRegion"] ?? "us-east-1"),
            dynamodb: r?.dynamodb ??
                {
                    SequenceNumber: String(idx + 1),
                    SizeBytes: 1,
                    StreamViewType: "NEW_AND_OLD_IMAGES",
                },
            eventSourceARN: String(r?.eventSourceARN ?? arn),
        })),
    };
}
export function buildKinesisEvent(streamArn, records = []) {
    const arn = String(streamArn ?? "").trim();
    return {
        Records: records.map((r, idx) => {
            const data = r?.kinesis?.data ?? r?.data ?? "";
            let dataB64 = "";
            if (typeof data === "string") {
                dataB64 = data;
            }
            else {
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
                    partitionKey: String(r?.kinesis?.partitionKey ?? r?.partitionKey ?? `pk-${idx + 1}`),
                    sequenceNumber: String(r?.kinesis?.sequenceNumber ?? r?.sequenceNumber ?? String(idx + 1)),
                    kinesisSchemaVersion: String(r?.kinesis?.kinesisSchemaVersion ?? "1.0"),
                },
            };
        }),
    };
}
export function buildSNSEvent(topicArn, records = []) {
    const arn = String(topicArn ?? "").trim();
    return {
        Records: records.map((r, idx) => {
            const sns = r.Sns ?? r.sns;
            return {
                EventSource: "aws:sns",
                EventVersion: String(r.EventVersion ?? r.eventVersion ?? "1.0"),
                EventSubscriptionArn: String(r.EventSubscriptionArn ?? r.eventSubscriptionArn ?? ""),
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
export function stepFunctionsTaskToken(event) {
    if (!event || typeof event !== "object")
        return "";
    const record = event;
    const direct = (key) => {
        const value = record[key];
        return typeof value === "string" ? value.trim() : "";
    };
    return direct("taskToken") || direct("TaskToken") || direct("task_token");
}
export function buildStepFunctionsTaskTokenEvent(taskToken, payload = {}) {
    const out = {};
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        for (const [key, value] of Object.entries(payload)) {
            out[key] = value;
        }
    }
    out["taskToken"] = String(taskToken ?? "").trim();
    return out;
}
