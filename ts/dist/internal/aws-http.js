import { STATUS_CODES } from "node:http";
import { headersFromSingle, normalizePath, parseRawQueryString, queryFromSingle, toBuffer, } from "./http.js";
import { normalizeRequest } from "./request.js";
import { errorResponse, normalizeResponse } from "./response.js";
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
// error for a streaming response body the HTTP API v2 adapter cannot deliver.
// It is returned as HTTP 500 with the nested AppTheory error body.
const APIGATEWAY_V2_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the HTTP API v2 adapter";
// LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE is the documented
// client-visible error for a streaming response body the buffered Lambda
// Function URL adapter cannot deliver. It is returned as HTTP 500 with the
// nested AppTheory error body, matching the HTTP API v2 fail-closed shape with
// the adapter named in the message.
const LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE = "streaming response body cannot be delivered by the Function URL adapter";
class StreamingBodyBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "StreamingBodyBudgetError";
    }
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
// unblockStreamingBody best-effort unblocks a pending async read so the drain
// can exit instead of lingering until the producer writes or closes. It is the
// TS-idiomatic counterpart of the Go adapter closing only *io.PipeReader:
// a Node.js Readable is destroyed; an async generator object is asked to
// unwind (fire-and-forget). A generator blocked inside a producer await that
// never resolves stays pending, bounded by the Lambda lifecycle.
function unblockStreamingBody(bodyStream) {
    const unblockable = bodyStream;
    if (unblockable === null || unblockable === undefined)
        return;
    if (typeof unblockable.destroy === "function") {
        try {
            unblockable.destroy();
            return;
        }
        catch {
            // fall through to iterator.return()
        }
    }
    if (typeof unblockable.return === "function") {
        try {
            const result = unblockable.return();
            if (result && typeof result.catch === "function") {
                result.catch(() => { });
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
            unblockStreamingBody(bodyStream);
            throw new StreamingBodyBudgetError("streaming body did not terminate within the adapter budget");
        }
        const next = await withDeadline(iterator.next(), remainingMs);
        if (next.done) {
            if (total === 0 && Date.now() >= deadline) {
                unblockStreamingBody(bodyStream);
                throw new StreamingBodyBudgetError("streaming body did not terminate within the adapter budget");
            }
            return Buffer.concat(chunks);
        }
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) {
            unblockStreamingBody(bodyStream);
            throw new StreamingBodyBudgetError("streaming body exceeds the adapter budget");
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
    let bodyBytes = toBuffer(normalized.body);
    const isBase64Encoded = Boolean(normalized.isBase64);
    if (normalized.bodyStream) {
        try {
            bodyBytes = await drainStreamingBodyForBufferedAdapter(normalized.bodyStream, APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES, APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS);
        }
        catch {
            const error = streamingBodyErrorResponse(APIGATEWAY_V2_STREAMING_BODY_ERROR_MESSAGE);
            const errorHeaders = {};
            for (const [key, values] of Object.entries(error.headers ?? {})) {
                if (!values || values.length === 0)
                    continue;
                errorHeaders[key] = String(values[0]);
            }
            return {
                statusCode: error.status,
                headers: errorHeaders,
                multiValueHeaders: {},
                body: error.body.toString("utf8"),
                isBase64Encoded: false,
                cookies: [...error.cookies],
            };
        }
    }
    return {
        statusCode: normalized.status,
        headers,
        multiValueHeaders,
        body: isBase64Encoded
            ? bodyBytes.toString("base64")
            : bodyBytes.toString("utf8"),
        isBase64Encoded,
        cookies: [...normalized.cookies],
    };
}
export async function lambdaFunctionURLResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = values.map((v) => String(v)).join(",");
    }
    let bodyBytes = toBuffer(normalized.body);
    const isBase64Encoded = Boolean(normalized.isBase64);
    if (normalized.bodyStream) {
        try {
            bodyBytes = await drainStreamingBodyForBufferedAdapter(normalized.bodyStream, APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES, APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS);
        }
        catch {
            const error = streamingBodyErrorResponse(LAMBDA_FUNCTION_URL_STREAMING_BODY_ERROR_MESSAGE);
            const errorHeaders = {};
            for (const [key, values] of Object.entries(error.headers ?? {})) {
                if (!values || values.length === 0)
                    continue;
                errorHeaders[key] = values.map((v) => String(v)).join(",");
            }
            return {
                statusCode: error.status,
                headers: errorHeaders,
                body: error.body.toString("utf8"),
                isBase64Encoded: false,
                cookies: [...error.cookies],
            };
        }
    }
    return {
        statusCode: normalized.status,
        headers,
        body: isBase64Encoded
            ? bodyBytes.toString("base64")
            : bodyBytes.toString("utf8"),
        isBase64Encoded,
        cookies: [...normalized.cookies],
    };
}
export function apigatewayProxyResponseFromResponse(resp) {
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
    const bodyBytes = toBuffer(normalized.body);
    const isBase64Encoded = Boolean(normalized.isBase64);
    return {
        statusCode: normalized.status,
        headers,
        multiValueHeaders,
        body: isBase64Encoded
            ? bodyBytes.toString("base64")
            : bodyBytes.toString("utf8"),
        isBase64Encoded,
    };
}
function albStatusDescription(status) {
    const code = Number(status ?? 0);
    const text = STATUS_CODES[String(code)] ?? "";
    return text ? `${code} ${text}` : String(code);
}
export function albTargetGroupResponseFromResponse(resp) {
    const out = apigatewayProxyResponseFromResponse(resp);
    return { ...out, statusDescription: albStatusDescription(out.statusCode) };
}
//# sourceMappingURL=aws-http.js.map