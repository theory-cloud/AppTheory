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

const MALFORMED_CLIENT_REQUEST_IDS = {
  crlf: "evil\r\nx-injected: 1",
  oversize: "a".repeat(129),
  space: "has space",
  nonascii: "caf\u00e9",
  tab: "a\tb",
  nul: "a\u0000b",
};

function requestIDApp(source, seen, extra = {}) {
  const app = createApp({
    tier: "p1",
    ids: { newId: () => GENERATED },
    ...(source ? { requestIdSource: source } : {}),
  });
  app.get("/context", (ctx) => {
    seen.clientRequestId = ctx.clientRequestId;
    return json(200, {
      request_id: ctx.requestId,
      client_request_id: ctx.clientRequestId,
      ...extra,
    });
  });
  return app;
}

function parseBody(resp) {
  return JSON.parse(Buffer.from(resp.body).toString("utf8"));
}

test("client request ID accessor exposes a well-formed client value in the default mode", async () => {
  const seen = {};
  const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_wellformed" }),
  );

  assert.equal(seen.clientRequestId, "req_client_wellformed");
  assert.equal(resp.headers["x-request-id"]?.[0], "req_client_wellformed");
  assert.equal(parseBody(resp).client_request_id, "req_client_wellformed");
});

test("client request ID accessor trims edge whitespace from a well-formed value", async () => {
  const seen = {};
  const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
  const resp = await app.serve(
    contextRequest({ "x-request-id": "  req_client_wellformed\t" }),
  );

  assert.equal(seen.clientRequestId, "req_client_wellformed");
  assert.equal(resp.headers["x-request-id"]?.[0], "req_client_wellformed");
});

test("client request ID accessor accepts a well-formed value at the 128-character limit", async () => {
  const boundary = "a".repeat(128);
  const seen = {};
  const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
  const resp = await app.serve(contextRequest({ "x-request-id": boundary }));

  assert.equal(seen.clientRequestId, boundary);
  assert.equal(resp.headers["x-request-id"]?.[0], boundary);
});

for (const [name, value] of Object.entries(MALFORMED_CLIENT_REQUEST_IDS)) {
  test(`default request-ID source ignores a malformed client value (${name})`, async () => {
    const seen = {};
    const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
    const resp = await app.serve(contextRequest({ "x-request-id": value }));

    assert.equal(seen.clientRequestId, "", name);
    assert.equal(resp.headers["x-request-id"]?.[0], GENERATED, name);
    assert.equal(parseBody(resp).request_id, GENERATED, name);
    assert.ok(
      !Buffer.from(resp.body).toString("utf8").includes(value),
      `${name} leaked the malformed client value into the body`,
    );
  });

  test(`malformed client value never reaches the error envelope (${name})`, async () => {
    const seen = {};
    const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
    const request = contextRequest({ "x-request-id": value });
    request.path = "/missing";
    const resp = await app.serve(request);

    assert.equal(resp.status, 404, name);
    assert.equal(resp.headers["x-request-id"]?.[0], GENERATED, name);
    assert.equal(parseBody(resp).error.request_id, GENERATED, name);
    assert.ok(
      !Buffer.from(resp.body).toString("utf8").includes(value),
      `${name} leaked the malformed client value into the envelope`,
    );
  });
}

test("default request-ID source falls back when the client value is malformed", async () => {
  const seen = {};
  const app = requestIDApp(REQUEST_ID_SOURCE_DEFAULT, seen);
  app.post("/createThing", (ctx) =>
    json(200, {
      request_id: ctx.requestId,
      client_request_id: ctx.clientRequestId,
    }),
  );

  const output = await app.serveAppSync(
    {
      arguments: {},
      request: { headers: { "x-request-id": "evil\r\nx-injected: 1" } },
      info: { fieldName: "createThing", parentTypeName: "Mutation" },
    },
    { awsRequestId: "aws_req_fallback" },
  );

  assert.equal(output.request_id, "aws_req_fallback");
  assert.equal(output.client_request_id, "");
});

test("client request ID accessor exposes a well-formed value in the server-issued mode", async () => {
  const seen = {};
  const app = requestIDApp(REQUEST_ID_SOURCE_SERVER, seen);
  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_visible" }),
  );

  assert.equal(seen.clientRequestId, "req_client_visible");
  assert.equal(resp.headers["x-request-id"]?.[0], GENERATED);
  assert.equal(parseBody(resp).request_id, GENERATED);
});

for (const [name, value] of Object.entries(MALFORMED_CLIENT_REQUEST_IDS)) {
  test(`server-issued mode exposes nothing for a malformed client value (${name})`, async () => {
    const seen = {};
    const app = requestIDApp(REQUEST_ID_SOURCE_SERVER, seen);
    const resp = await app.serve(contextRequest({ "x-request-id": value }));

    assert.equal(seen.clientRequestId, "", name);
    assert.equal(resp.headers["x-request-id"]?.[0], GENERATED, name);
    assert.ok(
      !Buffer.from(resp.body).toString("utf8").includes(value),
      `${name} leaked the malformed client value into the body`,
    );
  });
}

test("raw request headers keep the client x-request-id exactly as received", async () => {
  const app = createApp({ tier: "p1", ids: fixedIds() });
  let raw = "";
  app.get("/context", (ctx) => {
    raw = ctx.request.headers["x-request-id"]?.[0] ?? "";
    return json(200, { request_id: ctx.requestId });
  });

  await app.serve(contextRequest({ "x-request-id": "evil\r\nx-injected: 1" }));

  assert.equal(raw, "evil\r\nx-injected: 1");
});

test("SecureApp populates the client request ID accessor for a well-formed value", async () => {
  const app = new SecureApp({ tier: "p1", ids: fixedIds() });
  let seen = "";
  app.handle(
    "GET",
    "/context",
    (ctx) => {
      seen = ctx.clientRequestId;
      return json(200, { request_id: ctx.requestId });
    },
    Public(),
  );

  const resp = await app.serve(
    contextRequest({ "x-request-id": "req_client_visible" }),
  );

  assert.equal(seen, "req_client_visible");
  assert.equal(resp.headers["x-request-id"]?.[0], "req_client_visible");
});
