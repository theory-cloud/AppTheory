import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUEST_ID_SOURCE_DEFAULT,
  REQUEST_ID_SOURCE_SERVER,
  SecureApp,
  Public,
  createApp,
  json,
  normalizeRequestIdSource,
} from "../dist/index.js";

const GENERATED = "req_server_issued";

function fixedIds() {
  return { newId: () => GENERATED };
}

function contextRequest(headers = {}) {
  return {
    method: "GET",
    path: "/context",
    query: {},
    headers,
    body: "",
    isBase64: false,
  };
}

test("request-ID source normalizes unknown values to the default", () => {
  assert.equal(normalizeRequestIdSource(undefined), REQUEST_ID_SOURCE_DEFAULT);
  assert.equal(normalizeRequestIdSource(""), REQUEST_ID_SOURCE_DEFAULT);
  assert.equal(
    normalizeRequestIdSource(REQUEST_ID_SOURCE_DEFAULT),
    REQUEST_ID_SOURCE_DEFAULT,
  );
  assert.equal(
    normalizeRequestIdSource(REQUEST_ID_SOURCE_SERVER),
    REQUEST_ID_SOURCE_SERVER,
  );
  assert.equal(normalizeRequestIdSource("SERVER"), REQUEST_ID_SOURCE_DEFAULT);
});

test("default request-ID source honors the client x-request-id header", async () => {
  const app = createApp({ tier: "p1", ids: fixedIds() });
  let seen = "";
  app.get("/context", (ctx) => {
    seen = ctx.requestId;
    return json(200, { request_id: ctx.requestId });
  });

  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_supplied" }),
  );

  assert.equal(resp.headers["x-request-id"]?.[0], "req_client_supplied");
  assert.equal(seen, "req_client_supplied");
  assert.equal(
    JSON.parse(Buffer.from(resp.body).toString("utf8")).request_id,
    "req_client_supplied",
  );
});

test("server-issued request-ID source ignores the client x-request-id header", async () => {
  const app = createApp({
    tier: "p1",
    ids: fixedIds(),
    requestIdSource: REQUEST_ID_SOURCE_SERVER,
  });
  let seen = "";
  app.get("/context", (ctx) => {
    seen = ctx.requestId;
    return json(200, { request_id: ctx.requestId });
  });

  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_forged" }),
  );

  assert.equal(resp.headers["x-request-id"]?.[0], GENERATED);
  assert.equal(seen, GENERATED);
  assert.equal(
    JSON.parse(Buffer.from(resp.body).toString("utf8")).request_id,
    GENERATED,
  );
});

test("server-issued request-ID source keeps the client value out of error envelopes", async () => {
  const app = createApp({
    tier: "p1",
    ids: fixedIds(),
    requestIdSource: REQUEST_ID_SOURCE_SERVER,
  });
  app.get("/portable-error", () => {
    const err = new Error("forbidden");
    err.code = "app.forbidden";
    throw err;
  });

  for (const [name, path, status, code] of [
    ["handler error", "/portable-error", 500, "app.internal"],
    ["framework not found", "/missing", 404, "app.not_found"],
  ]) {
    const request = contextRequest({ "x-request-id": "req_client_forged" });
    request.path = path;
    const resp = await app.serve(request);

    assert.equal(resp.status, status, name);
    assert.equal(resp.headers["x-request-id"]?.[0], GENERATED, name);
    const body = JSON.parse(Buffer.from(resp.body).toString("utf8"));
    assert.equal(body.error.request_id, GENERATED, name);
    assert.equal(body.error.code, code, name);
  }
});

test("server-issued request-ID source uses the Lambda fallback id on AppSync", async () => {
  const app = createApp({
    tier: "p2",
    ids: fixedIds(),
    requestIdSource: REQUEST_ID_SOURCE_SERVER,
  });
  app.post("/createThing", (ctx) => json(200, { request_id: ctx.requestId }));

  const output = await app.serveAppSync(
    {
      arguments: {},
      request: { headers: { "x-request-id": "req_client_forged" } },
      info: { fieldName: "createThing", parentTypeName: "Mutation" },
    },
    { awsRequestId: "aws_req_fallback" },
  );

  assert.equal(output.request_id, "aws_req_fallback");
});

test("SecureApp reaches the server-issued request-ID source through its closed options", async () => {
  const app = new SecureApp({
    tier: "p1",
    ids: fixedIds(),
    requestIdSource: REQUEST_ID_SOURCE_SERVER,
  });
  let seen = "";
  app.handle(
    "GET",
    "/context",
    (ctx) => {
      seen = ctx.requestId;
      return json(200, { request_id: ctx.requestId });
    },
    Public(),
  );

  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_forged" }),
  );

  assert.equal(seen, GENERATED);
  assert.equal(resp.headers["x-request-id"]?.[0], GENERATED);
});
