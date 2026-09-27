import { STATUS_CODES } from "node:http";
import { AppError } from "../errors.js";
import { headersFromSingle, normalizePath, parseRawQueryString, queryFromSingle, toBuffer, } from "./http.js";
import { normalizeRequest } from "./request.js";
import { errorResponse, normalizeResponse, } from "./response.js";
import { sourceProvenanceFromProviderRequestContext } from "./source-provenance.js";
// APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES bounds how many bytes of a streaming
// response body the buffered HTTP API v2 / Function URL adapters drain before
// failing closed. HTTP API v2 (payload format 2.0) and the buffered Function
// URL path deliver buffered responses only, so the adapters drain terminating
// streams into the buffered body up to this budget instead of silently
// dropping them.
const APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES = 4 * 1024 * 1024;
// APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS bounds how long the buffered
// adapters wait for a streaming response body to terminate before failing
// closed. A never-terminating stream (for example a live SSE session listener)
// must not hold the Lambda until the provider buffering ceiling; failing
// loudly and cheaply lets clients surface the transport mismatch instead of
// spinning on an empty 200.
const APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS = 5000;
// APIGATEWAY_V2_STREAMING_BODY_ERROR_MESSAGE is the documented client-visible
// error for a streaming response body the HTTP API v2 adapter cannot deliver
// for a non-size reason (it did not terminate within the budget, or the stream
// errored). It is returned as HTTP 500 with the nested AppTheory error body. A
// body that merely exceeds the byte budget maps to 413 (app.too_large) instead,
// matching the framework's size semantics.
const APIGATEWAY_V2_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the HTTP API v2 adapter";
// LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE is the documented
// client-visible error for a streaming response body the buffered Lambda
// Function URL adapter cannot deliver for a non-size reason. It is returned as
// HTTP 500 with the nested AppTheory error body, matching the HTTP API v2
// fail-closed shape with the adapter named in the message. A body that merely
// exceeds the byte budget maps to 413 (app.too_large) instead.
const LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the Function URL adapter";
// APIGATEWAY_PROXY_STREAMING_BODY_ERROR_MESSAGE is the documented client-visible
// error for a streaming response body the buffered API Gateway REST v1 adapter
// cannot deliver for a non-size reason. The v1 buffered shape delivers a
// complete body only, so the adapter drains the body under the shared budget and
// fails closed with the adapter named in the message.
const APIGATEWAY_PROXY_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the API Gateway REST v1 adapter";
// ALB_TARGET_GROUP_STREAMING_BODY_ERROR_MESSAGE is the documented client-visible
// error for a streaming response body the buffered ALB target group adapter
// cannot deliver for a non-size reason. ALB delivers buffered responses only, so
// the adapter drains the body under the shared budget and fails closed with the
// adapter named in the message.
const ALB_TARGET_GROUP_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the ALB target group adapter";
class StreamingBodyBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "StreamingBodyBudgetError";
    }
}
// StreamingBodyTooLargeError marks a drain failure caused by a size violation
// (the streaming body exceeded a byte budget) rather than a delivery failure
// (non-termination or a stream error). Size violations map to 413
// (app.too_large) per the framework's size semantics; delivery failures keep
// the documented 500 fail-closed shape.
class StreamingBodyTooLargeError extends StreamingBodyBudgetError {
    constructor() {
        super("streaming body exceeds the adapter budget");
        this.name = "StreamingBodyTooLargeError";
    }
}
// isStreamingBodySizeError reports whether a drain failure is a size violation
// rather than a delivery failure. Both the adapter's own byte budget
// (StreamingBodyTooLargeError) and the framework's MaxResponseBytes limiter
// (an AppError with code app.too_large) are size errors and must map to 413.
function isStreamingBodySizeError(err) {
    if (err instanceof StreamingBodyTooLargeError)
        return true;
    if (err instanceof AppError && err.code === "app.too_large")
        return true;
    return false;
}
export function requestFromWebSocketEvent(event) {
    const headers = {};
    for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
        headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
    }
    for (const [key, value] of Object.entries(event.headers ?? {})) {
        if (headers[key])
            continue;
        headers[key] = [String(value)];
    }
    const query = {};
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
        query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
    }
    for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (query[key])
            continue;
        query[key] = [String(value)];
    }
    return normalizeRequest({
        method: String(event.httpMethod ?? ""),
        path: String(event.path ?? "/"),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
    });
}
function requestFromAPIGatewayProxyLike(event, pathOverride) {
    const headers = {};
    for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
        headers[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
    }
    for (const [key, value] of Object.entries(event.headers ?? {})) {
        if (headers[key])
            continue;
        headers[key] = [String(value)];
    }
    const query = {};
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
        query[key] = Array.isArray(values) ? values.map((v) => String(v)) : [];
    }
    for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (query[key])
            continue;
        query[key] = [String(value)];
    }
    const rc = event.requestContext && typeof event.requestContext === "object"
        ? event.requestContext
        : null;
    const rcMethod = rc && typeof rc["httpMethod"] === "string" ? String(rc["httpMethod"]) : "";
    const rcPath = rc && typeof rc["path"] === "string" ? String(rc["path"]) : "/";
    return {
        method: String(event.httpMethod ?? rcMethod ?? ""),
        path: String(pathOverride ?? event.path ?? rcPath ?? "/"),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
        sourceProvenance: sourceProvenanceFromProviderRequestContext("apigw-v1", sourceIPFromAPIGatewayProxy(event)),
    };
}
function sourceIPFromAPIGatewayProxy(event) {
    const requestContext = event.requestContext && typeof event.requestContext === "object"
        ? event.requestContext
        : null;
    const identity = requestContext &&
        requestContext["identity"] &&
        typeof requestContext["identity"] === "object"
        ? requestContext["identity"]
        : null;
    return identity?.["sourceIp"];
}
const REMOTE_MCP_APIGW_CANONICAL_RESOURCES = new Set([
    "/mcp",
    "/mcp/{actor}",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp/{actor}",
]);
function trimEdgeSlashes(value) {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === "/") {
        start += 1;
    }
    while (end > start && value[end - 1] === "/") {
        end -= 1;
    }
    return value.slice(start, end);
}
function trimTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }
    return value.slice(0, end);
}
function normalizeAPIGatewayProxyRoutePath(path) {
    const trimmed = trimEdgeSlashes(String(path ?? "").trim());
    if (!trimmed)
        return "/";
    const parts = trimmed
        .split("/")
        .map((part) => part.trim())
        .filter((part) => part);
    if (parts.length === 0)
        return "/";
    return `/${parts.join("/")}`;
}
function apigatewayProxyMatchedResource(event) {
    const resource = normalizeAPIGatewayProxyRoutePath(event.resource);
    if (resource !== "/")
        return resource;
    const rc = event.requestContext && typeof event.requestContext === "object"
        ? event.requestContext
        : null;
    const rcResource = rc && typeof rc["resourcePath"] === "string"
        ? normalizeAPIGatewayProxyRoutePath(rc["resourcePath"])
        : "";
    return rcResource === "/" ? "" : rcResource;
}
function shouldCanonicalizeAPIGatewayProxyRequestPath(event) {
    return REMOTE_MCP_APIGW_CANONICAL_RESOURCES.has(apigatewayProxyMatchedResource(event));
}
function canonicalizeAPIGatewayProxyRequestPath(path) {
    const normalized = normalizePath(path);
    if (normalized === "/")
        return normalized;
    return trimTrailingSlashes(normalized) || "/";
}
export function requestFromAPIGatewayProxy(event) {
    const path = shouldCanonicalizeAPIGatewayProxyRequestPath(event)
        ? canonicalizeAPIGatewayProxyRequestPath(event.path ??
            event.requestContext?.["path"] ??
            "/")
        : undefined;
    return requestFromAPIGatewayProxyLike(event, path);
}
export function requestFromALBTargetGroup(event) {
    return requestFromAPIGatewayProxyLike(event);
}
export function requestFromAPIGatewayV2(event) {
    const cookies = Array.isArray(event.cookies)
        ? event.cookies.map((v) => String(v))
        : [];
    const headers = headersFromSingle(event.headers, cookies.length > 0);
    if (cookies.length > 0) {
        headers["cookie"] = cookies;
    }
    const rawQueryString = String(event.rawQueryString ?? "").replace(/^\?/, "");
    const query = rawQueryString
        ? parseRawQueryString(rawQueryString)
        : queryFromSingle(event.queryStringParameters);
    return {
        method: String(event.requestContext?.http?.method ?? ""),
        path: normalizeAPIGatewayV2StagePath(event.rawPath, event.requestContext?.http?.path, event.requestContext?.stage),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
        sourceProvenance: sourceProvenanceFromProviderRequestContext("apigw-v2", event.requestContext?.http?.sourceIp),
    };
}
function normalizeAPIGatewayV2StagePath(rawPath, requestContextHTTPPath, stageValue) {
    const path = String(rawPath ?? requestContextHTTPPath ?? "/");
    const stage = trimStageSlashes(String(stageValue ?? ""));
    if (!stage || stage === "$default") {
        return path;
    }
    const prefix = `/${stage}`;
    if (path === prefix) {
        return "/";
    }
    if (path.startsWith(`${prefix}/`)) {
        return path.slice(prefix.length);
    }
    return path;
}
function trimStageSlashes(value) {
    const trimmed = value.trim();
    let start = 0;
    let end = trimmed.length;
    while (start < end && trimmed.charCodeAt(start) === 47) {
        start += 1;
    }
    while (end > start && trimmed.charCodeAt(end - 1) === 47) {
        end -= 1;
    }
    return trimmed.slice(start, end);
}
export function requestFromLambdaFunctionURL(event) {
    const cookies = Array.isArray(event.cookies)
        ? event.cookies.map((v) => String(v))
        : [];
    const headers = headersFromSingle(event.headers, cookies.length > 0);
    if (cookies.length > 0) {
        headers["cookie"] = cookies;
    }
    const rawQueryString = String(event.rawQueryString ?? "").replace(/^\?/, "");
    const query = rawQueryString
        ? parseRawQueryString(rawQueryString)
        : queryFromSingle(event.queryStringParameters);
    return {
        method: String(event.requestContext?.http?.method ?? ""),
        path: String(event.rawPath ?? event.requestContext?.http?.path ?? "/"),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
        sourceProvenance: sourceProvenanceFromProviderRequestContext("lambda-url", event.requestContext?.http?.sourceIp),
    };
}
// unblockStreamingBody unblocks a pending async read so the drain can exit, and
// waits for the producer to unwind before returning. Waiting is unconditional:
// there is no grace window, because a producer the runtime started must not be
// running once the adapter returns. In Lambda the execution environment is
// frozen once the handler returns, so an abandoned producer resumes at an
// unpredictable time (or never); a producer that cannot be interrupted is
// bounded by the Lambda function timeout instead of being abandoned here.
//
// It is the TS-idiomatic counterpart of the Go adapter closing a body reader: a
// Node.js Readable is destroyed (and its close promise awaited); an async
// generator object is asked to unwind through iterator.return().
async function unblockStreamingBody(bodyStream) {
    const unblockable = bodyStream;
    if (unblockable === null || unblockable === undefined)
        return;
    if (typeof unblockable.destroy === "function") {
        try {
            unblockable.destroy();
        }
        catch {
            // fall through to iterator.return()
        }
        const closed = unblockable.closed;
        if (closed && typeof closed.then === "function") {
            await closed.catch(() => undefined);
            return;
        }
    }
    if (typeof unblockable.return === "function") {
        try {
            const result = unblockable.return();
            if (result && typeof result.then === "function") {
                await result.catch(() => undefined);
            }
        }
        catch {
            // best-effort unblock
        }
    }
}
// withDeadline races a pending promise against a timer, rejecting with a
// StreamingBodyBudgetError when the deadline fires first. The raced promise
// keeps its settled handlers, so a late resolution is dropped without an
// unhandled rejection; the timer is cleared as soon as either side wins.
function withDeadline(promise, ms) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new StreamingBodyBudgetError("streaming body deadline exceeded"));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
// drainStreamingBodyForBufferedAdapter drains a terminating async streaming
// body into a single buffer under a bounded byte and time budget, throwing
// StreamingBodyBudgetError when the stream does not terminate in time,
// exceeds the byte budget, or reports an error. The empty-EOF-at-deadline
// guard (a stream that closed with no bytes at/after the deadline) makes the
// fail-closed deterministic against the handler-unwind race.
async function drainStreamingBodyForBufferedAdapter(bodyStream, maxBytes, timeoutMs) {
    const iterator = bodyStream[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;
    const chunks = [];
    let total = 0;
    for (;;) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            await unblockStreamingBody(bodyStream);
            throw new StreamingBodyBudgetError("streaming body did not terminate within the adapter budget");
        }
        const pending = iterator.next();
        let next;
        try {
            next = await withDeadline(pending, remainingMs);
        }
        catch (err) {
            if (err instanceof StreamingBodyBudgetError) {
                // The deadline won while this read was still pending. Unblock the
                // producer and wait for the abandoned read to settle before failing
                // closed, so the drain cannot return while a producer it started is
                // still running. The read's own outcome is dropped: the budget error is
                // what the adapter reports.
                await unblockStreamingBody(bodyStream);
                await pending.then(() => undefined, () => undefined);
            }
            throw err;
        }
        if (next.done) {
            if (total === 0 && Date.now() >= deadline) {
                await unblockStreamingBody(bodyStream);
                throw new StreamingBodyBudgetError("streaming body did not terminate within the adapter budget");
            }
            return Buffer.concat(chunks);
        }
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) {
            await unblockStreamingBody(bodyStream);
            throw new StreamingBodyTooLargeError();
        }
        chunks.push(chunk);
    }
}
function streamingBodyErrorResponse(message) {
    const normalized = errorResponse("app.internal", message);
    return {
        status: normalized.status,
        headers: normalized.headers,
        cookies: normalized.cookies,
        body: normalized.body,
    };
}
// streamingBodySizeErrorResponse builds the size-semantics denial shape for a
// streaming body that exceeded a byte budget: HTTP 413 with the framework's
// app.too_large error body, matching what MaxResponseBytes overruns produce on
// the portable path. Delivery failures (non-termination, stream errors) keep
// the documented 500 fail-closed shape instead.
function streamingBodySizeErrorResponse() {
    const normalized = errorResponse("app.too_large", "response too large");
    return {
        status: normalized.status,
        headers: normalized.headers,
        cookies: normalized.cookies,
        body: normalized.body,
    };
}
export async function apigatewayV2ResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    const multiValueHeaders = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = String(values[0]);
        multiValueHeaders[key] = values.map((v) => String(v));
    }
    const drained = await bufferedAdapterBody(normalized, APIGATEWAY_V2_STREAMING_BODY_ERROR_MESSAGE, singleValueHeaders);
    if (!drained.ok) {
        return {
            statusCode: drained.status,
            headers: drained.headers,
            multiValueHeaders: {},
            body: drained.body.toString("utf8"),
            isBase64Encoded: false,
            cookies: [...drained.cookies],
        };
    }
    return {
        statusCode: normalized.status,
        headers,
        multiValueHeaders,
        body: normalized.isBase64
            ? drained.body.toString("base64")
            : drained.body.toString("utf8"),
        isBase64Encoded: Boolean(normalized.isBase64),
        cookies: [...normalized.cookies],
    };
}
export async function lambdaFunctionURLResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = joinedValueHeaders(normalized.headers);
    const drained = await bufferedAdapterBody(normalized, LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE, joinedValueHeaders);
    if (!drained.ok) {
        return {
            statusCode: drained.status,
            headers: drained.headers,
            body: drained.body.toString("utf8"),
            isBase64Encoded: false,
            cookies: [...drained.cookies],
        };
    }
    return {
        statusCode: normalized.status,
        headers,
        body: normalized.isBase64
            ? drained.body.toString("base64")
            : drained.body.toString("utf8"),
        isBase64Encoded: Boolean(normalized.isBase64),
        cookies: [...normalized.cookies],
    };
}
// bufferedAdapterBody drains a streaming response body into the buffered body
// under the shared adapter budget.
//
// Every buffered adapter routes through this, so the ALB target group, the
// buffered API Gateway REST v1 and the WebSocket shapes get the same drain,
// unblock and join as the HTTP API v2 and Function URL shapes. An adapter that
// dropped a streaming body instead would return while a producer the invocation
// had started was still running. ok=false is the fail-closed outcome: the
// headers and cookies are the error response's own, not the drained response's.
async function bufferedAdapterBody(resp, errorMessage, headerBuilder) {
    if (!resp.bodyStream) {
        return {
            ok: true,
            status: resp.status,
            headers: {},
            cookies: [],
            body: toBuffer(resp.body),
        };
    }
    try {
        const body = await drainStreamingBodyForBufferedAdapter(resp.bodyStream, APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES, APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS);
        return { ok: true, status: resp.status, headers: {}, cookies: [], body };
    }
    catch (err) {
        const error = isStreamingBodySizeError(err)
            ? streamingBodySizeErrorResponse()
            : streamingBodyErrorResponse(errorMessage);
        return {
            ok: false,
            status: error.status,
            headers: headerBuilder(error.headers),
            cookies: [...error.cookies],
            body: error.body,
        };
    }
}
export async function apigatewayProxyResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    const multiValueHeaders = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = String(values[0]);
        multiValueHeaders[key] = values.map((v) => String(v));
    }
    if (normalized.cookies.length > 0) {
        headers["set-cookie"] = String(normalized.cookies[0]);
        multiValueHeaders["set-cookie"] = normalized.cookies.map((v) => String(v));
    }
    const drained = await bufferedAdapterBody(normalized, APIGATEWAY_PROXY_STREAMING_BODY_ERROR_MESSAGE, singleValueHeaders);
    return {
        statusCode: drained.status,
        headers: drained.ok ? { ...headers, ...drained.headers } : drained.headers,
        multiValueHeaders: drained.ok ? multiValueHeaders : {},
        body: normalized.isBase64
            ? drained.body.toString("base64")
            : drained.body.toString("utf8"),
        isBase64Encoded: drained.ok ? Boolean(normalized.isBase64) : false,
    };
}
function singleValueHeaders(headers) {
    const out = {};
    for (const [key, values] of Object.entries(headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        out[key] = String(values[0]);
    }
    return out;
}
function joinedValueHeaders(headers) {
    const out = {};
    for (const [key, values] of Object.entries(headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        out[key] = values.map((v) => String(v)).join(",");
    }
    return out;
}
export async function albTargetGroupResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    const multiValueHeaders = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = String(values[0]);
        multiValueHeaders[key] = values.map((v) => String(v));
    }
    if (normalized.cookies.length > 0) {
        headers["set-cookie"] = String(normalized.cookies[0]);
        multiValueHeaders["set-cookie"] = normalized.cookies.map((v) => String(v));
    }
    const drained = await bufferedAdapterBody(normalized, ALB_TARGET_GROUP_STREAMING_BODY_ERROR_MESSAGE, singleValueHeaders);
    return {
        statusCode: drained.status,
        statusDescription: albStatusDescription(drained.status),
        headers: drained.ok ? { ...headers, ...drained.headers } : drained.headers,
        multiValueHeaders: drained.ok ? multiValueHeaders : {},
        body: normalized.isBase64
            ? drained.body.toString("base64")
            : drained.body.toString("utf8"),
        isBase64Encoded: drained.ok ? Boolean(normalized.isBase64) : false,
    };
}
function albStatusDescription(status) {
    const code = Number(status ?? 0);
    const text = STATUS_CODES[String(code)] ?? "";
    return text ? `${code} ${text}` : String(code);
}
//# sourceMappingURL=aws-http.js.map