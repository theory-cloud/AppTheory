import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/app.js";
import { AppError, AppTheoryError } from "../dist/errors.js";

test("serveAppSync formats portable AppTheory errors", async () => {
  const app = createApp({ tier: "p2" });
  app.post("/createThing", () => {
    throw new AppTheoryError("app.validation_failed", "bad input", {
      statusCode: 422,
      details: { field: "name" },
      traceId: "trace_1",
      timestamp: "2026-03-11T15:04:05Z",
    });
  });

  const out = await app.serveAppSync(
    {
      arguments: { id: "thing_123" },
      info: { fieldName: "createThing", parentTypeName: "Mutation" },
    },
    { awsRequestId: "aws_req_1" },
  );

  assert.deepEqual(out, {
    pay_theory_error: true,
    error_message: "bad input",
    error_type: "CLIENT_ERROR",
    error_data: {
      status_code: 422,
      request_id: "aws_req_1",
      trace_id: "trace_1",
      timestamp: "2026-03-11T15:04:05Z",
    },
    error_info: {
      code: "app.validation_failed",
      details: { field: "name" },
      path: "/createThing",
      method: "POST",
      trigger_type: "appsync",
    },
  });
});

test("serveAppSync formats AppError values with request id propagation", async () => {
  const app = createApp({ tier: "p2" });
  app.post("/createThing", () => {
    throw new AppError("app.forbidden", "forbidden");
  });

  const out = await app.serveAppSync(
    {
      arguments: { id: "thing_123" },
      info: { fieldName: "createThing", parentTypeName: "Mutation" },
    },
    { awsRequestId: "aws_req_2" },
  );

  assert.deepEqual(out, {
    pay_theory_error: true,
    error_message: "forbidden",
    error_type: "CLIENT_ERROR",
    error_data: {
      status_code: 403,
      request_id: "aws_req_2",
    },
    error_info: {
      code: "app.forbidden",
      path: "/createThing",
      method: "POST",
      trigger_type: "appsync",
    },
  });
});

test("serveAppSync preserves Lift-style generic unexpected errors", async () => {
  const app = createApp({ tier: "p2" });
  app.post("/createThing", () => {
    throw new Error("boom");
  });

  const out = await app.serveAppSync({
    arguments: { id: "thing_123" },
    info: { fieldName: "createThing", parentTypeName: "Mutation" },
  });

  assert.deepEqual(out, {
    pay_theory_error: true,
    error_message: "boom",
    error_type: "SYSTEM_ERROR",
    error_data: {},
    error_info: {},
  });
});
