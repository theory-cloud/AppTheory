import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/index.js";
import { canonicalizeHeaders, headersFromSingle } from "../dist/internal/http.js";

function prototypeLikeHeaders() {
  return JSON.parse('{"__proto__":"proto","constructor":"ctor","X-Foo":"A"}');
}

test("canonicalizeHeaders treats prototype-like keys as ordinary headers", () => {
  const headers = canonicalizeHeaders(prototypeLikeHeaders());

  assert.equal(Object.getPrototypeOf(headers), null);
  assert.deepEqual(headers["__proto__"], ["proto"]);
  assert.deepEqual(headers.constructor, ["ctor"]);
  assert.deepEqual(headers["x-foo"], ["A"]);
});

test("headersFromSingle preserves prototype-like keys before request normalization", () => {
  const headers = headersFromSingle(prototypeLikeHeaders(), false);

  assert.equal(Object.getPrototypeOf(headers), null);
  assert.deepEqual(headers["__proto__"], ["proto"]);
  assert.deepEqual(headers.constructor, ["ctor"]);
  assert.deepEqual(headers["X-Foo"], ["A"]);
});

test("serveAPIGatewayV2 accepts prototype-like headers without returning app.internal", async () => {
  const app = createApp({ tier: "p0" });
  app.get("/echo", (ctx) => ({
    status: 200,
    headers: { "content-type": ["application/json; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(JSON.stringify(ctx.request.headers), "utf8"),
    isBase64: false,
  }));

  const resp = await app.serveAPIGatewayV2({
    headers: prototypeLikeHeaders(),
    rawPath: "/echo",
    rawQueryString: "",
    body: "",
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: "GET",
        path: "/echo",
      },
    },
  });

  assert.equal(resp.statusCode, 200);
  assert.deepEqual(
    JSON.parse(resp.body),
    JSON.parse(
      '{"__proto__":["proto"],"constructor":["ctor"],"x-foo":["A"]}',
    ),
  );
});
