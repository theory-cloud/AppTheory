import test from "node:test";
import assert from "node:assert/strict";

import { createApp, htmlStream, timeoutMiddleware } from "../dist/index.js";

// This file proves the invocation-scope invariant for the TypeScript runtime: an
// asynchronous read, task or handler the runtime starts for a request must have
// settled before the adapter (or the middleware) that started it returns, so no
// work outlives the Lambda invocation that started it.

// Mirrors APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS in src/internal/aws-http.ts.
const STREAMING_BODY_TIMEOUT_MS = 5000;

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

function request(path) {
  return {
    method: "GET",
    path,
    query: {},
    headers: {},
    cookies: {},
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

// countActiveTimeouts reports how many timer handles the process still holds, so
// a test can prove the runtime cleared the timers it created.
function countActiveTimeouts() {
  if (typeof process.getActiveResourcesInfo !== "function") {
    return null;
  }
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
    .length;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// abortSignalFromContextCarrier accepts either an AbortSignal or the carrier
// object the runtime stores on the request context.
function abortSignalFromContextCarrier(value) {
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) {
    return value;
  }
  if (value && typeof value === "object") {
    const signal = value.signal;
    if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) {
      return signal;
    }
  }
  return null;
}

test("http api v2 adapter joins the read it abandons at the drain deadline", async () => {
  const app = createApp();

  let unwound = false;
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });

  const producer = (async function* heldStream() {
    try {
      yield Buffer.from("data: first\n\n", "utf8");
      // Hold the next read open past the drain deadline. A producer that
      // observes the unwind settles here; an abandoned one does not.
      await readGate;
    } finally {
      unwound = true;
    }
  })();

  app.get("/held", () => htmlStream(200, producer));

  const timersBefore = countActiveTimeouts();
  const startedAt = Date.now();
  const releaseTimer = setTimeout(
    () => releaseRead(),
    STREAMING_BODY_TIMEOUT_MS + 50,
  );

  try {
    const out = await app.serveAPIGatewayV2(apigwV2Event("/held"));

    assert.equal(out.statusCode, 500);
    assert.equal(
      unwound,
      true,
      "the adapter returned while the read it abandoned could still run",
    );
    assert.ok(
      Date.now() - startedAt >= STREAMING_BODY_TIMEOUT_MS,
      "the adapter gave up before its drain budget expired",
    );

    await sleep(20);
    const timersAfter = countActiveTimeouts();
    if (timersBefore !== null && timersAfter !== null) {
      assert.ok(
        timersAfter <= timersBefore,
        `adapter left ${timersAfter - timersBefore} pending timer(s) behind`,
      );
    }
  } finally {
    clearTimeout(releaseTimer);
  }
});

test("http api v2 adapter does not hold the invocation on an uninterruptible producer", async () => {
  const app = createApp();

  const producer = (async function* liveStream() {
    yield Buffer.from("data: first\n\n", "utf8");
    // Never settles: the generator can be asked to unwind, but it is suspended
    // inside an await, so the unwind cannot complete. The adapter's wait for it
    // stays bounded instead of holding the invocation open forever.
    await new Promise(() => {});
  })();

  app.get("/live", () => htmlStream(200, producer));

  const startedAt = Date.now();
  const out = await app.serveAPIGatewayV2(apigwV2Event("/live"));

  assert.equal(out.statusCode, 500);
  assert.ok(
    Date.now() - startedAt < STREAMING_BODY_TIMEOUT_MS + 2000,
    "adapter held the invocation well past its drain budget",
  );
});

test("timeout middleware waits for the handler it timed out", async () => {
  const app = createApp({ tier: "p0" });
  app.use(timeoutMiddleware({ defaultTimeoutMs: 5 }));

  let handlerFinished = false;
  app.get("/uncooperative", async () => {
    // Ignores the abort signal entirely.
    await sleep(40);
    handlerFinished = true;
    return {
      status: 200,
      headers: { "content-type": ["text/plain; charset=utf-8"] },
      cookies: [],
      body: Buffer.from("late", "utf8"),
      isBase64: false,
    };
  });

  const resp = await app.serve(request("/uncooperative"));
  const body = JSON.parse(Buffer.from(resp.body).toString("utf8"));

  assert.equal(resp.status, 408);
  assert.equal(body.error.code, "app.timeout");
  assert.equal(
    handlerFinished,
    true,
    "the middleware returned while the handler it started was still running",
  );
});

test("timeout middleware still returns promptly for a cooperative handler", async () => {
  const app = createApp({ tier: "p0" });
  app.use(timeoutMiddleware({ defaultTimeoutMs: 5 }));

  let handlerFinished = false;
  app.get("/cooperative", async (ctx) => {
    const signal = abortSignalFromContextCarrier(ctx?.ctx ?? null);
    await new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    handlerFinished = true;
    return {
      status: 200,
      headers: { "content-type": ["text/plain; charset=utf-8"] },
      cookies: [],
      body: Buffer.from("cancelled", "utf8"),
      isBase64: false,
    };
  });

  const startedAt = Date.now();
  const resp = await app.serve(request("/cooperative"));

  assert.equal(resp.status, 408);
  assert.equal(handlerFinished, true);
  assert.ok(
    Date.now() - startedAt < 1000,
    "cooperative cancellation did not release the invocation promptly",
  );
});
