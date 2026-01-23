const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { runAllFixtures } = require("./run.cjs");

async function importDist(relPath) {
  const abs = path.join(process.cwd(), "ts", "dist", relPath);
  return import(pathToFileURL(abs).href);
}

function conditionalCheckFailed(message = "conditional check failed") {
  const err = new Error(message);
  err.name = "ConditionalCheckFailedException";
  return err;
}

function transactionCanceled(message = "transaction canceled") {
  const err = new Error(message);
  err.name = "TransactionCanceledException";
  return err;
}

class FakeDynamoDB {
  constructor() {
    this.items = new Map();
  }

  _key(pk, sk) {
    return `${pk}||${sk}`;
  }

  _getS(av) {
    return av && typeof av === "object" && "S" in av ? String(av.S) : "";
  }

  _getN(av) {
    if (!av || typeof av !== "object" || !("N" in av)) return 0;
    const n = Number(av.N);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }

  _applyUpdate(map, input) {
    const pk = this._getS(input?.Key?.PK);
    const sk = this._getS(input?.Key?.SK);
    const k = this._key(pk, sk);
    const existing = map.get(k);
    const item = existing ? JSON.parse(JSON.stringify(existing)) : {};

    const eav = input?.ExpressionAttributeValues ?? {};
    const inc = this._getN(eav[":inc"]);

    const cond = String(input?.ConditionExpression ?? "");
    if (cond.includes("#Count <")) {
      if (!("Count" in item)) throw conditionalCheckFailed();
      const limit = this._getN(eav[":limit"]);
      const current = this._getN(item.Count);
      if (!(current < limit)) throw conditionalCheckFailed();
    }
    if (cond.includes("attribute_not_exists") && cond.includes(":maxAllowed")) {
      const maxAllowed = this._getN(eav[":maxAllowed"]);
      const current = "Count" in item ? this._getN(item.Count) : 0;
      if ("Count" in item && !(current < maxAllowed)) {
        throw conditionalCheckFailed();
      }
    }

    const update = String(input?.UpdateExpression ?? "");
    if (update.includes("ADD #Count")) {
      const current = "Count" in item ? this._getN(item.Count) : 0;
      item.Count = { N: String(current + inc) };
    }
    if (":now" in eav) {
      item.UpdatedAt = eav[":now"];
    }
    if (update.includes("if_not_exists")) {
      const setIfMissing = (name, token) => {
        if (!(name in item) && token in eav) item[name] = eav[token];
      };
      setIfMissing("WindowType", ":wt");
      setIfMissing("WindowID", ":wid");
      setIfMissing("Identifier", ":id");
      setIfMissing("Resource", ":res");
      setIfMissing("Operation", ":op");
      setIfMissing("WindowStart", ":ws");
      setIfMissing("TTL", ":ttl");
      setIfMissing("CreatedAt", ":now");
    }

    map.set(k, item);

    if (input?.ReturnValues === "ALL_NEW") {
      return { Attributes: item };
    }
    return {};
  }

  async getItem(input) {
    const pk = this._getS(input?.Key?.PK);
    const sk = this._getS(input?.Key?.SK);
    const item = this.items.get(this._key(pk, sk));
    return item ? { Item: item } : {};
  }

  async putItem(input) {
    const pk = this._getS(input?.Item?.PK);
    const sk = this._getS(input?.Item?.SK);
    const k = this._key(pk, sk);
    if (input?.ConditionExpression && this.items.has(k)) {
      throw conditionalCheckFailed();
    }
    this.items.set(k, input.Item);
    return {};
  }

  async updateItem(input) {
    return this._applyUpdate(this.items, input);
  }

  async transactWriteItems(input) {
    const staged = new Map(this.items);
    try {
      for (const tx of input?.TransactItems ?? []) {
        if (tx?.Update) this._applyUpdate(staged, tx.Update);
      }
    } catch (err) {
      if (err && err.name === "ConditionalCheckFailedException") {
        throw transactionCanceled();
      }
      throw err;
    }

    this.items = staged;
    return {};
  }

