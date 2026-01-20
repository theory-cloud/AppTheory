import assert from "node:assert/strict";

import { AppError, buildLambdaFunctionURLRequest, createTestEnv } from "../../ts/dist/index.js";

const env = createTestEnv({ now: new Date("2026-01-01T00:00:00.000Z") });
env.ids.queue("req-stream-1");

const app = env.app({ tier: "p1" });

app.get("/html", () => ({
  status: 200,
  headers: { "content-type": ["text/html; charset=utf-8"] },
  cookies: ["a=b; Path=/"],
  body: Buffer.alloc(0),
  bodyStream: (async function* () {
    yield Buffer.from("<!doctype html>", "utf8");
    yield Buffer.from("<h1>Hello</h1>", "utf8");
  })(),
  isBase64: false,
}));

app.get("/mutate-headers", () => {
  const resp = {
    status: 200,
    headers: { "content-type": ["text/plain; charset=utf-8"], "x-phase": ["before"] },
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };

  resp.bodyStream = (async function* () {
    yield Buffer.from("a", "utf8");
    resp.headers["x-phase"] = ["after"];
    yield Buffer.from("b", "utf8");
  })();

  return resp;
});

app.get("/late-error", () => ({
  status: 200,
  headers: { "content-type": ["text/plain; charset=utf-8"] },
  cookies: [],
  body: Buffer.alloc(0),
  bodyStream: (async function* () {
    yield Buffer.from("hello", "utf8");
    throw new AppError("app.internal", "boom");
  })(),
  isBase64: false,
}));

{
  const event = buildLambdaFunctionURLRequest("GET", "/html");
  const resp = await env.invokeLambdaFunctionURLStreaming(app, event);

  assert.equal(resp.status, 200);
  assert.deepEqual(resp.headers["content-type"], ["text/html; charset=utf-8"]);
  assert.deepEqual(resp.cookies, ["a=b; Path=/"]);
  assert.deepEqual(resp.chunks.map((c) => Buffer.from(c).toString("utf8")), ["<!doctype html>", "<h1>Hello</h1>"]);
  assert.equal(Buffer.from(resp.body).toString("utf8"), "<!doctype html><h1>Hello</h1>");
  assert.equal(resp.stream_error_code, "");
}

{
  const event = buildLambdaFunctionURLRequest("GET", "/mutate-headers");
  const resp = await env.invokeLambdaFunctionURLStreaming(app, event);

  assert.equal(resp.status, 200);
  assert.deepEqual(resp.headers["x-phase"], ["before"]);
  assert.deepEqual(resp.chunks.map((c) => Buffer.from(c).toString("utf8")), ["a", "b"]);
  assert.equal(Buffer.from(resp.body).toString("utf8"), "ab");
  assert.equal(resp.stream_error_code, "");
}

{
  const event = buildLambdaFunctionURLRequest("GET", "/late-error");
  const resp = await env.invokeLambdaFunctionURLStreaming(app, event);

  assert.equal(resp.status, 200);
  assert.deepEqual(resp.chunks.map((c) => Buffer.from(c).toString("utf8")), ["hello"]);
  assert.equal(Buffer.from(resp.body).toString("utf8"), "hello");
  assert.equal(resp.stream_error_code, "app.internal");
}

console.log("examples/testkit/ts-streaming.mjs: PASS");

