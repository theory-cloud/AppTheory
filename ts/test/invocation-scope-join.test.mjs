import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  Context,
  createApp,
  htmlStream,
  timeoutMiddleware,
} from "../dist/index.js";

// This file proves the invocation-scope invariant for the three TypeScript
// launch sites whose join the baseline justifies by waiting for the abandoned
// work:
//
//   ts/src/internal/aws-http.ts|timer[#1]         (withDeadline's drain budget)
//   ts/src/internal/aws-http.ts|promise-race[#1]  (the raced read)
//   ts/src/app.ts|timer[#1]                       (the timeout middleware)
//
// Each test is strict: it asserts an ordering that only holds while the join is
// present, so deleting the join makes the test fail instead of merely weakening
// it. The tests drive the runtime's real timers through node:test's mock clock,
// so the 5000 ms drain budget and the middleware's abort deadline are exercised
// without a wall-clock wait.

// Mirrors APIGATEWAY_V2_STREAMING_BODY_TIMEOUT_MS in src/internal/aws-http.ts.
const STREAMING_BODY_TIMEOUT_MS = 5000;

const MIDDLEWARE_TIMEOUT_MS = 20;

function flush() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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

function okResponse(body = "") {
  return {
    status: 200,
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(body, "utf8"),
    isBase64: false,
  };
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

// trackTimers records every timer the runtime arms and every timer it clears
// while the callback body runs. A timer that is armed and never cleared is a
// handle the invocation would leave behind, so a test can prove the runtime
// released it instead of drifting past its own return.
async function trackTimers(body) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = [];
  const cleared = new Set();
  globalThis.setTimeout = (...args) => {
    const handle = realSetTimeout(...args);
    armed.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    cleared.add(handle);
    return realClearTimeout(handle);
  };
  try {
    await body(() => armed.filter((handle) => !cleared.has(handle)));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

// heldReadBody is an async iterable whose read never settles on its own. It
// records when the drain asks it to unwind, so a test can tell "the drain
// released the producer and then waited for the abandoned read" from "the drain
// released the producer and returned" or "the drain did nothing at all".
function heldReadBody(events) {
  let release;
  return {
    releaseRead(value) {
      release(value);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      events.push("read:pending");
      return new Promise((resolve) => {
        release = (value) => resolve({ done: false, value });
      });
    },
    return() {
      events.push("producer:released");
      return Promise.resolve({ done: true, value: undefined });
    },
  };
}

test("http api v2 adapter waits for the read it abandons at the drain deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const events = [];
    const body = heldReadBody(events);
    const app = createApp();
    app.get("/held", () => htmlStream(200, body));

    const state = { settled: false, response: null };
    const served = app.serveAPIGatewayV2(apigwV2Event("/held")).then(
      (response) => {
        state.settled = true;
        state.response = response;
      },
      (err) => {
        state.settled = true;
        state.response = { statusCode: 0, error: err };
      },
    );

    await flush();
    assert.deepEqual(events, ["read:pending"]);

    // The budget expires while the read is still pending. The drain must not
    // resolve the invocation on the timer alone: the read it abandoned has to
    // settle first, which is the join the baseline records for both
    // withDeadline's timer and its Promise.race.
    mock.timers.tick(STREAMING_BODY_TIMEOUT_MS);
    await flush();

    assert.equal(
      state.settled,
      false,
      "the adapter returned at the drain deadline while the read it abandoned could still run",
    );
    assert.deepEqual(events, ["read:pending"]);

    body.releaseRead(Buffer.from("late", "utf8"));
    await flush();
    await served;

    assert.equal(state.settled, true);
    assert.equal(
      state.response.statusCode,
      500,
      "the abandoned read was delivered instead of failing closed",
    );
    assert.deepEqual(
      events,
      ["read:pending", "producer:released"],
      "the adapter never released the producer it abandoned",
    );
  } finally {
    mock.timers.reset();
  }
});