  withoutTransactions() {
    const out = new FakeDynamoDB();
    out.items = this.items;
    out.transactWriteItems = undefined;
    return out;
  }
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

test("routing: handleStrict rejects invalid patterns", async () => {
  const { createApp } = await importDist("index.js");

  const app = createApp();
  assert.throws(
    () => app.handleStrict("GET", "/{proxy+}/x", () => ({ status: 200, headers: {}, cookies: [], body: "", isBase64: false })),
    /invalid route pattern/i,
  );
});

test("limited: dynamodb client sets x-amz-target and parses error type", async (t) => {
  const { DynamoDBClient } = await importDist("internal/aws-dynamodb.js");

  const prevFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prevFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const target = String(init?.headers?.["x-amz-target"] ?? "");
    if (target.includes("UpdateItem")) {
      return new Response(
        JSON.stringify({
          __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException",
          message: "nope",
        }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const c = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "SECRET_TEST" },
  });

  await c.getItem({ TableName: "t", Key: { PK: { S: "pk" }, SK: { S: "sk" } } });
  assert.ok(calls.length >= 1);
  assert.ok(String(calls[0].init?.headers?.["x-amz-target"] ?? "").includes("GetItem"));

  await assert.rejects(
    () =>
      c.updateItem({
        TableName: "t",
        Key: { PK: { S: "pk" }, SK: { S: "sk" } },
        UpdateExpression: "ADD #Count :inc",
      }),
    (err) => err && err.name === "ConditionalCheckFailedException",
  );
});

test("limited: checkAndIncrement creates and then denies", async () => {
  const { DynamoRateLimiter, FixedWindowStrategy } = await importDist("index.js");

  const dynamo = new FakeDynamoDB();
  // Avoid hour boundary where window starts can collide (minute/hour share the same window start).
  const clock = { now: () => new Date("2026-01-01T00:01:30.000Z") };
  const limiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy: new FixedWindowStrategy(60_000, 2),
  });

  const key = { identifier: "i1", resource: "/r", operation: "GET" };
  const d1 = await limiter.checkAndIncrement(key);
  assert.equal(d1.allowed, true);
  assert.equal(d1.currentCount, 1);

  const d2 = await limiter.checkAndIncrement(key);
  assert.equal(d2.allowed, true);
  assert.equal(d2.currentCount, 2);

  const d3 = await limiter.checkAndIncrement(key);
  assert.equal(d3.allowed, false);
  assert.equal(d3.currentCount, 2);
  assert.ok((d3.retryAfterMs ?? 0) >= 0);
});

test("limited: multiwindow transact increments and denies on window breach", async () => {
  const { DynamoRateLimiter, MultiWindowStrategy } = await importDist("index.js");

  const dynamo = new FakeDynamoDB();
  const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
  const strategy = new MultiWindowStrategy([
    { durationMs: 60_000, maxRequests: 2 },
    { durationMs: 3_600_000, maxRequests: 10 },
  ]);

  const limiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy,
  });

  const key = { identifier: "i1", resource: "/r", operation: "GET" };
  await limiter.checkAndIncrement(key);
  await limiter.checkAndIncrement(key);
  const d3 = await limiter.checkAndIncrement(key);
  assert.equal(d3.allowed, false);
  assert.equal(d3.limit, 2);
});

test("limited: error helpers preserve type and cause", async () => {
  const { RateLimiterError, newError, wrapError } = await importDist("index.js");

  const e1 = newError("invalid_input", "bad key");
  assert.ok(e1 instanceof RateLimiterError);
  assert.equal(e1.name, "RateLimiterError");
  assert.equal(e1.type, "invalid_input");
  assert.equal(e1.message, "bad key");
  assert.equal(e1.cause, null);

  const cause = new Error("boom");
  const e2 = wrapError(cause, "internal_error", "wrapped");
  assert.ok(e2 instanceof RateLimiterError);
  assert.equal(e2.type, "internal_error");
  assert.equal(e2.message, "wrapped");
  assert.equal(e2.cause, cause);
});

