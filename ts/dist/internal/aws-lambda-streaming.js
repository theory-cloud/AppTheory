import { Buffer } from "node:buffer";
import { AppError, AppTheoryError } from "../errors.js";
import { HTTP_ERROR_FORMAT_NESTED, normalizeHTTPErrorFormat, } from "../http-error-format.js";
import { requestFromLambdaFunctionURL } from "./aws-http.js";
import { firstHeaderValue } from "./http.js";
import { responseForErrorWithFormat, responseForErrorWithRequestIdAndFormat, } from "./response.js";
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
async function writeStreamedLambdaFunctionURLResponse(responseStream, resp, httpErrorFormat) {
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
            const early = responseForErrorWithRequestIdAndFormat(httpErrorFormat, err, requestId);
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
    try {
        if (firstChunk && firstChunk.length > 0) {
            out.write(firstChunk);
        }
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
        // The prefetched first chunk is written before the loop starts, so a
        // transport failure there never enters the for-await and would otherwise
        // leave the generator suspended past the invocation. Unwind it explicitly;
        // a generator the loop already drained ignores the extra return().
        if (iterator) {
            try {
                await iterator.return?.();
            }
            catch {
                // best-effort unwind: the transport is already failing
            }
        }
        out.end();
    }
    return streamErrorCode;
}
export async function serveLambdaFunctionURLStreaming(app, event, responseStream, ctx) {
    const httpErrorFormat = normalizeHTTPErrorFormat(app.getHTTPErrorFormat?.() ?? HTTP_ERROR_FORMAT_NESTED);
    let request;
    try {
        request = requestFromLambdaFunctionURL(event);
    }
    catch (err) {
        const resp = responseForErrorWithFormat(httpErrorFormat, err);
        return await writeStreamedLambdaFunctionURLResponse(responseStream, resp, httpErrorFormat);
    }
    const resp = await app.serve(request, ctx);
    return await writeStreamedLambdaFunctionURLResponse(responseStream, resp, httpErrorFormat);
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
//# sourceMappingURL=aws-lambda-streaming.js.map