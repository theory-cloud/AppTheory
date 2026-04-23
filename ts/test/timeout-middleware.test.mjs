import test from "node:test";
import assert from "node:assert/strict";

import { createApp, timeoutMiddleware } from "../dist/app.js";

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

test("timeoutMiddleware returns app.timeout for slow handlers", async () => {
  const app = createApp({ tier: "p0" });
  app.use(timeoutMiddleware({ defaultTimeoutMs: 5 }));
  app.get("/sleep", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    return {
      status: 200,
      headers: { "content-type": ["text/plain; charset=utf-8"] },
      cookies: [],
      body: Buffer.from("done", "utf8"),
      isBase64: false,
    };
  });

  const resp = await app.serve(request("/sleep"));
  const body = JSON.parse(Buffer.from(resp.body).toString("utf8"));

  assert.equal(resp.status, 408);
  assert.equal(body.error.code, "app.timeout");
});

test("timeoutMiddleware propagates cooperative cancellation before side effects", async () => {
  const app = createApp({ tier: "p0" });
  app.use(timeoutMiddleware({ defaultTimeoutMs: 5 }));

  let committedSideEffect = false;
  app.get("/cooperative", async (ctx) => {
    const signal = abortSignalFromContextCarrier(ctx?.ctx ?? null);
    const cancelled = await new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        committedSideEffect = true;
        resolve(false);
      }, 20);

      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });

    return {
      status: 200,
      headers: { "content-type": ["text/plain; charset=utf-8"] },
      cookies: [],
      body: Buffer.from(cancelled ? "cancelled" : "late", "utf8"),
      isBase64: false,
    };
  });

  const resp = await app.serve(request("/cooperative"));
  assert.equal(resp.status, 408);

  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  assert.equal(committedSideEffect, false);
});
