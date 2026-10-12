import test from "node:test";
import assert from "node:assert/strict";

import {
  createApp,
  createLambdaFunctionURLStreamingHandler,
  htmlStream,
} from "../dist/index.js";

// R1 parity for the only other response-streaming adapter in the framework: the
// Lambda Function URL streaming handler. It must hand a portable bodyStream to
// the transport as bytes (never an empty 200) and must unwind the body's
// producer before it returns, including when the transport write fails.

class CaptureResponseStream {
  constructor({ failAfter = -1 } = {}) {
    this.statusCode = 0;
    this.headers = {};
    this.cookies = [];
    this.chunks = [];
    this.ended = false;
    this.failAfter = failAfter;
  }

  init(meta) {
    this.statusCode = Number(meta?.statusCode ?? 0);
    this.headers = { ...(meta?.headers ?? {}) };
    this.cookies = [...(meta?.cookies ?? [])];
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk ?? []));
    if (this.failAfter >= 0 && this.chunks.length > this.failAfter) {
      throw new Error("client disconnected");
    }
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.ended = true;
  }
}

function lambdaFunctionURLEvent(path) {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path } },
    body: "",
    isBase64Encoded: false,
  };
}

function streamingHandler(app) {
  globalThis.awslambda = { streamifyResponse: (handler) => handler };
  return createLambdaFunctionURLStreamingHandler(app);
}

function sseChunks(...chunks) {
  return (async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk, "utf8");
    }
  })();
}

function sourceProvenanceRoute(app) {
  app.get("/source", (ctx) => {
    const provenance = ctx.sourceProvenance();
    return {
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      cookies: [],
      body: Buffer.from(JSON.stringify({ provider: provenance.provider }), "utf8"),
      isBase64: false,
    };
  });
}

test("handleLambda discriminates real Function URL events from API Gateway v2", async () => {
  const app = createApp();
  sourceProvenanceRoute(app);

  // A standard Function URL payload carries a top-level routeKey of "$default"
  // and a *.lambda-url.*.on.aws requestContext domainName.
  const functionURL = {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/source",
    rawQueryString: "",
    cookies: [],
    headers: {},
    requestContext: {
      domainName: "abcd1234.lambda-url.us-east-1.on.aws",
      http: { method: "GET", path: "/source", sourceIp: "198.51.100.10" },
    },
    body: "",
    isBase64Encoded: false,
  };

  const urlOut = await app.handleLambda(functionURL);
  assert.equal(urlOut.statusCode, 200);
  assert.deepEqual(JSON.parse(String(urlOut.body)), { provider: "lambda-url" });

  // API Gateway v2 default and custom domains both carry routeKey, so they must
  // stay on the API Gateway v2 adapter.
  for (const domainName of [
    "abcd1234.execute-api.us-east-1.amazonaws.com",
    "api.example.com",
  ]) {
    const v2Out = await app.handleLambda({
      ...functionURL,
      routeKey: "GET /source",
      requestContext: {
        domainName,
        http: { method: "GET", path: "/source", sourceIp: "198.51.100.11" },
      },
    });
    assert.equal(v2Out.statusCode, 200);
    assert.deepEqual(JSON.parse(String(v2Out.body)), { provider: "apigw-v2" });
  }
});

test("function url streaming adapter streams a bodyStream to the transport", async () => {
  const app = createApp();
  app.get("/sse", () => htmlStream(200, sseChunks("one", "two")));

  const out = new CaptureResponseStream();
  try {
    await streamingHandler(app)(lambdaFunctionURLEvent("/sse"), out, undefined);
  } finally {
    delete globalThis.awslambda;
  }

  assert.equal(out.statusCode, 200);
  assert.equal(Buffer.concat(out.chunks).toString("utf8"), "onetwo");
  assert.equal(out.ended, true);
});

test("function url streaming adapter unwinds the producer when a later write fails", async () => {
  const app = createApp();
  let unwound = false;
  app.get("/sse", () =>
    htmlStream(
      200,
      (async function* () {
        try {
          yield Buffer.from("one");
          yield Buffer.from("two");
          yield Buffer.from("three");
        } finally {
          unwound = true;
        }
      })(),
    ),
  );

  const out = new CaptureResponseStream({ failAfter: 1 });
  try {
    await streamingHandler(app)(lambdaFunctionURLEvent("/sse"), out, undefined);
  } finally {
    delete globalThis.awslambda;
  }

  assert.equal(unwound, true, "the body producer was still suspended when the adapter returned");
  assert.equal(out.ended, true);
});

test("function url streaming adapter unwinds the producer when the first write fails", async () => {
  const app = createApp();
  let unwound = false;
  app.get("/sse", () =>
    htmlStream(
      200,
      (async function* () {
        try {
          yield Buffer.from("one");
          yield Buffer.from("two");
        } finally {
          unwound = true;
        }
      })(),
    ),
  );

  const out = new CaptureResponseStream({ failAfter: 0 });
  let rejection;
  try {
    await streamingHandler(app)(lambdaFunctionURLEvent("/sse"), out, undefined);
  } catch (err) {
    rejection = err;
  } finally {
    delete globalThis.awslambda;
  }

  assert.equal(rejection, undefined, `the adapter rejected instead of closing the body: ${rejection}`);
  assert.equal(unwound, true, "the body producer was still suspended when the adapter returned");
  assert.equal(out.ended, true);
});
