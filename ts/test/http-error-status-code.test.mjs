import test from "node:test";
import assert from "node:assert/strict";

import { App, AppError, AppTheoryError } from "../dist/index.js";

// The nested envelope must always report the status the runtime actually sent
// (issue #1161). Each case drives a producer class through the serve path and
// asserts error.status_code === response status.
function statusCodeOf(response) {
  const body = JSON.parse(Buffer.from(response.body).toString("utf8"));
  return body.error.status_code;
}

const ok = async () => ({ status: 200, headers: {}, cookies: [], body: "" });

test("served error envelopes carry the status code of the served response", async () => {
  const cases = [
    {
      name: "routing not found",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/ping", ok);
        return app;
      },
      request: { method: "GET", path: "/missing", headers: {}, body: "" },
    },
    {
      name: "routing method not allowed",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/ping", ok);
        return app;
      },
      request: { method: "DELETE", path: "/ping", headers: {}, body: "" },
    },
    {
      name: "panic recovery",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/panic", () => {
          throw new Error("boom");
        });
        return app;
      },
      request: { method: "GET", path: "/panic", headers: {}, body: "" },
    },
    {
      name: "policy rate limit",
      build: () =>
        new App({
          tier: "p2",
          policy: async () => ({ code: "app.rate_limited" }),
        }),
      request: { method: "GET", path: "/limited", headers: {}, body: "" },
    },
    {
      name: "policy load shed",
      build: () =>
        new App({
          tier: "p2",
          policy: async () => ({ code: "app.overloaded" }),
        }),
      request: { method: "GET", path: "/shed", headers: {}, body: "" },
    },
    {
      name: "request too large",
      build: () => new App({ tier: "p2", limits: { maxRequestBytes: 1 } }),
      request: { method: "GET", path: "/big", headers: {}, body: "too big" },
    },
    {
      name: "response too large",
      build: () => {
        const app = new App({ tier: "p2", limits: { maxResponseBytes: 1 } });
        app.get("/big", async () => ({
          status: 200,
          headers: {},
          cookies: [],
          body: "too big",
        }));
        return app;
      },
      request: { method: "GET", path: "/big", headers: {}, body: "" },
    },
    {
      name: "legacy AppError from a handler",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/legacy", async () => {
          throw new AppError("app.bad_request", "invalid json");
        });
        return app;
      },
      request: { method: "GET", path: "/legacy", headers: {}, body: "" },
    },
    {
      name: "portable error without a status",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/portable", async () => {
          throw new AppTheoryError("app.not_found", "not found");
        });
        return app;
      },
      request: { method: "GET", path: "/portable", headers: {}, body: "" },
    },
  ];

  for (const tc of cases) {
    await test(tc.name, async () => {
      const response = await tc.build().serve(tc.request);
      assert.equal(statusCodeOf(response), response.status, tc.name);
    });
  }
});

test("flat-legacy error envelopes stay byte-identical and carry no status_code", async () => {
  const app = new App({ tier: "p0", httpErrorFormat: "flat_legacy" });
  app.get("/ping", ok);

  const missing = await app.serve({
    method: "GET",
    path: "/missing",
    headers: {},
    body: "",
  });
  assert.equal(
    Buffer.from(missing.body).toString("utf8"),
    '{"code":"app.not_found","message":"not found"}',
  );

  const portable = await app.serve({
    method: "GET",
    path: "/ping",
    headers: {},
    body: "",
  });
  assert.equal(portable.status, 200);
});

// An AppTheoryError whose details carry a value with no JSON representation
// cannot be serialized, so the response is the internal-error fallback (issue
// #1161 boundary).
async function serveUnserializableDetails(format) {
  const app = new App({
    tier: "p0",
    ...(format ? { httpErrorFormat: format } : {}),
  });
  app.get("/teapot", async () => {
    const err = new AppTheoryError("teapot", "I am a teapot");
    err.statusCode = 418;
    err.details = { unserializable: () => {} };
    throw err;
  });
  return app.serve({ method: "GET", path: "/teapot", headers: {}, body: "" });
}

test("an unserializable nested envelope is sent as the internal-error fallback with status 500", async () => {
  const response = await serveUnserializableDetails(null);
  assert.equal(response.status, 500);
  assert.equal(
    Buffer.from(response.body).toString("utf8"),
    '{"error":{"code":"app.internal","message":"internal error","status_code":500}}',
  );
  assert.deepEqual(response.headers["content-type"], [
    "application/json; charset=utf-8",
  ]);
});

test("an unserializable flat-legacy envelope is sent as the internal-error fallback with status 500", async () => {
  const response = await serveUnserializableDetails("flat_legacy");
  assert.equal(response.status, 500);
  assert.equal(
    Buffer.from(response.body).toString("utf8"),
    '{"code":"app.internal","message":"internal error"}',
  );
  assert.deepEqual(response.headers["content-type"], [
    "application/json; charset=utf-8",
  ]);
});
