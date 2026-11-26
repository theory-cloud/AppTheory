// Purpose: the clean-consumer call path for the packed AppTheory TypeScript
// runtime.
//
// This file is copied into a directory that holds nothing but the installed
// tarball (and therefore the real `@theory-cloud/tabletheory-ts` release asset
// the tarball depends on), and is then run with `node consumer.mjs`. It imports
// only published entry points, drives one real `handleLambda` request through
// API Gateway v2 dispatch, and asserts the canonical response and the canonical
// fail-closed 404 envelope.
//
// It is deliberately not a test framework: the gate is the process exit code, so
// an assertion failure throws and the install is not proven.

import assert from "node:assert/strict";

import { createApp, text } from "@theory-cloud/apptheory";

const app = createApp();

app.get("/ping", () => text(200, "pong"));

function apiGatewayV2Request(method, path) {
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { host: "example.com" },
    requestContext: {
      accountId: "000000000000",
      apiId: "consumerinstall",
      domainName: "example.com",
      domainPrefix: "consumerinstall",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "apptheory-consumer-install",
      },
      requestId: "consumer-install-request",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1767225600000,
    },
    body: undefined,
    isBase64Encoded: false,
  };
}

// The runtime's data layer must be a real, importable dependency, not a name
// that only appears in package.json.
const tableTheory = await import("@theory-cloud/tabletheory-ts");
assert.ok(
  tableTheory !== null && typeof tableTheory === "object",
  "@theory-cloud/tabletheory-ts did not load",
);
assert.ok(
  Object.keys(tableTheory).length > 0,
  "@theory-cloud/tabletheory-ts exports nothing",
);

const ok = await app.handleLambda(apiGatewayV2Request("GET", "/ping"), {
  awsRequestId: "consumer-install-request",
});
assert.equal(ok.statusCode, 200, `expected 200, got ${ok.statusCode}`);
assert.equal(ok.body, "pong", `expected "pong", got ${JSON.stringify(ok.body)}`);

const missing = await app.handleLambda(apiGatewayV2Request("GET", "/absent"), {
  awsRequestId: "consumer-install-request",
});
assert.equal(
  missing.statusCode,
  404,
  `expected the fail-closed 404 envelope, got ${missing.statusCode}`,
);
assert.ok(
  typeof missing.body === "string" && missing.body.length > 0,
  "the fail-closed 404 envelope carried no body",
);

const tierApp = createApp({ tier: "p0" });
assert.ok(
  typeof tierApp.handleLambda === "function",
  "createApp({ tier: \"p0\" }) did not return an app",
);

console.log(
  `consumer-install(ts): handleLambda GET /ping -> ${ok.statusCode} ${JSON.stringify(ok.body)}, ` +
    `GET /absent -> ${missing.statusCode}, tabletheory-ts ${tableTheory ? "loaded" : "missing"}`,
);
