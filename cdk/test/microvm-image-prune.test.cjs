// Unit tests for the AppTheoryMicrovmImage version-prune handler.
//
// The handler is deployed as inline Lambda code (a plain CommonJS string with no
// runtime dependencies), so these tests load the compiled source out of the
// `@internal` module and evaluate it in a sandbox where `fetch` is mocked. The
// request shapes asserted here are pinned against the Lambda MicroVMs control
// plane as exposed by the pinned `lambdamicrovms` AWS SDK v1.0.0
// (aws-sdk-go-v2 service model, smithy REST-JSON protocol):
//
// - ListMicrovmImageVersions: GET /2025-09-09/microvm-images/{imageIdentifier}/versions
// - DeleteMicrovmImageVersion: DELETE /2025-09-09/microvm-images/{imageIdentifier}/versions/{imageVersion}
//
// with SigV4 signing name `lambda` on host `lambda.{region}.amazonaws.com`.
//
// The SigV4 golden values asserted below (canonical request + signature) were
// derived by running the real pinned `lambdamicrovms` v1.0.0 client and signer
// (aws-sdk-go-v2 v1.43.5) with a recording transport and LogSigning at the same
// fixed timestamp; they are hardcoded so the test cannot share the handler's
// canonicalization assumption. The SDK signer re-escapes the already-escaped
// wire path for the canonical URI (`escapePath(uriPath, false)`), so the wire
// path stays single-encoded while the canonical URI is double-encoded.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { MICROVM_IMAGE_PRUNE_HANDLER_SOURCE } = require("../lib/private/microvm-image-prune-handler");

const IMAGE_ARN = "arn:aws:lambda:us-east-1:123456789012:microvm-image:apptheory-microvm-image";
const ESCAPED_IMAGE_ARN =
  "arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Amicrovm-image%3Aapptheory-microvm-image";
const REGION = "us-east-1";
const FIXED_NOW = new Date("2026-08-28T12:34:56.789Z");

const ENV = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  AWS_SESSION_TOKEN: "SESSIONTOKEN123",
};

function loadHandlerModule(fetchImpl) {
  const moduleObj = { exports: {} };
  const realRequire = require;
  const sandboxRequire = (id) => {
    if (id === "node:crypto") {
      return realRequire("node:crypto");
    }
    throw new Error(`handler must not require external modules: ${id}`);
  };
  const sandboxFetch =
    fetchImpl ||
    (async () => {
      throw new Error("no fetch mock installed for this test");
    });
  const factory = new Function(
    "module",
    "exports",
    "require",
    "process",
    "console",
    "fetch",
    MICROVM_IMAGE_PRUNE_HANDLER_SOURCE,
  );
  factory(moduleObj, moduleObj.exports, sandboxRequire, process, console, sandboxFetch);
  return moduleObj.exports;
}

