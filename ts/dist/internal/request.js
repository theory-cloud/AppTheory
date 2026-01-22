import { Buffer } from "node:buffer";
import { AppError } from "../errors.js";
import { canonicalizeHeaders, cloneQuery, normalizeMethod, normalizePath, parseCookies, toBuffer, } from "./http.js";
export function normalizeRequest(request) {
    const method = normalizeMethod(request.method);
    const path = normalizePath(request.path);
    const query = cloneQuery(request.query);
    const headers = canonicalizeHeaders(request.headers);
    const rawBody = toBuffer(request.body);
    const isBase64 = Boolean(request.isBase64);
    let body;
    if (isBase64) {
        try {
            body = Buffer.from(rawBody.toString("utf8"), "base64");
        }
        catch {
            throw new AppError("app.bad_request", "invalid base64");
        }
    }
    else {
        body = rawBody;
    }
    const cookies = parseCookies(headers["cookie"]);
    return { method, path, query, headers, cookies, body, isBase64 };
}
