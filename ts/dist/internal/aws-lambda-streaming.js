import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "../errors.js";
import { requestFromLambdaFunctionURL } from "./aws-http.js";
import { firstHeaderValue } from "./http.js";
import { responseForError, responseForErrorWithRequestId } from "./response.js";
function lambdaFunctionURLSingleHeaders(headers) {
    const out = {};
    for (const [key, values] of Object.entries(headers ?? {})) {
        if (!values || values.length === 0)
            continue;
        out[key] = values.map((v) => String(v)).join(",");
    }
    return out;
}
function httpResponseStreamFrom(responseStream, meta) {
    const aws = globalThis.awslambda;
    const HttpResponseStream = (aws && typeof aws === "object" && "HttpResponseStream" in aws
        ? aws.HttpResponseStream
        : null);
    if (HttpResponseStream &&
        typeof HttpResponseStream.from ===
            "function") {
        return HttpResponseStream.from(responseStream, meta);
    }
    if (typeof responseStream.init === "function") {
        responseStream.init(meta);
        return responseStream;
    }
    return responseStream;
}
function streamErrorCodeForError(err) {
    if (!err)
        return "";
    if (err instanceof AppTheoryError && String(err.code ?? "").trim()) {
        return String(err.code).trim();
    }
    if (err instanceof AppError && String(err.code ?? "").trim()) {
        return String(err.code).trim();
    }
    return "app.internal";
}
async function writeStreamedLambdaFunctionURLResponse(responseStream, resp) {
    if (resp.isBase64) {
        throw new TypeError("apptheory: cannot stream isBase64 responses");
    }
    const headers = lambdaFunctionURLSingleHeaders(resp.headers);
    const cookies = Array.isArray(resp.cookies) ? [...resp.cookies] : [];
    const prefix = Buffer.from(resp.body ?? []);
    const stream = resp.bodyStream;
    const meta = {
        statusCode: Number(resp.status ?? 200),
        headers,
        cookies,
    };
    let firstChunk = null;
    let iterator = null;
    if (prefix.length > 0) {
        firstChunk = prefix;
    }
    else if (stream) {
        iterator = stream[Symbol.asyncIterator]();
        try {
            const first = await iterator.next();
            if (!first.done) {
                firstChunk = Buffer.from(first.value ?? []);
            }
        }
        catch (err) {
            const requestId = firstHeaderValue(resp.headers ?? {}, "x-request-id");
            const early = responseForErrorWithRequestId(err, requestId);
            const earlyMeta = {
                statusCode: Number(early.status ?? 200),
                headers: lambdaFunctionURLSingleHeaders(early.headers),
                cookies: Array.isArray(early.cookies) ? [...early.cookies] : [],
            };
            const out = httpResponseStreamFrom(responseStream, earlyMeta);
            const bodyBytes = Buffer.from(early.body ?? []);
            if (bodyBytes.length > 0)
                out.write(bodyBytes);
            out.end();
            return "";
        }
    }
    const out = httpResponseStreamFrom(responseStream, meta);
    let streamErrorCode = "";
    if (firstChunk && firstChunk.length > 0) {
        out.write(firstChunk);
    }
    try {
        if (stream) {
            if (!iterator) {
                for await (const chunk of stream) {
                    out.write(Buffer.from(chunk ?? []));
                }
            }
            else {
                for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
                    out.write(Buffer.from(chunk ?? []));
                }
            }
        }
    }
    catch (err) {
        streamErrorCode = streamErrorCodeForError(err);
    }
    finally {
        out.end();
    }
    return streamErrorCode;
}
export async function serveLambdaFunctionURLStreaming(app, event, responseStream, ctx) {
    let request;
    try {
        request = requestFromLambdaFunctionURL(event);
    }
    catch (err) {
        const resp = responseForError(err);
        return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
    }
    const resp = await app.serve(request, ctx);
    return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
}
export class CapturedHttpResponseStream {
    statusCode = 0;
    headers = {};
    cookies = [];
    chunks = [];
    ended = false;
    init(meta) {
        this.statusCode = Number(meta.statusCode ?? 0);
        this.headers = { ...(meta.headers ?? {}) };
        this.cookies = Array.isArray(meta.cookies)
            ? meta.cookies.map((c) => String(c))
            : [];
    }
    write(chunk) {
        this.chunks.push(Buffer.from(chunk ?? []));
        return true;
    }
    end(chunk) {
        if (chunk !== null && chunk !== undefined) {
            this.write(chunk);
        }
        this.ended = true;
    }
}
