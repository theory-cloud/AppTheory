import test from "node:test";
import assert from "node:assert/strict";

import {
  AppError,
  AppTheoryError,
  appTheoryErrorFromAppError,
  getLogger,
  isAppTheoryError,
  setLogger,
} from "../dist/index.js";
import {
  normalizeSourceProvenance,
  sourceProvenanceFromProviderRequestContext,
  unknownSourceProvenance,
} from "../dist/internal/source-provenance.js";

test("logger default and replacement paths", () => {
  setLogger(null);
  const noop = getLogger();
  noop.debug("debug", { a: 1 });
  noop.info("info");
  noop.warn("warn");
  noop.error("error");
  assert.equal(noop.withField("k", "v"), noop);
  assert.equal(noop.withFields({ k: "v" }), noop);
  assert.equal(noop.withRequestID("req_1"), noop);
  assert.equal(noop.withTenantID("tenant_1"), noop);
  assert.equal(noop.withUserID("user_1"), noop);
  assert.equal(noop.withTraceID("trace_1"), noop);
  assert.equal(noop.withSpanID("span_1"), noop);
  assert.equal(noop.isHealthy(), true);
  assert.deepEqual(noop.getStats(), {});

  const custom = { ...noop, isHealthy: () => false, getStats: () => ({ ok: false }) };
  setLogger(custom);
  assert.equal(getLogger(), custom);
  assert.equal(getLogger().isHealthy(), false);
  assert.deepEqual(getLogger().getStats(), { ok: false });
});

test("error helpers preserve portable metadata", () => {
  const cause = new Error("root");
  const err = new AppTheoryError("app.conflict", "conflict", {
    statusCode: 409,
    details: { field: "name" },
    requestId: "req_1",
    traceId: "trace_1",
    timestamp: new Date("2026-05-14T12:00:00.000Z"),
    stackTrace: "stack",
    cause,
  })
    .withDetails({ field: "other" })
    .withRequestID("req_2")
    .withTraceID("trace_2")
    .withTimestamp("2026-05-14T13:00:00.000Z")
    .withStackTrace("stack2")
    .withStatusCode(410)
    .withCause(cause);

  assert.equal(isAppTheoryError(err), true);
  assert.equal(err.statusCode, 410);
  assert.equal(err.requestId, "req_2");
  assert.equal(err.traceId, "trace_2");
  assert.equal(err.timestamp, "2026-05-14T13:00:00.000Z");
  assert.equal(err.stackTrace, "stack2");
  assert.equal(err.cause, cause);

  const appErr = new AppError("app.not_found", "missing");
  const converted = appTheoryErrorFromAppError(appErr);
  assert.equal(converted.code, "app.not_found");
  assert.equal(converted.message, "missing");
});

test("source provenance normalizes provider request context", () => {
  assert.deepEqual(unknownSourceProvenance(), {
    sourceIP: "",
    provider: "unknown",
    source: "unknown",
    valid: false,
  });

  assert.deepEqual(sourceProvenanceFromProviderRequestContext("bad", "127.0.0.1"), unknownSourceProvenance());
  assert.deepEqual(sourceProvenanceFromProviderRequestContext("apigw-v2", "bad"), unknownSourceProvenance());

  const ipv4 = sourceProvenanceFromProviderRequestContext("apigw-v2", " 127.0.0.1 ");
  assert.equal(ipv4.valid, true);
  assert.equal(ipv4.sourceIP, "127.0.0.1");

  const mapped = sourceProvenanceFromProviderRequestContext("lambda-url", "0:0:0:0:0:ffff:192.0.2.128");
  assert.equal(mapped.sourceIP, "::ffff:192.0.2.128");

  const compressed = sourceProvenanceFromProviderRequestContext("apigw-v1", "2001:0db8:0000:0000:0000:ff00:0042:8329");
  assert.equal(compressed.sourceIP, "2001:db8::ff00:42:8329");

  assert.deepEqual(normalizeSourceProvenance({ valid: false }), unknownSourceProvenance());
  assert.deepEqual(normalizeSourceProvenance({ valid: true, provider: "bad", source: "provider_request_context", sourceIP: "127.0.0.1" }), unknownSourceProvenance());
  assert.deepEqual(normalizeSourceProvenance({ valid: true, provider: "apigw-v2", source: "other", sourceIP: "127.0.0.1" }), unknownSourceProvenance());
  assert.deepEqual(normalizeSourceProvenance({ valid: true, provider: "apigw-v2", source: "provider_request_context", sourceIP: "bad" }), unknownSourceProvenance());

  const normalized = normalizeSourceProvenance({ valid: true, provider: "apigw-v2", source: "provider_request_context", sourceIP: "2001:db8::1" });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.sourceIP, "2001:db8::1");
});
