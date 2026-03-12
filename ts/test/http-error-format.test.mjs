import test from "node:test";
import assert from "node:assert/strict";

import { createApp, HTTP_ERROR_FORMAT_FLAT_LEGACY } from "../dist/index.js";
import { AppTheoryError } from "../dist/errors.js";

test("default HTTP errors remain nested", async () => {
  const app = createApp({ tier: "p2" });
  app.get("/portable", () => {
    throw new AppTheoryError("VALIDATION_ERROR", "bad input", {
      statusCode: 422,
      details: { field: "config_type" },
    });
  });

  const resp = await app.serve({
    method: "GET",
    path: "/portable",
    headers: { "x-request-id": "req_123" },
    body: "",
  });

  assert.equal(resp.status, 422);
  assert.equal(resp.headers["x-request-id"]?.[0], "req_123");
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: {
      code: "VALIDATION_ERROR",
      message: "bad input",
      status_code: 422,
      details: { field: "config_type" },
      request_id: "req_123",
    },
  });
});

test("legacy HTTP error format flattens portable and framework errors", async () => {
  const app = createApp({
    tier: "p2",
    httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY,
  });
  app.get("/portable", () => {
    throw new AppTheoryError("VALIDATION_ERROR", "bad input", {
      statusCode: 422,
      details: { field: "config_type" },
      traceId: "trace_1",
      requestId: "req_from_error",
    });
  });

  const portable = await app.serve({
    method: "GET",
    path: "/portable",
    headers: { "x-request-id": "req_123" },
    body: "",
  });
  assert.equal(portable.status, 422);
  assert.equal(portable.headers["x-request-id"]?.[0], "req_123");
  assert.deepEqual(JSON.parse(Buffer.from(portable.body).toString("utf8")), {
    code: "VALIDATION_ERROR",
    message: "bad input",
    details: { field: "config_type" },
  });

  const missing = await app.serve({
    method: "GET",
    path: "/missing",
    headers: { "x-request-id": "req_456" },
    body: "",
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["x-request-id"]?.[0], "req_456");
  assert.deepEqual(JSON.parse(Buffer.from(missing.body).toString("utf8")), {
    code: "app.not_found",
    message: "not found",
  });
});

test("legacy HTTP error format applies to HTTP adapter parse failures", async () => {
  const app = createApp({
    tier: "p2",
    httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY,
  });

  const resp = await app.serveAPIGatewayV2({
    rawQueryString: "%zz",
    requestContext: { http: { method: "GET", path: "/" } },
  });

  assert.equal(resp.statusCode, 400);
  assert.deepEqual(JSON.parse(resp.body), {
    code: "app.bad_request",
    message: "invalid query string",
  });
});