async function withEnv(env, body) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
  }
  for (const key of Object.keys(env)) {
    process.env[key] = env[key];
  }
  try {
    return await body();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

// Captures every request the handler makes and answers them from a route table.
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const route = routes.find((r) => r.match(url, options));
    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${url}` }), { status: 500 });
    }
    return route.respond(url, options);
  };
  return { calls, impl };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listRoute(items, status = 200, pageBody = {}) {
  return {
    match: (url, options) => options.method === "GET" && url.includes("/versions"),
    respond: () => jsonResponse({ items, ...pageBody }, status),
  };
}

function deleteRoute(status = 200, body = {}) {
  return {
    match: (url, options) => options.method === "DELETE",
    respond: () => jsonResponse({ imageIdentifier: IMAGE_ARN, imageVersion: "1", state: "DELETED", ...body }, status),
  };
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("prune: no versions is a no-op success", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const { calls, impl } = mockFetch([listRoute([])]);
  const logs = [];
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
      logImpl: (message) => logs.push(message),
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 0, versionsDeleted: 0, versionsSkipped: 0 });
  assert.equal(calls.length, 1, "one list call, no delete calls");
  assert.equal(calls[0].options.method, "GET");
  assert.ok(logs.some((line) => line.includes("versions seen=0 deleted=0 skipped=0 kept=<none>")));
});

test("prune: single active version is a no-op", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const { calls, impl } = mockFetch([listRoute([{ imageVersion: "1", status: "ACTIVE", createdAt: 100 }])]);
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 1, versionsDeleted: 0, versionsSkipped: 0 });
  assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 0);
});

test("prune: deletes every version older than the two newest active", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const versions = [
    { imageVersion: "1", status: "INACTIVE", createdAt: 100 },
    { imageVersion: "2", status: "INACTIVE", createdAt: 200 },
    { imageVersion: "3", status: "ACTIVE", createdAt: 300 },
    { imageVersion: "4", status: "ACTIVE", createdAt: 400 },
  ];
  const { calls, impl } = mockFetch([listRoute(versions), deleteRoute()]);
  const logs = [];
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
      logImpl: (message) => logs.push(message),
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 4, versionsDeleted: 2, versionsSkipped: 0 });
  const deleted = calls.filter((c) => c.options.method === "DELETE");
  assert.equal(deleted.length, 2);
  assert.deepEqual(
    deleted.map((c) => c.url),
    [
      `https://lambda.${REGION}.amazonaws.com/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions/1`,
      `https://lambda.${REGION}.amazonaws.com/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions/2`,
    ],
    "versions 3 and 4 (the two newest active) must not be deleted",
  );
  assert.ok(logs.some((line) => line.includes("versions seen=4 deleted=2 skipped=0 kept=4,3")));
});

test("prune: two active versions are both kept (safety copy)", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const versions = [
    { imageVersion: "1", status: "ACTIVE", createdAt: 100 },
    { imageVersion: "2", status: "ACTIVE", createdAt: 200 },
  ];
  const { calls, impl } = mockFetch([listRoute(versions), deleteRoute()]);
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 2, versionsDeleted: 0, versionsSkipped: 0 });
  assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 0, "both active versions are kept");
});

test("prune: same-second active versions tiebreak on version number for the second keep slot", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const versions = [
    { imageVersion: "8", status: "ACTIVE", createdAt: 100 },
    { imageVersion: "10", status: "ACTIVE", createdAt: 200 },
    { imageVersion: "9", status: "ACTIVE", createdAt: 200 },
  ];
  const { calls, impl } = mockFetch([listRoute(versions), deleteRoute()]);
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 3, versionsDeleted: 1, versionsSkipped: 0 });
  const deleted = calls.filter((c) => c.options.method === "DELETE");
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0].url.endsWith("/versions/8"), "keeps versions 10 and 9; prunes 8");
});

test("prune: no active version attempts to delete everything", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const versions = [
    { imageVersion: "1", status: "INACTIVE", createdAt: 100 },
    { imageVersion: "2", status: "FAILED", createdAt: 200 },
  ];
  const { calls, impl } = mockFetch([listRoute(versions), deleteRoute()]);
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 2, versionsDeleted: 2, versionsSkipped: 0 });
});

test("prune: per-version delete refusal is skipped and does not fail the run", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const versions = [
    { imageVersion: "1", status: "INACTIVE", createdAt: 100 },
    { imageVersion: "2", status: "INACTIVE", createdAt: 200 },
    { imageVersion: "3", status: "ACTIVE", createdAt: 300 },
  ];
  const refusingDelete = {
    match: (url, options) => options.method === "DELETE" && url.endsWith("/versions/1"),
    respond: () =>
      new Response(JSON.stringify({ message: "version in use by running microvms" }), { status: 409 }),
  };
  const { calls, impl } = mockFetch([listRoute(versions), refusingDelete, deleteRoute()]);
  const logs = [];
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
      logImpl: (message) => logs.push(message),
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 3, versionsDeleted: 1, versionsSkipped: 1 });
  const deleted = calls.filter((c) => c.options.method === "DELETE");
  assert.equal(deleted.length, 2);
  assert.ok(deleted[1].url.endsWith("/versions/2"), "continues past the refused version");
  assert.ok(logs.some((line) => line.includes("skipping version 1: microvm-image-prune: DELETE")));
  assert.ok(logs.some((line) => line.includes("HTTP 409")));
  assert.ok(logs.some((line) => line.includes("versions seen=3 deleted=1 skipped=1 kept=3")));
});

