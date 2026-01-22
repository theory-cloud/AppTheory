import { STATUS_CODES } from "node:http";
import { headersFromSingle, parseRawQueryString, queryFromSingle, toBuffer, } from "./http.js";
import { normalizeRequest } from "./request.js";
import { normalizeResponse } from "./response.js";
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
function requestFromAPIGatewayProxyLike(event) {
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
        path: String(event.path ?? rcPath ?? "/"),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
    };
}
export function requestFromAPIGatewayProxy(event) {
    return requestFromAPIGatewayProxyLike(event);
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
        path: String(event.rawPath ?? event.requestContext?.http?.path ?? "/"),
        query,
        headers,
        body: toBuffer(String(event.body ?? "")),
        isBase64: Boolean(event.isBase64Encoded),
    };
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
    };
}
export function apigatewayV2ResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    const multiValueHeaders = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = String(values[0]);
        multiValueHeaders[key] = values.map((v) => String(v));
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
        cookies: [...normalized.cookies],
    };
}
export function lambdaFunctionURLResponseFromResponse(resp) {
    const normalized = normalizeResponse(resp);
    const headers = {};
    for (const [key, values] of Object.entries(normalized.headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        headers[key] = values.map((v) => String(v)).join(",");
    }
    const bodyBytes = toBuffer(normalized.body);
    const isBase64Encoded = Boolean(normalized.isBase64);
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
