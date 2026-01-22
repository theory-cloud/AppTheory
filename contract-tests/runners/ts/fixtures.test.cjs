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