test("prune: list failure fails loudly", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const { calls, impl } = mockFetch([
    {
      match: (url, options) => options.method === "GET",
      respond: () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    },
  ]);
  await assert.rejects(
    withEnv(ENV, () =>
      pruneMicrovmImageVersions({
        imageIdentifier: IMAGE_ARN,
        region: REGION,
        now: FIXED_NOW,
        fetchImpl: impl,
      }),
    ),
    /HTTP 403/,
  );
  assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 0, "no deletes after a failed list");
});

test("prune: 404 on the version list is nothing to prune", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const notFoundList = {
    match: (url, options) => options.method === "GET",
    respond: () =>
      new Response(
        JSON.stringify({
          message: "MicrovmImageNotFoundException",
          __type: "ResourceNotFoundException",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  };
  const { calls, impl } = mockFetch([notFoundList]);
  const logs = [];
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
      logImpl: (message) => logs.push(message),
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 0, versionsDeleted: 0, versionsSkipped: 0 });
  assert.equal(calls.length, 1, "one list call, no delete calls");
  assert.ok(logs.some((line) => line.includes("list returned 404: image not present; nothing to prune")));
  assert.ok(logs.some((line) => line.includes("versions seen=0 deleted=0 skipped=0 kept=<none>")));
});

test("prune: transport failure on list fails loudly", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const impl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    withEnv(ENV, () =>
      pruneMicrovmImageVersions({
        imageIdentifier: IMAGE_ARN,
        region: REGION,
        now: FIXED_NOW,
        fetchImpl: impl,
      }),
    ),
    /ECONNREFUSED/,
  );
});

test("prune: paginates with nextToken", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const firstPage = {
    match: (url, options) => options.method === "GET" && !url.includes("nextToken="),
    respond: () =>
      jsonResponse({
        items: [{ imageVersion: "1", status: "INACTIVE", createdAt: 100 }],
        nextToken: "page-2-token",
      }),
  };
  const secondPage = {
    match: (url, options) => options.method === "GET" && url.includes("nextToken=page-2-token"),
    respond: () =>
      jsonResponse({
        items: [{ imageVersion: "2", status: "ACTIVE", createdAt: 200 }],
      }),
  };
  const { calls, impl } = mockFetch([firstPage, secondPage, deleteRoute()]);
  const summary = await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  assert.deepEqual(summary, { versionsSeen: 2, versionsDeleted: 1, versionsSkipped: 0 });
  const lists = calls.filter((c) => c.options.method === "GET");
  assert.equal(lists.length, 2);
  assert.ok(lists[0].url.endsWith("?maxResults=50"), "first page carries maxResults=50 and no nextToken");
  assert.ok(lists[1].url.includes("maxResults=50&nextToken=page-2-token"), "second page keeps maxResults=50 alongside nextToken");
  assert.ok(lists[1].url.endsWith("?maxResults=50&nextToken=page-2-token"));
});

test("request shape: list versions GET against the verified API path", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const { calls, impl } = mockFetch([listRoute([])]);
  await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  const call = calls[0];
  assert.equal(call.options.method, "GET");
  assert.equal(
    call.url,
    `https://lambda.${REGION}.amazonaws.com/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions?maxResults=50`,
  );
  const headers = call.options.headers;
  assert.equal(headers.host, `lambda.${REGION}.amazonaws.com`);
  assert.equal(headers["x-amz-content-sha256"], EMPTY_SHA256, "empty body payload hash");
  assert.equal(headers["x-amz-date"], "20260828T123456Z");
  assert.equal(headers["x-amz-security-token"], ENV.AWS_SESSION_TOKEN);
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260828\/us-east-1\/lambda\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
});

