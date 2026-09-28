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

// liveStream models a live listener: it yields one chunk and then never
// terminates on its own. It does not race its own unwind, so asking it to unwind
// cannot complete until the gate settles — which is exactly the body the adapter
// must still join rather than abandon.
function liveStream(firstChunk) {
  let releaseRead;
  const gate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let unwound = false;
  const stream = (async function* () {
    try {
      yield Buffer.from(firstChunk, "utf8");
      await gate;
    } finally {
      unwound = true;
    }
  })();
  return {
    stream,
    release: () => releaseRead(),
    unwound: () => unwound,
  };
}

// Mirrors APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS in src/internal/aws-http.ts.
const STREAMING_BODY_TIMEOUT_MS = 5000;

// assertLiveBodyJoined runs a buffered adapter call for a live body, releases the
// body once the drain budget has expired, and asserts the adapter waited for it.
async function assertLiveBodyJoined(t, live, call, expectedMessage) {
  const startedAt = Date.now();
  const timer = setTimeout(() => live.release(), STREAMING_BODY_TIMEOUT_MS + 100);
  try {
    const out = await call();
    assert.equal(out.statusCode, 500);
    assert.match(
      JSON.stringify(out),
      new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(
      live.unwound(),
      true,
      "the adapter returned while the live body it gave up on could still run",
    );
    assert.ok(
      Date.now() - startedAt >= STREAMING_BODY_TIMEOUT_MS,
      "the adapter returned before its drain budget expired",
    );
  } finally {
    clearTimeout(timer);
  }
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

test("apigateway v2 adapter fails closed on a live streaming body and joins it", async () => {
  const app = createApp();
  const live = liveStream("data: first\n\n");
  app.get("/live", () => htmlStream(200, live.stream));

  await assertLiveBodyJoined(
    null,
    live,
    () => app.serveAPIGatewayV2(apigwV2Event("/live")),
    APIGATEWAY_V2_STREAMING_ERROR_MESSAGE,
  );
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

test("lambda function url adapter fails closed on a live streaming body and joins it", async () => {
  const app = createApp();
  const live = liveStream("data: first\n\n");
  app.get("/live", () => htmlStream(200, live.stream));

  await assertLiveBodyJoined(
    null,
    live,
    () => app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/live")),
    LAMBDA_FUNCTION_URL_STREAMING_ERROR_MESSAGE,
  );
});

test("lambda function url adapter maps a streaming body over the byte budget to 413", async () => {
  const app = createApp();
  const oversized = Buffer.alloc(STREAMING_BODY_MAX_BYTES + 1, 0x61);
  app.get("/big", () => htmlStream(200, sseChunks(oversized)));

  const out = await app.serveLambdaFunctionURL(lambdaFunctionURLEvent("/big"));

  assertStreamingTooLarge(out);
});

test("apigateway v2 adapter maps a streaming body over MaxResponseBytes to 413", async () => {
  // The MaxResponseBytes limiter wraps the stream in the portable serve
  // path; when the adapter drains a stream that trips the limiter, the
  // overrun must map to 413 app.too_large (same size semantics as the drain
  // byte-budget overrun), not the 500 delivery-failure shape.
  const app = createApp({ limits: { maxResponseBytes: 8 } });
  app.get("/big", () => htmlStream(200, sseChunks(Buffer.from("abcdefghij", "utf8"))));

  const out = await app.serveAPIGatewayV2(apigwV2Event("/big"));

  assertStreamingTooLarge(out);
});

test("lambda function url adapter maps a streaming body over MaxResponseBytes to 413", async () => {
  const app = createApp({ limits: { maxResponseBytes: 8 } });
  app.get("/big", () => htmlStream(200, sseChunks(Buffer.from("abcdefghij", "utf8"))));

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

test("websocket decode failures use the route key in observability", async () => {
  // The WebSocket decode-observability method dimension is the route key
  // ($connect, ...), aligned with Go and Py; it must not be the handshake
  // HTTP method (always GET). The record also carries the real decode
  // duration instead of a hardcoded 0.
  const logs = [];
  let now = new Date(0);
  const app = createApp({
    tier: "p2",
    clock: {
      now: () => {
        const cur = now;
        now = new Date(now.getTime() + 5);
        return cur;
      },
    },
    observability: {
      log: (r) => logs.push(r),
    },
  });

  const out = await app.serveWebSocket({
    requestContext: { routeKey: "$connect" },
    path: "/",
    isBase64Encoded: true,
    body: "not base64",
  });

  assert.equal(out.statusCode, 400);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].method, "$connect");
  assert.equal(logs[0].path, "/");
  assert.equal(logs[0].durationMs, 5);
});

test("serveWebSocket fails closed on a dual-body response", async () => {
  // A dual-body response (non-empty buffered body + bodyStream) is divergent
  // across adapters; the WS serve path must route the normalize failure
  // through the same error handling as a thrown handler error (clean nested
  // 500), aligned with Go and Py.
  const app = createApp({ tier: "p2" });
  app.webSocket("$default", () => ({
    status: 200,
    headers: { "content-type": ["text/html; charset=utf-8"] },
    cookies: [],
    body: Buffer.from("buffered", "utf8"),
    bodyStream: (async function* () {
      yield Buffer.from("streamed", "utf8");
    })(),
    isBase64: false,
  }));

  const out = await app.serveWebSocket({
    requestContext: { routeKey: "$default", requestId: "req_ws_dual_1" },
    path: "/",
  });

  assert.equal(out.statusCode, 500);
  const error = JSON.parse(out.body).error;
  assert.equal(error.code, "app.internal");
  assert.equal(error.message, "internal error");
  assert.equal(error.request_id, "req_ws_dual_1");
});
