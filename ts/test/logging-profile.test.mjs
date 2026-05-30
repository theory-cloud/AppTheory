import test from "node:test";
import assert from "node:assert/strict";

import {
  LOGGING_PROFILE_CLOUDWATCH_JSON,
  LOGGING_PROFILE_LEGACY,
  LOGGING_PROFILE_LOCAL_DEV,
  LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
  LOGGING_PROFILE_SCHEMA_VERSION,
  LoggingProfileValidationError,
  ProfileLogger,
  builtInLoggingProfileNames,
  decodeLoggingProfileJSON,
  defaultLoggingProfile,
  encodeLoggingProfileEvent,
  hooksFromLogger,
  hooksFromProfileLogger,
  loggingProfileCatalog,
  loggingProfileValidationErrors,
  validateLoggingProfile,
} from "../dist/index.js";

function minimalProfileEnvironment() {
  return {
    SERVICE_NAME: "payments-api",
    STAGE: "live",
    PARTNER: "paytheory",
    AWS_LAMBDA_FUNCTION_NAME: "payments-live-authorize",
    AWS_REGION: "us-east-1",
  };
}

function profileEnvironment() {
  return {
    ...minimalProfileEnvironment(),
    SOURCE_ACCOUNT_ID: "111122223333",
    ACCOUNT_FAMILY: "paytheory-live",
  };
}

test("logging profile catalog and default variants", () => {
  const names = ["cloudwatch-json", "legacy", "local-dev", "paytheory-alert-v1"];
  assert.deepEqual(builtInLoggingProfileNames(), names);
  assert.deepEqual(loggingProfileCatalog(), {
    schema_version: LOGGING_PROFILE_SCHEMA_VERSION,
    profiles: names,
  });

  const paytheory = defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
  const cloudwatch = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  const legacy = defaultLoggingProfile(LOGGING_PROFILE_LEGACY);
  const local = defaultLoggingProfile(LOGGING_PROFILE_LOCAL_DEV);
  for (const cfg of [paytheory, cloudwatch, legacy, local]) validateLoggingProfile(cfg);
  validateLoggingProfile(decodeLoggingProfileJSON(JSON.stringify(paytheory)));
  assert.equal(paytheory.encoding.timestamp_field, "ts");
  assert.deepEqual(cloudwatch.required_fields, ["timestamp", "level", "message"]);
  assert.equal(legacy.encoding.level_field, "level");
  assert.equal(local.levels.warn, "WARN");
  assert.throws(() => defaultLoggingProfile("custom-alert"), /unsupported value/);
});

test("logging profile validation fails closed deterministically", () => {
  const cfg = {
    schema_version: "",
    profile: "",
    encoding: {},
    levels: { Error: "SEVERE", trace: "TRACE", info: "" },
    required_fields: [""],
    recommended_fields: [""],
    field_map: {
      raw_source: "service",
      message: "raw_payload",
      event: "",
    },
    enrichment: {
      static: { raw_payload: "payload" },
      context: { raw_payload: "", method: "" },
    },
    error_capture: {
      stack_trace_field: "raw_payload",
      stack_hash_field: "raw_payload",
    },
  };
  assert.deepEqual(loggingProfileValidationErrors(cfg), [
    "schema_version: required",
    "profile: required",
    "encoding.format: required",
    "levels.Error: unsupported level Error",
    "levels.info: required",
    "levels.trace: unsupported level trace",
    "required_fields[0]: required",
    "recommended_fields[0]: required",
    "field_map.event: required",
    "field_map.message: unsupported field raw_payload",
    "field_map.raw_source: unsupported source raw_source",
    "enrichment.static.raw_payload: unsupported field raw_payload",
    "enrichment.context.method: required",
    "enrichment.context.raw_payload: unsupported field raw_payload",
    "enrichment.context.raw_payload: required",
    "error_capture.stack_trace_field: unsupported field raw_payload",
    "error_capture.stack_hash_field: unsupported field raw_payload",
  ]);

  assert.throws(() => validateLoggingProfile(cfg), LoggingProfileValidationError);
  assert.throws(() => decodeLoggingProfileJSON("{"), /logging profile json:/);
  assert.throws(() => decodeLoggingProfileJSON("[]"), /root must be an object/);
  assert.throws(
    () =>
      decodeLoggingProfileJSON(
        JSON.stringify({
          schema_version: LOGGING_PROFILE_SCHEMA_VERSION,
          profile: LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
          encoding: { format: "json", unknown_encoding_option: true },
          unknown_top_level: true,
        }),
      ),
    (error) =>
      error instanceof LoggingProfileValidationError &&
      error.errors.includes("encoding.unknown_encoding_option: unsupported option") &&
      error.errors.includes("unknown_top_level: unsupported option"),
  );
});