test("request shape: delete version DELETE with version in path and no query", async () => {
  const { pruneMicrovmImageVersions } = loadHandlerModule();
  const { calls, impl } = mockFetch([
    listRoute([{ imageVersion: "1", status: "INACTIVE", createdAt: 100 }]),
    deleteRoute(),
  ]);
  await withEnv(ENV, () =>
    pruneMicrovmImageVersions({
      imageIdentifier: IMAGE_ARN,
      region: REGION,
      now: FIXED_NOW,
      fetchImpl: impl,
    }),
  );
  const call = calls[1];
  assert.equal(call.options.method, "DELETE");
  assert.equal(
    call.url,
    `https://lambda.${REGION}.amazonaws.com/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions/1`,
  );
  assert.ok(!call.url.includes("?"), "DELETE carries no query string");
  assert.equal(call.options.headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.match(call.options.headers.authorization, /Credential=AKIDEXAMPLE\/20260828\/us-east-1\/lambda\/aws4_request/);
});

test("request shape: SigV4 canonical URI is double-encoded (pinned to the real SDK signer)", async () => {
  const { signV4 } = loadHandlerModule();
  const signed = signV4({
    method: "GET",
    path: `/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions`,
    query: { maxResults: "100" },
    host: `lambda.${REGION}.amazonaws.com`,
    region: REGION,
    now: FIXED_NOW,
    payloadHash: EMPTY_SHA256,
    credentials: {
      accessKeyId: ENV.AWS_ACCESS_KEY_ID,
      secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
      sessionToken: ENV.AWS_SESSION_TOKEN,
    },
  });
  // Golden canonical request and signature emitted by the REAL
  // lambdamicrovms v1.0.0 signer (aws-sdk-go-v2 v1.43.5, smithy
  // httpbinding.EscapePath(uriPath, false)) with LogSigning at the same
  // fixed timestamp. The SDK re-escapes the already-escaped wire path for
  // the canonical URI: the single-encoded wire path `arn%3A...%3A...`
  // signs as the double-encoded `arn%253A...%253A...`. These values are
  // hardcoded so the test cannot share the implementation's assumption.
  const goldenCanonicalRequest = [
    "GET",
    "/2025-09-09/microvm-images/arn%253Aaws%253Alambda%253Aus-east-1%253A123456789012%253Amicrovm-image%253Aapptheory-microvm-image/versions",
    "maxResults=100",
    "host:lambda.us-east-1.amazonaws.com",
    "x-amz-content-sha256:" + EMPTY_SHA256,
    "x-amz-date:20260828T123456Z",
    "x-amz-security-token:" + ENV.AWS_SESSION_TOKEN,
    "",
    "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    EMPTY_SHA256,
  ].join("\n");
  assert.equal(signed.canonicalRequest, goldenCanonicalRequest);
  const signature = signed.headers.authorization.match(/Signature=([0-9a-f]{64})/)[1];
  assert.equal(signature, "47c9fec7874b48f813d35eeb4b2fbc5ad29a9bf4a210ca965cef21c19be649a3");
  assert.equal(signed.headers.authorization, [
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260828/us-east-1/lambda/aws4_request",
    "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    "Signature=47c9fec7874b48f813d35eeb4b2fbc5ad29a9bf4a210ca965cef21c19be649a3",
  ].join(", "));
});

test("request shape: delete SigV4 canonical URI is double-encoded (pinned to the real SDK signer)", async () => {
  const { signV4 } = loadHandlerModule();
  const signed = signV4({
    method: "DELETE",
    path: `/2025-09-09/microvm-images/${ESCAPED_IMAGE_ARN}/versions/1`,
    query: {},
    host: `lambda.${REGION}.amazonaws.com`,
    region: REGION,
    now: FIXED_NOW,
    payloadHash: EMPTY_SHA256,
    credentials: {
      accessKeyId: ENV.AWS_ACCESS_KEY_ID,
      secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
      sessionToken: ENV.AWS_SESSION_TOKEN,
    },
  });
  assert.equal(
    signed.canonicalRequest.split("\n")[1],
    "/2025-09-09/microvm-images/arn%253Aaws%253Alambda%253Aus-east-1%253A123456789012%253Amicrovm-image%253Aapptheory-microvm-image/versions/1",
  );
  const signature = signed.headers.authorization.match(/Signature=([0-9a-f]{64})/)[1];
  assert.equal(signature, "fc3b675b26eeb00f58fa76b40fe6c850d882ed366cc92a32d0c788c01718f021");
});

test("request shape: escaping matches the SDK Amazon path-escape style", async () => {
  const { escapePathComponent } = loadHandlerModule();
  assert.equal(escapePathComponent(IMAGE_ARN), ESCAPED_IMAGE_ARN);
  assert.equal(escapePathComponent("a/b c"), "a%2Fb%20c");
  assert.equal(escapePathComponent("abc-._~123"), "abc-._~123");
});

test("handler: Delete request type returns success without calling the API", async () => {
  const { handler } = loadHandlerModule();
  const result = await withEnv(ENV, () =>
    handler({ RequestType: "Delete", PhysicalResourceId: "phys-id", LogicalResourceId: "ImagePrune" }),
  );
  assert.deepEqual(result, {});
});

test("handler: Create/Update prune and return a summary in Data", async () => {
  const { calls, impl } = mockFetch([listRoute([{ imageVersion: "1", status: "ACTIVE", createdAt: 100 }])]);
  const { handler } = loadHandlerModule(impl);
  const result = await withEnv(
    {
      ...ENV,
      APPTHEORY_MICROVM_IMAGE_ARN: IMAGE_ARN,
      APPTHEORY_MICROVM_IMAGE_REGION: REGION,
      AWS_REGION: REGION,
    },
    () =>
      handler({
        RequestType: "Create",
        RequestId: "req-1",
        LogicalResourceId: "ImagePrune",
        ResourceProperties: {},
      }),
  );
  assert.deepEqual(result.Data, { VersionsSeen: 1, VersionsDeleted: 0, VersionsSkipped: 0 });
  assert.equal(calls.length, 1, "Create prunes once");
});

test("handler: Create against a 404 version list succeeds (image does not exist yet)", async () => {
  const notFoundList = {
    match: (url, options) => options.method === "GET",
    respond: () =>
      new Response(
        JSON.stringify({
          message: "MicrovmImageNotFoundException",
          __type: "ResourceNotFoundException",
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  };
  const { calls, impl } = mockFetch([notFoundList]);
  const { handler } = loadHandlerModule(impl);
  const result = await withEnv(
    {
      ...ENV,
      APPTHEORY_MICROVM_IMAGE_ARN: IMAGE_ARN,
      APPTHEORY_MICROVM_IMAGE_REGION: REGION,
      AWS_REGION: REGION,
    },
    () =>
      handler({
        RequestType: "Create",
        RequestId: "req-1",
        LogicalResourceId: "ImagePrune",
        ResourceProperties: {},
      }),
  );
  assert.deepEqual(result.Data, { VersionsSeen: 0, VersionsDeleted: 0, VersionsSkipped: 0 });
  assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 0, "no deletes when the image does not exist");
});

test("handler: Create without the image ARN env fails loudly", async () => {
  const { handler } = loadHandlerModule();
  await assert.rejects(
    withEnv(ENV, () =>
      handler({
        RequestType: "Create",
        RequestId: "req-1",
        LogicalResourceId: "ImagePrune",
        ResourceProperties: {},
      }),
    ),
    /APPTHEORY_MICROVM_IMAGE_ARN/,
  );
});

test("handler: list failure propagates so the deployment fails loudly", async () => {
  const { impl } = mockFetch([
    {
      match: () => true,
      respond: () => new Response("upstream error", { status: 502 }),
    },
  ]);
  const { handler } = loadHandlerModule(impl);
  await assert.rejects(
    withEnv(
      {
        ...ENV,
        APPTHEORY_MICROVM_IMAGE_ARN: IMAGE_ARN,
        APPTHEORY_MICROVM_IMAGE_REGION: REGION,
        AWS_REGION: REGION,
      },
      () =>
        handler({
          RequestType: "Update",
          RequestId: "req-1",
          LogicalResourceId: "ImagePrune",
          PhysicalResourceId: "phys-1",
          ResourceProperties: {},
        }),
    ),
    /HTTP 502/,
  );
});
