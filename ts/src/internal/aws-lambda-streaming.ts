import { Buffer } from "node:buffer";

import type { LambdaFunctionURLRequest } from "../aws-types.js";
import { AppError } from "../errors.js";
import type { Request, Response } from "../types.js";

import { requestFromLambdaFunctionURL } from "./aws-http.js";
import { firstHeaderValue } from "./http.js";
import { responseForError, responseForErrorWithRequestId } from "./response.js";

type LambdaResponseMeta = {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
};

type HttpResponseStreamConstructorLike = {
  from: (
    responseStream: HttpResponseStreamLike,
    meta: LambdaResponseMeta,
  ) => HttpResponseStreamLike;
};

export type HttpResponseStreamLike = {
  init?: (meta: LambdaResponseMeta) => void;
  write: (chunk: Uint8Array) => unknown;
  end: (chunk?: Uint8Array) => unknown;
};

type AppLike = {
  serve: (request: Request, ctx?: unknown) => Promise<Response>;
};

function lambdaFunctionURLSingleHeaders(
  headers: Record<string, string[]> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(headers ?? {})) {
    if (!values || values.length === 0) continue;
    out[key] = values.map((v) => String(v)).join(",");
  }
  return out;
}

function httpResponseStreamFrom(
  responseStream: HttpResponseStreamLike,
  meta: LambdaResponseMeta,
): HttpResponseStreamLike {
  const aws = (globalThis as unknown as { awslambda?: unknown }).awslambda;
  const HttpResponseStream = (
    aws && typeof aws === "object" && "HttpResponseStream" in aws
      ? (aws as { HttpResponseStream?: unknown }).HttpResponseStream
      : null
  ) as unknown;

  if (
    HttpResponseStream &&
    typeof (HttpResponseStream as HttpResponseStreamConstructorLike).from ===
      "function"
  ) {
    return (HttpResponseStream as HttpResponseStreamConstructorLike).from(
      responseStream,
      meta,
    );
  }

  if (typeof responseStream.init === "function") {
    responseStream.init(meta);
    return responseStream;
  }

  return responseStream;
}

function streamErrorCodeForError(err: unknown): string {
  if (!err) return "";
  if (err instanceof AppError && String(err.code ?? "").trim()) {
    return String(err.code).trim();
  }
  return "app.internal";
}

async function writeStreamedLambdaFunctionURLResponse(
  responseStream: HttpResponseStreamLike,
  resp: Response,
): Promise<string> {
  if (resp.isBase64) {
    throw new TypeError("apptheory: cannot stream isBase64 responses");
  }

  const headers = lambdaFunctionURLSingleHeaders(resp.headers);
  const cookies = Array.isArray(resp.cookies) ? [...resp.cookies] : [];

  const prefix = Buffer.from(resp.body ?? []);
  const stream = resp.bodyStream;

  const meta: LambdaResponseMeta = {
    statusCode: Number(resp.status ?? 200),
    headers,
    cookies,
  };

  let firstChunk: Buffer | null = null;
  let iterator: AsyncIterator<Uint8Array> | null = null;

  if (prefix.length > 0) {
    firstChunk = prefix;
  } else if (stream) {
    iterator = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (!first.done) {
        firstChunk = Buffer.from(first.value ?? []);
      }
    } catch (err) {
      const requestId = firstHeaderValue(resp.headers ?? {}, "x-request-id");
      const early = responseForErrorWithRequestId(err, requestId);
      const earlyMeta: LambdaResponseMeta = {
        statusCode: Number(early.status ?? 200),
        headers: lambdaFunctionURLSingleHeaders(early.headers),
        cookies: Array.isArray(early.cookies) ? [...early.cookies] : [],
      };

      const out = httpResponseStreamFrom(responseStream, earlyMeta);
      const bodyBytes = Buffer.from(early.body ?? []);
      if (bodyBytes.length > 0) out.write(bodyBytes);
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
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          out.write(Buffer.from(chunk ?? []));
        }
      } else {
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          out.write(Buffer.from(chunk ?? []));
        }
      }
    }
  } catch (err) {
    streamErrorCode = streamErrorCodeForError(err);
  } finally {
    out.end();
  }

  return streamErrorCode;
}

export async function serveLambdaFunctionURLStreaming(
  app: AppLike,
  event: LambdaFunctionURLRequest,
  responseStream: HttpResponseStreamLike,
  ctx?: unknown,
): Promise<string> {
  let request: Request;
  try {
    request = requestFromLambdaFunctionURL(event);
  } catch (err) {
    const resp = responseForError(err);
    return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
  }

  const resp = await app.serve(request, ctx);
  return await writeStreamedLambdaFunctionURLResponse(responseStream, resp);
}

export class CapturedHttpResponseStream implements HttpResponseStreamLike {
  statusCode = 0;
  headers: Record<string, string> = {};
  cookies: string[] = [];
  chunks: Buffer[] = [];
  ended = false;

  init(meta: LambdaResponseMeta): void {
    this.statusCode = Number(meta.statusCode ?? 0);
    this.headers = { ...(meta.headers ?? {}) };
    this.cookies = Array.isArray(meta.cookies)
      ? meta.cookies.map((c) => String(c))
      : [];
  }

  write(chunk: Uint8Array): true {
    this.chunks.push(Buffer.from(chunk ?? []));
    return true;
  }

  end(chunk?: Uint8Array): void {
    if (chunk !== null && chunk !== undefined) {
      this.write(chunk);
    }
    this.ended = true;
  }
}