test("limited: models resolve table name and window helpers", async (t) => {
  const {
    formatRfc3339Nano,
    getFixedWindow,
    getMinuteWindow,
    rateLimitTableName,
    setKeys,
    unixSeconds,
  } = await importDist("index.js");

  const prev = {
    APPTHEORY_RATE_LIMIT_TABLE_NAME: process.env.APPTHEORY_RATE_LIMIT_TABLE_NAME,
    RATE_LIMIT_TABLE_NAME: process.env.RATE_LIMIT_TABLE_NAME,
    RATE_LIMIT_TABLE: process.env.RATE_LIMIT_TABLE,
    LIMITED_TABLE_NAME: process.env.LIMITED_TABLE_NAME,
  };
  t.after(() => {
    process.env.APPTHEORY_RATE_LIMIT_TABLE_NAME = prev.APPTHEORY_RATE_LIMIT_TABLE_NAME;
    process.env.RATE_LIMIT_TABLE_NAME = prev.RATE_LIMIT_TABLE_NAME;
    process.env.RATE_LIMIT_TABLE = prev.RATE_LIMIT_TABLE;
    process.env.LIMITED_TABLE_NAME = prev.LIMITED_TABLE_NAME;
  });

  process.env.APPTHEORY_RATE_LIMIT_TABLE_NAME = "  apptheory-rate-limits ";
  process.env.RATE_LIMIT_TABLE_NAME = "rate-limits-2";
  process.env.RATE_LIMIT_TABLE = "rate-limits-3";
  process.env.LIMITED_TABLE_NAME = "rate-limits-4";
  assert.equal(rateLimitTableName(), "apptheory-rate-limits");

  process.env.APPTHEORY_RATE_LIMIT_TABLE_NAME = "";
  assert.equal(rateLimitTableName(), "rate-limits-2");

  process.env.RATE_LIMIT_TABLE_NAME = "";
  assert.equal(rateLimitTableName(), "rate-limits-3");

  process.env.RATE_LIMIT_TABLE = "";
  assert.equal(rateLimitTableName(), "rate-limits-4");

  process.env.LIMITED_TABLE_NAME = "";
  assert.equal(rateLimitTableName(), "rate-limits");

  const now = new Date("2026-01-01T00:00:00.123Z");
  assert.equal(formatRfc3339Nano(now), "2026-01-01T00:00:00.123000000Z");

  const fixed = getFixedWindow(new Date("2026-01-01T00:00:01.234Z"), 1000);
  assert.equal(fixed.windowType, "CUSTOM_1000ms");
  assert.equal(unixSeconds(fixed.start), Math.floor(fixed.start.valueOf() / 1000));

  const bad = getFixedWindow(now, 0);
  assert.equal(bad.windowType, "CUSTOM_0ms");
  assert.equal(bad.start.valueOf(), now.valueOf());
  assert.equal(bad.end.valueOf(), now.valueOf());

  const minute = getMinuteWindow(new Date("2026-01-01T00:00:59.999Z"));
  assert.equal(minute.start.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(minute.end.toISOString(), "2026-01-01T00:01:00.000Z");

  const entry = {
    Identifier: "i1",
    WindowStart: 123,
    Resource: "/r",
    Operation: "GET",
  };
  setKeys(entry);
  assert.equal(entry.PK, "i1#123");
  assert.equal(entry.SK, "/r#GET");
});

test("limited: strategies calculate windows and enforce limits", async () => {
  const { FixedWindowStrategy, MultiWindowStrategy, SlidingWindowStrategy } =
    await importDist("index.js");

  const key = { identifier: "i1", resource: "/r", operation: "GET" };

  const fixed = new FixedWindowStrategy(60_000, 3);
  fixed.setIdentifierLimit("i1", 2);
  assert.equal(fixed.getLimit(key), 2);
  assert.equal(fixed.calculateWindows(new Date("2026-01-01T00:00:01.000Z")).length, 1);
  assert.equal(fixed.shouldAllow({ a: 1 }, 2), true);
  assert.equal(fixed.shouldAllow({ a: 2 }, 2), false);

  const sliding = new SlidingWindowStrategy(120_000, 5, 60_000);
  sliding.setResourceLimit("/r", 4);
  assert.equal(sliding.getLimit(key), 4);
  assert.ok(sliding.calculateWindows(new Date("2026-01-01T00:01:30.000Z")).length >= 1);

  const multi = new MultiWindowStrategy([
    { durationMs: 60_000, maxRequests: 2 },
    { durationMs: 3_600_000, maxRequests: 10 },
  ]);
  assert.equal(multi.getLimit(key), 2);
  const windows = multi.calculateWindows(new Date("2026-01-01T00:00:30.000Z"));
  assert.equal(windows.length, 2);
  assert.equal(
    multi.shouldAllow(
      {
        [`${windows[0].key}`]: 2,
        [`${windows[1].key}`]: 0,
      },
      0,
    ),
    false,
  );
});

test("limited: checkLimit denies with retryAfter and getUsage reads counts", async () => {
  const { DynamoRateLimiter, FixedWindowStrategy } = await importDist("index.js");

  const dynamo = new FakeDynamoDB();
  const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
  const limiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy: new FixedWindowStrategy(60_000, 2),
  });

  const key = { identifier: "i1", resource: "/r", operation: "GET" };
  await limiter.checkAndIncrement(key);
  await limiter.checkAndIncrement(key);

  const decision = await limiter.checkLimit(key);
  assert.equal(decision.allowed, false);
  assert.equal(decision.currentCount, 2);
  assert.equal(decision.limit, 2);
  assert.ok((decision.retryAfterMs ?? 0) >= 0);

  const usage = await limiter.getUsage(key);
  assert.equal(usage.identifier, "i1");
  assert.equal(usage.resource, "/r");
  assert.equal(usage.currentMinute.count, 2);
  assert.equal(usage.currentHour.count, 2);
});

