const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { runAllFixtures } = require("./run.cjs");

async function importDist(relPath) {
  const abs = path.join(process.cwd(), "ts", "dist", relPath);
  return import(pathToFileURL(abs).href);
}

test("contract fixtures (ts runtime)", { timeout: 60_000 }, async () => {
  const { fixtures, failures } = await runAllFixtures({ fixturesRoot: "contract-tests/fixtures" });
  const ids = failures.map((f) => f.fixture.id).sort();
  assert.equal(
    failures.length,
    0,
    `expected 0 failing fixtures, got ${failures.length}/${fixtures.length}: ${ids.join(", ")}`,
  );
});

test("clock: ManualClock can set and advance", async () => {
  const { ManualClock } = await importDist("clock.js");

  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new ManualClock(start);
  assert.equal(clock.now().toISOString(), start.toISOString());

  clock.advance(250);
  assert.equal(clock.now().toISOString(), new Date(start.valueOf() + 250).toISOString());

  const next = new Date("2026-01-01T00:00:10.000Z");
  clock.set(next);
  assert.equal(clock.now().toISOString(), next.toISOString());
});

test("sanitization: sanitizeLogString strips newlines", async () => {
  const { sanitizeLogString } = await importDist("sanitization.js");
  assert.equal(sanitizeLogString("a\nb\r\nc"), "abc");
});

