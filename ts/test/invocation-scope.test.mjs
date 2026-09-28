import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { assertDistIsFresh } from "./invocation-scope-dist-freshness.mjs";
import { createApp, htmlStream, timeoutMiddleware } from "../dist/index.js";

// This file proves the invocation-scope invariant for the TypeScript runtime: an
// asynchronous read, task or handler the runtime starts for a request must have
// settled before the adapter (or the middleware) that started it returns, so no
// work outlives the Lambda invocation that started it.
//
// The drain-deadline tests drive the runtime's real timers through node:test's
// mock clock and assert the ordering the invariant is about ("the adapter has
// not returned at its deadline", "the adapter returned once the read settled"),
// never elapsed wall-clock time: a `Date.now()` comparison against a
// `setTimeout` boundary has no slack and compares two clock domains, so it can
// fail while the invariant holds. The timer-leak half of the invariant is pinned
// by the mock-clock tests in invocation-scope-join.test.mjs, which count the
// timer handles the runtime arms and clears.
//
// The tests load the built package, so assertDistIsFresh fails loudly when the
// build is older than the source it was built from instead of passing against
// stale output.
assertDistIsFresh();

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

// flush lets the microtask and immediate queues drain between mock-clock ticks,
// so a test observes the runtime's state rather than racing its own tick.
function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
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

    const state = { settled: false, response: null };
    const served = app.serveAPIGatewayV2(apigwV2Event("/held")).then((out) => {
      state.settled = true;
      state.response = out;
    });

    await flush();

    // The read the drain started is still pending when the budget expires, and
    // the only thing that releases it is this test's own release below, which
    // lands after the deadline. The drain must not resolve the invocation on its
    // own deadline.
    mock.timers.tick(STREAMING_BODY_TIMEOUT_MS);
    await flush();
    assert.equal(
      state.settled,
      false,
      "the adapter gave up at its drain deadline while the read it abandoned could still run",
    );

    releaseRead();
    await flush();
    await served;

    assert.equal(state.response.statusCode, 500);
    assert.equal(
      unwound,
      true,
      "the adapter returned while the read it abandoned could still run",
    );
  } finally {
    mock.timers.reset();
  }
});

test("http api v2 adapter waits for a producer that cannot observe the unwind", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const app = createApp();

    let unwound = false;
    let releaseRead;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });

    const producer = (async function* heldStream() {
      try {
        yield Buffer.from("data: first\n\n", "utf8");
        // Suspended inside an await the producer does not race against its own
        // unwind, so asking it to unwind cannot complete until the await settles.
        // The adapter waits for it anyway: a producer the invocation started must
        // not still be running when the adapter returns. On Lambda the invocation
        // (not the adapter) bounds a producer like this one.
        await gate;
      } finally {
        unwound = true;
      }
    })();

    app.get("/live", () => htmlStream(200, producer));

    const state = { settled: false, response: null };
    const served = app.serveAPIGatewayV2(apigwV2Event("/live")).then((out) => {
      state.settled = true;
      state.response = out;
    });

    await flush();

    // Past its drain budget the adapter has closed the body and is waiting for
    // the read it abandoned; it must not have returned yet. The read settles
    // only on the release below.
    mock.timers.tick(STREAMING_BODY_TIMEOUT_MS);
    await flush();
    assert.equal(
      state.settled,
      false,
      "the adapter returned at its drain deadline while a producer it abandoned could still run",
    );

    releaseRead();
    await flush();
    await served;

    assert.equal(state.response.statusCode, 500);
    assert.equal(
      unwound,
      true,
      "the adapter returned while a producer it abandoned could still run",
    );
  } finally {
    mock.timers.reset();
  }
});

test("alb and buffered v1 adapters drain and join a streaming body", async () => {
  const app = createApp();

  let albFinished = false;
  app.get("/alb", () =>
    htmlStream(
      200,
      (async function* albBody() {
        try {
          yield Buffer.from("alb body", "utf8");
        } finally {
          albFinished = true;
        }
      })(),
    ),
  );

  const alb = await app.serveALB({
    httpMethod: "GET",
    path: "/alb",
    headers: {},
    body: "",
    isBase64Encoded: false,
  });
  assert.equal(alb.statusCode, 200);
  assert.equal(alb.body, "alb body");
  assert.equal(albFinished, true, "the ALB adapter dropped a streaming body");

  let v1Finished = false;
  app.get("/v1", () =>
    htmlStream(
      200,
      (async function* v1Body() {
        try {
          yield Buffer.from("v1 body", "utf8");
        } finally {
          v1Finished = true;
        }
      })(),
    ),
  );

  const v1 = await app.serveAPIGatewayProxy({
    httpMethod: "GET",
    path: "/v1",
    headers: {},
    body: "",
    isBase64Encoded: false,
  });
  assert.equal(v1.statusCode, 200);
  assert.equal(v1.body, "v1 body");
  assert.equal(v1Finished, true, "the buffered v1 adapter dropped a streaming body");
});

test("alb and buffered v1 adapters fail closed on an oversized body and join the producer", async () => {
  const app = createApp();

  let finished = false;
  app.get("/huge", () =>
    htmlStream(
      200,
      (async function* oversized() {
        try {
          // One chunk past the shared 4 MiB adapter budget.
          yield Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
        } finally {
          finished = true;
        }
      })(),
    ),
  );

  const alb = await app.serveALB({
    httpMethod: "GET",
    path: "/huge",
    headers: {},
    body: "",
    isBase64Encoded: false,
  });
  assert.equal(alb.statusCode, 413);
  assert.equal(finished, true, "the ALB adapter abandoned the producer of a size-denied body");

  const v1 = await app.serveAPIGatewayProxy({
    httpMethod: "GET",
    path: "/huge",
    headers: {},
    body: "",
    isBase64Encoded: false,
  });
  assert.equal(v1.statusCode, 413);
  assert.equal(finished, true);
});

test("a limiter-wrapped streaming body is released and joined when the transport stops reading", async () => {
  // MaxResponseBytes wraps the body, so a transport that stops reading it (a
  // client disconnect) only reaches the producer if the wrapper forwards the
  // unwind. The limiter is an async generator, so its return() propagates
  // through the for-await chain.
  const app = createApp({ limits: { maxResponseBytes: 1024 } });

  let finished = false;
  app.get("/limited", () =>
    htmlStream(
      200,
      (async function* limited() {
        try {
          yield Buffer.from("first", "utf8");
          await new Promise(() => {});
        } finally {
          finished = true;
        }
      })(),
    ),
  );

  const resp = await app.serve(request("/limited"));
  assert.ok(resp.bodyStream, "expected a limited body stream");

  const iterator = resp.bodyStream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);

  await iterator.return();
  assert.equal(finished, true, "the limiter hid the producer's unwind");
});

test("timeout middleware never abandons a handler that ignores its abort signal", async () => {
  const app = createApp({ tier: "p0" });
  app.use(timeoutMiddleware({ defaultTimeoutMs: 5 }));

  let handlerFinished = false;
  let sideEffectAfterReturn = false;
  app.get("/uncooperative", async () => {
    // Ignores the abort signal entirely and runs to completion on the invoking
    // task, so the middleware cannot return before it finishes.
    await sleep(40);
    handlerFinished = true;
    sideEffectAfterReturn = false;
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
  assert.equal(sideEffectAfterReturn, false);
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