test("logging profile malformed composite values fail with validation errors", () => {
  const cases = [
    ["encoding", { encoding: true }, "encoding: must be an object"],
    ["levels", { levels: true }, "levels: must be an object"],
    ["required_fields", { required_fields: true }, "required_fields: must be an array"],
    [
      "recommended_fields",
      { recommended_fields: { field: "trace_id" } },
      "recommended_fields: must be an array",
    ],
    ["field_map", { field_map: true }, "field_map: must be an object"],
    ["enrichment", { enrichment: true }, "enrichment: must be an object"],
    ["enrichment.static", { enrichment: { static: true } }, "enrichment.static: must be an object"],
    ["enrichment.context", { enrichment: { context: true } }, "enrichment.context: must be an object"],
    ["error_capture", { error_capture: true }, "error_capture: must be an object"],
    ["sanitization", { sanitization: true }, "sanitization: must be an object"],
    ["alerting_hints", { alerting_hints: true }, "alerting_hints: must be an object"],
    [
      "alerting_hints.fingerprint_fields",
      { alerting_hints: { fingerprint_fields: true } },
      "alerting_hints.fingerprint_fields: must be an array",
    ],
    [
      "alerting_hints.keeper_lookup_fields",
      { alerting_hints: { keeper_lookup_fields: {} } },
      "alerting_hints.keeper_lookup_fields: must be an array",
    ],
  ];

  for (const [name, patch, expected] of cases) {
    const cfg = {
      ...JSON.parse(JSON.stringify(defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1))),
      ...patch,
    };
    assert.ok(loggingProfileValidationErrors(cfg).includes(expected), name);
    assert.throws(
      () => validateLoggingProfile(cfg),
      (error) => error instanceof LoggingProfileValidationError && error.errors.includes(expected),
    );
    assert.throws(
      () => decodeLoggingProfileJSON(JSON.stringify(cfg)),
      (error) => error instanceof LoggingProfileValidationError && error.errors.includes(expected),
    );
  }
});

test("logging profile encoder emits paytheory alert shape", () => {
  const cfg = defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
  const stackTrace = "processor.go:42\nhandler.go:7";
  const got = encodeLoggingProfileEvent(cfg, profileEnvironment(), {
    timestamp: "1970-01-01T00:00:00Z",
    level: "error",
    message: "charge authorization failed",
    normalized_message: "charge authorization failed",
    request: {
      request_id: "req_test_123",
      trace_id: "trace-profile-123",
      correlation_id: "corr-profile-123",
      route: "POST /payments/{payment_id}/authorize",
    },
    job: { name: "authorize-payment" },
    error: {
      type: "ProcessorError",
      code: "processor.declined",
      message: "processor declined",
      stack_trace: stackTrace,
    },
    fields: { safe_processor: "tesouro", raw_payload: "must-not-appear" },
  });

  assert.deepEqual(got, {
    ts: "1970-01-01T00:00:00Z",
    level: "ERROR",
    message: "charge authorization failed",
    service: "payments-api",
    stage: "live",
    partner: "paytheory",
    function: "payments-live-authorize",
    aws_region: "us-east-1",
    source_account_id: "111122223333",
    account_family: "paytheory-live",
    request_id: "req_test_123",
    trace_id: "trace-profile-123",
    correlation_id: "corr-profile-123",
    error_type: "ProcessorError",
    error_code: "processor.declined",
    normalized_message: "charge authorization failed",
    stack_trace: stackTrace,
    stack_hash: "sha256:d3d3dd723c56522d25492427bf8ca94b80feed197d55aa42e9bab0c1b5031bdc",
    route: "POST /payments/{payment_id}/authorize",
    job_name: "authorize-payment",
    safe_processor: "tesouro",
  });
});

test("logging profile encoder handles collisions, timestamps, and context variants", () => {
  const paytheory = defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
  const collision = encodeLoggingProfileEvent(paytheory, minimalProfileEnvironment(), {
    timestamp: "1970-01-01T00:00:00Z",
    level: "error",
    message: "profile-owned message",
    fields: {
      ts: "2099-01-01T00:00:00Z",
      level: "INFO",
      message: "override-msg",
      service: "override-service",
      safe_processor: "tesouro",
    },
  });
  assert.equal(collision.ts, "1970-01-01T00:00:00Z");
  assert.equal(collision.level, "ERROR");
  assert.equal(collision.message, "profile-owned message");
  assert.equal(collision.service, "payments-api");
  assert.equal(collision.safe_processor, "tesouro");

  const cloudwatch = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  cloudwatch.encoding.timestamp_format = "rfc3339";
  cloudwatch.enrichment = {
    static: { service: "local-service" },
    context: {
      tenant_id: "request.tenant_id",
      user_id: "request.user_id",
      span_id: "request.span_id",
      method: "request.method",
      path: "request.path",
      status: "request.status",
    },
  };
  cloudwatch.required_fields = ["timestamp", "level", "message", "service"];
  const context = encodeLoggingProfileEvent(cloudwatch, {}, {
    timestamp: new Date("2026-05-22T12:34:56.789Z"),
    level: "info",
    message: "ok",
    request: {
      tenant_id: "tenant_test_123",
      user_id: "user_test_123",
      span_id: "span_test_123",
      method: "POST",
      path: "/payments",
      status: 201,
    },
  });
  assert.equal(context.timestamp, "2026-05-22T12:34:56Z");
  assert.equal(context.service, "local-service");
  assert.equal(context.status, "201");

  const nano = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  nano.required_fields = ["timestamp", "level", "message"];
  assert.equal(
    encodeLoggingProfileEvent(nano, {}, { timestamp: new Date("2026-05-22T12:34:56.789Z"), message: "ok" }).timestamp,
    "2026-05-22T12:34:56.789Z",
  );
  assert.equal(
    encodeLoggingProfileEvent(nano, {}, { timestamp: "not-a-time", message: "ok" }).timestamp,
    "1970-01-01T00:00:00Z",
  );
  assert.throws(
    () => encodeLoggingProfileEvent(paytheory, {}, { timestamp: "1970-01-01T00:00:00Z", level: "error", message: "missing env" }),
    /logging profile required fields missing: service/,
  );
});