test("sanitization: sanitizeFieldValue masks sensitive fields", async () => {
  const { sanitizeFieldValue } = await importDist("sanitization.js");

  assert.equal(sanitizeFieldValue("authorization", "Bearer secret"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("client_secret", "x"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("card_number", "4242 4242 4242 4242"), "424242******4242");

  const nested = sanitizeFieldValue("root", {
    password: "p\nw",
    ok: "a\r\nb",
    list: [{ api_key: "x" }, "fine"],
  });
  assert.deepEqual(nested, {
    password: "[REDACTED]",
    ok: "ab",
    list: [{ api_key: "[REDACTED]" }, "fine"],
  });
});

test("sanitization: sanitizeJSON sanitizes nested body JSON strings", async () => {
  const { sanitizeJSON } = await importDist("sanitization.js");

  assert.equal(sanitizeJSON(""), "(empty)");
  assert.match(sanitizeJSON("{"), /^\(malformed JSON: /);

  const out = sanitizeJSON(
    JSON.stringify({
      authorization: "Bearer secret",
      body: JSON.stringify({ card_number: "4242 4242 4242 4242" }),
    }),
  );
  assert.match(out, /"authorization": "\[REDACTED\]"/);
  assert.match(out, /424242\*{6}4242/);
});

test("sanitization: sanitizeXML applies payment patterns", async () => {
  const { sanitizeXML, paymentXMLPatterns } = await importDist("sanitization.js");

  const xml = "<CardNum>4242424242424242</CardNum><CVV>123</CVV><TransArmorToken>abcd1234</TransArmorToken>";
  const out = sanitizeXML(xml, paymentXMLPatterns);
  assert.equal(
    out,
    "<CardNum>424242******4242</CardNum><CVV>[REDACTED]</CVV><TransArmorToken>****1234</TransArmorToken>",
  );
});

test("aws lambda streaming: CapturedHttpResponseStream captures init/write/end", async () => {
  const { CapturedHttpResponseStream } = await importDist("internal/aws-lambda-streaming.js");
  const { Buffer } = require("node:buffer");

  const s = new CapturedHttpResponseStream();
  s.init({ statusCode: 201, headers: { "x-test": "ok" }, cookies: ["a=b"] });
  s.write(Buffer.from("hi"));
  s.end(Buffer.from("!"));

  assert.equal(s.statusCode, 201);
  assert.deepEqual(s.headers, { "x-test": "ok" });
  assert.deepEqual(s.cookies, ["a=b"]);
  assert.equal(Buffer.concat(s.chunks).toString("utf8"), "hi!");
  assert.equal(s.ended, true);
});

test("aws lambda streaming: serveLambdaFunctionURLStreaming streams prefix + iterator chunks and returns stream error code", async (t) => {
  const { serveLambdaFunctionURLStreaming, CapturedHttpResponseStream } = await importDist(
    "internal/aws-lambda-streaming.js",
  );
  const { AppError } = await importDist("errors.js");
  const { Buffer } = require("node:buffer");

  const prevAws = globalThis.awslambda;
  t.after(() => {
    globalThis.awslambda = prevAws;
  });

  let sawMeta = null;
  globalThis.awslambda = {
    HttpResponseStream: {
      from: (responseStream, meta) => {
        sawMeta = meta;
        return responseStream;
      },
    },
  };

  const app = {
    async serve() {
      async function* stream() {
        yield Buffer.from("a");
        throw new AppError("app.stream", "boom");
      }
      return {
        status: 200,
        headers: { "x-request-id": ["req_1"] },
        cookies: [],
        body: Buffer.from("p"),
        bodyStream: stream(),
        isBase64: false,
      };
    },
  };

  const event = {
    version: "2.0",
    rawPath: "/",
    requestContext: { http: { method: "GET", path: "/" } },
  };

  const stream = new CapturedHttpResponseStream();
  const code = await serveLambdaFunctionURLStreaming(app, event, stream);

  assert.equal(code, "app.stream");
  assert.equal(sawMeta.statusCode, 200);
  assert.equal(Buffer.concat(stream.chunks).toString("utf8"), "pa");
});

test("websocket management: Fake client records calls and errors", async () => {
  const { FakeWebSocketManagementClient } = await importDist("websocket-management.js");
  const { Buffer } = require("node:buffer");

  const ws = new FakeWebSocketManagementClient({ endpoint: "https://example.com/dev" });

  await ws.postToConnection("c1", Buffer.from("hi"));
  ws.connections.set("c1", { ok: true });
  assert.deepEqual(await ws.getConnection("c1"), { ok: true });
  await ws.deleteConnection("c1");

  await assert.rejects(() => ws.postToConnection("", Buffer.from("x")), /connection id is empty/);
  await assert.rejects(() => ws.getConnection("missing"), /connection not found/);

  assert.equal(ws.calls.length, 4);
  assert.equal(ws.calls[0].op, "post_to_connection");
  assert.equal(ws.calls[1].op, "get_connection");
  assert.equal(ws.calls[2].op, "delete_connection");
  assert.equal(ws.calls[3].op, "get_connection");
});

test("websocket management: WebSocketManagementClient builds requests and handles non-2xx responses", async (t) => {
  const { WebSocketManagementClient } = await importDist("websocket-management.js");

  const prevFetch = globalThis.fetch;
  const prevEnv = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };
  t.after(() => {
    globalThis.fetch = prevFetch;
    process.env.AWS_REGION = prevEnv.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = prevEnv.AWS_DEFAULT_REGION;
  });

  process.env.AWS_REGION = "";
  process.env.AWS_DEFAULT_REGION = "";

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("@connections/bad")) {
      return new Response("nope", { status: 500 });
    }
    if (String(url).includes("@connections/good") && String(init?.method) === "GET") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 200 });
  };

  const c = new WebSocketManagementClient({
    endpoint: "wss://abc.execute-api.us-west-2.amazonaws.com/dev",
    credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "SECRET_TEST" },
  });
  assert.equal(c.region, "us-west-2");
  assert.equal(c.endpoint, "https://abc.execute-api.us-west-2.amazonaws.com/dev");

  await c.postToConnection("good", new Uint8Array([1, 2, 3]));
  assert.deepEqual(await c.getConnection("good"), { ok: true });
  await c.deleteConnection("good");

  await assert.rejects(() => c.postToConnection("bad", new Uint8Array([0])), /post_to_connection failed/);
  assert.ok(calls.length >= 4);
});

test("testkit: step functions task token helpers handle variants", async () => {
  const { stepFunctionsTaskToken, buildStepFunctionsTaskTokenEvent } = await importDist("testkit.js");

  assert.equal(stepFunctionsTaskToken(null), "");
  assert.equal(stepFunctionsTaskToken("x"), "");
  assert.equal(stepFunctionsTaskToken({ taskToken: "  abc " }), "abc");
  assert.equal(stepFunctionsTaskToken({ TaskToken: "DEF" }), "DEF");
  assert.equal(stepFunctionsTaskToken({ task_token: "ghi" }), "ghi");

  assert.deepEqual(buildStepFunctionsTaskTokenEvent("  tok_1  ", { ok: true }), { ok: true, taskToken: "tok_1" });
  assert.deepEqual(buildStepFunctionsTaskTokenEvent("tok_2", ["not-an-object"]), { taskToken: "tok_2" });
});