test("limited: multiwindow falls back without transactWriteItems", async () => {
  const { DynamoRateLimiter, MultiWindowStrategy } = await importDist("index.js");

  const dynamo = new FakeDynamoDB().withoutTransactions();
  const clock = { now: () => new Date("2026-01-01T00:01:30.000Z") };
  const limiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy: new MultiWindowStrategy([
      { durationMs: 60_000, maxRequests: 2 },
      { durationMs: 3_600_000, maxRequests: 10 },
    ]),
  });

  const key = { identifier: "i1", resource: "/r", operation: "GET" };
  const d1 = await limiter.checkAndIncrement(key);
  assert.equal(d1.allowed, true);
  const d2 = await limiter.checkAndIncrement(key);
  assert.equal(d2.allowed, true);
  const d3 = await limiter.checkAndIncrement(key);
  assert.equal(d3.allowed, false);
});

test("aws-sigv4: loads env credentials and signs requests", async (t) => {
  const { isAwsCredentials, loadEnvCredentials, signedFetch } = await importDist(
    "internal/aws-sigv4.js",
  );

  assert.equal(isAwsCredentials(null), false);
  assert.equal(isAwsCredentials({}), false);
  assert.equal(
    isAwsCredentials({ accessKeyId: "AKIA_TEST", secretAccessKey: "SECRET" }),
    true,
  );

  const prevEnv = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  };
  t.after(() => {
    process.env.AWS_ACCESS_KEY_ID = prevEnv.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = prevEnv.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SESSION_TOKEN = prevEnv.AWS_SESSION_TOKEN;
  });

  process.env.AWS_ACCESS_KEY_ID = "AKIA_ENV";
  process.env.AWS_SECRET_ACCESS_KEY = "SECRET_ENV";
  process.env.AWS_SESSION_TOKEN = "TOKEN_ENV";
  const creds = loadEnvCredentials();
  assert.equal(creds.accessKeyId, "AKIA_ENV");
  assert.equal(creds.secretAccessKey, "SECRET_ENV");
  assert.equal(creds.sessionToken, "TOKEN_ENV");

  const prevFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prevFetch;
  });

  let sawHeaders = null;
  globalThis.fetch = async (_url, init) => {
    sawHeaders = init?.headers ?? null;
    return new Response("", { status: 200 });
  };

  await signedFetch({
    method: "POST",
    url: "https://example.com/x?y=1",
    region: "us-east-1",
    service: "dynamodb",
    credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "SECRET_TEST" },
    headers: { "x-test": "ok" },
    body: new Uint8Array([1, 2, 3]),
  });

  assert.ok(sawHeaders);
  assert.equal(String(sawHeaders.host ?? ""), "example.com");
  assert.equal(String(sawHeaders["x-test"] ?? ""), "ok");
  assert.ok(String(sawHeaders["x-amz-date"] ?? ""));
  assert.match(
    String(sawHeaders.authorization ?? ""),
    /^AWS4-HMAC-SHA256 Credential=/,
  );
});

