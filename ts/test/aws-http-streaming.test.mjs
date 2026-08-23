import test from "node:test";
import assert from "node:assert/strict";

import { createApp, htmlStream } from "../dist/index.js";

const APIGATEWAY_V2_STREAMING_ERROR_MESSAGE =
  "streaming response body cannot be delivered by the HTTP API v2 adapter";
const LAMBDA_FUNCTION_URL_STREAMING_ERROR_MESSAGE =
  "streaming response body cannot be delivered by the Function URL adapter";

const STREAMING_BODY_MAX_BYTES = 4 * 1024 * 1024;

function sseChunks(...chunks) {
  return (async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk, "utf8");
    }
  })();
}

function liveStream(firstChunk) {
  return (async function* () {
    yield Buffer.from(firstChunk, "utf8");
    // Never resolves, never terminates: a live listener.
    await new Promise(() => {});
  })();
}

function errorStream() {
  return (async function* () {
    yield Buffer.from("data: first\n\n", "utf8");
    throw new Error("stream exploded");
  })();
}

function apigwV2Event(path) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path } },
    body: "",
    isBase64Encoded: false,
  };
}

function lambdaFunctionURLEvent(path) {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path } },
    body: "",
    isBase64Encoded: false,
  };
}

function assertStreamingError(response, message) {
  assert.equal(response.statusCode, 500);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  const body = JSON.parse(response.body);
  assert.deepEqual(body, { error: { code: "app.internal", message } });
}

// assertStreamingTooLarge asserts the size-semantics denial shape: a streaming
// body over the byte budget maps to 413 app.too_large, not the 500
// delivery-failure shape used for non-termination and stream errors.
function assertStreamingTooLarge(response) {
  assert.equal(response.statusCode, 413);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  const body = JSON.parse(response.body);
  assert.deepEqual(body, {
    error: { code: "app.too_large", message: "response too large" },
  });
}

test("apigateway v2 adapter delivers a terminating streaming body as buffered content", async () => {
  const app = createApp();
  app.get("/sse", () =>
    htmlStream(200, sseChunks("data: first\n\n", "data: second\n\n")),
  );

  const out = await app.serveAPIGatewayV2(apigwV2Event("/sse"));

  assert.equal(out.statusCode, 200);
  assert.match(out.headers["content-type"] ?? "", /^text\/html/);
  assert.equal(out.body, "data: first\n\ndata: second\n\n");
  assert.equal(out.isBase64Encoded, false);
});

test("apigateway v2 adapter fails closed on a live streaming body", async () => {
  const app = createApp();
  app.get("/live", () => htmlStream(200, liveStream("data: first\n\n")));

  const out = await app.serveAPIGatewayV2(apigwV2Event("/live"));

  assertStreamingError(out, APIGATEWAY_V2_STREAMING_ERROR_MESSAGE);
});

test("apigateway v2 adapter maps a streaming body over the byte budget to 413", async () => {
  const app = createApp();
  const oversized = Buffer.alloc(STREAMING_BODY_MAX_BYTES + 1, 0x61);
  app.get("/big", () => htmlStream(200, sseChunks(oversized)));

  const out = await app.serveAPIGatewayV2(apigwV2Event("/big"));

  assertStreamingTooLarge(out);
});

test("apigateway v2 adapter fails closed on a streaming body error", async () => {
  const app = createApp();
  app.get("/err", () => htmlStream(200, errorStream()));

  const out = await app.serveAPIGatewayV2(apigwV2Event("/err"));

  assertStreamingError(out, APIGATEWAY_V2_STREAMING_ERROR_MESSAGE);
});

test("lambda function url adapter delivers a terminating streaming body as buffered content", async () => {
  const app = createApp();
  app.get("/sse", () =>
    htmlStream(200, sseChunks("data: first\n\n", "data: second\n\n")),
  );

  const out = await app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/sse"));

  assert.equal(out.statusCode, 200);
  assert.match(out.headers["content-type"] ?? "", /^text\/html/);
  assert.equal(out.body, "data: first\n\ndata: second\n\n");
  assert.equal(out.isBase64Encoded, false);
});

test("lambda function url adapter fails closed on a live streaming body", async () => {
  const app = createApp();
  app.get("/live", () => htmlStream(200, liveStream("data: first\n\n")));

  const out = await app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/live"));

  assertStreamingError(out, LAMBDA_FUNCTION_URL_STREAMING_ERROR_MESSAGE);
});

test("lambda function url adapter maps a streaming body over the byte budget to 413", async () => {
  const app = createApp();
  const oversized = Buffer.alloc(STREAMING_BODY_MAX_BYTES + 1, 0x61);
  app.get("/big", () => htmlStream(200, sseChunks(oversized)));

  const out = await app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/big"));

  assertStreamingTooLarge(out);
});

test("lambda function url adapter fails closed on a streaming body error", async () => {
  const app = createApp();
  app.get("/err", () => htmlStream(200, errorStream()));

  const out = await app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/err"));

  assertStreamingError(out, LAMBDA_FUNCTION_URL_STREAMING_ERROR_MESSAGE);
});

test("adapter decode failures emit observability records", async () => {
  // An invalid raw query string fails request decoding before the portable
  // path records observability; the adapter must still emit a record so
  // decode failures are not silent.
  const logs = [];
  const app = createApp({
    tier: "p2",
    observability: {
      log: (r) => logs.push(r),
    },
  });

  const out = await app.serveAPIGatewayV2({
    version: "2.0",
    routeKey: "$default",
    rawPath: "/x",
    rawQueryString: "%zz",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path: "/x" } },
    body: "",
    isBase64Encoded: false,
  });

  assert.equal(out.statusCode, 400);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "request.completed");
  assert.equal(logs[0].method, "GET");
  assert.equal(logs[0].path, "/x");
  assert.equal(logs[0].status, 400);
  assert.equal(logs[0].errorCode, "app.bad_request");
});

test("adapter decode failures stay silent below P2", async () => {
  const logs = [];
  const app = createApp({
    tier: "p1",
    observability: {
      log: (r) => logs.push(r),
    },
  });

  await app.serveAPIGatewayV2({
    version: "2.0",
    routeKey: "$default",
    rawPath: "/x",
    rawQueryString: "%zz",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path: "/x" } },
    body: "",
    isBase64Encoded: false,
  });

  assert.equal(logs.length, 0);
});