test("testkit: build* request helpers normalize method, query, and body", async () => {
  const { buildAPIGatewayV2Request, buildLambdaFunctionURLRequest, buildALBTargetGroupRequest } = await importDist(
    "testkit.js",
  );

  const v2 = buildAPIGatewayV2Request("get", "/hello?x=1", { body: "hi" });
  assert.equal(v2.requestContext.http.method, "GET");
  assert.equal(v2.rawPath, "/hello");
  assert.equal(v2.rawQueryString, "x=1");
  assert.equal(v2.body, "hi");
  assert.equal(v2.isBase64Encoded, false);

  const v2b64 = buildAPIGatewayV2Request("post", "/upload", { body: Buffer.from([1, 2, 3]), isBase64: true });
  assert.equal(v2b64.body, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(v2b64.isBase64Encoded, true);

  const url = buildLambdaFunctionURLRequest("patch", "/a", {
    query: { b: ["2"], a: ["1"] },
    cookies: ["a=b"],
  });
  assert.equal(url.requestContext.http.method, "PATCH");
  assert.equal(url.rawQueryString, "a=1&b=2");
  assert.deepEqual(url.cookies, ["a=b"]);

  const alb = buildALBTargetGroupRequest("put", "/q?a=1&a=2", {
    headers: { "x-one": "h1" },
    multiHeaders: { "x-two": ["h2", "h3"], "x-one": ["override"] },
    body: "ok",
  });
  assert.equal(alb.httpMethod, "PUT");
  assert.equal(alb.path, "/q");
  assert.equal(alb.queryStringParameters.a, "1");
  assert.deepEqual(alb.multiValueQueryStringParameters.a, ["1", "2"]);
  assert.equal(alb.headers["x-one"], "h1");
  assert.deepEqual(alb.multiValueHeaders["x-one"], ["override"]);
  assert.deepEqual(alb.multiValueHeaders["x-two"], ["h2", "h3"]);
});

test("testkit: build* event helpers provide stable defaults", async () => {
  const {
    buildSQSEvent,
    buildEventBridgeEvent,
    buildDynamoDBStreamEvent,
    buildKinesisEvent,
    buildSNSEvent,
  } = await importDist("testkit.js");

  const sqs = buildSQSEvent("arn:aws:sqs:us-east-1:000000000000:queue/test", [{ body: "hi" }, { messageId: "m2" }]);
  assert.equal(sqs.Records.length, 2);
  assert.equal(sqs.Records[0].messageId, "msg-1");
  assert.equal(sqs.Records[0].eventSourceARN, "arn:aws:sqs:us-east-1:000000000000:queue/test");
  assert.equal(sqs.Records[1].messageId, "m2");

  const eb = buildEventBridgeEvent({ ruleArn: "arn:aws:events:us-east-1:000000000000:rule/test", resources: ["r1"] });
  assert.ok(eb.resources.includes("r1"));
  assert.ok(eb.resources.includes("arn:aws:events:us-east-1:000000000000:rule/test"));

  const ddb = buildDynamoDBStreamEvent("arn:aws:dynamodb:us-east-1:000000000000:table/t/stream/1", [
    { eventName: "INSERT" },
  ]);
  assert.equal(ddb.Records[0].eventName, "INSERT");
  assert.equal(ddb.Records[0].eventSourceARN, "arn:aws:dynamodb:us-east-1:000000000000:table/t/stream/1");

  const kin = buildKinesisEvent("arn:aws:kinesis:us-east-1:000000000000:stream/s", [
    { data: Buffer.from("hello") },
    { kinesis: { data: "aGVsbG8=" } },
  ]);
  assert.equal(kin.Records[0].kinesis.data, Buffer.from("hello").toString("base64"));
  assert.equal(kin.Records[1].kinesis.data, "aGVsbG8=");

  const sns = buildSNSEvent("arn:aws:sns:us-east-1:000000000000:topic/t", [
    { message: "m1" },
    { Sns: { MessageId: "m2", Message: "m2", TopicArn: "arn:custom", Timestamp: "2026-01-01T00:00:00Z" } },
  ]);
  assert.equal(sns.Records[0].Sns.Message, "m1");
  assert.equal(sns.Records[1].Sns.MessageId, "m2");
  assert.equal(sns.Records[1].Sns.TopicArn, "arn:custom");
});

test("testkit: TestEnv.invokeStreaming collects bytes and stream errors", async () => {
  const { createTestEnv } = await importDist("testkit.js");
  const { AppError } = await importDist("errors.js");

  const env = createTestEnv({ now: new Date("2026-01-01T00:00:00Z") });

  const okApp = {
    async serve() {
      async function* stream() {
        yield Buffer.from("b");
        yield Buffer.from("c");
      }
      return {
        status: 201,
        headers: { "x-one": "1", "x-two": ["2", 3] },
        cookies: ["a=b"],
        body: Buffer.from("a"),
        bodyStream: stream(),
        isBase64: false,
      };
    },
  };

  const ok = await env.invokeStreaming(okApp, { method: "GET", path: "/" });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.headers, { "x-one": ["1"], "x-two": ["2", "3"] });
  assert.deepEqual(ok.cookies, ["a=b"]);
  assert.equal(Buffer.from(ok.body).toString("utf8"), "abc");
  assert.equal(ok.stream_error_code, "");

  const errApp = {
    async serve() {
      async function* stream() {
        yield Buffer.from("x");
        throw new AppError("app.stream", "boom");
      }
      return {
        status: 200,
        headers: {},
        cookies: [],
        body: Buffer.from("p"),
        bodyStream: stream(),
        isBase64: false,
      };
    },
  };

  const out = await env.invokeStreaming(errApp, { method: "GET", path: "/" });
  assert.equal(Buffer.from(out.body).toString("utf8"), "px");
  assert.equal(out.stream_error_code, "app.stream");
});