test("aws-dynamodb: requires region when not provided", async (t) => {
  const { DynamoDBClient } = await importDist("internal/aws-dynamodb.js");

  const prevEnv = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };
  t.after(() => {
    process.env.AWS_REGION = prevEnv.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = prevEnv.AWS_DEFAULT_REGION;
  });

  process.env.AWS_REGION = "";
  process.env.AWS_DEFAULT_REGION = "";

  assert.throws(
    () =>
      new DynamoDBClient({
        region: "",
        credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "SECRET" },
      }),
    /aws region is empty/i,
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

test("context: helpers, json parsing, and websocket client validation", async () => {
  const { Context, EventContext, WebSocketContext } = await importDist("context.js");
  const { AppError } = await importDist("errors.js");
  const { ManualIdGenerator } = await importDist("ids.js");

  const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
  const ids = new ManualIdGenerator({ prefix: "id", start: 1 });

  const request = {
    method: "POST",
    path: "/x",
    headers: { "content-type": ["application/json"] },
    query: {},
    body: Buffer.from(JSON.stringify({ a: 1 }), "utf8"),
  };

  const ctx = new Context({ request, params: { p: "v" }, clock, ids, requestId: "req_1" });
  assert.equal(ctx.now().toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(ctx.newId(), "id-1");
  assert.equal(ctx.param("p"), "v");

  ctx.set("k", 123);
  assert.equal(ctx.get("k"), 123);
  ctx.set("   ", "ignored");
  assert.equal(ctx.get("   "), undefined);

  assert.deepEqual(ctx.jsonValue(), { a: 1 });

  const bad = new Context({
    request: { ...request, headers: { "content-type": ["text/plain"] } },
    clock,
    ids,
  });
  assert.throws(
    () => bad.jsonValue(),
    (err) => err instanceof AppError && err.code === "app.bad_request",
  );

  const evt = new EventContext({ clock, ids });
  assert.equal(evt.now().toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(evt.newId(), "id-2");
  evt.set("x", "y");
  assert.equal(evt.get("x"), "y");
  evt.set("", "ignored");
  assert.equal(evt.get(""), undefined);

  const wsMissingFactory = new WebSocketContext({
    connectionId: "c1",
    managementEndpoint: "https://example.com/ws",
    clock,
    ids,
  });
  await assert.rejects(() => wsMissingFactory.sendMessage(Buffer.from("x")), /missing websocket client factory/i);
  await assert.rejects(() => wsMissingFactory.sendMessage(Buffer.from("x")), /missing websocket client factory/i);

  const wsNullClient = new WebSocketContext({
    connectionId: "c1",
    managementEndpoint: "https://example.com/ws",
    clock,
    ids,
    clientFactory: async () => null,
  });
  await assert.rejects(() => wsNullClient.sendMessage(Buffer.from("x")), /returned null/i);
  await assert.rejects(() => wsNullClient.sendMessage(Buffer.from("x")), /returned null/i);

  const wsNoPost = new WebSocketContext({
    connectionId: "c1",
    managementEndpoint: "https://example.com/ws",
    clock,
    ids,
    clientFactory: async () => ({}),
  });
  await assert.rejects(() => wsNoPost.sendMessage(Buffer.from("x")), /missing postToConnection/i);

  const calls = [];
  const wsOk = new WebSocketContext({
    connectionId: "c1",
    managementEndpoint: "https://example.com/ws",
    clock,
    ids,
    clientFactory: async () => ({
      postToConnection: async (id, data) => {
        calls.push({ id, data: Buffer.from(data).toString("utf8") });
      },
    }),
  });
  await wsOk.sendMessage(Buffer.from("hi"));
  await wsOk.sendJSONMessage({ ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "c1");
});

test("response: serialization, streaming, and forwarded ip/origin parsing", async () => {
  const { clientIP, htmlStream, json, originURL, safeJSONForHTML } = await importDist("response.js");

  const circular = {};
  circular.self = circular;
  assert.throws(() => json(200, circular), /json serialization failed/i);
  assert.throws(() => safeJSONForHTML(circular), /json serialization failed/i);

  const streamResp = htmlStream(200, ["a", Buffer.from("b")]);
  const chunks = [];
  for await (const chunk of streamResp.bodyStream) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  assert.deepEqual(chunks, ["a", "b"]);

  assert.equal(
    originURL({ forwarded: ["for=1.1.1.1;proto=http;host=example.com"] }),
    "http://example.com",
  );
  assert.equal(originURL({ host: ["example.com"] }), "https://example.com");
  assert.equal(originURL({}), "");

  assert.equal(clientIP({ "cloudfront-viewer-address": ['"[2001:db8::1]:12345"'] }), "2001:db8::1");
  assert.equal(clientIP({ "x-forwarded-for": ["1.2.3.4, 5.6.7.8"] }), "1.2.3.4");
  assert.equal(clientIP({}), "");
});

test("limited: metadata trimming, sliding currentCount, and failOpen behavior", async () => {
  const { DynamoRateLimiter, FixedWindowStrategy, SlidingWindowStrategy } = await importDist("index.js");

  const clock = { now: () => new Date("2026-01-01T00:01:30.000Z") };
  const dynamo = new FakeDynamoDB();
  const limiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy: new FixedWindowStrategy(60_000, 2),
  });

  await limiter.checkAndIncrement({
    identifier: "i1",
    resource: "/r",
    operation: "GET",
    metadata: { "": "ignored", " ip ": "127.0.0.1" },
  });

  const created = [...dynamo.items.values()][0];
  assert.ok(created?.Metadata?.M);
  assert.ok(!("" in created.Metadata.M));
  assert.ok("ip" in created.Metadata.M);

  const sliding = new SlidingWindowStrategy(120_000, 5, 60_000);
  const now = clock.now();
  const windows = sliding.calculateWindows(now);
  const sk = "/r#GET";
  let expected = 0;
  windows.forEach((w, idx) => {
    const count = idx + 1;
    expected += count;
    const pk = `i1#${Math.floor(w.start.valueOf() / 1000)}`;
    dynamo.items.set(`${pk}||${sk}`, { PK: { S: pk }, SK: { S: sk }, Count: { N: String(count) } });
  });

  const slidingLimiter = new DynamoRateLimiter({
    dynamo,
    clock,
    config: { failOpen: false },
    strategy: sliding,
  });
  const decision = await slidingLimiter.checkLimit({ identifier: "i1", resource: "/r", operation: "GET" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.currentCount, expected);

  class FailingDynamoDB {
    async updateItem() {
      throw new Error("boom");
    }
  }

  const failOpenLimiter = new DynamoRateLimiter({
    dynamo: new FailingDynamoDB(),
    clock,
    config: { failOpen: true },
    strategy: new FixedWindowStrategy(60_000, 2),
  });
  const ok = await failOpenLimiter.checkAndIncrement({ identifier: "i1", resource: "/r", operation: "GET" });
  assert.equal(ok.allowed, true);

  const failClosedLimiter = new DynamoRateLimiter({
    dynamo: new FailingDynamoDB(),
    clock,
    config: { failOpen: false },
    strategy: new FixedWindowStrategy(60_000, 2),
  });
  await assert.rejects(
    () => failClosedLimiter.checkAndIncrement({ identifier: "i1", resource: "/r", operation: "GET" }),
    (err) => err && err.name === "RateLimiterError",
  );
});