test("profile logger writes entries, hooks, and lifecycle state", () => {
  const cfg = defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
  const lines = [];
  const logger = new ProfileLogger(cfg, {
    environment: minimalProfileEnvironment(),
    writer: (line) => lines.push(line),
    clock: () => new Date(0),
  });
  logger
    .withRequestID("req_test_123")
    .withTenantID("tenant_test_123")
    .error("charge failed", {
      normalized_message: "charge failed",
      error_type: "ProcessorError",
      error_code: "processor.declined",
      safe_processor: "tesouro",
    });
  assert.equal(logger.entries().length, 1);
  assert.equal(logger.entries()[0].level, "ERROR");
  assert.equal(logger.entries()[0].request_id, "req_test_123");
  assert.deepEqual(lines, [JSON.stringify(logger.entries()[0])]);
  assert.equal(logger.getStats().entries_logged, 1);

  const hookLines = [];
  const { hooks, logger: hookLogger } = hooksFromProfileLogger(cfg, {
    environment: minimalProfileEnvironment(),
    writer: (line) => hookLines.push(line),
    clock: () => new Date(0),
  });
  hooks.log({
    level: "warn",
    event: "request.completed",
    requestId: "req_hook_123",
    tenantId: "tenant_hook_123",
    method: "POST",
    path: "/payments/123/authorize",
    status: 402,
    errorCode: "processor.declined",
  });
  assert.equal(hookLogger.entries()[0].level, "WARN");
  assert.equal(hookLogger.entries()[0].message, "request.completed");
  assert.equal(hookLogger.entries()[0].method, "POST");
  assert.deepEqual(hooksFromLogger(null), {});
});

test("profile logger context methods close and record errors", () => {
  const cfg = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  cfg.enrichment = {
    context: {
      tenant_id: "request.tenant_id",
      user_id: "request.user_id",
      trace_id: "request.trace_id",
      span_id: "request.span_id",
    },
  };
  cfg.required_fields = ["timestamp", "level", "message"];
  const logger = new ProfileLogger(cfg, {
    writer: null,
    clock: () => new Date(0),
  });
  logger
    .withField("safe_field", "safe")
    .withUserID("user_test_123")
    .withTraceID("trace_test_123")
    .withSpanID("span_test_123")
    .withTenantID("tenant_test_123")
    .debug("debug message", { status: "201" });
  assert.equal(logger.entries()[0].level, "DEBUG");
  assert.equal(logger.entries()[0].tenant_id, "tenant_test_123");
  assert.equal(logger.entries()[0].safe_field, "safe");
  assert.equal(logger.isHealthy(), true);
  logger.flush();
  logger.close();
  assert.equal(logger.isHealthy(), false);
  logger.info("ignored after close");
  assert.equal(logger.entries().length, 1);

  const broken = new ProfileLogger(defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1), {
    writer: null,
    clock: () => new Date(0),
  });
  broken.info("missing env");
  assert.match(broken.getStats().last_error, /logging profile required fields missing/);
});

test("profile logger retention is bounded and shared by scoped loggers", () => {
  const cfg = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  cfg.enrichment = { context: { request_id: "request.request_id" } };
  cfg.required_fields = ["timestamp", "level", "message"];

  const lines = [];
  const logger = new ProfileLogger(cfg, {
    writer: (line) => lines.push(line),
    clock: () => new Date(0),
  });
  const retentionCap = 1024;
  const total = retentionCap + 2;
  const scoped = logger.withRequestID("req_retention");
  for (let index = 0; index < total; index += 1) {
    scoped.info(`message-${index}`);
  }

  const entries = logger.entries();
  assert.equal(entries.length, retentionCap);
  assert.equal(entries[0].message, "message-2");
  assert.equal(entries.at(-1).message, `message-${total - 1}`);
  assert.equal(entries[0].request_id, "req_retention");

  assert.equal(lines.length, total);
  assert.equal(JSON.parse(lines.at(-1)).message, `message-${total - 1}`);
  assert.equal(logger.getStats().entries_logged, total);
  assert.equal(logger.getStats().entries_dropped, 2);
});