test("app: route helpers and tier p0 normalization errors", async () => {
  const { createApp } = await importDist("app.js");

  const app = createApp({ tier: "p0" });
  app.get("/", async () => ({ status: 200, body: "ok" }));
  app.post("/p", async () => ({ status: 201, body: "post" }));
  app.put("/u", async () => ({ status: 200, body: "put" }));
  app.delete("/d", async () => ({ status: 200, body: "del" }));
  app.use("not-a-function");
  app.useEvents(null);

  const ok = await app.serve({ method: "GET", path: "/", headers: {}, query: {}, body: "" });
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(ok.body).toString("utf8"), "ok");

  const bad = await app.serve({ method: "GET", path: "/", headers: {}, query: {}, body: { bad: true } });
  assert.equal(bad.status, 500);
});

test("app: cors preflight and allowlist headers/origins are applied", async () => {
  const { createApp } = await importDist("app.js");

  const app = createApp({
    cors: { allowedOrigins: ["*"], allowCredentials: true, allowHeaders: ["X-One", " X-Two ", ""] },
  });
  app.get("/", async () => ({ status: 200, body: "ok" }));

  const preflight = await app.serve({
    method: "OPTIONS",
    path: "/",
    headers: { origin: "https://example.com", "access-control-request-method": "GET" },
    query: {},
    body: "",
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"][0], "https://example.com");
  assert.equal(preflight.headers["access-control-allow-credentials"][0], "true");
  assert.equal(preflight.headers["access-control-allow-headers"][0], "X-One, X-Two");
  assert.equal(preflight.headers["access-control-allow-methods"][0], "GET");
});

test("app: policy hook, authRequired, and invalid handler results are enforced", async () => {
  const { createApp } = await importDist("app.js");
  const { AppError } = await importDist("errors.js");

  const policyApp = createApp({
    tier: "p2",
    policyHook: async () => ({ code: "app.rate_limited" }),
  });
  policyApp.get("/", async () => ({ status: 200, body: "ok" }));
  const limited = await policyApp.serve({ method: "GET", path: "/", headers: {}, query: {}, body: "" });
  assert.equal(limited.status, 429);
  assert.deepEqual(JSON.parse(Buffer.from(limited.body).toString("utf8")).error.code, "app.rate_limited");

  const policyThrowApp = createApp({
    tier: "p2",
    policyHook: async () => {
      throw new AppError("app.overloaded", "nope");
    },
  });
  policyThrowApp.get("/", async () => ({ status: 200, body: "ok" }));
  const overloaded = await policyThrowApp.serve({ method: "GET", path: "/", headers: {}, query: {}, body: "" });
  assert.equal(overloaded.status, 503);

  const authMissingApp = createApp({ tier: "p2" });
  authMissingApp.handle("GET", "/secure", async () => ({ status: 200, body: "ok" }), { authRequired: true });
  const unauth = await authMissingApp.serve({ method: "GET", path: "/secure", headers: {}, query: {}, body: "" });
  assert.equal(unauth.status, 401);

  const authBlankApp = createApp({ tier: "p2", authHook: async () => "  " });
  authBlankApp.handle("GET", "/secure", async () => ({ status: 200, body: "ok" }), { authRequired: true });
  const unauth2 = await authBlankApp.serve({ method: "GET", path: "/secure", headers: {}, query: {}, body: "" });
  assert.equal(unauth2.status, 401);

  const invalidOutApp = createApp({ tier: "p2" });
  invalidOutApp.get("/", async () => null);
  const internal1 = await invalidOutApp.serve({ method: "GET", path: "/", headers: {}, query: {}, body: "" });
  assert.equal(internal1.status, 500);

  const invalidRespApp = createApp({ tier: "p2" });
  invalidRespApp.get("/", async () => ({
    status: 200,
    body: "x",
    bodyStream: [Buffer.from("y")],
    isBase64: true,
  }));
  const internal2 = await invalidRespApp.serve({ method: "GET", path: "/", headers: {}, query: {}, body: "" });
  assert.equal(internal2.status, 500);
});

test("testkit: invokeLambdaFunctionURLStreaming streams first chunk and handles errors", async () => {
  const { createTestEnv, buildLambdaFunctionURLRequest } = await importDist("testkit.js");
  const { AppError } = await importDist("errors.js");

  const env = createTestEnv();
  const event = buildLambdaFunctionURLRequest("GET", "/");

  const okApp = {
    async serve() {
      async function* stream() {
        yield Buffer.from("a");
        yield Buffer.from("b");
      }
      return {
        status: 200,
        headers: { "x-test": ["ok"] },
        cookies: ["a=b"],
        body: Buffer.alloc(0),
        bodyStream: stream(),
        isBase64: false,
      };
    },
  };

  const ok = await env.invokeLambdaFunctionURLStreaming(okApp, event);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(ok.body).toString("utf8"), "ab");
  assert.deepEqual(ok.headers["x-test"], ["ok"]);
  assert.deepEqual(ok.cookies, ["a=b"]);
  assert.equal(ok.stream_error_code, "");

  const errorApp = {
    async serve() {
      async function* stream() {
        yield Buffer.from("x");
        throw new Error("boom");
      }
      return {
        status: 200,
        headers: { "x-request-id": ["req_1"] },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: stream(),
        isBase64: false,
      };
    },
  };

  const err = await env.invokeLambdaFunctionURLStreaming(errorApp, event);
  assert.equal(Buffer.from(err.body).toString("utf8"), "x");
  assert.equal(err.stream_error_code, "app.internal");

  const earlyErrApp = {
    async serve() {
      const stream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new AppError("app.bad_request", "bad stream");
            },
          };
        },
      };
      return {
        status: 200,
        headers: { "x-request-id": ["req_2"] },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: stream,
        isBase64: false,
      };
    },
  };

  const early = await env.invokeLambdaFunctionURLStreaming(earlyErrApp, event);
  assert.equal(early.status, 400);
  assert.match(Buffer.from(early.body).toString("utf8"), /app\.bad_request/);
});

test("ids: ManualIdGenerator supports queue, reset, and prefix sequencing", async () => {
  const { ManualIdGenerator } = await importDist("ids.js");

  const ids = new ManualIdGenerator({ prefix: "id", start: 3 });
  assert.equal(ids.newId(), "id-3");

  ids.queue("q1", "q2");
  assert.equal(ids.newId(), "q1");
  assert.equal(ids.newId(), "q2");

  ids.reset();
  assert.equal(ids.newId(), "id-1");
});
