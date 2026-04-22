import { Buffer } from "node:buffer";
import { AppError } from "../errors.js";
import { canonicalizeHeaders, cloneQuery, normalizeMethod, normalizePath, parseCookies, toBuffer, } from "./http.js";
function decodedBase64Length(value) {
    if (value.length === 0)
        return 0;
    if (value.length % 4 !== 0)
        return -1;
    if (/[^A-Za-z0-9+/=]/.test(value))
        return -1;
    const firstPad = value.indexOf("=");
    if (firstPad === -1)
        return (value.length / 4) * 3;
    const padLen = value.length - firstPad;
    if (padLen > 2)
        return -1;
    for (let i = firstPad; i < value.length; i += 1) {
        if (value[i] !== "=")
            return -1;
    }
    return (value.length / 4) * 3 - padLen;
}
export function normalizeRequest(request, maxRequestBytes = 0) {
    const method = normalizeMethod(request.method);
    const path = normalizePath(request.path);
    const query = cloneQuery(request.query);
    const headers = canonicalizeHeaders(request.headers);
    const rawBody = toBuffer(request.body);
    const isBase64 = Boolean(request.isBase64);
    let body;
    if (isBase64) {
        const asString = rawBody.toString("utf8");
        const decodedLength = decodedBase64Length(asString);
        if (decodedLength < 0) {
            throw new AppError("app.bad_request", "invalid base64");
        }
        if (maxRequestBytes > 0 && decodedLength > maxRequestBytes) {
            throw new AppError("app.too_large", "request too large");
        }
        body = Buffer.from(asString, "base64");
    }
    else {
        body = rawBody;
    }
    const cookies = parseCookies(headers["cookie"]);
    return { method, path, query, headers, cookies, body, isBase64 };
}