test("http api v2 adapter absorbs the read that loses the deadline race", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const events = [];
    let rejectRead;
    const body = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        events.push("read:pending");
        return new Promise((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      return() {
        events.push("producer:released");
        return Promise.resolve({ done: true, value: undefined });
      },
    };

    const app = createApp();
    app.get("/rejected", () => htmlStream(200, body));

    const state = { settled: false, response: null };
    const served = app.serveAPIGatewayV2(apigwV2Event("/rejected")).then(
      (response) => {
        state.settled = true;
        state.response = response;
      },
      (err) => {
        state.settled = true;
        state.response = { statusCode: 0, error: err };
      },
    );

    await flush();
    assert.deepEqual(events, ["read:pending"]);

    // The budget timer wins the race. The read it beat is still awaited: a
    // loser that settles after the drain returned would be work the invocation
    // started and never joined.
    mock.timers.tick(STREAMING_BODY_TIMEOUT_MS);
    await flush();

    assert.equal(
      state.settled,
      false,
      "the adapter returned on the raced timer while the read it beat was still pending",
    );

    rejectRead(new Error("producer failed after the drain deadline"));
    await flush();
    await served;

    // The abandoned read's rejection is absorbed by the adapter's join, so the
    // adapter reports the budget error and node:test never sees an unhandled
    // rejection from it.
    assert.equal(state.settled, true);
    assert.equal(state.response.statusCode, 500);
  } finally {
    mock.timers.reset();
  }
});

test("http api v2 adapter clears its drain budget timer on every read", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    await trackTimers(async (pendingTimers) => {
      const app = createApp();
      app.get("/terminating", () =>
        htmlStream(
          200,
          (async function* terminatingBody() {
            yield Buffer.from("first", "utf8");
            yield Buffer.from("second", "utf8");
          })(),
        ),
      );

      const response = await app.serveAPIGatewayV2(
        apigwV2Event("/terminating"),
      );

      assert.equal(response.statusCode, 200);
      assert.equal(response.body, "firstsecond");
      assert.equal(
        pendingTimers().length,
        0,
        "the drain left a budget timer armed after the read it guarded settled",
      );
    });
  } finally {
    mock.timers.reset();
  }
});

test("timeout middleware runs the handler on the invoking task and never abandons it", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const middleware = timeoutMiddleware({
      defaultTimeoutMs: MIDDLEWARE_TIMEOUT_MS,
      timeoutMessage: "too slow",
    });
    const ctx = new Context({ request: request("/uncooperative") });
    const order = [];
    const state = { settled: false, error: null };

    const served = middleware(ctx, async () => {
      // Runs to completion on the invoking task after ignoring the abort
      // signal: the middleware may only settle once this returns.
      order.push("handler:start");
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      order.push("handler:finish");
      return okResponse("late");
    });

    assert.deepEqual(
      order,
      ["handler:start"],
      "the middleware did not start the handler on the invoking task",
    );

    const settled = served.then(
      () => {
        order.push("middleware:settled");
        state.settled = true;
      },
      (err) => {
        order.push("middleware:settled");
        state.settled = true;
        state.error = err;
      },
    );

    mock.timers.tick(MIDDLEWARE_TIMEOUT_MS);
    await flush();

    assert.equal(
      state.settled,
      false,
      "the middleware abandoned a handler that was still running",
    );

    mock.timers.tick(150);
    await flush();
    await settled;

    assert.equal(state.error?.code, "app.timeout");
    assert.ok(
      order.indexOf("handler:finish") < order.indexOf("middleware:settled"),
      "the middleware settled before the handler it started finished",
    );
    assert.deepEqual(order, [
      "handler:start",
      "handler:finish",
      "middleware:settled",
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("timeout middleware clears its abort timer before it returns", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    await trackTimers(async (pendingTimers) => {
      const middleware = timeoutMiddleware({
        defaultTimeoutMs: 300,
        timeoutMessage: "too slow",
      });
      const ctx = new Context({ request: request("/fast") });

      let signal = null;
      await middleware(ctx, async (handlerCtx) => {
        signal = abortSignalFromContextCarrier(handlerCtx?.ctx ?? null);
        return okResponse("fast");
      });

      assert.ok(signal, "the middleware did not hand the handler an abort signal");
      assert.equal(signal.aborted, false);
      assert.equal(
        pendingTimers().length,
        0,
        "the middleware left its abort timer armed after it returned",
      );

      // Advancing past the deadline must not abort a request that already
      // returned; an armed timer would fire here.
      mock.timers.tick(300);
      await flush();
      assert.equal(
        signal.aborted,
        false,
        "the middleware's abort timer fired after the middleware returned",
      );
    });
  } finally {
    mock.timers.reset();
  }
});
