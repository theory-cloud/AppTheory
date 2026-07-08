#!/usr/bin/env node

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { pathToFileURL } = require("node:url");
const util = require("node:util");

let cachedRuntime = null;

const CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER =
  "kinesis_require_cloudwatch_logs_subscription";
const CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER =
  "apptheory: cloudwatch logs subscription decoder helper missing";

async function loadAppTheoryRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const runtimePath = path.join(process.cwd(), "ts", "dist", "index.js");
  const runtimeUrl = pathToFileURL(runtimePath).href;
  cachedRuntime = await import(runtimeUrl);
  return cachedRuntime;
}

function parseArgs(argv) {
  const args = { fixtures: "contract-tests/fixtures", id: "", filter: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixtures") {
      args.fixtures = argv[i + 1];
      i += 1;
    } else if (arg === "--id") {
      args.id = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--filter") {
      args.filter = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return args;
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function diagnosticReason(reason) {
  const text = String(reason ?? "").toLowerCase();
  if (text.includes("mismatch")) return "reason: mismatch";
  if (text.includes("missing")) return "reason: missing expected contract element";
  if (text.includes("extra")) return "reason: unexpected contract element";
  if (text.includes("error")) return "reason: error response mismatch";
  if (text.includes("invalid")) return "reason: invalid contract value";
  return "reason: fixture assertion failed";
}

function redactedDiagnostic() {
  return "<redacted; contract diagnostic value omitted>";
}

function deepEqual(a, b) {
  return util.isDeepStrictEqual(a, b);
}

function newEffects() {
  return { logs: [], metrics: [], spans: [], emf_logs: [] };
}

function compareEMFLogsIfExpected(fixture, effects, actual, expected) {
  if (!Object.prototype.hasOwnProperty.call(fixture.expect ?? {}, "emf_logs")) {
    return { ok: true };
  }
  const expectedEmfLogs = fixture.expect?.emf_logs ?? [];
  const actualEmfLogs = effects?.emf_logs ?? [];
  if (deepEqual(expectedEmfLogs, actualEmfLogs)) return { ok: true };
  return {
    ok: false,
    reason: "emf_logs mismatch",
    actual,
    expected,
    expected_emf_logs: expectedEmfLogs,
    actual_emf_logs: actualEmfLogs,
  };
}

function isLoggingProfileContractFixture(fixture) {
  const setup = fixture.setup ?? {};
  const input = fixture.input ?? {};
  const expect = fixture.expect ?? {};
  return (
    Object.prototype.hasOwnProperty.call(setup, "logging_profile") ||
    Object.prototype.hasOwnProperty.call(input, "logging_event") ||
    Object.prototype.hasOwnProperty.call(input, "logging_profile_catalog") ||
    Object.prototype.hasOwnProperty.call(expect, "profile_logs") ||
    Object.prototype.hasOwnProperty.call(expect, "profile_validation_errors") ||
    Object.prototype.hasOwnProperty.call(expect, "logging_profile_catalog")
  );
}

function isOpenAPIContractFixture(fixture) {
  return Object.prototype.hasOwnProperty.call(fixture.setup ?? {}, "openapi");
}

async function compareOpenAPIContract(fixture) {
  const runtime = await loadAppTheoryRuntime();
  let actual = null;
  let actualError = null;
  try {
    actual = runtime.generateOpenAPIJSON(
      normalizeOpenAPISpecForRuntime(fixture.setup?.openapi ?? {}),
    );
  } catch (err) {
    actualError = err;
  }
  if (fixture.expect?.error) {
    if (Object.prototype.hasOwnProperty.call(fixture.expect, "output_json")) {
      return {
        ok: false,
        reason: "fixture expect cannot set both error and output_json",
        expected_error: fixture.expect.error,
        actual_error: null,
      };
    }
    const expectedMessage = String(fixture.expect.error.message ?? "").trim();
    const actualMessage = String(actualError?.message ?? actualError ?? "").trim();
    if (actualError && (!expectedMessage || actualMessage === expectedMessage)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: actualError
        ? "openapi error message mismatch"
        : "expected openapi error, got nil",
      expected_error: fixture.expect.error,
      actual_error: actualError ? { message: actualMessage } : null,
    };
  }
  if (actualError) {
    return {
      ok: false,
      reason: "unexpected openapi error",
      expected_output_json: fixture.expect?.output_json,
      actual_output_json: null,
      actual_error: { message: String(actualError?.message ?? actualError) },
    };
  }
  const expected = fixture.expect?.output_json;
  if (actual === expected) return { ok: true };
  return {
    ok: false,
    reason: "openapi canonical json mismatch",
    expected_output_json: expected,
    actual_output_json: actual,
  };
}

function normalizeOpenAPISpecForRuntime(spec) {
  return {
    title: String(spec?.title ?? ""),
    version: String(spec?.version ?? ""),
    routes: (spec?.routes ?? []).map((route) => ({
      method: String(route?.method ?? ""),
      path: String(route?.path ?? ""),
      operationId: String(route?.operation_id ?? route?.operationId ?? ""),
      ...(route?.summary !== undefined ? { summary: String(route.summary) } : {}),
      ...(Array.isArray(route?.tags)
        ? { tags: route.tags.map((tag) => String(tag)) }
        : {}),
      ...(route?.success_status !== undefined || route?.successStatus !== undefined
        ? { successStatus: Number(route?.success_status ?? route?.successStatus) }
        : {}),
      request: {
        fields: normalizeOpenAPIFields(route?.request?.fields ?? []),
      },
      response: {
        ...(route?.response?.description !== undefined
          ? { description: String(route.response.description) }
          : {}),
        fields: normalizeOpenAPIFields(route?.response?.fields ?? []),
      },
    })),
  };
}

function normalizeOpenAPIFields(fields) {
  return (fields ?? []).map((field) => ({
    field: String(field?.field ?? ""),
    source: String(field?.source ?? ""),
    name: String(field?.name ?? ""),
    type: String(field?.type ?? ""),
    ...(field?.array !== undefined ? { array: Boolean(field.array) } : {}),
    ...(field?.required !== undefined
      ? { required: Boolean(field.required) }
      : {}),
    ...(Array.isArray(field?.validation)
      ? {
          validation: field.validation.map((rule) => ({
            rule: String(rule?.rule ?? ""),
            ...(Object.prototype.hasOwnProperty.call(rule ?? {}, "value")
              ? { value: rule.value }
              : {}),
          })),
        }
      : {}),
  }));
}

async function compareLoggingProfileContract(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const setup = fixture.setup ?? {};
  const input = fixture.input ?? {};
  const expect = fixture.expect ?? {};
  if (Object.prototype.hasOwnProperty.call(expect, "logging_profile_catalog")) {
    const actual = runtime.loggingProfileCatalog();
    if (deepEqual(actual, expect.logging_profile_catalog)) return { ok: true };
    return {
      ok: false,
      reason: "logging_profile_catalog mismatch",
      expected_logging_profile_catalog: expect.logging_profile_catalog,
      actual_logging_profile_catalog: actual,
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(expect, "profile_validation_errors")
  ) {
    const actual = decodeLoggingProfileValidationErrors(
      runtime,
      setup.logging_profile,
    );
    if (deepEqual(actual, expect.profile_validation_errors ?? []))
      return { ok: true };
    return {
      ok: false,
      reason: "profile_validation_errors mismatch",
      expected_profile_validation_errors:
        expect.profile_validation_errors ?? [],
      actual_profile_validation_errors: actual,
    };
  }
  if (Object.prototype.hasOwnProperty.call(expect, "profile_logs")) {
    let actualLogs = [];
    try {
      const config = runtime.decodeLoggingProfileJSON(
        JSON.stringify(setup.logging_profile ?? {}),
      );
      const actual = runtime.encodeLoggingProfileEvent(
        config,
        setup.environment ?? {},
        input.logging_event ?? {},
      );
      actualLogs = [actual];
    } catch (err) {
      return {
        ok: false,
        reason: `profile_logs encode failed: ${err?.message ?? String(err)}`,
        expected_profile_logs: expect.profile_logs ?? [],
        actual_profile_logs: actualLogs,
      };
    }
    if (deepEqual(actualLogs, expect.profile_logs ?? [])) return { ok: true };
    return {
      ok: false,
      reason: "profile_logs mismatch",
      expected_profile_logs: expect.profile_logs ?? [],
      actual_profile_logs: actualLogs,
    };
  }
  return { ok: true };
}

function decodeLoggingProfileValidationErrors(runtime, profile) {
  try {
    runtime.decodeLoggingProfileJSON(JSON.stringify(profile ?? {}));
    return [];
  } catch (err) {
    if (Array.isArray(err?.errors)) return err.errors;
    return [err?.message ?? String(err)];
  }
}

function listFixtureFiles(fixturesRoot) {
  if (!fs.existsSync(fixturesRoot)) {
    return [];
  }
  const files = [];
  const tierDirs = fs
    .readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const tier of tierDirs) {
    const dir = path.join(fixturesRoot, tier);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      files.push(path.join(dir, entry));
    }
  }
  files.sort();
  return files;
}

function selectedFixtureID(id, filter) {
  const fixtureID = String(id ?? "").trim();
  const fixtureFilter = String(filter ?? "").trim();
  if (fixtureID && fixtureFilter && fixtureID !== fixtureFilter) {
    throw new Error(
      `fixture id mismatch: --id ${JSON.stringify(fixtureID)} != --filter ${JSON.stringify(fixtureFilter)}`,
    );
  }
  return fixtureID || fixtureFilter;
}

function filterFixturesByID(fixtures, fixtureID) {
  const matches = fixtures.filter((fixture) => fixture.id === fixtureID);
  if (matches.length !== 1) {
    throw new Error(
      `fixture id ${JSON.stringify(fixtureID)} matched ${matches.length} fixtures`,
    );
  }
  return matches;
}

function loadFixtures(fixturesRoot) {
  const files = listFixtureFiles(fixturesRoot);
  if (files.length === 0) {
    throw new Error("no fixtures found");
  }
  return files.map((file) => {
    const raw = fs.readFileSync(file, "utf8");
    const fixture = JSON.parse(raw);
    if (!fixture.id) {
      throw new Error(`fixture ${file} missing id`);
    }
    return fixture;
  });
}

function canonicalizeHeaders(headers) {
  const out = Object.create(null);
  if (!headers) return out;
  const keys = Object.keys(headers).sort();
  for (const key of keys) {
    const lower = String(key).trim().toLowerCase();
    if (!lower) continue;
    const values = Array.isArray(headers[key]) ? headers[key] : [headers[key]];
    if (!out[lower]) out[lower] = [];
    out[lower].push(...values.map((v) => String(v)));
  }
  return out;
}

function decodeFixtureBody(body) {
  if (!body) return Buffer.alloc(0);
  if (body.encoding === "utf8") return Buffer.from(body.value ?? "", "utf8");
  if (body.encoding === "base64")
    return Buffer.from(body.value ?? "", "base64");
  throw new Error(`unknown body encoding ${JSON.stringify(body.encoding)}`);
}

function parseCookies(cookieHeaders) {
  const out = {};
  for (const header of cookieHeaders ?? []) {
    for (const part of String(header).split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const name = trimmed.slice(0, idx).trim();
      if (!name) continue;
      const value = trimmed.slice(idx + 1).trim();
      out[name] = value;
    }
  }
  return out;
}

function canonicalizeRequest(inReq, ctx) {
  const method = String(inReq.method ?? "")
    .trim()
    .toUpperCase();
  let pathValue = String(inReq.path ?? "").trim();
  if (!pathValue) pathValue = "/";
  if (!pathValue.startsWith("/")) pathValue = `/${pathValue}`;

  const headers = canonicalizeHeaders(inReq.headers ?? {});

  let bodyBytes = decodeFixtureBody(inReq.body);
  if (inReq.is_base64 === true) {
    const asString = bodyBytes.toString("utf8");
    bodyBytes = Buffer.from(asString, "base64");
  }

  const cookies = parseCookies(headers.cookie);

  return {
    method,
    path: pathValue,
    query: inReq.query ?? {},
    headers,
    cookies,
    body: bodyBytes,
    is_base64: inReq.is_base64 === true,
    path_params: {},
    request_id: "",
    tenant_id: "",
    auth_identity: "",
    remaining_ms: Number(ctx?.remaining_ms ?? 0),
    middleware_trace: [],
  };
}

function splitPath(p) {
  const trimmed = String(p ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (!trimmed) return [];
  return trimmed.split("/");
}

function matchPath(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length)
    return { ok: false, params: {} };
  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const pattern = patternSegments[i];
    const value = pathSegments[i];
    if (!value) return { ok: false, params: {} };
    const isParam =
      pattern.startsWith("{") && pattern.endsWith("}") && pattern.length > 2;
    if (isParam) {
      const name = pattern.slice(1, -1);
      params[name] = value;
      continue;
    }
    if (pattern !== value) return { ok: false, params: {} };
  }
  return { ok: true, params };
}

function formatAllowHeader(methods) {
  const set = new Set();
  for (const m of methods ?? []) {
    const upper = String(m).trim().toUpperCase();
    if (upper) set.add(upper);
  }
  return Array.from(set).sort().join(", ");
}

function statusForError(code) {
  switch (code) {
    case "app.bad_request":
    case "app.validation_failed":
      return 400;
    case "app.unauthorized":
      return 401;
    case "app.forbidden":
      return 403;
    case "app.not_found":
      return 404;
    case "app.method_not_allowed":
      return 405;
    case "app.conflict":
      return 409;
    case "app.too_large":
      return 413;
    case "app.rate_limited":
      return 429;
    case "app.overloaded":
      return 503;
    case "app.internal":
      return 500;
    default:
      return 500;
  }
}

function appErrorResponse(code, message, extraHeaders, requestId) {
  const headers = canonicalizeHeaders(extraHeaders ?? {});
  headers["content-type"] = ["application/json; charset=utf-8"];
  const error = { code, message };
  if (requestId) {
    error.request_id = requestId;
  }
  const bodyJson = { error };
  return {
    status: statusForError(code),
    headers,
    cookies: [],
    body: Buffer.from(JSON.stringify(bodyJson), "utf8"),
    is_base64: false,
  };
}

function isJsonContentType(headers) {
  const values = headers["content-type"] ?? [];
  for (const v of values) {
    const value = String(v).trim().toLowerCase();
    if (value.startsWith("application/json")) return true;
  }
  return false;
}

function builtInHandler(name) {
  switch (name) {
    case "static_pong":
      return () => ({
        status: 200,
        headers: { "content-type": ["text/plain; charset=utf-8"] },
        cookies: [],
        body: Buffer.from("pong", "utf8"),
        is_base64: false,
      });
    case "echo_path_params":
      return (req) => ({
        status: 200,
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body: Buffer.from(JSON.stringify({ params: req.path_params }), "utf8"),
        is_base64: false,
      });
    case "echo_request":
      return (req) => ({
        status: 200,
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body: Buffer.from(
          JSON.stringify({
            method: req.method,
            path: req.path,
            query: req.query,
            headers: req.headers,
            cookies: req.cookies,
            body_b64: req.body.toString("base64"),
            is_base64: req.is_base64,
          }),
          "utf8",
        ),
        is_base64: false,
      });
    case "echo_context":
      return (req) => ({
        status: 200,
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body: Buffer.from(
          JSON.stringify({
            request_id: req.request_id,
            tenant_id: req.tenant_id,
            auth_identity: req.auth_identity,
            remaining_ms: req.remaining_ms,
          }),
          "utf8",
        ),
        is_base64: false,
      });
    case "echo_middleware_trace":
      return (req) => ({
        status: 200,
        headers: { "content-type": ["application/json; charset=utf-8"] },
        cookies: [],
        body: Buffer.from(
          JSON.stringify({ trace: req.middleware_trace }),
          "utf8",
        ),
        is_base64: false,
      });
    case "parse_json_echo":
      return (req) => {
        if (!isJsonContentType(req.headers)) {
          throw { code: "app.bad_request", message: "invalid json" };
        }
        if (req.body.length === 0) {
          return {
            status: 200,
            headers: { "content-type": ["application/json; charset=utf-8"] },
            cookies: [],
            body: Buffer.from("null", "utf8"),
            is_base64: false,
          };
        }
        try {
          const parsed = JSON.parse(req.body.toString("utf8"));
          return {
            status: 200,
            headers: { "content-type": ["application/json; charset=utf-8"] },
            cookies: [],
            body: Buffer.from(JSON.stringify(parsed), "utf8"),
            is_base64: false,
          };
        } catch {
          throw { code: "app.bad_request", message: "invalid json" };
        }
      };
    case "panic":
      return () => {
        throw new Error("boom");
      };
    case "unexpected_error":
      return () => {
        throw new Error("boom");
      };
    case "binary_body":
      return () => ({
        status: 200,
        headers: { "content-type": ["application/octet-stream"] },
        cookies: [],
        body: Buffer.from([0x00, 0x01, 0x02]),
        is_base64: true,
      });
    case "unauthorized":
      return () => {
        throw { code: "app.unauthorized", message: "unauthorized" };
      };
    case "validation_failed":
      return () => {
        throw { code: "app.validation_failed", message: "validation failed" };
      };
    case "large_response":
      return () => ({
        status: 200,
        headers: { "content-type": ["text/plain; charset=utf-8"] },
        cookies: [],
        body: Buffer.from("12345", "utf8"),
        is_base64: false,
      });
    default:
      return null;
  }
}

function firstHeaderValue(headers, key) {
  const values = headers[String(key).trim().toLowerCase()] ?? [];
  return values.length > 0 ? String(values[0]) : "";
}

function extractTenantId(headers, query) {
  const headerTenant = firstHeaderValue(headers, "x-tenant-id");
  if (headerTenant) return headerTenant;
  const values = query?.tenant ?? [];
  return values.length > 0 ? String(values[0]) : "";
}

function isCorsPreflight(method, headers) {
  return (
    String(method).toUpperCase() === "OPTIONS" &&
    firstHeaderValue(headers, "access-control-request-method")
  );
}

function finalizeResponse(resp, enableP1, requestId, origin) {
  const headers = canonicalizeHeaders(resp.headers ?? {});
  if (enableP1) {
    if (requestId) headers["x-request-id"] = [requestId];
    if (origin) {
      headers["access-control-allow-origin"] = [origin];
      headers.vary = ["origin"];
    }
  }
  return {
    ...resp,
    headers,
    cookies: resp.cookies ?? [],
  };
}

function newFixtureApp(routes, opts) {
  const enableP1 = Boolean(opts?.enableP1);
  const enableP2 = Boolean(opts?.enableP2);
  const limits = opts?.limits ?? {};
  const effects = newEffects();

  const compiled = (routes ?? []).map((r) => ({
    method: String(r.method).trim().toUpperCase(),
    path: String(r.path).trim(),
    segments: splitPath(r.path),
    handler: String(r.handler).trim(),
    auth_required: Boolean(r.auth_required),
  }));

  return {
    effects,
    handle(req) {
      let requestId = "";
      let origin = "";
      let errorCode = "";

      effects.logs = [];
      effects.metrics = [];
      effects.spans = [];

      const recordEffects = (resp, errCode) => {
        if (!enableP2) return;
        const status = Number(resp.status ?? 0);
        let level = "info";
        if (status >= 500) level = "error";
        else if (status >= 400) level = "warn";

        effects.logs.push({
          level,
          event: "request.completed",
          request_id: req.request_id,
          tenant_id: req.tenant_id,
          method: req.method,
          path: req.path,
          status,
          error_code: errCode ?? "",
        });

        effects.metrics.push({
          name: "apptheory.request",
          value: 1,
          tags: {
            method: req.method,
            path: req.path,
            status: String(status),
            error_code: errCode ?? "",
            tenant_id: req.tenant_id,
          },
        });

        effects.spans.push({
          name: `http ${req.method} ${req.path}`,
          attributes: {
            "http.method": req.method,
            "http.route": req.path,
            "http.status_code": String(status),
            "request.id": req.request_id,
            "tenant.id": req.tenant_id,
            "error.code": errCode ?? "",
          },
        });
      };

      const finish = (resp, errCode) => {
        const out = finalizeResponse(resp, enableP1, requestId, origin);
        recordEffects(out, errCode);
        return out;
      };

      if (enableP1) {
        requestId =
          firstHeaderValue(req.headers, "x-request-id") || "req_test_123";
        req.request_id = requestId;

        origin = firstHeaderValue(req.headers, "origin");
        req.tenant_id = extractTenantId(req.headers, req.query);

        req.middleware_trace.push("request_id", "recovery", "logging");
        if (origin) req.middleware_trace.push("cors");

        if (origin && isCorsPreflight(req.method, req.headers)) {
          const allow = firstHeaderValue(
            req.headers,
            "access-control-request-method",
          );
          return finish(
            {
              status: 204,
              headers: { "access-control-allow-methods": [allow] },
              cookies: [],
              body: Buffer.alloc(0),
              is_base64: false,
            },
            errorCode,
          );
        }

        if (
          limits.max_request_bytes &&
          req.body.length > limits.max_request_bytes
        ) {
          errorCode = "app.too_large";
          return finish(
            appErrorResponse(
              "app.too_large",
              "request too large",
              {},
              requestId,
            ),
            errorCode,
          );
        }

        if (enableP2) {
          if (firstHeaderValue(req.headers, "x-force-rate-limit")) {
            errorCode = "app.rate_limited";
            return finish(
              appErrorResponse(
                "app.rate_limited",
                "rate limited",
                { "retry-after": ["1"] },
                requestId,
              ),
              errorCode,
            );
          }
          if (firstHeaderValue(req.headers, "x-force-shed")) {
            errorCode = "app.overloaded";
            return finish(
              appErrorResponse(
                "app.overloaded",
                "overloaded",
                { "retry-after": ["1"] },
                requestId,
              ),
              errorCode,
            );
          }
        }
      }

      let match = null;
      const allowed = [];
      for (const route of compiled) {
        const { ok, params } = matchPath(route.segments, splitPath(req.path));
        if (!ok) continue;
        allowed.push(route.method);
        if (route.method === req.method) {
          match = { route, params };
          break;
        }
      }

      if (!match) {
        if (allowed.length > 0) {
          errorCode = "app.method_not_allowed";
          return finish(
            appErrorResponse(
              "app.method_not_allowed",
              "method not allowed",
              { allow: [formatAllowHeader(allowed)] },
              requestId,
            ),
            errorCode,
          );
        }
        errorCode = "app.not_found";
        return finish(
          appErrorResponse("app.not_found", "not found", {}, requestId),
          errorCode,
        );
      }

      if (enableP1 && match.route.auth_required) {
        req.middleware_trace.push("auth");
        const authz = firstHeaderValue(req.headers, "authorization");
        if (!authz.trim()) {
          errorCode = "app.unauthorized";
          return finish(
            appErrorResponse("app.unauthorized", "unauthorized", {}, requestId),
            errorCode,
          );
        }
        req.auth_identity = "authorized";
      }
      if (enableP1) req.middleware_trace.push("handler");

      const handler = builtInHandler(match.route.handler);
      if (!handler) {
        errorCode = "app.internal";
        return finish(
          appErrorResponse("app.internal", "internal error", {}, requestId),
          errorCode,
        );
      }

      let resp;
      try {
        const enriched = { ...req, path_params: match.params };
        resp = handler(enriched);
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          "message" in err
        ) {
          errorCode = err.code;
          resp = appErrorResponse(err.code, err.message, {}, requestId);
        } else {
          errorCode = "app.internal";
          resp = appErrorResponse(
            "app.internal",
            "internal error",
            {},
            requestId,
          );
        }
        return finish(resp, errorCode);
      }

      if (
        enableP1 &&
        limits.max_response_bytes &&
        resp.body.length > limits.max_response_bytes
      ) {
        errorCode = "app.too_large";
        resp = appErrorResponse(
          "app.too_large",
          "response too large",
          {},
          requestId,
        );
      }

      return finish(resp, errorCode);
    },
  };
}

function compareHeaders(expectedHeaders, actualHeaders) {
  const e = canonicalizeHeaders(expectedHeaders ?? {});
  const a = canonicalizeHeaders(actualHeaders ?? {});
  return deepEqual(e, a);
}

const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
const MICROVM_REQUIRED_LIFECYCLE_HOOKS = [
  "prepare_image",
  "start",
  "readiness",
  "stop",
  "teardown",
  "failure",
];
const MICROVM_REQUIRED_LIFECYCLE_STATES = [
  "requested",
  "image_preparing",
  "image_prepared",
  "starting",
  "started",
  "readiness_probing",
  "ready",
  "stopping",
  "stopped",
  "tearing_down",
  "terminated",
  "failed",
];
const MICROVM_REQUIRED_CONTROLLER_COMMANDS = [
  "create",
  "start",
  "stop",
  "status",
  "session",
];
const MICROVM_REQUIRED_ENVELOPE_FIELDS = [
  "command",
  "request_id",
  "tenant_id",
  "auth_context",
];
const MICROVM_REQUIRED_SESSION_FIELDS = [
  "tenant_id",
  "namespace",
  "session_id",
  "state",
  "desired_state",
  "image_ref",
  "controller_id",
  "created_at",
  "updated_at",
  "expires_at",
  "generation",
  "last_command_id",
  "auth_subject",
];

async function compareMicroVMContractFixture(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const actual = await validateMicroVMContractFixture(
    fixture.setup?.microvm_contract,
    runtime,
  );
  const expected = fixture.expect?.microvm_contract_validation;
  if (!expected) {
    return {
      ok: false,
      reason: "missing expect.microvm_contract_validation",
      expected_microvm_contract_validation: null,
      actual_microvm_contract_validation: actual,
    };
  }
  if (deepEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "microvm_contract_validation mismatch",
    expected_microvm_contract_validation: expected,
    actual_microvm_contract_validation: actual,
  };
}

async function validateMicroVMContractFixture(contract, runtime) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract fixture missing",
    );
  }

  const kind = String(contract.kind ?? "").trim();
  const version = String(contract.version ?? "").trim();
  if (
    String(contract.contract ?? "").trim() !== MICROVM_CONTRACT_NAME ||
    version !== MICROVM_CONTRACT_VERSION
  ) {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract must be named and versioned",
    );
  }
  if (kind !== "lifecycle" && kind !== "controller_session") {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract kind is unsupported",
    );
  }

  const escapeHatches = contract.escape_hatches ?? {};
  const escapeHatchError = validateMicroVMEscapeHatches(
    runtime,
    kind,
    version,
    escapeHatches,
  );
  if (escapeHatchError) return escapeHatchError;

  const controller = contract.controller ?? {};
  if (
    kind === "controller_session" &&
    !microVMControllerAuthDefaultsDeny(controller.auth ?? {})
  ) {
    return {
      valid: false,
      kind,
      version,
      error_code: "m15.microvm.unauthenticated_controller",
      error_message:
        "apptheory: microvm controller must default to authenticated deny",
    };
  }

  if (kind === "lifecycle") {
    const err = await validateMicroVMLifecycle(
      runtime,
      contract.lifecycle ?? {},
    );
    if (err)
      return invalidMicroVMContract("m15.microvm.lifecycle_incomplete", err);
  } else {
    const controllerErr = await validateMicroVMController(runtime, controller);
    if (controllerErr)
      return invalidMicroVMContract(
        "m15.microvm.controller_incomplete",
        controllerErr,
      );
    const registryErr = await validateMicroVMSessionRegistry(
      runtime,
      contract.session_registry ?? {},
    );
    if (registryErr)
      return invalidMicroVMContract(
        "m15.microvm.session_registry_incomplete",
        registryErr,
      );
  }

  return { valid: true, kind, version };
}

function invalidMicroVMContract(errorCode, errorMessage) {
  return { valid: false, error_code: errorCode, error_message: errorMessage };
}

function microVMControllerAuthDefaultsDeny(auth) {
  return (
    auth.required === true &&
    String(auth.default ?? "")
      .trim()
      .toLowerCase() === "deny"
  );
}

async function validateMicroVMLifecycle(runtime, lifecycle) {
  try {
    runtime.validateMicroVMLifecycleContract(lifecycle);
    const handlers = {};
    for (const hook of MICROVM_REQUIRED_LIFECYCLE_HOOKS)
      handlers[hook] = () => undefined;
    const adapter = runtime.createMicroVMLifecycleAdapter({
      contract: lifecycle,
      handlers,
    });
    let state = "requested";
    for (const hook of [
      "prepare_image",
      "start",
      "readiness",
      "stop",
      "teardown",
    ]) {
      const result = await adapter.handle({
        request_id: "m15-lifecycle-fixture",
        tenant_id: "tenant-fixture",
        namespace: "namespace-fixture",
        session_id: "session-fixture",
        hook,
        state,
      });
      if (result.error) return result.error.message;
      state = String(result.state ?? "");
    }
    if (state !== "terminated")
      return `apptheory: microvm lifecycle adapter terminated at ${state}`;

    const failure = await adapter.handle({
      request_id: "m15-lifecycle-fixture-failure",
      tenant_id: "tenant-fixture",
      namespace: "namespace-fixture",
      session_id: "session-fixture",
      hook: "failure",
      state: "starting",
    });
    if (failure.error) return failure.error.message;
    if (failure.state !== "failed")
      return `apptheory: microvm lifecycle failure hook produced ${failure.state}`;
    return "";
  } catch (err) {
    return err?.message ?? String(err);
  }
}

function validateMicroVMEscapeHatches(runtime, kind, version, escapeHatches) {
  try {
    runtime.validateMicroVMEscapeHatches(escapeHatches ?? {});
    return null;
  } catch (err) {
    return {
      valid: false,
      kind,
      version,
      error_code: String(err?.code ?? "m15.microvm.invalid_contract"),
      error_message: err?.message ?? String(err),
    };
  }
}
async function validateMicroVMController(runtime, controller) {
  try {
    runtime.validateMicroVMControllerContract(controller);
    await exerciseRuntimeController(runtime);
    return "";
  } catch (err) {
    return err?.message ?? String(err);
  }
}

async function exerciseRuntimeController(runtime) {
  const client = runtime.createFakeMicroVMClient(new Date(0));
  const controller = runtime.createMicroVMController(client, {
    controller_id: "controller-fixture",
    ids: { newID: () => "session-fixture" },
  });
  const create = await controller.handle(
    runtimeControllerRequest(runtime.MicroVMCommand.Create, "m15-create", ""),
  );
  if (create.error) return Promise.reject(create.error);
  requireCreateResponse(create);

  const start = await controller.handle(
    runtimeControllerRequest(
      runtime.MicroVMCommand.Start,
      "m15-start",
      create.session_id,
    ),
  );
  if (start.error) return Promise.reject(start.error);
  requireStartStopResponse("start", start, create.session_id, "started");

  const status = await controller.handle(
    runtimeControllerRequest(
      runtime.MicroVMCommand.Status,
      "m15-status",
      create.session_id,
    ),
  );
  if (status.error) return Promise.reject(status.error);
  requireStatusResponse(status, create.session_id);

  const session = await controller.handle(
    runtimeControllerRequest(
      runtime.MicroVMCommand.Session,
      "m15-session",
      create.session_id,
    ),
  );
  if (session.error) return Promise.reject(session.error);
  requireSessionResponse(session, create.session_id);

  const stop = await controller.handle(
    runtimeControllerRequest(
      runtime.MicroVMCommand.Stop,
      "m15-stop",
      create.session_id,
    ),
  );
  if (stop.error) return Promise.reject(stop.error);
  requireStartStopResponse("stop", stop, create.session_id, "stopped");
}

function requireCreateResponse(response) {
  if (
    !response.session_id ||
    response.state !== "requested" ||
    !response.registry_version
  ) {
    throw new Error("apptheory: microvm controller create response incomplete");
  }
}

function requireStartStopResponse(name, response, sessionID, desiredState) {
  if (
    response.session_id !== sessionID ||
    !response.state ||
    response.desired_state !== desiredState
  ) {
    throw new Error(
      `apptheory: microvm controller ${name} response incomplete`,
    );
  }
}

function requireStatusResponse(response, sessionID) {
  if (
    response.session_id !== sessionID ||
    !response.lifecycle_state ||
    !response.last_transition
  ) {
    throw new Error("apptheory: microvm controller status response incomplete");
  }
}

function requireSessionResponse(response, sessionID) {
  if (
    response.session_id !== sessionID ||
    !response.tenant_id ||
    !response.namespace ||
    !response.registry_version
  ) {
    throw new Error(
      "apptheory: microvm controller session response incomplete",
    );
  }
}

function runtimeControllerRequest(command, requestID, sessionID) {
  const request = {
    command,
    request_id: requestID,
    tenant_id: "tenant-fixture",
    namespace: "namespace-fixture",
    auth_context: {
      subject: "subject-fixture",
      tenant_id: "tenant-fixture",
    },
    session_id: sessionID,
  };
  if (command === "create") {
    request.image_ref = "image-fixture";
    request.network_connector_ref = "network-fixture";
  }
  return request;
}
async function validateMicroVMSessionRegistry(runtime, registry) {
  try {
    runtime.validateMicroVMSessionRegistryContract(registry);
    await exerciseRuntimeSessionRegistry(runtime);
    return "";
  } catch (err) {
    return err?.message ?? String(err);
  }
}

async function exerciseRuntimeSessionRegistry(runtime) {
  const now = new Date("1970-01-01T00:01:40.000Z");
  const record = {
    tenant_id: "tenant-fixture",
    namespace: "namespace-fixture",
    session_id: "session-fixture",
    state: "starting",
    desired_state: "started",
    endpoint: "https://microvm.example.test/session-fixture",
    microvm_id: "microvm-fixture",
    provider_id: "apptheory.microvm.registry",
    provider_microvm_id: "session-fixture",
    provider_state: "starting",
    aws_lifecycle_state: "starting",
    image_ref: "image-fixture",
    network_connector_ref: "network-fixture",
    controller_id: "controller-fixture",
    created_at: now,
    updated_at: new Date(now.valueOf() + 60_000),
    last_observed_at: new Date(now.valueOf() + 60_000),
    expires_at: new Date(now.valueOf() + 3_600_000),
    generation: 3,
    last_action: "start",
    last_command_id: "m15-registry",
    auth_subject: "subject-fixture",
    metadata: { safe: "ok" },
  };
  const registryRecord = runtime.microVMSessionRecordToRegistryRecord(record);
  if (
    registryRecord.pk !==
      runtime.microVMSessionRegistryPartitionKey(
        record.tenant_id,
        record.namespace,
      ) ||
    registryRecord.sk !==
      runtime.microVMSessionRegistrySortKey(record.session_id) ||
    registryRecord.ttl !== Math.trunc(record.expires_at.valueOf() / 1000) ||
    registryRecord.endpoint !== record.endpoint ||
    registryRecord.microvm_id !== record.microvm_id ||
    registryRecord.last_action !== "start"
  ) {
    throw new Error(
      "apptheory: microvm session registry canonical record incomplete",
    );
  }
  const roundTrip = runtime.microVMSessionFromRegistryRecord(registryRecord);
  if (
    roundTrip.endpoint !== record.endpoint ||
    roundTrip.microvm_id !== record.microvm_id ||
    roundTrip.last_action !== record.last_action
  ) {
    throw new Error(
      "apptheory: microvm session registry round trip incomplete",
    );
  }
  const store = runtime.createMemoryMicroVMSessionRegistry();
  const stored = await store.put(record);
  if (stored.last_action !== "start") {
    throw new Error("apptheory: microvm memory registry lost last action");
  }
  const client = runtime.createMicroVMRegistryClient(store, {
    ttl_ms: 30 * 60 * 1000,
  });
  const created = await client.create({
    request_id: "m15-registry-create",
    tenant_id: "tenant-fixture",
    namespace: "namespace-fixture",
    session_id: "session-registry-client",
    image_ref: "image-fixture",
    network_connector_ref: "network-fixture",
    session_spec: { metadata: { safe: "ok" } },
    controller_id: "controller-fixture",
    auth_subject: "subject-fixture",
    now,
  });
  if (
    created.last_action !== "create" ||
    created.expires_at.valueOf() - created.created_at.valueOf() !==
      30 * 60 * 1000
  ) {
    throw new Error(
      "apptheory: microvm registry client create record incomplete",
    );
  }
  const status = await client.status({
    request_id: "m15-registry-status",
    tenant_id: created.tenant_id,
    namespace: created.namespace,
    session_id: created.session_id,
    auth_subject: created.auth_subject,
  });
  if (
    status.last_action !== "create" ||
    status.registry_version !== created.generation
  ) {
    throw new Error("apptheory: microvm registry client status incomplete");
  }
}

function missingStrings(required, got) {
  const seen = new Set(
    (Array.isArray(got) ? got : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  return required.filter((value) => !seen.has(value)).sort();
}

async function compareMicroVMRealContractFixture(fixture) {
  if (fixture.expect?.microvm_lifecycle_adapter) {
    return await compareMicroVMRealLifecycleAdapterFixture(fixture);
  }
  if (fixture.expect?.microvm_controller_route) {
    return await compareMicroVMControllerRouteFixture(fixture);
  }
  if (fixture.expect?.microvm_execution_role) {
    return await compareMicroVMExecutionRoleFixture(fixture);
  }

  const runtime = await loadAppTheoryRuntime();
  const actual = validateMicroVMRealContractFixture(
    fixture.setup?.microvm_contract,
    runtime,
  );
  const expected = fixture.expect?.microvm_contract_validation;
  if (!expected) {
    return {
      ok: false,
      reason: "missing expect.microvm_contract_validation",
      expected_microvm_contract_validation: null,
      actual_microvm_contract_validation: actual,
    };
  }
  if (deepEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "microvm_contract_validation mismatch",
    expected_microvm_contract_validation: expected,
    actual_microvm_contract_validation: actual,
  };
}

function validateMicroVMRealContractFixture(contract, runtime) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract fixture missing",
    );
  }

  const kind = String(contract.kind ?? "").trim();
  const version = String(contract.version ?? "").trim();
  if (
    String(contract.contract ?? "").trim() !== MICROVM_CONTRACT_NAME ||
    version !== "m16.microvm/v1"
  ) {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract must be named and versioned",
    );
  }
  if (kind !== "lifecycle" && kind !== "operation") {
    return invalidMicroVMContract(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract kind is unsupported",
    );
  }

  const escapeHatchError = validateMicroVMEscapeHatches(
    runtime,
    kind,
    version,
    contract.escape_hatches ?? {},
  );
  if (escapeHatchError) return escapeHatchError;

  try {
    if (kind === "lifecycle") {
      runtime.validateMicroVMRealLifecycleContract(contract.lifecycle ?? {});
    } else {
      runtime.validateMicroVMOperationContract(
        contract.operation_contract ?? {},
      );
    }
  } catch (err) {
    return {
      valid: false,
      kind,
      version,
      error_code: String(
        err?.code ?? "m16.microvm.operation_contract_incomplete",
      ),
      error_message: err?.message ?? String(err),
    };
  }

  return { valid: true, kind, version };
}

async function compareMicroVMRealLifecycleAdapterFixture(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const actual = await validateMicroVMRealLifecycleAdapterFixture(
    fixture.setup?.microvm_contract,
    runtime,
  );
  const expected = fixture.expect?.microvm_lifecycle_adapter;
  if (!expected) {
    return {
      ok: false,
      reason: "missing expect.microvm_lifecycle_adapter",
      expected_microvm_lifecycle_adapter: null,
      actual_microvm_lifecycle_adapter: actual,
    };
  }
  if (deepEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "microvm_lifecycle_adapter mismatch",
    expected_microvm_lifecycle_adapter: expected,
    actual_microvm_lifecycle_adapter: actual,
  };
}

async function validateMicroVMRealLifecycleAdapterFixture(contract, runtime) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return invalidMicroVMLifecycleAdapter(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract fixture missing",
    );
  }

  const kind = String(contract.kind ?? "").trim();
  const version = String(contract.version ?? "").trim();
  if (
    String(contract.contract ?? "").trim() !== MICROVM_CONTRACT_NAME ||
    version !== "m16.microvm/v1"
  ) {
    return invalidMicroVMLifecycleAdapter(
      "m15.microvm.invalid_contract",
      "apptheory: microvm contract must be named and versioned",
    );
  }
  if (kind !== "lifecycle") {
    return invalidMicroVMLifecycleAdapter(
      "m15.microvm.invalid_contract",
      "apptheory: microvm lifecycle adapter requires lifecycle contract kind",
    );
  }

  const escapeHatchError = validateMicroVMEscapeHatches(
    runtime,
    kind,
    version,
    contract.escape_hatches ?? {},
  );
  if (escapeHatchError) {
    return invalidMicroVMLifecycleAdapter(
      escapeHatchError.error_code,
      escapeHatchError.error_message,
    );
  }

  const lifecycle = contract.lifecycle ?? {};
  try {
    runtime.validateMicroVMRealLifecycleContract(lifecycle);
  } catch (err) {
    return microVMLifecycleAdapterFromError(
      err,
      "m16.microvm.lifecycle_incomplete",
    );
  }

  const handlerStates = [];
  const handlers = {};
  for (const hook of microVMRealLifecycleFixtureHooks()) {
    handlers[hook] = (event) => {
      handlerStates.push(String(event.state ?? ""));
    };
  }

  let adapter;
  try {
    adapter = runtime.createMicroVMLifecycleAdapter({
      contract: lifecycle,
      handlers,
    });
  } catch (err) {
    return microVMLifecycleAdapterFromError(
      err,
      "m16.microvm.lifecycle_incomplete",
    );
  }

  let state = "requested";
  for (const hook of [
    "validate",
    "run",
    "ready",
    "suspend",
    "resume",
    "terminate",
  ]) {
    const result = await adapter.handle({
      request_id: "m16-lifecycle-adapter-fixture",
      tenant_id: "tenant-fixture",
      namespace: "namespace-fixture",
      session_id: "session-fixture",
      hook,
      state,
    });
    if (result.error) {
      return invalidMicroVMLifecycleAdapter(
        result.error.code,
        result.error.message,
      );
    }
    state = String(result.state ?? "");
  }

  const failure = await adapter.handle({
    request_id: "m16-lifecycle-adapter-fixture-failure",
    tenant_id: "tenant-fixture",
    namespace: "namespace-fixture",
    session_id: "session-fixture",
    hook: "failure",
    state: "running",
  });
  if (failure.error) {
    return invalidMicroVMLifecycleAdapter(
      failure.error.code,
      failure.error.message,
    );
  }

  return {
    valid: true,
    version,
    final_state: state,
    failure_state: String(failure.state ?? ""),
    handler_states: handlerStates,
  };
}

function microVMRealLifecycleFixtureHooks() {
  return [
    "validate",
    "run",
    "ready",
    "suspend",
    "resume",
    "terminate",
    "failure",
  ];
}

function invalidMicroVMLifecycleAdapter(errorCode, errorMessage) {
  return { valid: false, error_code: errorCode, error_message: errorMessage };
}

function microVMLifecycleAdapterFromError(err, defaultCode) {
  return invalidMicroVMLifecycleAdapter(
    String(err?.code ?? defaultCode),
    err?.message ?? String(err),
  );
}

async function compareMicroVMControllerRouteFixture(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const setup = normalizeMicroVMControllerRouteSetup(
    fixture.setup?.microvm_controller_route ?? {},
  );
  const expected = fixture.expect?.microvm_controller_route ?? {};
  const now = new Date("2023-11-14T22:13:20.000Z");
  const provider = runtime.createFakeMicroVMProvider(now);
  const registry = runtime.createMemoryMicroVMSessionRegistry();
  const controller = runtime.createRealMicroVMController(provider, registry, {
    ids: { newID: () => setup.session_id },
    clock: { now: () => new Date(now.valueOf()) },
    deployment_defaults: setup.deployment_defaults,
  });
  if (setup.seed_session) {
    const seeded = await controller.handle(
      microVMControllerRouteRunRequest(runtime, setup),
    );
    if (seeded?.error) {
      return {
        ok: false,
        reason: `seed microvm_controller_route session failed: ${seeded.error.message ?? seeded.error.code}`,
        actual: {
          status: 0,
          headers: {},
          cookies: [],
          body: Buffer.alloc(0),
          is_base64: false,
        },
        expected,
      };
    }
  }

  const appOptions = {
    tier: "p1",
    ids: { newID: () => "req-m16-route-fallback" },
    clock: { now: () => new Date(now.valueOf()) },
  };
  if (setup.authenticated) {
    appOptions.authHook = () => "subject-1";
  }
  const app = runtime.createApp(appOptions);
  runtime.registerMicroVMControllerRoutes(app, controller);

  const req = canonicalizeRequest(
    fixture.input?.request ?? {},
    fixture.input?.context ?? {},
  );
  const actual = await app.serve({
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    cookies: req.cookies,
    body: req.body,
    is_base64: req.is_base64,
  });

  const bodyText = Buffer.from(actual.body ?? Buffer.alloc(0)).toString("utf8");
  let body = {};
  if (bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        reason: "microvm_controller_route response json mismatch",
        actual,
        expected,
      };
    }
  }

  const compare = compareMicroVMControllerRouteExpected(expected, actual, body);
  if (!compare.ok) return { ...compare, actual, expected };

  if (Number.isInteger(expected.registry_token_metadata_count)) {
    let record;
    try {
      record = await registry.get({
        tenant_id: setup.tenant_id,
        namespace: setup.namespace,
        session_id: setup.session_id,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `read microvm_controller_route registry record failed: ${err?.message ?? String(err)}`,
        actual,
        expected,
      };
    }
    const count = Array.isArray(record.token_metadata)
      ? record.token_metadata.length
      : 0;
    if (count !== expected.registry_token_metadata_count) {
      return {
        ok: false,
        reason: `registry_token_metadata_count: expected ${expected.registry_token_metadata_count}, got ${count}`,
        actual,
        expected,
      };
    }
    const recordText = stableStringify(record);
    for (const forbidden of expected.forbidden_body_substrings ?? []) {
      if (forbidden && recordText.includes(String(forbidden))) {
        return {
          ok: false,
          reason: `microvm_controller_route registry record contains forbidden substring ${JSON.stringify(forbidden)}`,
          actual,
          expected,
        };
      }
    }
  }

  return { ok: true };
}

async function compareMicroVMExecutionRoleFixture(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const setup = normalizeMicroVMExecutionRoleSetup(
    fixture.setup?.microvm_execution_role ?? {},
  );
  const expected = fixture.expect?.microvm_execution_role ?? {};
  const actual = await runMicroVMExecutionRoleFixture(runtime, setup);
  if (deepEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "microvm_execution_role mismatch",
    actual_microvm_execution_role: actual,
    expected_microvm_execution_role: expected,
  };
}

async function runMicroVMExecutionRoleFixture(runtime, setup) {
  const envKey = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";
  const previous = process.env[envKey];
  if (setup.execution_role_arn) {
    process.env[envKey] = setup.execution_role_arn;
  } else {
    delete process.env[envKey];
  }
  try {
    const now = new Date("2023-11-14T22:13:20.000Z");
    const baseProvider = runtime.createFakeMicroVMProvider(now);
    let providerExecutionRoleArn = "";
    const provider = {
      run: async (input) => {
        providerExecutionRoleArn = String(input?.execution_role_arn ?? "");
        return await baseProvider.run(input);
      },
      get: (input) => baseProvider.get(input),
      list: (input) => baseProvider.list(input),
      suspend: (input) => baseProvider.suspend(input),
      resume: (input) => baseProvider.resume(input),
      terminate: (input) => baseProvider.terminate(input),
      createAuthToken: (input) => baseProvider.createAuthToken(input),
      createShellToken: (input) => baseProvider.createShellToken(input),
    };
    const registry = runtime.createMemoryMicroVMSessionRegistry();
    const controller = runtime.createRealMicroVMController(provider, registry, {
      ids: { newID: () => setup.session_id },
      clock: { now: () => new Date(now.valueOf()) },
    });
    const response = await controller.handle(
      microVMControllerRouteRunRequest(runtime, setup),
    );
    if (response?.error) {
      return {
        valid: false,
        error_code: String(response.error.code ?? ""),
        error_message: String(response.error.message ?? ""),
      };
    }
    return {
      valid: true,
      session_id: String(response.session_id ?? ""),
      state: String(response.state ?? ""),
      provider_execution_role_arn: providerExecutionRoleArn,
    };
  } catch (err) {
    return {
      valid: false,
      error_code: String(err?.code ?? ""),
      error_message: String(err?.message ?? String(err)),
    };
  } finally {
    if (previous === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = previous;
    }
  }
}

function normalizeMicroVMExecutionRoleSetup(setup) {
  return {
    tenant_id: String(setup.tenant_id ?? "tenant-1").trim() || "tenant-1",
    namespace:
      String(setup.namespace ?? "namespace-1").trim() || "namespace-1",
    session_id:
      String(setup.session_id ?? "fixture-session").trim() ||
      "fixture-session",
    execution_role_arn: String(setup.execution_role_arn ?? "").trim(),
  };
}

function normalizeMicroVMControllerRouteSetup(setup) {
  return {
    authenticated: setup.authenticated === true,
    seed_session: setup.seed_session === true,
    tenant_id: String(setup.tenant_id ?? "tenant-1").trim() || "tenant-1",
    namespace: String(setup.namespace ?? "namespace-1").trim() || "namespace-1",
    session_id:
      String(setup.session_id ?? "fixture-session").trim() || "fixture-session",
    deployment_defaults: normalizeMicroVMDeploymentDefaults(
      setup.deployment_defaults ?? {},
    ),
  };
}

function normalizeMicroVMDeploymentDefaults(defaults) {
  return {
    image_ref: String(defaults.image_ref ?? "").trim(),
    network_connector_ref: String(defaults.network_connector_ref ?? "").trim(),
    ingress_network_connector_refs: stringList(
      defaults.ingress_network_connector_refs ?? [],
    ),
    egress_network_connector_refs: stringList(
      defaults.egress_network_connector_refs ?? [],
    ),
  };
}

function stringList(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
}

function microVMControllerRouteRunRequest(runtime, setup) {
  return {
    command: runtime.MicroVMCommand.Run,
    request_id: "req-m16-route-seed",
    tenant_id: setup.tenant_id,
    namespace: setup.namespace,
    auth_context: {
      subject: "subject-1",
      tenant_id: setup.tenant_id,
      namespace: setup.namespace,
    },
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
    session_spec: { metadata: { safe: "ok" } },
  };
}

function compareMicroVMControllerRouteExpected(expected, actual, body) {
  if (expected.status !== actual.status) {
    return {
      ok: false,
      reason: `status: expected ${expected.status}, got ${actual.status}`,
    };
  }
  const bodyText = Buffer.from(actual.body ?? Buffer.alloc(0)).toString("utf8");
  for (const required of expected.body_contains ?? []) {
    if (required && !bodyText.includes(String(required))) {
      return {
        ok: false,
        reason: `microvm_controller_route body missing substring ${JSON.stringify(required)}`,
      };
    }
  }
  for (const forbidden of expected.forbidden_body_substrings ?? []) {
    if (forbidden && bodyText.includes(String(forbidden))) {
      return {
        ok: false,
        reason: `microvm_controller_route body contains forbidden substring ${JSON.stringify(forbidden)}`,
      };
    }
  }
  for (const field of [
    "command",
    "tenant_id",
    "namespace",
    "session_id",
    "state",
    "token_type",
  ]) {
    if (expected[field] && body[field] !== expected[field]) {
      return {
        ok: false,
        reason: `${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(body[field])}`,
      };
    }
  }
  if (
    Array.isArray(expected.scope) &&
    expected.scope.length > 0 &&
    !deepEqual(expected.scope, body.scope ?? [])
  ) {
    return {
      ok: false,
      reason: `scope: expected ${stableStringify(expected.scope)}, got ${stableStringify(body.scope ?? [])}`,
    };
  }
  if (
    expected.error_code &&
    microVMControllerRouteErrorCode(body) !== expected.error_code
  ) {
    return {
      ok: false,
      reason: `error_code: expected ${JSON.stringify(expected.error_code)}, got ${JSON.stringify(microVMControllerRouteErrorCode(body))}`,
    };
  }
  return { ok: true };
}

function microVMControllerRouteErrorCode(body) {
  const err = body?.error;
  if (!err || typeof err !== "object") return "";
  return String(err.code ?? "");
}

function expectsSetupError(fixture) {
  const expect = fixture.expect ?? {};
  return (
    Object.prototype.hasOwnProperty.call(expect, "error") &&
    !Object.prototype.hasOwnProperty.call(expect, "response") &&
    !Object.prototype.hasOwnProperty.call(expect, "output_json") &&
    !fixture.input?.request &&
    !fixture.input?.aws_event
  );
}

function compareSetupError(fixture, actualError) {
  const expected = fixture.expect?.error ?? {};
  if (!actualError) {
    return {
      ok: false,
      reason: "expected setup error, got none",
      expected_error: expected,
      actual_error: null,
    };
  }
  const actual = {
    code: String(actualError?.code ?? "").trim(),
    message: String(actualError?.message ?? actualError),
    status_code: Number(actualError?.statusCode ?? 0),
  };
  const expectedCode = String(expected.code ?? "").trim();
  if (expectedCode && actual.code !== expectedCode) {
    return {
      ok: false,
      reason: "setup error code mismatch",
      expected_error: expected,
      actual_error: actual,
    };
  }
  const expectedStatusCode = Number(expected.status_code ?? 0);
  if (expectedStatusCode && actual.status_code !== expectedStatusCode) {
    return {
      ok: false,
      reason: "setup error status_code mismatch",
      expected_error: expected,
      actual_error: actual,
    };
  }
  const expectedMessage = String(expected.message ?? "");
  if (expectedMessage && !actual.message.includes(expectedMessage)) {
    return {
      ok: false,
      reason: "setup error message mismatch",
      expected_error: expected,
      actual_error: actual,
    };
  }
  return { ok: true };
}

function routeHandlerForRegistration(runtime, route, effects) {
  const name = String(route?.handler ?? "").trim();
  if (!name) return null;
  const handler = builtInAppTheoryHandler(runtime, name, effects);
  if (!handler) {
    throw new Error(`unknown handler ${JSON.stringify(route?.handler)}`);
  }
  return handler;
}


function sequenceIdGenerator(ids, fallback) {
  let next = 0;
  return {
    newId() {
      if (next < (ids ?? []).length) {
        const value = String(ids[next] ?? "").trim();
        next += 1;
        if (value) return value;
      } else {
        next += 1;
      }
      return `${fallback}-${next}`;
    },
  };
}

function isoFromUnixMS(ms, fallback = "1970-01-01T00:00:00Z") {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n).toISOString().replace(/\.000Z$/, "Z");
}

function fixtureMCPMessageArg(args) {
  const payload = args && typeof args === "object" ? args : {};
  const message = String(payload.message ?? "").trim();
  if (!message) throw new Error("missing message");
  return message;
}

function fixtureMCPToolHandler(name) {
  switch (String(name ?? "").trim()) {
    case "echo_text":
      return (args) => ({ content: [{ type: "text", text: fixtureMCPMessageArg(args) }] });
    case "fail_error":
      return () => {
        throw new Error("fixture tool failed");
      };
    case "task_echo":
      return (args) => {
        const message = fixtureMCPMessageArg(args);
        return {
          content: [{ type: "text", text: message }],
          structuredContent: { message },
        };
      };
    default:
      throw new Error(`unknown mcp tool handler ${JSON.stringify(name)}`);
  }
}

function fixtureMCPStreamingToolHandler(name) {
  switch (String(name ?? "").trim()) {
    case "stream_progress":
      return async (args, emit) => {
        const message = fixtureMCPMessageArg(args);
        await emit({ data: { seq: 1, total: 2, message: "half" } });
        await emit({ data: { seq: 2, total: 2, message: "done" } });
        return { content: [{ type: "text", text: message }] };
      };
    default:
      throw new Error(`unknown mcp streaming tool handler ${JSON.stringify(name)}`);
  }
}

function registerFixtureMCPTool(runtime, server, tool) {
  const def = {
    name: String(tool.name ?? ""),
    ...(tool.title ? { title: String(tool.title) } : {}),
    ...(tool.description ? { description: String(tool.description) } : {}),
    inputSchema: tool.input_schema ?? {},
    ...(tool.output_schema !== undefined ? { outputSchema: tool.output_schema } : {}),
    ...(tool.task_support ? { execution: { taskSupport: String(tool.task_support) } } : {}),
  };
  if (tool.streaming) {
    server.registry().registerStreamingTool(def, fixtureMCPStreamingToolHandler(tool.handler));
    return;
  }
  server.registry().registerTool(def, fixtureMCPToolHandler(tool.handler));
}

function registerFixtureMCPResource(server, resource) {
  const contents = (resource.contents ?? []).map((content) => ({
    uri: String(content.uri ?? ""),
    ...(content.mime_type ? { mimeType: String(content.mime_type) } : {}),
    ...(content.text ? { text: String(content.text) } : {}),
    ...(content.blob ? { blob: String(content.blob) } : {}),
  }));
  server.resources().registerResource(
    {
      uri: String(resource.uri ?? ""),
      name: String(resource.name ?? ""),
      ...(resource.title ? { title: String(resource.title) } : {}),
      ...(resource.description ? { description: String(resource.description) } : {}),
      ...(resource.mime_type ? { mimeType: String(resource.mime_type) } : {}),
      ...(resource.size ? { size: Number(resource.size) } : {}),
    },
    () => contents.map((content) => ({ ...content })),
  );
}

function registerFixtureMCPResourceTemplate(server, template) {
  server.resources().registerResourceTemplate({
    uriTemplate: String(template.uri_template ?? ""),
    name: String(template.name ?? ""),
    ...(template.title ? { title: String(template.title) } : {}),
    ...(template.description ? { description: String(template.description) } : {}),
    ...(template.mime_type ? { mimeType: String(template.mime_type) } : {}),
  });
}

function fixtureMCPPromptHandler(name) {
  switch (String(name ?? "").trim()) {
    case "render_greeting":
      return (args) => {
        const payload = args && typeof args === "object" ? args : {};
        const nameArg = String(payload.name ?? "").trim() || "friend";
        return {
          description: "Rendered greeting",
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Hello, ${nameArg}.` },
            },
          ],
        };
      };
    default:
      throw new Error(`unknown mcp prompt handler ${JSON.stringify(name)}`);
  }
}

function registerFixtureMCPPrompt(server, prompt) {
  server.prompts().registerPrompt(
    {
      name: String(prompt.name ?? ""),
      ...(prompt.title ? { title: String(prompt.title) } : {}),
      ...(prompt.description ? { description: String(prompt.description) } : {}),
      arguments: (prompt.arguments ?? []).map((arg) => ({
        name: String(arg.name ?? ""),
        ...(arg.title ? { title: String(arg.title) } : {}),
        ...(arg.description ? { description: String(arg.description) } : {}),
        ...(arg.required ? { required: true } : {}),
      })),
    },
    fixtureMCPPromptHandler(prompt.handler),
  );
}

class FixtureMCPTaskStore {
  constructor(runtime, config) {
    this.runtime = runtime;
    this.config = config ?? {};
    this.sessions = new Map();
    this.createTime = isoFromUnixMS(this.config.clock_unix_ms, "2026-03-03T12:00:00Z");
    this.updateTime = isoFromUnixMS(this.config.update_clock_unix_ms, "2026-03-03T12:00:01Z");
  }

  _record(sessionId, taskId) {
    return this.sessions.get(String(sessionId ?? "").trim())?.get(String(taskId ?? "").trim()) ?? null;
  }

  _clone(record) {
    return JSON.parse(JSON.stringify(record));
  }

  async create(task) {
    const record = this._clone(task);
    record.sessionId = String(record.sessionId ?? "").trim();
    record.task.taskId = String(record.task.taskId ?? "").trim();
    if (!record.sessionId) throw new Error("missing session id");
    if (!record.task.taskId) throw new Error("missing task id");
    record.task.createdAt = this.createTime;
    record.task.lastUpdatedAt = this.createTime;
    let session = this.sessions.get(record.sessionId);
    if (!session) {
      session = new Map();
      this.sessions.set(record.sessionId, session);
    }
    if (session.has(record.task.taskId)) throw new Error("task already exists");
    session.set(record.task.taskId, this._clone(record));
    return this._clone(record);
  }

  async get(lookup) {
    const record = this._record(lookup.sessionId, lookup.taskId);
    if (!record) throw new this.runtime.McpTaskNotFoundError();
    return this._clone(record);
  }

  async update(task) {
    const existing = this._record(task.sessionId, task.task.taskId);
    if (!existing) throw new this.runtime.McpTaskNotFoundError();
    if (["completed", "failed", "canceled"].includes(String(existing.task.status))) {
      throw new this.runtime.McpTaskTerminalError();
    }
    const record = this._clone(task);
    record.task.createdAt = existing.task.createdAt;
    record.task.lastUpdatedAt = this.updateTime;
    this.sessions.get(record.sessionId).set(record.task.taskId, record);
    return this._clone(record);
  }

  async list(request) {
    const session = this.sessions.get(String(request.sessionId ?? "").trim());
    if (!session) return { tasks: [] };
    const limit = Number(request.limit ?? 0) > 0 ? Number(request.limit) : session.size;
    const tasks = [...session.values()]
      .sort((a, b) => {
        const time = String(a.task.createdAt).localeCompare(String(b.task.createdAt));
        if (time !== 0) return time;
        return String(a.task.taskId).localeCompare(String(b.task.taskId));
      })
      .slice(0, limit)
      .map((record) => this._clone(record.task));
    return { tasks };
  }

  async cancel(lookup) {
    const record = this._record(lookup.sessionId, lookup.taskId);
    if (!record) throw new this.runtime.McpTaskNotFoundError();
    if (["completed", "failed", "canceled"].includes(String(record.task.status))) {
      throw new this.runtime.McpTaskTerminalError();
    }
    record.task.status = "canceled";
    record.task.statusMessage = "task canceled";
    record.task.lastUpdatedAt = this.updateTime;
    record.error = { code: -32000, message: "task canceled" };
    return this._clone(record);
  }

  async deleteSession(sessionId) {
    this.sessions.delete(String(sessionId ?? "").trim());
  }
}

async function newFixtureMCPServer(runtime, setup) {
  const mcpSetup = setup ?? {};
  const serverConfig = mcpSetup.server ?? {};
  const idGenerator = sequenceIdGenerator(mcpSetup.id_sequence ?? [], "mcp-id");
  const streamIdGenerator = sequenceIdGenerator(mcpSetup.stream_id_sequence ?? [], "mcp-stream");
  const sessionSeed = (mcpSetup.session_store?.seed ?? []).map((seed) => ({
    id: String(seed.id ?? ""),
    createdAt: isoFromUnixMS(seed.created_unix_ms),
    expiresAt: isoFromUnixMS(seed.expires_unix_ms, ""),
    data: seed.data ?? {},
  }));
  const options = {
    idGenerator,
    sessionStore: new runtime.MemoryMcpSessionStore({
      now: () => new Date("2023-11-14T22:13:20Z"),
      seed: sessionSeed,
    }),
    streamStore: new runtime.MemoryMcpStreamStore({ idGenerator: streamIdGenerator }),
  };
  if (mcpSetup.task_runtime?.enabled) {
    options.taskRuntime = {
      store: new FixtureMCPTaskStore(runtime, mcpSetup.task_runtime),
      defaultTtlMs: Number(mcpSetup.task_runtime.default_ttl_ms ?? 0),
      maxTtlMs: Number(mcpSetup.task_runtime.max_ttl_ms ?? 0),
      pollIntervalMs: Number(mcpSetup.task_runtime.poll_interval_ms ?? 0),
      listLimit: Number(mcpSetup.task_runtime.list_limit ?? 0),
      modelImmediateResponse: String(mcpSetup.task_runtime.model_immediate_response ?? ""),
    };
  }
  const server = runtime.createMcpServer(
    String(serverConfig.name ?? "").trim() || "AppTheoryContractMCP",
    String(serverConfig.version ?? "").trim() || "sp09",
    options,
  );
  for (const tool of mcpSetup.tools ?? []) registerFixtureMCPTool(runtime, server, tool);
  for (const resource of mcpSetup.resources ?? []) registerFixtureMCPResource(server, resource);
  for (const template of mcpSetup.resource_templates ?? []) registerFixtureMCPResourceTemplate(server, template);
  for (const prompt of mcpSetup.prompts ?? []) registerFixtureMCPPrompt(server, prompt);
  return server;
}

function parseMCPSSEFrames(body) {
  const text = Buffer.from(body ?? []).toString("utf8");
  if (!text.includes("data: ") && !text.includes("id: ")) return [];
  const frames = [];
  for (const rawChunk of text.split("\n\n")) {
    const chunk = rawChunk.replace(/^\n+|\n+$/g, "");
    if (!chunk.trim()) continue;
    const frame = { id: "", data: "" };
    const dataLines = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id: ")) {
        frame.id = line.slice(4).trim();
      } else if (line.startsWith("event: ")) {
        frame.event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line.trim() === "") {
        // ignore
      } else {
        throw new Error(`invalid SSE line ${JSON.stringify(line)}`);
      }
    }
    frame.data = dataLines.join("\n");
    frames.push(frame);
  }
  return frames;
}

async function responseBodyBytes(response) {
  const buffers = [];
  if (response.body) buffers.push(Buffer.from(response.body));
  if (response.bodyStream) {
    for await (const chunk of response.bodyStream) buffers.push(Buffer.from(chunk ?? []));
  }
  return Buffer.concat(buffers);
}

async function invokeMCPFixtureStep(app, step) {
  const req = canonicalizeRequest(step.request ?? {}, {});
  const response = await app.serve(req);
  const body = await responseBodyBytes(response);
  return {
    status: Number(response.status ?? 0),
    headers: canonicalizeHeaders(response.headers ?? {}),
    cookies: Array.isArray(response.cookies) ? response.cookies.map(String) : [],
    body,
    sse_frames: parseMCPSSEFrames(body),
    is_base64: Boolean(response.isBase64),
  };
}

function compareMCPStep(expected, actual) {
  if (Number(expected.status ?? 0) !== actual.status) {
    return { ok: false, reason: `status: expected ${expected.status}, got ${actual.status}`, actual, expected };
  }
  if (Boolean(expected.is_base64) !== actual.is_base64) {
    return { ok: false, reason: `is_base64: expected ${expected.is_base64}, got ${actual.is_base64}`, actual, expected };
  }
  if (!deepEqual(expected.cookies ?? [], actual.cookies ?? [])) {
    return { ok: false, reason: "cookies mismatch", actual, expected };
  }
  if (!compareHeaders(expected.headers ?? {}, actual.headers ?? {})) {
    return { ok: false, reason: "headers mismatch", actual, expected };
  }
  if (Array.isArray(expected.sse_frames)) {
    if (!deepEqual(expected.sse_frames, actual.sse_frames)) {
      return { ok: false, reason: "sse_frames mismatch", actual, expected };
    }
    return { ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(expected, "body_json")) {
    let actualJson;
    try {
      actualJson = JSON.parse(actual.body.toString("utf8"));
    } catch {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    if (!deepEqual(expected.body_json, actualJson)) {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    return { ok: true };
  }
  const expectedBody = expected.body ? decodeFixtureBody(expected.body) : Buffer.alloc(0);
  if (!expectedBody.equals(actual.body)) {
    return { ok: false, reason: "body mismatch", actual, expected };
  }
  return { ok: true };
}

async function runFixtureMCP(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const server = await newFixtureMCPServer(runtime, fixture.setup?.mcp ?? {});
  const ids = { newId: () => "req_mcp_123" };
  const app = runtime.createApp({ ids });
  const handler = server.handler();
  app.post("/mcp", handler);
  app.get("/mcp", handler);
  app.delete("/mcp", handler);

  const steps = fixture.input?.mcp?.steps ?? [];
  const expectedSteps = fixture.expect?.mcp?.steps ?? [];
  if (steps.length !== expectedSteps.length) {
    return { ok: false, reason: "mcp steps length mismatch", actual: steps.length, expected: expectedSteps.length };
  }
  for (let i = 0; i < steps.length; i += 1) {
    const actual = await invokeMCPFixtureStep(app, steps[i]);
    const result = compareMCPStep(expectedSteps[i], actual);
    if (!result.ok) {
      return { ...result, reason: `step ${steps[i].name}: ${result.reason}` };
    }
  }
  return { ok: true };
}

function oauthPathFromURL(raw, fallback = "/") {
  try {
    const url = new URL(String(raw ?? ""));
    return url.pathname || fallback;
  } catch {
    return fallback;
  }
}

function oauthSequence(values) {
  let index = 0;
  return {
    next(prefix) {
      if (index < (values ?? []).length) {
        const out = String(values[index] ?? "").trim();
        index += 1;
        if (out) return out;
      }
      index += 1;
      return `${prefix}_${index}`;
    },
  };
}

function oauthSetupPolicy(setup) {
  const policy = setup.dcr_policy ?? {};
  return {
    allowedRedirectUris: (policy.allowed_redirect_uris ?? []).map(String),
    requirePublicClient: policy.require_public_client === true,
    requireRefreshToken: policy.require_refresh_token === true,
  };
}

function oauthTokenRecords(setup) {
  return (setup.bearer_tokens ?? []).map((record) => ({
    token: String(record.token ?? ""),
    subject: String(record.subject ?? ""),
    audience: String(record.audience ?? ""),
    scope: String(record.scope ?? ""),
    scopes: (record.scopes ?? []).map(String),
    expiresAt: record.expires_unix
      ? new Date(Number(record.expires_unix) * 1000)
      : undefined,
  }));
}

async function newOAuthFixtureApp(runtime, setup) {
  const resource = String(setup.resource ?? "").trim();
  const metadataURL = runtime.resourceMetadataURLFromMcpEndpoint(resource);
  if (!metadataURL) throw new Error("oauth setup resource is not an absolute URL");
  const state = {
    clients: new Map(),
    codes: new Map(),
    ids: oauthSequence(setup.id_sequence ?? []),
  };
  const clockUnix = Number(setup.clock_unix ?? 0);
  const fixedNow = () => new Date(clockUnix * 1000);
  const app = runtime.createApp({ tier: "p0" });
  const metadata = runtime.newProtectedResourceMetadata(
    resource,
    setup.authorization_servers ?? [],
  );
  metadata.scopes_supported = (setup.scopes_supported ?? []).map(String);
  metadata.bearer_methods_supported = ["header"];
  app.get(oauthPathFromURL(metadataURL), runtime.protectedResourceMetadataHandler(metadata));

  const validator = runtime.newMemoryBearerTokenValidator(oauthTokenRecords(setup), {
    requiredAudience: String(setup.required_audience ?? resource).trim(),
    requiredScopes: (setup.required_scopes ?? []).map(String),
    now: fixedNow,
  });
  const bearerMiddleware = runtime.requireBearerTokenMiddleware({
    resourceMetadataURL: metadataURL,
    claimsValidator: validator,
  });
  const protectedNext = async (ctx) => {
    const claims = runtime.bearerTokenClaimsFromContext(ctx) ?? {};
    return runtime.json(200, {
      ok: true,
      subject: String(claims.subject ?? ""),
      scopes: (claims.scopes ?? []).map(String),
    });
  };
  const protectedHandler = async (ctx) => bearerMiddleware(ctx, protectedNext);
  app.get(oauthPathFromURL(resource, "/mcp"), protectedHandler);

  const policy = oauthSetupPolicy(setup);
  app.post("/register", async (ctx) => {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(ctx.request.body ?? []).toString("utf8"));
      runtime.validateDynamicClientRegistrationRequest(payload, policy);
    } catch {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    const clientId = state.ids.next("client");
    state.clients.set(clientId, payload);
    return runtime.json(201, {
      client_id: clientId,
      client_id_issued_at: clockUnix,
    });
  });
  app.get("/authorize", async (ctx) => {
    const q = ctx.request.query ?? {};
    const clientId = firstQuery(q, "client_id");
    const client = state.clients.get(clientId);
    if (
      !client ||
      firstQuery(q, "response_type") !== "code" ||
      firstQuery(q, "code_challenge_method") !== "S256" ||
      firstQuery(q, "resource") !== resource
    ) {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    const redirectURI = firstQuery(q, "redirect_uri");
    if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectURI)) {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    const challenge = firstQuery(q, "code_challenge");
    if (!challenge) {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    const code = state.ids.next("code");
    state.codes.set(code, {
      code,
      clientId,
      redirectURI,
      resource,
      scope: firstQuery(q, "scope"),
      codeChallenge: challenge,
    });
    return {
      status: 302,
      headers: { location: [redirectWithCode(redirectURI, code, firstQuery(q, "state"))] },
      cookies: [],
      body: Buffer.alloc(0),
      isBase64: false,
    };
  });
  app.post("/token", async (ctx) => {
    const form = new URLSearchParams(Buffer.from(ctx.request.body ?? []).toString("utf8"));
    const code = form.get("code") ?? "";
    const rec = state.codes.get(code);
    if (
      !rec ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("resource") !== resource ||
      form.get("client_id") !== rec.clientId ||
      form.get("redirect_uri") !== rec.redirectURI
    ) {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    state.codes.delete(code);
    let verified = false;
    try {
      verified = runtime.pkceVerifyS256(form.get("code_verifier") ?? "", rec.codeChallenge);
    } catch {
      verified = false;
    }
    if (!verified) {
      return oauthErrorResponse(runtime, 400, "app.bad_request", "bad request");
    }
    return runtime.json(200, {
      access_token: state.ids.next("access"),
      refresh_token: state.ids.next("refresh"),
      token_type: "Bearer",
      expires_in: 3600,
      scope: rec.scope,
    });
  });
  return app;
}

function oauthErrorResponse(runtime, status, code, message) {
  return runtime.json(status, { error: { code, message } });
}

function firstQuery(query, name) {
  const values = query?.[name] ?? [];
  return String(Array.isArray(values) ? (values[0] ?? "") : values).trim();
}

function redirectWithCode(redirectURI, code, state) {
  const url = new URL(redirectURI);
  url.searchParams.set("code", code);
  if (String(state ?? "").trim()) url.searchParams.set("state", String(state).trim());
  return url.toString();
}

async function invokeOAuthFixtureStep(app, step) {
  const req = canonicalizeRequest(step.request ?? {}, {});
  const response = await app.serve(req);
  const body = await responseBodyBytes(response);
  return {
    status: Number(response.status ?? 0),
    headers: canonicalizeHeaders(response.headers ?? {}),
    cookies: Array.isArray(response.cookies) ? response.cookies.map(String) : [],
    body,
    is_base64: Boolean(response.isBase64),
  };
}

function compareOAuthStep(expected, actual) {
  if (Number(expected.status ?? 0) !== actual.status) {
    return { ok: false, reason: `status: expected ${expected.status}, got ${actual.status}`, actual, expected };
  }
  if (Boolean(expected.is_base64) !== actual.is_base64) {
    return { ok: false, reason: `is_base64: expected ${expected.is_base64}, got ${actual.is_base64}`, actual, expected };
  }
  if (!deepEqual(expected.cookies ?? [], actual.cookies ?? [])) {
    return { ok: false, reason: "cookies mismatch", actual, expected };
  }
  if (!compareHeaders(expected.headers ?? {}, actual.headers ?? {})) {
    return { ok: false, reason: "headers mismatch", actual, expected };
  }
  if (Object.prototype.hasOwnProperty.call(expected, "body_json")) {
    let actualJson;
    try {
      actualJson = JSON.parse(actual.body.toString("utf8"));
    } catch {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    if (!deepEqual(expected.body_json, actualJson)) {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    return { ok: true };
  }
  const expectedBody = expected.body ? decodeFixtureBody(expected.body) : Buffer.alloc(0);
  if (!expectedBody.equals(actual.body)) {
    return { ok: false, reason: "body mismatch", actual, expected };
  }
  return { ok: true };
}

async function runFixtureOAuth(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const app = await newOAuthFixtureApp(runtime, fixture.setup?.oauth ?? {});
  const steps = fixture.input?.oauth?.steps ?? [];
  const expectedSteps = fixture.expect?.oauth?.steps ?? [];
  if (steps.length !== expectedSteps.length) {
    return { ok: false, reason: "oauth steps length mismatch", actual: steps.length, expected: expectedSteps.length };
  }
  for (let i = 0; i < steps.length; i += 1) {
    const actual = await invokeOAuthFixtureStep(app, steps[i]);
    const result = compareOAuthStep(expectedSteps[i], actual);
    if (!result.ok) {
      return { ...result, reason: `step ${steps[i].name}: ${result.reason}` };
    }
  }
  return { ok: true };
}


async function runFixtureObjectStore(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const backend = String(fixture.setup?.objectstore?.backend ?? "fake").trim();
  if (backend !== "fake") {
    return { ok: false, reason: `objectstore fixture backend ${JSON.stringify(backend)} is unsupported` };
  }
  const steps = fixture.input?.objectstore?.steps ?? [];
  if (steps.length === 0) {
    return { ok: false, reason: "objectstore fixture missing input.objectstore.steps" };
  }
  const fake = runtime.createFakeObjectStore();
  const actualSteps = [];
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop
    actualSteps.push(await runObjectStoreStep(runtime, fake, step));
  }
  return compareFixtureOutputJson(fixture, {
    steps: actualSteps,
    calls: objectStoreCallsJSON(fake.calls()),
  });
}

async function runObjectStoreStep(runtime, fake, step) {
  const operation = String(step.operation ?? "").trim().toLowerCase();
  const result = { name: String(step.name ?? ""), operation };
  try {
    if (operation === "parse_ref") {
      const ref = objectStoreStepRef(runtime, step);
      return objectStoreStepResult(result, { ref });
    }
    if (operation === "put") {
      const ref = await fake.put({
        ref: objectStoreStepRef(runtime, step),
        payload: decodeFixtureBody(step.payload),
        ...(step.content_type ? { contentType: String(step.content_type) } : {}),
        ...(step.metadata ? { metadata: cloneObjectStoreMetadata(step.metadata) } : {}),
      });
      return objectStoreStepResult(result, { ref });
    }
    if (operation === "get") {
      const output = await fake.get({
        ref: objectStoreStepRef(runtime, step),
        maxBytes: Number(step.max_bytes ?? 0),
      });
      return objectStoreStepResult(result, { output });
    }
    if (operation === "delete") {
      await fake.delete({ ref: objectStoreStepRef(runtime, step) });
      return objectStoreStepResult(result, {});
    }
    if (["list", "presign", "multipart"].includes(operation)) {
      assertForbiddenObjectStoreOperation(runtime, fake, operation);
    }
    runtime.unsupportedObjectStoreOperation(operation);
  } catch (err) {
    return objectStoreStepResult(result, { error: err });
  }
  return objectStoreStepResult(result, {});
}

function objectStoreStepResult(base, { ref = null, output = null, error = null }) {
  const result = { ...base };
  if (error) {
    result.ok = false;
    result.error = objectStoreErrorJSON(error);
    return result;
  }
  result.ok = true;
  if (output) {
    result.ref = objectStoreRefJSON(output.ref);
    result.payload = objectStoreBodyJSON(output.payload);
    if (output.contentType) result.content_type = output.contentType;
    if (output.metadata && Object.keys(output.metadata).length > 0) {
      result.metadata = cloneObjectStoreMetadata(output.metadata);
    }
    return result;
  }
  if (ref) result.ref = objectStoreRefJSON(ref);
  return result;
}

function objectStoreStepRef(runtime, step) {
  if (typeof step.ref === "string") return runtime.parseObjectRef(step.ref);
  const raw = step.ref && typeof step.ref === "object" ? step.ref : {};
  const ref = {
    bucket: String(raw.bucket ?? ""),
    key: String(raw.key ?? ""),
    ...(raw.version_id ? { versionId: String(raw.version_id) } : {}),
  };
  runtime.validateObjectRef(ref);
  return ref;
}

function objectStoreErrorJSON(err) {
  return {
    code: String(err?.code ?? objectStoreErrorCodeFromMessage(String(err?.message ?? err))),
    message: String(err?.message ?? err),
  };
}

function objectStoreErrorCodeFromMessage(message) {
  if (message === "objectstore: invalid object ref") return "objectstore.invalid_ref";
  if (message === "objectstore: max bytes must be positive") return "objectstore.invalid_get_limit";
  if (message === "objectstore: object exceeds max bytes") return "objectstore.object_too_large";
  if (message === "objectstore: object not found") return "objectstore.not_found";
  if (message.startsWith("objectstore: unsupported operation")) return "objectstore.unsupported_operation";
  return "objectstore.error";
}

function assertForbiddenObjectStoreOperation(_runtime, fake, operation) {
  const methodNames = {
    list: ["list", "listObjects"],
    presign: ["presign", "presignGet", "presignPut", "publicURL"],
    multipart: ["multipart", "createMultipartUpload", "uploadPart", "completeMultipartUpload", "abortMultipartUpload"],
  };
  for (const method of methodNames[operation] ?? []) {
    if (typeof fake?.[method] === "function") {
      throw new Error(`objectstore: forbidden operation exposed: ${operation}`);
    }
  }
}

function objectStoreCallsJSON(calls) {
  return (calls ?? []).map((call) => {
    const out = { operation: String(call.operation ?? ""), ref: objectStoreRefJSON(call.ref ?? {}) };
    if (call.maxBytes !== undefined) out.max_bytes = Number(call.maxBytes);
    if (call.payload) out.payload = objectStoreBodyJSON(call.payload);
    if (call.contentType) out.content_type = String(call.contentType);
    if (call.metadata && Object.keys(call.metadata).length > 0) {
      out.metadata = cloneObjectStoreMetadata(call.metadata);
    }
    return out;
  });
}

function objectStoreRefJSON(ref) {
  const out = { bucket: String(ref.bucket ?? ""), key: String(ref.key ?? "") };
  if (ref.versionId) out.version_id = String(ref.versionId);
  return out;
}

function objectStoreBodyJSON(payload) {
  const bytes = Buffer.from(payload ?? []);
  if (isValidUTF8(bytes)) return { encoding: "utf8", value: bytes.toString("utf8") };
  return { encoding: "base64", value: bytes.toString("base64") };
}

function isValidUTF8(bytes) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(decoded, "utf8").equals(bytes);
  } catch (_err) {
    return false;
  }
}

function cloneObjectStoreMetadata(metadata) {
  return Object.fromEntries(
    Object.keys(metadata ?? {})
      .sort()
      .map((key) => [key, String(metadata[key])]),
  );
}

async function runFixture(fixture) {
  if (isOpenAPIContractFixture(fixture)) {
    return await compareOpenAPIContract(fixture);
  }

  const tier = String(fixture.tier ?? "")
    .trim()
    .toLowerCase();

  if (tier === "mcp") {
    return await runFixtureMCP(fixture);
  }
  if (tier === "oauth") {
    return await runFixtureOAuth(fixture);
  }
  if (tier === "objectstore") {
    return await runFixtureObjectStore(fixture);
  }
  if (tier === "vectorstore") {
    return await runFixtureVectorStore(fixture);
  }

  if (tier === "p0") {
    const result = await runFixtureP0(fixture);
    if (expectsSetupError(fixture)) {
      return compareSetupError(fixture, result.actualError);
    }
    return compareFixture(fixture, result.actual, result.effects);
  }
  if (tier === "p1") {
    const { actual, effects } = await runFixtureP1(fixture);
    return compareFixture(fixture, actual, effects);
  }
  if (tier === "p2") {
    if (isLoggingProfileContractFixture(fixture)) {
      return await compareLoggingProfileContract(fixture);
    }
    const expect = fixture.expect ?? {};
    if (
      Object.prototype.hasOwnProperty.call(expect, "output_json") ||
      Object.prototype.hasOwnProperty.call(expect, "error")
    ) {
      const { actualOutput, actualError, effects } =
        await runFixtureP2Output(fixture);
      return compareFixtureM1Result(fixture, {
        actualOutput,
        actualError,
        effects,
      });
    }
    const { actual, effects } = await runFixtureP2(fixture);
    return compareFixture(fixture, actual, effects);
  }
  if (tier === "m1") {
    const { actualOutput, actualError, effects } = await runFixtureM1(fixture);
    return compareFixtureM1Result(fixture, {
      actualOutput,
      actualError,
      effects,
    });
  }
  if (tier === "m2") {
    const { actual, wsCalls } = await runFixtureM2(fixture);
    const result = compareFixture(fixture, actual, {
      logs: [],
      metrics: [],
      spans: [],
    });
    if (!result.ok) return result;
    return compareWebSocketCalls(fixture, wsCalls);
  }
  if (tier === "m3") {
    const { actual } = await runFixtureM3(fixture);
    return compareFixture(fixture, actual, {
      logs: [],
      metrics: [],
      spans: [],
    });
  }
  if (tier === "m12") {
    const { actual, effects } = await runFixtureM12(fixture);
    return compareFixture(fixture, actual, effects);
  }
  if (tier === "m14") {
    const result = await runFixtureM14(fixture);
    if (expectsSetupError(fixture)) {
      return compareSetupError(fixture, result.actualError);
    }
    const { actual } = result;
    return compareFixture(fixture, actual, {
      logs: [],
      metrics: [],
      spans: [],
    });
  }
  if (tier === "m15") {
    return await compareMicroVMContractFixture(fixture);
  }
  if (tier === "m16") {
    return await compareMicroVMRealContractFixture(fixture);
  }

  const enableP1 = ["p1", "p2"].includes(tier);
  const enableP2 = tier === "p2";
  const app = newFixtureApp(fixture.setup?.routes ?? [], {
    enableP1,
    enableP2,
    limits: fixture.setup?.limits ?? {},
  });
  const req = canonicalizeRequest(
    fixture.input?.request ?? {},
    fixture.input?.context ?? {},
  );
  const actual = app.handle(req);
  const effects = app.effects ?? {};
  return compareFixture(fixture, actual, effects);
}

function compareFixture(fixture, actual, effects) {
  const expected = fixture.expect?.response ?? {};

  if (expected.status !== actual.status) {
    return {
      ok: false,
      reason: `status: expected ${expected.status}, got ${actual.status}`,
      actual,
      expected,
    };
  }
  if ((expected.is_base64 ?? false) !== (actual.is_base64 ?? false)) {
    return {
      ok: false,
      reason: `is_base64: expected ${expected.is_base64}, got ${actual.is_base64}`,
      actual,
      expected,
    };
  }
  if (!deepEqual(expected.cookies ?? [], actual.cookies ?? [])) {
    return { ok: false, reason: "cookies mismatch", actual, expected };
  }
  if (!compareHeaders(expected.headers, actual.headers)) {
    return { ok: false, reason: "headers mismatch", actual, expected };
  }

  const expectedStreamErrorCode = String(expected.stream_error_code ?? "");
  const actualStreamErrorCode = String(actual.stream_error_code ?? "");
  if (expectedStreamErrorCode !== actualStreamErrorCode) {
    return {
      ok: false,
      reason: `stream_error_code: expected ${JSON.stringify(expectedStreamErrorCode)}, got ${JSON.stringify(actualStreamErrorCode)}`,
      actual,
      expected,
    };
  }

  const hasBodyJson = Object.prototype.hasOwnProperty.call(
    expected,
    "body_json",
  );
  if (hasBodyJson) {
    let actualJson;
    try {
      actualJson = JSON.parse(actual.body.toString("utf8"));
    } catch {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    if (!deepEqual(expected.body_json, actualJson)) {
      return { ok: false, reason: "body_json mismatch", actual, expected };
    }
    const expectedLogs = fixture.expect?.logs ?? [];
    const expectedMetrics = fixture.expect?.metrics ?? [];
    const expectedSpans = fixture.expect?.spans ?? [];
    if (!deepEqual(expectedLogs, effects.logs ?? [])) {
      return {
        ok: false,
        reason: "logs mismatch",
        actual,
        expected,
        expected_logs: expectedLogs,
        actual_logs: effects.logs ?? [],
      };
    }
    if (!deepEqual(expectedMetrics, effects.metrics ?? [])) {
      return {
        ok: false,
        reason: "metrics mismatch",
        actual,
        expected,
        expected_metrics: expectedMetrics,
        actual_metrics: effects.metrics ?? [],
      };
    }
    if (!deepEqual(expectedSpans, effects.spans ?? [])) {
      return {
        ok: false,
        reason: "spans mismatch",
        actual,
        expected,
        expected_spans: expectedSpans,
        actual_spans: effects.spans ?? [],
      };
    }
    const emfResult = compareEMFLogsIfExpected(fixture, effects, actual, expected);
    if (!emfResult.ok) return emfResult;
    return { ok: true };
  }

  const expectedChunksRaw = expected.chunks ?? null;
  if (Array.isArray(expectedChunksRaw) && expectedChunksRaw.length > 0) {
    const expectedChunks = expectedChunksRaw.map(decodeFixtureBody);
    const actualChunks = Array.isArray(actual.chunks)
      ? actual.chunks.map((c) => Buffer.from(c ?? []))
      : [];
    if (expectedChunks.length !== actualChunks.length) {
      return { ok: false, reason: "chunks mismatch", actual, expected };
    }
    for (let i = 0; i < expectedChunks.length; i += 1) {
      if (!expectedChunks[i].equals(actualChunks[i])) {
        return { ok: false, reason: `chunk ${i} mismatch`, actual, expected };
      }
    }

    const expectedBody = expected.body
      ? decodeFixtureBody(expected.body)
      : Buffer.concat(expectedChunks);
    if (!expectedBody.equals(actual.body)) {
      return { ok: false, reason: "body mismatch", actual, expected };
    }

    const expectedLogs = fixture.expect?.logs ?? [];
    const expectedMetrics = fixture.expect?.metrics ?? [];
    const expectedSpans = fixture.expect?.spans ?? [];
    if (!deepEqual(expectedLogs, effects.logs ?? [])) {
      return {
        ok: false,
        reason: "logs mismatch",
        actual,
        expected,
        expected_logs: expectedLogs,
        actual_logs: effects.logs ?? [],
      };
    }
    if (!deepEqual(expectedMetrics, effects.metrics ?? [])) {
      return {
        ok: false,
        reason: "metrics mismatch",
        actual,
        expected,
        expected_metrics: expectedMetrics,
        actual_metrics: effects.metrics ?? [],
      };
    }
    if (!deepEqual(expectedSpans, effects.spans ?? [])) {
      return {
        ok: false,
        reason: "spans mismatch",
        actual,
        expected,
        expected_spans: expectedSpans,
        actual_spans: effects.spans ?? [],
      };
    }
    const emfResult = compareEMFLogsIfExpected(fixture, effects, actual, expected);
    if (!emfResult.ok) return emfResult;
    return { ok: true };
  }

  if (expected.body) {
    const expectedBytes = decodeFixtureBody(expected.body);
    if (!expectedBytes.equals(actual.body)) {
      return { ok: false, reason: "body mismatch", actual, expected };
    }
    const expectedLogs = fixture.expect?.logs ?? [];
    const expectedMetrics = fixture.expect?.metrics ?? [];
    const expectedSpans = fixture.expect?.spans ?? [];
    if (!deepEqual(expectedLogs, effects.logs ?? [])) {
      return {
        ok: false,
        reason: "logs mismatch",
        actual,
        expected,
        expected_logs: expectedLogs,
        actual_logs: effects.logs ?? [],
      };
    }
    if (!deepEqual(expectedMetrics, effects.metrics ?? [])) {
      return {
        ok: false,
        reason: "metrics mismatch",
        actual,
        expected,
        expected_metrics: expectedMetrics,
        actual_metrics: effects.metrics ?? [],
      };
    }
    if (!deepEqual(expectedSpans, effects.spans ?? [])) {
      return {
        ok: false,
        reason: "spans mismatch",
        actual,
        expected,
        expected_spans: expectedSpans,
        actual_spans: effects.spans ?? [],
      };
    }
    const emfResult = compareEMFLogsIfExpected(fixture, effects, actual, expected);
    if (!emfResult.ok) return emfResult;
    return { ok: true };
  }

  if (!Buffer.alloc(0).equals(actual.body)) {
    return { ok: false, reason: "body mismatch", actual, expected };
  }
  const expectedLogs = fixture.expect?.logs ?? [];
  const expectedMetrics = fixture.expect?.metrics ?? [];
  const expectedSpans = fixture.expect?.spans ?? [];
  if (!deepEqual(expectedLogs, effects.logs ?? [])) {
    return {
      ok: false,
      reason: "logs mismatch",
      actual,
      expected,
      expected_logs: expectedLogs,
      actual_logs: effects.logs ?? [],
    };
  }
  if (!deepEqual(expectedMetrics, effects.metrics ?? [])) {
    return {
      ok: false,
      reason: "metrics mismatch",
      actual,
      expected,
      expected_metrics: expectedMetrics,
      actual_metrics: effects.metrics ?? [],
    };
  }
  if (!deepEqual(expectedSpans, effects.spans ?? [])) {
    return {
      ok: false,
      reason: "spans mismatch",
      actual,
      expected,
      expected_spans: expectedSpans,
      actual_spans: effects.spans ?? [],
    };
  }
  const emfResult = compareEMFLogsIfExpected(fixture, effects, actual, expected);
  if (!emfResult.ok) return emfResult;
  return { ok: true };
}

function compareFixtureOutputJson(fixture, actualOutput) {
  if (
    !fixture.expect ||
    !Object.prototype.hasOwnProperty.call(fixture.expect, "output_json")
  ) {
    return {
      ok: false,
      reason: "missing expect.output_json",
      expected_output_json: null,
      actual_output_json: actualOutput,
    };
  }
  const expectedOutput = fixture.expect.output_json;
  if (stableStringify(expectedOutput) !== stableStringify(actualOutput)) {
    return {
      ok: false,
      reason: "output_json mismatch",
      expected_output_json: expectedOutput,
      actual_output_json: actualOutput,
    };
  }
  return { ok: true };
}

function compareFixtureM1Result(
  fixture,
  { actualOutput, actualError, effects },
) {
  const expect = fixture.expect ?? {};
  const hasError = Object.prototype.hasOwnProperty.call(expect, "error");
  const hasOutputJson = Object.prototype.hasOwnProperty.call(
    expect,
    "output_json",
  );

  if (hasError) {
    if (hasOutputJson) {
      return {
        ok: false,
        reason: "fixture expect cannot set both error and output_json",
        expected_error: expect.error,
        actual_error: actualError
          ? { message: String(actualError.message ?? actualError) }
          : null,
      };
    }

    if (!actualError) {
      return {
        ok: false,
        reason: "expected error, got none",
        expected_error: expect.error,
        actual_error: null,
      };
    }

    const expectedMsg = String(expect.error?.message ?? "").trim();
    const actualMsg = String(actualError.message ?? actualError).trim();
    if (expectedMsg && actualMsg !== expectedMsg) {
      return {
        ok: false,
        reason: "error mismatch",
        expected_error: expect.error,
        actual_error: { message: actualMsg },
      };
    }
    return compareM1SideEffectsIfExpected(fixture, effects);
  }

  if (!hasOutputJson) {
    return {
      ok: false,
      reason: "missing expect.output_json or expect.error",
      expected_output_json: null,
      actual_output_json: actualOutput,
      actual_error: actualError
        ? { message: String(actualError.message ?? actualError) }
        : null,
    };
  }
  if (actualError) {
    return {
      ok: false,
      reason: "unexpected error",
      expected_output_json: expect.output_json,
      actual_output_json: actualOutput,
      actual_error: { message: String(actualError.message ?? actualError) },
    };
  }
  const outputResult = compareFixtureOutputJson(fixture, actualOutput);
  if (!outputResult.ok) return outputResult;
  return compareM1SideEffectsIfExpected(fixture, effects);
}

function compareM1SideEffectsIfExpected(fixture, effects) {
  const expect = fixture.expect ?? {};
  const expectsEffects =
    Object.prototype.hasOwnProperty.call(expect, "logs") ||
    Object.prototype.hasOwnProperty.call(expect, "metrics") ||
    Object.prototype.hasOwnProperty.call(expect, "spans") ||
    Object.prototype.hasOwnProperty.call(expect, "emf_logs");
  if (!expectsEffects) return { ok: true };
  const actualEffects = effects ?? newEffects();
  if (!deepEqual(expect.logs ?? [], actualEffects.logs ?? [])) {
    return {
      ok: false,
      reason: "logs mismatch",
      expected_output_json: expect.output_json ?? null,
      actual_output_json: null,
      expected_logs: expect.logs ?? [],
      actual_logs: actualEffects.logs ?? [],
    };
  }
  if (!deepEqual(expect.metrics ?? [], actualEffects.metrics ?? [])) {
    return {
      ok: false,
      reason: "metrics mismatch",
      expected_output_json: expect.output_json ?? null,
      actual_output_json: null,
      expected_metrics: expect.metrics ?? [],
      actual_metrics: actualEffects.metrics ?? [],
    };
  }
  if (!deepEqual(expect.spans ?? [], actualEffects.spans ?? [])) {
    return {
      ok: false,
      reason: "spans mismatch",
      expected_output_json: expect.output_json ?? null,
      actual_output_json: null,
      expected_spans: expect.spans ?? [],
      actual_spans: actualEffects.spans ?? [],
    };
  }
  if (Object.prototype.hasOwnProperty.call(expect, "emf_logs") && !deepEqual(expect.emf_logs ?? [], actualEffects.emf_logs ?? [])) {
    return {
      ok: false,
      reason: "emf_logs mismatch",
      expected_output_json: expect.output_json ?? null,
      actual_output_json: null,
      expected_emf_logs: expect.emf_logs ?? [],
      actual_emf_logs: actualEffects.emf_logs ?? [],
    };
  }
  return { ok: true };
}

function usesCloudWatchLogsSubscriptionHandler(fixture) {
  return (fixture.setup?.kinesis ?? []).some(
    (route) =>
      String(route?.handler ?? "").trim() ===
      CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER,
  );
}

function buildCloudWatchLogsSubscriptionExpectations(fixture) {
  const usesHandler = usesCloudWatchLogsSubscriptionHandler(fixture);
  const expectationRoot = fixture.expect?.cloudwatch_logs_subscription ?? null;
  if (!expectationRoot) {
    if (usesHandler) {
      throw new Error("fixture missing expect.cloudwatch_logs_subscription");
    }
    return null;
  }
  if (!usesHandler) {
    throw new Error(
      "expect.cloudwatch_logs_subscription requires kinesis_require_cloudwatch_logs_subscription handler",
    );
  }

  const expectedRecords = expectationRoot.records ?? [];
  if (!Array.isArray(expectedRecords) || expectedRecords.length === 0) {
    throw new Error(
      "fixture missing expect.cloudwatch_logs_subscription.records",
    );
  }

  const inputRecords = fixture.input?.aws_event?.event?.Records ?? null;
  if (!Array.isArray(inputRecords) || inputRecords.length === 0) {
    throw new Error(
      "cloudwatch logs subscription fixture missing kinesis input records",
    );
  }

  const byRecordId = new Map();
  expectedRecords.forEach((expected, index) => {
    const recordId = String(expected?.record_id ?? "").trim();
    if (!recordId) {
      throw new Error(
        `expect.cloudwatch_logs_subscription.records[${index}] missing record_id`,
      );
    }
    if (byRecordId.has(recordId)) {
      throw new Error(
        `duplicate cloudwatch logs subscription expectation for record_id ${JSON.stringify(recordId)}`,
      );
    }
    validateCloudWatchLogsSubscriptionExpectationRecord({
      ...expected,
      record_id: recordId,
    });
    byRecordId.set(recordId, { ...expected, record_id: recordId });
  });

  const seenInputRecordIds = new Set();
  inputRecords.forEach((record, index) => {
    const recordId = String(record?.eventID ?? "").trim();
    if (!recordId) {
      throw new Error(
        `kinesis input Records[${index}] missing eventID for cloudwatch logs subscription expectation`,
      );
    }
    if (seenInputRecordIds.has(recordId)) {
      throw new Error(
        `duplicate kinesis input record_id ${JSON.stringify(recordId)}`,
      );
    }
    seenInputRecordIds.add(recordId);
    if (!byRecordId.has(recordId)) {
      throw new Error(
        `missing cloudwatch logs subscription expectation for kinesis record_id ${JSON.stringify(recordId)}`,
      );
    }
  });

  for (const recordId of byRecordId.keys()) {
    if (!seenInputRecordIds.has(recordId)) {
      throw new Error(
        `extra cloudwatch logs subscription expectation for record_id ${JSON.stringify(recordId)}`,
      );
    }
  }

  return byRecordId;
}

function validateCloudWatchLogsSubscriptionExpectationRecord(expected) {
  const recordId = String(expected?.record_id ?? "").trim();
  if (expected?.decode_error === true) {
    const hasDecodedFields =
      String(expected.message_type ?? "").trim() ||
      String(expected.owner ?? "").trim() ||
      String(expected.log_group ?? "").trim() ||
      String(expected.log_stream ?? "").trim() ||
      (Array.isArray(expected.subscription_filters) &&
        expected.subscription_filters.length > 0) ||
      (Array.isArray(expected.log_events) && expected.log_events.length > 0) ||
      (expected.safe_summary &&
        Object.keys(expected.safe_summary).length > 0) ||
      (Array.isArray(expected.forbidden_safe_log_substrings) &&
        expected.forbidden_safe_log_substrings.length > 0);
    if (hasDecodedFields) {
      throw new Error(
        `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} has decode_error=true and decoded fields`,
      );
    }
    return;
  }

  const missing = [];
  if (!String(expected?.message_type ?? "").trim())
    missing.push("message_type");
  if (!String(expected?.owner ?? "").trim()) missing.push("owner");
  if (!String(expected?.log_group ?? "").trim()) missing.push("log_group");
  if (!String(expected?.log_stream ?? "").trim()) missing.push("log_stream");
  if (
    !Array.isArray(expected?.subscription_filters) ||
    expected.subscription_filters.length === 0
  ) {
    missing.push("subscription_filters");
  }
  if (
    !Array.isArray(expected?.log_events) ||
    expected.log_events.length === 0
  ) {
    missing.push("log_events");
  }
  if (
    !expected?.safe_summary ||
    typeof expected.safe_summary !== "object" ||
    Array.isArray(expected.safe_summary) ||
    Object.keys(expected.safe_summary).length === 0
  ) {
    missing.push("safe_summary");
  }
  if (missing.length > 0) {
    throw new Error(
      `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} expectation missing ${missing.join(", ")}; malformed records must set decode_error=true`,
    );
  }

  expected.subscription_filters.forEach((filter, index) => {
    if (!String(filter ?? "").trim()) {
      throw new Error(
        `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} subscription_filters[${index}] is empty`,
      );
    }
  });
  expected.log_events.forEach((event, index) => {
    if (!String(event?.id ?? "").trim()) {
      throw new Error(
        `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} log_events[${index}] missing id`,
      );
    }
    if (!String(event?.message ?? "").trim()) {
      throw new Error(
        `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} log_events[${index}] missing message`,
      );
    }
  });
  if (
    cloudWatchLogsSafeSummaryContainsForbidden(
      expected.safe_summary,
      expected.forbidden_safe_log_substrings ?? [],
    )
  ) {
    throw new Error(
      `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} safe_summary contains forbidden raw log substring`,
    );
  }
}

function runtimeCloudWatchLogsSubscriptionDecoder(runtime) {
  const helper =
    runtime?.decodeCloudWatchLogsSubscriptionRecord ??
    runtime?.decodeCloudWatchLogsSubscription;
  if (typeof helper !== "function") {
    return missingCloudWatchLogsSubscriptionDecoder;
  }
  return async (record) => helper(record);
}

async function missingCloudWatchLogsSubscriptionDecoder() {
  throw new Error(CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER);
}

function makeCloudWatchLogsSubscriptionKinesisHandler(
  fixture,
  decoder = missingCloudWatchLogsSubscriptionDecoder,
) {
  const expectations = buildCloudWatchLogsSubscriptionExpectations(fixture);
  return async (_ctx, record) => {
    if (!expectations) {
      throw new Error(
        "fixture missing validated cloudwatch logs subscription expectations",
      );
    }
    const recordId = String(record?.eventID ?? "").trim();
    const expected = expectations.get(recordId);
    if (!expected) {
      throw new Error(
        `missing cloudwatch logs subscription expectation for kinesis record_id ${JSON.stringify(recordId)}`,
      );
    }

    const actual = await decoder(record);
    if (expected.decode_error === true) {
      throw new Error(
        `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} expected decode_error=true, got decoded record`,
      );
    }

    const compare = compareCloudWatchLogsSubscriptionDecodedRecord(
      expected,
      actual,
    );
    if (!compare.ok) {
      throw new Error(compare.reason);
    }
  };
}

function compareCloudWatchLogsSubscriptionDecodedRecord(expected, actual) {
  const recordId = String(expected?.record_id ?? "").trim();
  const actualRecordId = String(actual?.record_id ?? "").trim();
  if (actualRecordId && actualRecordId !== recordId) {
    return {
      ok: false,
      reason: `cloudwatch logs subscription record_id mismatch: expected ${JSON.stringify(recordId)}, got ${JSON.stringify(actualRecordId)}`,
    };
  }
  for (const key of ["message_type", "owner", "log_group", "log_stream"]) {
    if (
      String(actual?.[key] ?? "").trim() !==
      String(expected?.[key] ?? "").trim()
    ) {
      return {
        ok: false,
        reason: `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} ${key} mismatch`,
      };
    }
  }
  if (
    !deepEqual(
      expected?.subscription_filters ?? [],
      actual?.subscription_filters ?? [],
    )
  ) {
    return {
      ok: false,
      reason: `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} subscription_filters mismatch`,
    };
  }
  if (!deepEqual(expected?.log_events ?? [], actual?.log_events ?? [])) {
    return {
      ok: false,
      reason: `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} log_events mismatch`,
    };
  }
  if (!deepEqual(expected?.safe_summary ?? {}, actual?.safe_summary ?? {})) {
    return {
      ok: false,
      reason: `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} safe_summary mismatch`,
    };
  }
  if (
    cloudWatchLogsSafeSummaryContainsForbidden(
      actual?.safe_summary ?? {},
      expected?.forbidden_safe_log_substrings ?? [],
    )
  ) {
    return {
      ok: false,
      reason: `cloudwatch logs subscription record_id ${JSON.stringify(recordId)} safe_summary contains forbidden raw log substring`,
    };
  }
  return { ok: true };
}

function cloudWatchLogsSafeSummaryContainsForbidden(
  safeSummary,
  forbiddenSubstrings,
) {
  if (
    !safeSummary ||
    !Array.isArray(forbiddenSubstrings) ||
    forbiddenSubstrings.length === 0
  ) {
    return false;
  }
  const serialized = JSON.stringify(safeSummary);
  return forbiddenSubstrings.some((substring) => {
    const needle = String(substring ?? "");
    return needle && serialized.includes(needle);
  });
}

function compareWebSocketCalls(fixture, wsCalls) {
  const expected = fixture.expect?.ws_calls ?? [];
  const actual = wsCalls?.calls ?? [];
  const endpoint = String(wsCalls?.endpoint ?? "");

  if (expected.length === 0) {
    if (actual.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `unexpected ws_calls (${actual.length})`,
      actual_ws_calls: actual,
      expected_ws_calls: [],
    };
  }

  if (expected.length !== actual.length) {
    return {
      ok: false,
      reason: `ws_calls length mismatch: expected ${expected.length}, got ${actual.length}`,
      actual_ws_calls: actual,
      expected_ws_calls: expected,
    };
  }

  for (let i = 0; i < expected.length; i += 1) {
    const exp = expected[i] ?? {};
    const got = actual[i] ?? {};

    if (String(exp.op ?? "").trim() !== String(got.op ?? "").trim()) {
      return {
        ok: false,
        reason: `ws_calls[${i}].op mismatch`,
        actual_ws_calls: actual,
        expected_ws_calls: expected,
      };
    }

    const expEndpoint = String(exp.endpoint ?? "").trim();
    if (expEndpoint && expEndpoint !== endpoint) {
      return {
        ok: false,
        reason: `ws_calls[${i}].endpoint mismatch`,
        actual_ws_calls: actual,
        expected_ws_calls: expected,
      };
    }

    if (
      String(exp.connection_id ?? "").trim() !==
      String(got.connectionId ?? "").trim()
    ) {
      return {
        ok: false,
        reason: `ws_calls[${i}].connection_id mismatch`,
        actual_ws_calls: actual,
        expected_ws_calls: expected,
      };
    }

    const expectedBytes = exp.data
      ? decodeFixtureBody(exp.data)
      : Buffer.alloc(0);
    const gotBytes = got.data ? Buffer.from(got.data) : Buffer.alloc(0);
    if (!expectedBytes.equals(gotBytes)) {
      return {
        ok: false,
        reason: `ws_calls[${i}].data mismatch`,
        actual_ws_calls: actual,
        expected_ws_calls: expected,
      };
    }
  }

  return { ok: true };
}

function builtInSQSHandler(name) {
  switch (String(name ?? "").trim()) {
    case "sqs_noop":
      return async () => {};
    case "sqs_always_fail":
      return async () => {
        throw new Error("fail");
      };
    case "sqs_fail_on_body":
      return async (_ctx, msg) => {
        if (String(msg?.body ?? "").trim() === "fail") {
          throw new Error("fail");
        }
      };
    case "sqs_requires_event_middleware":
      return async (ctx) => {
        if (ctx.get("mw") !== "ok") {
          throw new Error("missing middleware value");
        }
        const trace = ctx.get("trace");
        if (!Array.isArray(trace) || trace.join(",") !== "evt_mw_a,evt_mw_b") {
          throw new Error("bad trace");
        }
      };
    default:
      return null;
  }
}

function builtInKinesisHandler(runtime, name, fixture) {
  switch (String(name ?? "").trim()) {
    case "kinesis_noop":
      return async () => {};
    case "kinesis_always_fail":
      return async () => {
        throw new Error("fail");
      };
    case "kinesis_fail_on_data":
      return async (_ctx, record) => {
        const dataB64 = String(record?.kinesis?.data ?? "").trim();
        const decoded = dataB64
          ? Buffer.from(dataB64, "base64").toString("utf8")
          : "";
        if (decoded.trim() === "fail") {
          throw new Error("fail");
        }
      };
    case "kinesis_requires_event_middleware":
      return async (ctx) => {
        if (ctx.get("mw") !== "ok") {
          throw new Error("missing middleware value");
        }
        const trace = ctx.get("trace");
        if (!Array.isArray(trace) || trace.join(",") !== "evt_mw_a,evt_mw_b") {
          throw new Error("bad trace");
        }
      };
    case CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER:
      return makeCloudWatchLogsSubscriptionKinesisHandler(
        fixture,
        runtimeCloudWatchLogsSubscriptionDecoder(runtime),
      );
    default:
      return null;
  }
}

function builtInSNSHandler(name) {
  switch (String(name ?? "").trim()) {
    case "sns_static_a":
      return async () => ({ handler: "a" });
    case "sns_static_b":
      return async () => ({ handler: "b" });
    case "sns_echo_event_middleware":
      return async (ctx) => ({ mw: ctx.get("mw"), trace: ctx.get("trace") });
    default:
      return null;
  }
}

function builtInDynamoDBStreamHandler(runtime, name, effects) {
  switch (String(name ?? "").trim()) {
    case "ddb_noop":
      return async () => {};
    case "ddb_always_fail":
      return async () => {
        throw new Error("fail");
      };
    case "ddb_fail_on_event_name_remove":
      return async (_ctx, record) => {
        if (String(record?.eventName ?? "").trim() === "REMOVE") {
          throw new Error("fail");
        }
      };
    case "ddb_requires_event_middleware":
      return async (ctx) => {
        if (ctx.get("mw") !== "ok") {
          throw new Error("missing middleware value");
        }
        const trace = ctx.get("trace");
        if (!Array.isArray(trace) || trace.join(",") !== "evt_mw_a,evt_mw_b") {
          throw new Error("bad trace");
        }
      };
    case "ddb_require_normalized_summary":
      return async (_ctx, record) => {
        requireDynamoDBSafeSummary(runtime, record, false);
      };
    case "ddb_require_normalized_summary_fail_on_remove":
      return async (_ctx, record) => {
        requireDynamoDBSafeSummary(runtime, record, true);
      };
    case "ddb_observed_fail_on_remove":
      return async (_ctx, record) => {
        requireDynamoDBSafeSummary(runtime, record, false);
        if (String(record?.eventName ?? "").trim() === "REMOVE") {
          throw new Error("raw dynamodb remove failure: do-not-log");
        }
      };
    default:
      return null;
  }
}

function requireDynamoDBSafeSummary(runtime, record, failOnRemove) {
  const summary = runtime.normalizeDynamoDBStreamRecord(record);
  for (const key of [
    "table_name",
    "event_id",
    "event_name",
    "sequence_number",
    "stream_view_type",
  ]) {
    if (!String(summary[key] ?? "").trim()) {
      throw new Error(`missing normalized dynamodb ${key}`);
    }
  }
  const safeLog = String(summary.safe_log ?? "").trim();
  const serialized = JSON.stringify(summary);
  if (
    !safeLog ||
    ["release#rel_123", "do-not-log", "previous-secret"].some((sentinel) =>
      serialized.includes(sentinel),
    )
  ) {
    throw new Error("unsafe dynamodb stream summary");
  }
  if (failOnRemove && String(record?.eventName ?? "").trim() === "REMOVE") {
    throw new Error("fail");
  }
}

function dynamoDBSafeSummary(record) {
  const tableName = dynamoDBFixtureTableNameFromStreamArn(
    String(record?.eventSourceARN ?? ""),
  );
  const sequenceNumber = String(record?.dynamodb?.SequenceNumber ?? "").trim();
  const eventId = String(record?.eventID ?? "").trim();
  const eventName = String(record?.eventName ?? "").trim();
  return {
    aws_region: String(record?.awsRegion ?? "").trim(),
    event_id: eventId,
    event_name: eventName,
    safe_log: `table=${tableName} event_id=${eventId} event_name=${eventName} sequence_number=${sequenceNumber}`,
    sequence_number: sequenceNumber,
    size_bytes: Number(record?.dynamodb?.SizeBytes ?? 0),
    stream_view_type: String(record?.dynamodb?.StreamViewType ?? "").trim(),
    table_name: tableName,
  };
}

function dynamoDBFixtureTableNameFromStreamArn(arn) {
  const value = String(arn ?? "").trim();
  if (!value) return "";
  const marker = ":table/";
  const idx = value.indexOf(marker);
  if (idx < 0) return "";
  const after = value.slice(idx + marker.length);
  const streamIdx = after.indexOf("/stream/");
  if (streamIdx >= 0) return after.slice(0, streamIdx);
  const slashIdx = after.indexOf("/");
  if (slashIdx >= 0) return after.slice(0, slashIdx);
  return after;
}

function builtInEventBridgeHandler(runtime, name, effects) {
  switch (String(name ?? "").trim()) {
    case "eventbridge_static_a":
      return async () => ({ handler: "a" });
    case "eventbridge_static_b":
      return async () => ({ handler: "b" });
    case "eventbridge_echo_event_middleware":
      return async (ctx) => ({ mw: ctx.get("mw"), trace: ctx.get("trace") });
    case "eventbridge_workload_envelope":
      return async (ctx, event) =>
        runtime.normalizeEventBridgeWorkloadEnvelope(ctx, event);
    case "eventbridge_scheduled_summary":
      return async (ctx, event) =>
        runtime.normalizeEventBridgeScheduledWorkload(ctx, event);
    case "eventbridge_observed_success":
      return async (ctx, event) =>
        runtime.normalizeEventBridgeWorkloadEnvelope(ctx, event);
    case "eventbridge_observed_panic":
      return async () => {
        throw new Error("raw eventbridge panic: do-not-log");
      };
    case "eventbridge_require_workload_envelope":
      return async (ctx, event) =>
        runtime.requireEventBridgeWorkloadEnvelope(ctx, event);
    default:
      return null;
  }
}

function eventBridgeWorkloadEnvelopeSummary(ctx, event) {
  const detailType = String(
    event?.["detail-type"] ?? event?.detailType ?? "",
  ).trim();
  const { correlationId, correlationSource } = eventBridgeCorrelationId(
    ctx,
    event,
  );
  return {
    account: String(event?.account ?? "").trim(),
    correlation_id: correlationId,
    correlation_source: correlationSource,
    detail_type: detailType,
    event_id: String(event?.id ?? "").trim(),
    region: String(event?.region ?? "").trim(),
    request_id: String(ctx?.requestId ?? "").trim(),
    resources: Array.isArray(event?.resources)
      ? event.resources.map((resource) => String(resource))
      : [],
    source: String(event?.source ?? "").trim(),
    time: String(event?.time ?? "").trim(),
  };
}

function eventBridgeScheduledSummary(ctx, event) {
  const envelope = eventBridgeWorkloadEnvelopeSummary(ctx, event);
  const detail =
    event && typeof event.detail === "object" && !Array.isArray(event.detail)
      ? event.detail
      : {};
  const result =
    detail.result &&
    typeof detail.result === "object" &&
    !Array.isArray(detail.result)
      ? detail.result
      : {};

  let runId = objectString(detail, "run_id");
  if (!runId) runId = String(event?.id ?? "").trim();
  if (!runId) runId = String(ctx?.ctx?.awsRequestId ?? "").trim();

  let idempotencyKey = objectString(detail, "idempotency_key");
  if (!idempotencyKey) {
    const eventId = String(event?.id ?? "").trim();
    const requestId = String(ctx?.ctx?.awsRequestId ?? "").trim();
    if (eventId) idempotencyKey = `eventbridge:${eventId}`;
    else if (requestId) idempotencyKey = `lambda:${requestId}`;
  }

  let status =
    objectString(result, "status") || objectString(detail, "status") || "ok";
  status = String(status).trim() || "ok";
  const remainingMs =
    Number(ctx?.remainingMs ?? 0) > 0 ? Math.floor(Number(ctx.remainingMs)) : 0;
  const deadlineUnixMs =
    remainingMs > 0 ? ctx.now().getTime() + remainingMs : 0;

  return {
    correlation_id: envelope.correlation_id,
    correlation_source: envelope.correlation_source,
    deadline_unix_ms: deadlineUnixMs,
    detail_type: envelope.detail_type,
    event_id: envelope.event_id,
    idempotency_key: idempotencyKey,
    kind: "scheduled",
    remaining_ms: remainingMs,
    result: {
      failed: objectInt(result, "failed"),
      processed: objectInt(result, "processed"),
      status,
    },
    run_id: runId,
    scheduled_time: envelope.time,
    source: envelope.source,
  };
}

function eventBridgeCorrelationId(ctx, event) {
  const metadataCorrelation = objectString(event?.metadata, "correlation_id");
  if (metadataCorrelation) {
    return {
      correlationId: metadataCorrelation,
      correlationSource: "metadata.correlation_id",
    };
  }

  const headerCorrelation = headerString(event?.headers, "x-correlation-id");
  if (headerCorrelation) {
    return {
      correlationId: headerCorrelation,
      correlationSource: "headers.x-correlation-id",
    };
  }

  const detailCorrelation = objectString(event?.detail, "correlation_id");
  if (detailCorrelation) {
    return {
      correlationId: detailCorrelation,
      correlationSource: "detail.correlation_id",
    };
  }

  const eventId = String(event?.id ?? "").trim();
  if (eventId) {
    return { correlationId: eventId, correlationSource: "event.id" };
  }

  const requestId = String(ctx?.ctx?.awsRequestId ?? "").trim();
  if (requestId) {
    return {
      correlationId: requestId,
      correlationSource: "lambda.aws_request_id",
    };
  }

  return { correlationId: "", correlationSource: "" };
}

function objectString(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return "";
  return String(object[key] ?? "").trim();
}

function objectInt(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return 0;
  const value = Number(object[key] ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function headerString(headers, key) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    return "";
  const wanted = String(key ?? "")
    .trim()
    .toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).trim().toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = String(entry ?? "").trim();
        if (candidate) return candidate;
      }
      return "";
    }
    return String(value ?? "").trim();
  }
  return "";
}

function recordEventBridgeEffects(
  effects,
  ctx,
  summary,
  level,
  outcome,
  errorCode,
) {
  if (!effects) return;
  const correlationId = String(summary?.correlation_id ?? "").trim();
  const source = String(summary?.source ?? "").trim();
  const detailType = String(summary?.detail_type ?? "").trim();
  effects.logs.push({
    level,
    event: "event.completed",
    request_id: String(ctx?.requestId ?? "").trim(),
    tenant_id: "",
    method: "",
    path: "",
    status: 0,
    error_code: errorCode,
    trigger: "eventbridge",
    correlation_id: correlationId,
    source,
    detail_type: detailType,
  });
  effects.metrics.push({
    name: "apptheory.event",
    value: 1,
    tags: {
      correlation_id: correlationId,
      detail_type: detailType,
      error_code: errorCode,
      outcome,
      source,
      trigger: "eventbridge",
    },
  });
  effects.spans.push({
    name: `eventbridge ${source} ${detailType}`,
    attributes: {
      "correlation.id": correlationId,
      "event.detail_type": detailType,
      "event.source": source,
      "error.code": errorCode,
      outcome,
      trigger: "eventbridge",
    },
  });
}

function recordDynamoDBEffects(
  effects,
  ctx,
  record,
  level,
  outcome,
  errorCode,
) {
  if (!effects) return;
  const summary = dynamoDBSafeSummary(record);
  const tableName = String(summary.table_name ?? "").trim();
  const eventId = String(summary.event_id ?? "").trim();
  const eventName = String(summary.event_name ?? "").trim();
  effects.logs.push({
    level,
    event: "event.completed",
    request_id: String(ctx?.requestId ?? "").trim(),
    tenant_id: "",
    method: "",
    path: "",
    status: 0,
    error_code: errorCode,
    trigger: "dynamodb_stream",
    correlation_id: eventId,
    table_name: tableName,
    event_id: eventId,
    event_name: eventName,
  });
  effects.metrics.push({
    name: "apptheory.event",
    value: 1,
    tags: {
      correlation_id: eventId,
      error_code: errorCode,
      event_name: eventName,
      outcome,
      table_name: tableName,
      trigger: "dynamodb_stream",
    },
  });
  effects.spans.push({
    name: `dynamodb_stream ${tableName} ${eventName}`,
    attributes: {
      "correlation.id": eventId,
      "dynamodb.event_id": eventId,
      "dynamodb.event_name": eventName,
      "dynamodb.table_name": tableName,
      "error.code": errorCode,
      outcome,
      trigger: "dynamodb_stream",
    },
  });
}

function fixtureLambdaContext(inputContext) {
  const ctx = {};
  const requestId = String(inputContext?.aws_request_id ?? "").trim();
  const remainingMs = Number(inputContext?.remaining_ms ?? 0);
  if (requestId) ctx.awsRequestId = requestId;
  if (Number.isFinite(remainingMs) && remainingMs > 0) {
    ctx.remaining_ms = Math.floor(remainingMs);
  }
  return ctx;
}

function builtInEventMiddleware(name) {
  switch (String(name ?? "").trim()) {
    case "evt_mw_a":
      return async (ctx, _event, next) => {
        ctx.set("mw", "ok");
        ctx.set("trace", ["evt_mw_a"]);
        return next();
      };
    case "evt_mw_b":
      return async (ctx, _event, next) => {
        const existing = ctx.get("trace");
        const trace = Array.isArray(existing) ? existing.slice() : [];
        trace.push("evt_mw_b");
        ctx.set("trace", trace);
        return next();
      };
    default:
      return null;
  }
}

async function runFixtureM1(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");
  const effects = newEffects();
  const app = runtime.createApp({
    tier: "p0",
    clock: new runtime.ManualClock(new Date(0)),
    ids,
    observability: {
      log: (r) => {
        const record = {
          level: r.level,
          event: r.event,
          request_id: r.requestId,
          tenant_id: r.tenantId,
          method: r.method,
          path: r.path,
          status: r.status,
          error_code: r.errorCode,
        };
        if (r.trigger) record.trigger = r.trigger;
        if (r.correlationId) record.correlation_id = r.correlationId;
        if (r.source) record.source = r.source;
        if (r.detailType) record.detail_type = r.detailType;
        if (r.tableName) record.table_name = r.tableName;
        if (r.eventId) record.event_id = r.eventId;
        if (r.eventName) record.event_name = r.eventName;
        effects.logs.push(record);
      },
      metric: (r) => {
        effects.metrics.push({ name: r.name, value: r.value, tags: r.tags });
      },
      span: (r) => {
        effects.spans.push({ name: r.name, attributes: r.attributes });
      },
    },
  });

  for (const name of fixture.setup?.middlewares ?? []) {
    const mw = builtInEventMiddleware(name);
    if (!mw) {
      throw new Error(`unknown event middleware ${JSON.stringify(name)}`);
    }
    app.useEvents(mw);
  }

  for (const route of fixture.setup?.sqs ?? []) {
    const handler = builtInSQSHandler(route.handler);
    if (!handler) {
      throw new Error(`unknown sqs handler ${JSON.stringify(route.handler)}`);
    }
    app.sqs(route.queue, handler);
  }

  for (const route of fixture.setup?.kinesis ?? []) {
    const handler = builtInKinesisHandler(runtime, route.handler, fixture);
    if (!handler) {
      throw new Error(
        `unknown kinesis handler ${JSON.stringify(route.handler)}`,
      );
    }
    app.kinesis(route.stream, handler);
  }

  for (const route of fixture.setup?.sns ?? []) {
    const handler = builtInSNSHandler(route.handler);
    if (!handler) {
      throw new Error(`unknown sns handler ${JSON.stringify(route.handler)}`);
    }
    app.sns(route.topic, handler);
  }

  for (const route of fixture.setup?.dynamodb ?? []) {
    const handler = builtInDynamoDBStreamHandler(
      runtime,
      route.handler,
      effects,
    );
    if (!handler) {
      throw new Error(
        `unknown dynamodb handler ${JSON.stringify(route.handler)}`,
      );
    }
    app.dynamoDB(route.table, handler);
  }

  for (const route of fixture.setup?.eventbridge ?? []) {
    const handler = builtInEventBridgeHandler(runtime, route.handler, effects);
    if (!handler) {
      throw new Error(
        `unknown eventbridge handler ${JSON.stringify(route.handler)}`,
      );
    }
    app.eventBridge(
      {
        ruleName: route.rule_name,
        source: route.source,
        detailType: route.detail_type,
      },
      handler,
    );
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (!awsEvent) {
    throw new Error("fixture missing input.aws_event");
  }

  let actualOutput = null;
  let actualError = null;
  try {
    actualOutput = await app.handleLambda(
      awsEvent.event ?? {},
      fixtureLambdaContext(fixture.input?.context ?? {}),
    );
  } catch (err) {
    actualError = err;
  }
  return { actualOutput, actualError, effects };
}

function builtInWebSocketHandler(runtime, name) {
  switch (String(name ?? "").trim()) {
    case "ws_connect_ok":
      return async (ctx) => {
        const ws = ctx.asWebSocket?.();
        if (!ws) {
          throw new Error("missing websocket context");
        }
        return runtime.json(200, {
          handler: "connect",
          route_key: ws.routeKey,
          event_type: ws.eventType,
          connection_id: ws.connectionId,
          management_endpoint: ws.managementEndpoint,
          request_id: ctx.requestId,
        });
      };
    case "ws_disconnect_ok":
      return async (ctx) => {
        const ws = ctx.asWebSocket?.();
        if (!ws) {
          throw new Error("missing websocket context");
        }
        return runtime.json(200, {
          handler: "disconnect",
          route_key: ws.routeKey,
          event_type: ws.eventType,
          connection_id: ws.connectionId,
          management_endpoint: ws.managementEndpoint,
          request_id: ctx.requestId,
        });
      };
    case "ws_default_send_json_ok":
      return async (ctx) => {
        const ws = ctx.asWebSocket?.();
        if (!ws) {
          throw new Error("missing websocket context");
        }
        await ws.sendJSONMessage({ ok: true });
        return runtime.json(200, {
          handler: "default",
          sent: true,
          route_key: ws.routeKey,
          event_type: ws.eventType,
          connection_id: ws.connectionId,
          management_endpoint: ws.managementEndpoint,
          request_id: ctx.requestId,
        });
      };
    case "ws_default_send_json_fail":
      return async (ctx) => {
        const ws = ctx.asWebSocket?.();
        if (!ws) {
          throw new Error("missing websocket context");
        }
        await ws.sendJSONMessage({ ok: true });
        return runtime.json(200, { sent: true });
      };
    case "ws_default_body_size":
      return async (ctx) => {
        const ws = ctx.asWebSocket?.();
        if (!ws) {
          throw new Error("missing websocket context");
        }
        return runtime.json(200, {
          handler: "default",
          body_len: ws.body.length,
          route_key: ws.routeKey,
          event_type: ws.eventType,
          connection_id: ws.connectionId,
          management_endpoint: ws.managementEndpoint,
          request_id: ctx.requestId,
        });
      };
    case "ws_connect_deny":
      return async () => {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      };
    case "ws_bad_request":
      return async () => {
        throw new runtime.AppError("app.bad_request", "bad request");
      };
    default:
      return null;
  }
}

async function runFixtureM2(fixture) {
  const runtime = await loadAppTheoryRuntime();

  let wsClient = null;
  const app = runtime.createApp({
    tier: "p0",
    webSocketClientFactory: (endpoint) => {
      wsClient = new runtime.FakeWebSocketManagementClient({ endpoint });
      for (const route of fixture.setup?.websockets ?? []) {
        if (String(route?.handler ?? "").trim() === "ws_default_send_json_fail") {
          wsClient.postError = new Error("testkit: post failed");
          break;
        }
      }
      return wsClient;
    },
  });

  for (const route of fixture.setup?.websockets ?? []) {
    const handler = builtInWebSocketHandler(runtime, route.handler);
    if (!handler) {
      throw new Error(
        `unknown websocket handler ${JSON.stringify(route.handler)}`,
      );
    }
    app.webSocket(route.route_key, handler);
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (!awsEvent) {
    throw new Error("fixture missing input.aws_event");
  }

  const raw = awsEvent.event ?? {};
  const resp = await app.handleLambda(raw, {});
  const actual = canonicalResponseFromAPIGatewayProxyResponse(resp);

  return {
    actual,
    wsCalls: {
      endpoint: wsClient?.endpoint ?? "",
      calls: Array.isArray(wsClient?.calls) ? wsClient.calls : [],
    },
  };
}

async function runFixtureM3(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const app = runtime.createApp({ tier: "p0" });

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandler(runtime, route.handler);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler, {
      authRequired: Boolean(route.auth_required),
    });
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (!awsEvent) {
    throw new Error("fixture missing input.aws_event");
  }

  const resp = await app.handleLambda(awsEvent.event ?? {}, {});
  const actual = canonicalResponseFromAPIGatewayProxyResponse(resp);
  return { actual };
}

async function runFixtureM12(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const effects = newEffects();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const limits = fixture.setup?.limits ?? {};
  const corsSetup = fixture.setup?.cors ?? null;
  const cors =
    corsSetup && typeof corsSetup === "object"
      ? {
          allowedOrigins: corsSetup.allowed_origins,
          allowCredentials: Boolean(corsSetup.allow_credentials),
          allowHeaders: corsSetup.allow_headers,
        }
      : undefined;
  const app = runtime.createApp({
    tier: "p1",
    ids,
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    ...(cors ? { cors } : {}),
    authHook: (ctx) => {
      const authz = firstHeaderValue(
        ctx.request.headers ?? {},
        "authorization",
      ).trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-forbidden")) {
        throw new runtime.AppError("app.forbidden", "forbidden");
      }
      return "authorized";
    },
  });

  for (const name of fixture.setup?.middlewares ?? []) {
    const mw = builtInMiddleware(runtime, name);
    if (!mw) {
      throw new Error(`unknown middleware ${JSON.stringify(name)}`);
    }
    app.use(mw);
  }

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandler(runtime, route.handler, effects);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler, {
      authRequired: Boolean(route.auth_required),
    });
  }

  const input = fixture.input?.request ?? {};
  const body = decodeFixtureBody(input.body);
  const req = {
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers: input.headers ?? {},
    body,
    isBase64: input.is_base64 ?? false,
  };

  const runtimeCtx = {
    remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0),
  };
  const resp = await app.serve(req, runtimeCtx);
  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    body: Buffer.from(resp.body ?? []),
    is_base64: resp.isBase64 ?? false,
  };

  await sleepMs(30);

  return { actual, effects };
}

async function runFixtureM14(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const limits = fixture.setup?.limits ?? {};
  const corsSetup = fixture.setup?.cors ?? null;
  const cors =
    corsSetup && typeof corsSetup === "object"
      ? {
          allowedOrigins: corsSetup.allowed_origins,
          allowCredentials: Boolean(corsSetup.allow_credentials),
          allowHeaders: corsSetup.allow_headers,
        }
      : undefined;
  const app = runtime.createApp({
    tier: "p1",
    ids,
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    ...(cors ? { cors } : {}),
    authHook: (ctx) => {
      const authz = firstHeaderValue(
        ctx.request.headers ?? {},
        "authorization",
      ).trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-forbidden")) {
        throw new runtime.AppError("app.forbidden", "forbidden");
      }
      return "authorized";
    },
  });

  let actualError = null;
  try {
    for (const name of fixture.setup?.middlewares ?? []) {
      const mw = builtInMiddleware(runtime, name);
      if (!mw) {
        throw new Error(`unknown middleware ${JSON.stringify(name)}`);
      }
      app.use(mw);
    }

    for (const route of fixture.setup?.routes ?? []) {
      const handler = builtInAppTheoryHandler(runtime, route.handler);
      if (!handler) {
        throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
      }
      app.handle(route.method, route.path, handler, {
        authRequired: Boolean(route.auth_required),
      });
    }
  } catch (err) {
    actualError = err;
  }

  if (expectsSetupError(fixture)) {
    return { actualError };
  }
  if (actualError) {
    throw actualError;
  }

  const input = fixture.input?.request ?? {};
  const body = decodeFixtureBody(input.body);
  const req = {
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers: input.headers ?? {},
    body,
    isBase64: input.is_base64 ?? false,
  };

  const runtimeCtx = {
    remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0),
  };
  const resp = await app.serve(req, runtimeCtx);

  const chunks = [];
  const buffers = [];

  if (resp.body && Buffer.from(resp.body).length > 0) {
    const b = Buffer.from(resp.body);
    chunks.push(b);
    buffers.push(b);
  }

  let streamErrorCode = "";
  if (resp.bodyStream) {
    try {
      for await (const chunk of resp.bodyStream) {
        const b = Buffer.from(chunk ?? []);
        chunks.push(b);
        buffers.push(b);
      }
    } catch (err) {
      streamErrorCode =
        err instanceof runtime.AppError
          ? String(err.code ?? "")
          : "app.internal";
    }
  }

  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    chunks,
    body: Buffer.concat(buffers),
    is_base64: resp.isBase64 ?? false,
    stream_error_code: streamErrorCode,
  };

  return { actual };
}

async function runFixtureP0(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const app = runtime.createApp({
    tier: "p0",
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
  });

  let actualError = null;
  try {
    for (const route of fixture.setup?.routes ?? []) {
      app.handle(route.method, route.path, routeHandlerForRegistration(runtime, route));
    }
  } catch (err) {
    actualError = err;
  }

  if (expectsSetupError(fixture)) {
    return { actualError, effects: newEffects() };
  }
  if (actualError) {
    throw actualError;
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (awsEvent) {
    const source = String(awsEvent.source ?? "")
      .trim()
      .toLowerCase();
    const event = awsEvent.event ?? {};

    if (source === "apigw_v2") {
      const resp = await app.serveAPIGatewayV2(event);
      return {
        actual: canonicalResponseFromAPIGatewayV2Response(resp),
        effects: newEffects(),
      };
    }
    if (source === "lambda_function_url") {
      const resp = await app.serveLambdaFunctionURL(event);
      return {
        actual: canonicalResponseFromLambdaFunctionURLResponse(resp),
        effects: newEffects(),
      };
    }
    if (source === "alb") {
      const resp = await app.serveALB(event);
      return {
        actual: canonicalResponseFromAPIGatewayProxyResponse(resp),
        effects: newEffects(),
      };
    }

    throw new Error(
      `unknown aws_event source ${JSON.stringify(awsEvent.source)}`,
    );
  }

  const input = fixture.input?.request ?? {};
  const body = decodeFixtureBody(input.body);
  const req = {
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers: input.headers ?? {},
    body,
    isBase64: input.is_base64 ?? false,
  };

  const resp = await app.serve(req);
  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    body: Buffer.from(resp.body ?? []),
    is_base64: resp.isBase64 ?? false,
  };

  return { actual, effects: newEffects() };
}

function canonicalResponseFromAPIGatewayV2Response(resp) {
  const status = Number(resp?.statusCode ?? 0);
  const isBase64Encoded = Boolean(resp?.isBase64Encoded);
  const bodyStr = String(resp?.body ?? "");
  const body = isBase64Encoded
    ? Buffer.from(bodyStr, "base64")
    : Buffer.from(bodyStr, "utf8");

  const headersSource =
    resp?.multiValueHeaders && Object.keys(resp.multiValueHeaders).length > 0
      ? resp.multiValueHeaders
      : (resp?.headers ?? {});

  const headers = {};
  for (const [key, value] of Object.entries(headersSource ?? {})) {
    headers[key] = Array.isArray(value)
      ? value.map((v) => String(v))
      : [String(value)];
  }

  return {
    status,
    headers,
    cookies: Array.isArray(resp?.cookies)
      ? resp.cookies.map((c) => String(c))
      : [],
    body,
    is_base64: isBase64Encoded,
  };
}

function canonicalResponseFromLambdaFunctionURLResponse(resp) {
  const status = Number(resp?.statusCode ?? 0);
  const isBase64Encoded = Boolean(resp?.isBase64Encoded);
  const bodyStr = String(resp?.body ?? "");
  const body = isBase64Encoded
    ? Buffer.from(bodyStr, "base64")
    : Buffer.from(bodyStr, "utf8");

  const headers = {};
  for (const [key, value] of Object.entries(resp?.headers ?? {})) {
    headers[key] = [String(value)];
  }

  return {
    status,
    headers,
    cookies: Array.isArray(resp?.cookies)
      ? resp.cookies.map((c) => String(c))
      : [],
    body,
    is_base64: isBase64Encoded,
  };
}

function canonicalResponseFromAPIGatewayProxyResponse(resp) {
  const status = Number(resp?.statusCode ?? 0);
  const isBase64Encoded = Boolean(resp?.isBase64Encoded);
  const bodyStr = String(resp?.body ?? "");
  const body = isBase64Encoded
    ? Buffer.from(bodyStr, "base64")
    : Buffer.from(bodyStr, "utf8");

  const headersSource =
    resp?.multiValueHeaders && Object.keys(resp.multiValueHeaders).length > 0
      ? resp.multiValueHeaders
      : (resp?.headers ?? {});

  const headersRaw = {};
  for (const [key, value] of Object.entries(headersSource ?? {})) {
    headersRaw[key] = Array.isArray(value)
      ? value.map((v) => String(v))
      : [String(value)];
  }
  const headers = canonicalizeHeaders(headersRaw);

  const cookies = Array.isArray(headers["set-cookie"])
    ? headers["set-cookie"].map((v) => String(v))
    : [];
  delete headers["set-cookie"];

  return {
    status,
    headers,
    cookies,
    body,
    is_base64: isBase64Encoded,
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function abortSignalFromContextCarrier(value) {
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) {
    return value;
  }
  if (value && typeof value === "object") {
    const signal = value.signal;
    if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) {
      return signal;
    }
  }
  return null;
}

async function waitForAbort(signal, timeoutMs) {
  if (!signal) return false;
  if (signal.aborted) return true;

  return await new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runFixtureP1(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const limits = fixture.setup?.limits ?? {};
  const corsSetup = fixture.setup?.cors ?? null;
  const cors =
    corsSetup && typeof corsSetup === "object"
      ? {
          allowedOrigins: corsSetup.allowed_origins,
          allowCredentials: Boolean(corsSetup.allow_credentials),
          allowHeaders: corsSetup.allow_headers,
        }
      : undefined;
  const app = runtime.createApp({
    tier: "p1",
    ids,
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    ...(cors ? { cors } : {}),
    authHook: (ctx) => {
      const authz = firstHeaderValue(
        ctx.request.headers ?? {},
        "authorization",
      ).trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-forbidden")) {
        throw new runtime.AppError("app.forbidden", "forbidden");
      }
      return "authorized";
    },
  });

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandler(runtime, route.handler);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler, {
      authRequired: Boolean(route.auth_required),
    });
  }

  const input = fixture.input?.request ?? {};
  const body = decodeFixtureBody(input.body);
  const req = {
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers: input.headers ?? {},
    body,
    isBase64: input.is_base64 ?? false,
  };

  const runtimeCtx = {
    remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0),
  };
  const resp = await app.serve(req, runtimeCtx);
  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    body: Buffer.from(resp.body ?? []),
    is_base64: resp.isBase64 ?? false,
  };

  return { actual, effects: newEffects() };
}

function builtInAppTheoryHandlerP2(runtime, name, effects, clock) {
  switch (String(name ?? "").trim()) {
    case "advance_clock_25ms":
      return () => {
        clock.advance(25);
        return runtime.text(200, "advanced");
      };
    case "advance_clock_13ms_internal":
      return () => {
        clock.advance(13);
        throw new runtime.AppTheoryError("app.internal", "internal error");
      };
    default:
      return builtInAppTheoryHandler(runtime, name, effects);
  }
}

async function runFixtureP2(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");
  const clock = new runtime.ManualClock(new Date(0));

  const effects = newEffects();
  const emfSink = Object.prototype.hasOwnProperty.call(fixture.expect ?? {}, "emf_logs")
    ? runtime.createEMFMetricSink({
        clock: () => clock.now(),
        write: (line) => effects.emf_logs.push(line),
      })
    : null;

  const limits = fixture.setup?.limits ?? {};
  const corsSetup = fixture.setup?.cors ?? null;
  const cors =
    corsSetup && typeof corsSetup === "object"
      ? {
          allowedOrigins: corsSetup.allowed_origins,
          allowCredentials: Boolean(corsSetup.allow_credentials),
          allowHeaders: corsSetup.allow_headers,
        }
      : undefined;
  const app = runtime.createApp({
    tier: "p2",
    ids,
    clock,
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    ...(cors ? { cors } : {}),
    authHook: (ctx) => {
      const authz = firstHeaderValue(
        ctx.request.headers ?? {},
        "authorization",
      ).trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      return "authorized";
    },
    policyHook: (ctx) => {
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-content-type-lowercase",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["1"],
            "content-type": ["text/plain; charset=utf-8"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-content-type",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["1"],
            "Content-Type": ["text/plain; charset=utf-8"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-multi-window",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["30"],
            "x-ratelimit-limit": ["2"],
            "x-ratelimit-remaining": ["0"],
            "x-ratelimit-reset": ["60"],
            "x-ratelimit-window": ["1m"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-store-failure",
        )
      ) {
        return {
          code: "app.overloaded",
          message: "overloaded",
          headers: {
            "retry-after": ["1"],
            "x-rate-limit-fail-closed": ["true"],
          },
        };
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-rate-limit")) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: { "retry-after": ["1"] },
        };
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-shed")) {
        return {
          code: "app.overloaded",
          message: "overloaded",
          headers: { "retry-after": ["1"] },
        };
      }
      return null;
    },
    observability: {
      log: (r) => {
        const record = {
          level: r.level,
          event: r.event,
          request_id: r.requestId,
          tenant_id: r.tenantId,
          method: r.method,
          path: r.path,
          status: r.status,
          error_code: r.errorCode,
          duration_ms: r.durationMs,
        };
        if (r.traceId) record.trace_id = r.traceId;
        effects.logs.push(record);
      },
      metric: (r) => {
        effects.metrics.push({
          name: r.name,
          value: r.value,
          duration_ms: r.durationMs,
          tags: r.tags,
        });
        emfSink?.recordMetric(r);
      },
      span: (r) => {
        effects.spans.push({ name: r.name, attributes: r.attributes });
      },
    },
  });

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandlerP2(runtime, route.handler, effects, clock);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler, {
      authRequired: Boolean(route.auth_required),
    });
  }

  const input = fixture.input?.request ?? {};
  const body = decodeFixtureBody(input.body);
  const req = {
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers: input.headers ?? {},
    body,
    isBase64: input.is_base64 ?? false,
  };

  const runtimeCtx = {
    remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0),
  };
  const resp = await app.serve(req, runtimeCtx);
  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    body: Buffer.from(resp.body ?? []),
    is_base64: resp.isBase64 ?? false,
  };

  return { actual, effects };
}

async function runFixtureP2Output(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const effects = newEffects();
  const limits = fixture.setup?.limits ?? {};
  const corsSetup = fixture.setup?.cors ?? null;
  const cors =
    corsSetup && typeof corsSetup === "object"
      ? {
          allowedOrigins: corsSetup.allowed_origins,
          allowCredentials: Boolean(corsSetup.allow_credentials),
          allowHeaders: corsSetup.allow_headers,
        }
      : undefined;
  const app = runtime.createApp({
    tier: "p2",
    ids,
    ...(fixture.setup?.http_error_format
      ? { httpErrorFormat: fixture.setup.http_error_format }
      : {}),
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    ...(cors ? { cors } : {}),
    authHook: (ctx) => {
      const authz = firstHeaderValue(
        ctx.request.headers ?? {},
        "authorization",
      ).trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      return "authorized";
    },
    policyHook: (ctx) => {
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-content-type-lowercase",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["1"],
            "content-type": ["text/plain; charset=utf-8"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-content-type",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["1"],
            "Content-Type": ["text/plain; charset=utf-8"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-multi-window",
        )
      ) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: {
            "retry-after": ["30"],
            "x-ratelimit-limit": ["2"],
            "x-ratelimit-remaining": ["0"],
            "x-ratelimit-reset": ["60"],
            "x-ratelimit-window": ["1m"],
          },
        };
      }
      if (
        firstHeaderValue(
          ctx.request.headers ?? {},
          "x-force-rate-limit-store-failure",
        )
      ) {
        return {
          code: "app.overloaded",
          message: "overloaded",
          headers: {
            "retry-after": ["1"],
            "x-rate-limit-fail-closed": ["true"],
          },
        };
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-rate-limit")) {
        return {
          code: "app.rate_limited",
          message: "rate limited",
          headers: { "retry-after": ["1"] },
        };
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-shed")) {
        return {
          code: "app.overloaded",
          message: "overloaded",
          headers: { "retry-after": ["1"] },
        };
      }
      return null;
    },
    observability: {
      log: (r) => {
        const record = {
          level: r.level,
          event: r.event,
          request_id: r.requestId,
          tenant_id: r.tenantId,
          method: r.method,
          path: r.path,
          status: r.status,
          error_code: r.errorCode,
        };
        if (r.traceId) record.trace_id = r.traceId;
        effects.logs.push(record);
      },
      metric: (r) => {
        effects.metrics.push({ name: r.name, value: r.value, tags: r.tags });
      },
      span: (r) => {
        effects.spans.push({ name: r.name, attributes: r.attributes });
      },
    },
  });

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandler(runtime, route.handler);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler, {
      authRequired: Boolean(route.auth_required),
    });
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (!awsEvent) {
    throw new Error("fixture missing input.aws_event");
  }
  const source = String(awsEvent.source ?? "")
    .trim()
    .toLowerCase();
  if (source !== "appsync") {
    throw new Error(
      `unknown aws_event source ${JSON.stringify(awsEvent.source)}`,
    );
  }

  let actualOutput = null;
  let actualError = null;
  try {
    actualOutput = await app.handleLambda(
      awsEvent.event ?? {},
      fixtureLambdaContext(fixture.input?.context ?? {}),
    );
  } catch (err) {
    actualError = err;
  }

  return { actualOutput, actualError, effects };
}

function builtInAppTheoryHandler(runtime, name, effects) {
  switch (name) {
    case "static_pong":
      return () => runtime.text(200, "pong");
    case "sleep_50ms":
      return async () => {
        await sleepMs(50);
        return runtime.text(200, "done");
      };
    case "cooperative_cancel_side_effect":
      return async (ctx) => {
        const signal = abortSignalFromContextCarrier(ctx?.ctx ?? null);
        if (await waitForAbort(signal, 20)) {
          return runtime.text(200, "cancelled");
        }
        effects?.metrics?.push({
          name: "timeout.side_effect_committed",
          value: 1,
          tags: { handler: "cooperative_cancel_side_effect" },
        });
        return runtime.text(200, "late");
      };
    case "echo_path_params":
      return (ctx) => runtime.json(200, { params: ctx.params ?? {} });
    case "echo_request":
      return (ctx) =>
        runtime.json(200, {
          method: ctx.request.method,
          path: ctx.request.path,
          query: ctx.request.query,
          headers: ctx.request.headers,
          cookies: ctx.request.cookies,
          body_b64: Buffer.from(ctx.request.body ?? []).toString("base64"),
          is_base64: Boolean(ctx.request.isBase64),
        });
    case "parse_json_echo":
      return (ctx) => runtime.json(200, ctx.jsonValue());
    case "json_required_echo":
      return (ctx) => {
        const headers = ctx.request?.headers ?? {};
        const contentTypes = Array.isArray(headers["content-type"])
          ? headers["content-type"]
          : [];
        if (
          !contentTypes.some((value) =>
            String(value).trim().toLowerCase().startsWith("application/json"),
          )
        ) {
          throw new runtime.AppTheoryError("app.bad_request", "invalid json", {
            statusCode: 400,
          });
        }
        const body = Buffer.from(ctx.request?.body ?? []);
        if (body.length === 0) {
          throw new runtime.AppTheoryError("EMPTY_BODY", "Request body is empty", {
            statusCode: 400,
          });
        }
        try {
          return runtime.json(200, JSON.parse(body.toString("utf8")));
        } catch (err) {
          throw new runtime.AppTheoryError(
            "INVALID_JSON",
            "Invalid JSON in request body",
            { statusCode: 400, cause: err },
          );
        }
      };
    case "bind_query_count":
      return (ctx) => {
        const raw = ctx.request?.query?.count?.[0] ?? "";
        if (!/^-?\d+$/.test(String(raw))) {
          throw new runtime.AppTheoryError(
            "app.bad_request",
            "invalid query binding for Count",
            {
              statusCode: 400,
              details: { source: "query", name: "count", field: "Count" },
            },
          );
        }
        return runtime.json(200, { count: Number(raw) });
      };
    case "bind_all_sources":
    case "bind_all_sources_strict":
      return runtime.bindHandler(
        {
          body: true,
          query: true,
          path: true,
          headers: true,
          strictJson: name === "bind_all_sources_strict",
          fields: {
            Name: { source: "body", name: "name", field: "Name" },
            Tenant: { source: "path", name: "tenant", field: "Tenant" },
            RequestID: {
              source: "header",
              name: "x-request-id",
              field: "RequestID",
            },
            Limit: { source: "query", name: "limit", type: "int", field: "Limit" },
            Enabled: {
              source: "query",
              name: "enabled",
              type: "bool",
              field: "Enabled",
            },
            Ratio: {
              source: "query",
              name: "ratio",
              type: "float",
              field: "Ratio",
            },
            Tags: {
              source: "query",
              name: "tag",
              type: "string",
              array: true,
              field: "Tags",
            },
            TTL: {
              source: "query",
              name: "ttl",
              type: "duration",
              field: "TTL",
            },
          },
        },
        (_ctx, req) => ({
          name: req.Name,
          tenant: req.Tenant,
          request_id: req.RequestID,
          limit: req.Limit,
          enabled: req.Enabled,
          ratio: req.Ratio,
          tags: req.Tags,
          ttl: req.TTL,
        }),
      );
    case "bind_duration_edges":
      return runtime.bindHandler(
        {
          query: true,
          fields: {
            Half: { source: "query", name: "half", type: "duration", field: "Half" },
            Micro: {
              source: "query",
              name: "micro",
              type: "duration",
              field: "Micro",
            },
            Boundary: {
              source: "query",
              name: "boundary",
              type: "duration",
              field: "Boundary",
            },
            Combined: {
              source: "query",
              name: "combined",
              type: "duration",
              field: "Combined",
            },
            Negative: {
              source: "query",
              name: "negative",
              type: "duration",
              field: "Negative",
            },
          },
        },
        (_ctx, req) => ({
          half: req.Half,
          micro: req.Micro,
          boundary: req.Boundary,
          combined: req.Combined,
          negative: req.Negative,
        }),
      );
    case "bind_numeric_edges":
      return runtime.bindHandler(
        {
          query: true,
          fields: {
            Count: { source: "query", name: "count", type: "int", field: "Count" },
            Ratio: {
              source: "query",
              name: "ratio",
              type: "float",
              field: "Ratio",
            },
          },
        },
        (_ctx, req) => ({ count: req.Count, ratio: req.Ratio }),
      );
    case "bind_strict_query_only":
      return runtime.bindHandler(
        {
          body: true,
          query: true,
          strictJson: true,
          fields: {
            Count: { source: "query", name: "count", type: "int", field: "Count" },
          },
        },
        (_ctx, req) => ({ count: req.Count }),
      );
    case "bind_strict_nested":
      return runtime.bindHandler(
        {
          body: true,
          strictJson: true,
          fields: {
            Profile: { source: "body", name: "profile", field: "Profile" },
            Nested: { source: "body", name: "nested", field: "Nested" },
          },
        },
        (_ctx, req) => ({ profile_name: req.Profile }),
      );
    case "bind_body_name":
      return runtime.bindHandler(
        {
          body: true,
          fields: {
            Name: { source: "body", name: "name", field: "Name" },
          },
        },
        (_ctx, req) => ({ name: req.Name }),
      );
    case "bind_strict_name":
      return runtime.bindHandler(
        {
          body: true,
          strictJson: true,
          fields: {
            Name: { source: "body", name: "name", field: "Name" },
          },
        },
        (_ctx, req) => ({ name: req.Name }),
      );
    case "validate_profile":
      return runtime.bindHandler(
        {
          body: true,
          fields: {
            name: { source: "body", name: "name" },
            age: { source: "body", name: "age", type: "int" },
            score: { source: "body", name: "score", type: "int" },
            nickname: { source: "body", name: "nickname" },
            bio: { source: "body", name: "bio" },
            email: { source: "body", name: "email" },
            role: { source: "body", name: "role" },
          },
          validation: {
            name: [runtime.required()],
            age: [runtime.min(18)],
            score: [runtime.max(10)],
            nickname: [runtime.minLength(2)],
            bio: [runtime.maxLength(5)],
            email: [runtime.pattern("^[^@]+@[^@]+\\.[^@]+$")],
            role: [runtime.oneOf(["admin", "member"])],
          },
        },
        (_ctx, req) => req,
      );
    case "validate_profile_query":
      return runtime.bindHandler(
        {
          body: true,
          query: true,
          fields: {
            Name: { source: "body", name: "name", field: "Name" },
            Age: { source: "query", name: "age", type: "int", field: "Age" },
          },
          validation: {
            Name: [runtime.required()],
            Age: [runtime.min(18)],
          },
        },
        (_ctx, req) => ({ name: req.Name, age: req.Age }),
      );
    case "validate_wire_names":
      return runtime.bindHandler(
        {
          body: true,
          query: true,
          path: true,
          headers: true,
          fields: {
            AccountID: {
              source: "path",
              name: "account_id",
              field: "AccountID",
            },
            PageSize: {
              source: "query",
              name: "page-size",
              type: "int",
              field: "PageSize",
            },
            Role: { source: "header", name: "x-role", field: "Role" },
            Name: { source: "body", name: "name", field: "Name" },
          },
          validation: {
            AccountID: [runtime.pattern("^acct_")],
            PageSize: [runtime.min(10)],
            Role: [runtime.oneOf(["admin", "member"])],
            Name: [runtime.required()],
          },
        },
        (_ctx, req) => ({
          account_id: req.AccountID,
          page_size: req.PageSize,
          role: req.Role,
          name: req.Name,
        }),
      );
    case "validate_invalid_rules":
      return runtime.bindHandler(
        {
          body: true,
          fields: {
            email: { source: "body", name: "email" },
            age: { source: "body", name: "age", type: "int" },
            name: { source: "body", name: "name" },
            role: { source: "body", name: "role" },
          },
          validation: {
            email: [{ rule: "pattern", value: "[" }],
            age: [{ rule: "min", value: "abc" }],
            name: [{ rule: "required", value: "unexpected" }],
            role: [{ rule: "typo", value: "1" }],
          },
        },
        (_ctx, req) => req,
      );
    case "validate_required_presence":
      return runtime.bindHandler(
        {
          body: true,
          validation: {
            count: [runtime.required()],
            active: [runtime.required()],
            name: [runtime.required()],
            tags: [runtime.required()],
            meta: [runtime.required()],
          },
        },
        (_ctx, req) => ({
          active: req.active,
          count: req.count,
          meta: req.meta,
          name: req.name,
          tags: req.tags,
        }),
      );
    case "echo_appsync_context":
      return (ctx) => {
        const appsync = ctx.asAppSync();
        return runtime.json(200, {
          field_name: appsync?.fieldName ?? "",
          parent_type_name: appsync?.parentTypeName ?? "",
          arguments: appsync?.arguments ?? {},
          identity: appsync?.identity ?? {},
          source: appsync?.source ?? {},
          variables: appsync?.variables ?? {},
          stash: appsync?.stash ?? {},
          prev: appsync?.prev ?? null,
          request_headers: appsync?.requestHeaders ?? {},
          raw_event_field: appsync?.rawEvent?.info?.fieldName ?? "",
          ctx_trigger_type: ctx.get("apptheory.trigger_type") ?? null,
          ctx_field_name: ctx.get("apptheory.appsync.field_name") ?? null,
          ctx_parent_type:
            ctx.get("apptheory.appsync.parent_type_name") ?? null,
          ctx_request_headers:
            ctx.get("apptheory.appsync.request_headers") ?? null,
        });
      };
    case "panic":
      return () => {
        throw new Error("boom");
      };
    case "unexpected_error":
      return () => {
        throw new Error("boom");
      };
    case "binary_body":
      return () =>
        runtime.binary(
          200,
          Buffer.from([0x00, 0x01, 0x02]),
          "application/octet-stream",
        );
    case "unauthorized":
      return () => {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      };
    case "validation_failed":
      return () => {
        throw new runtime.AppError(
          "app.validation_failed",
          "validation failed",
        );
      };
    case "portable_error":
      return () => {
        throw new runtime.AppTheoryError("app.conflict", "conflict", {
          statusCode: 409,
          details: { field: "email", retryable: false },
          traceId: "trace_456",
          timestamp: "2024-01-02T03:04:05Z",
          stackTrace: "stack:line",
        });
      };
    case "echo_context":
      return (ctx) =>
        runtime.json(200, {
          request_id: ctx.requestId ?? "",
          tenant_id: ctx.tenantId ?? "",
          auth_identity: ctx.authIdentity ?? "",
          remaining_ms: Number(ctx.remainingMs ?? 0),
        });
    case "echo_middleware_trace":
      return (ctx) => runtime.json(200, { trace: ctx.middlewareTrace ?? [] });
    case "echo_ctx_value_and_trace":
      return (ctx) =>
        runtime.json(200, {
          mw: ctx.get("mw") ?? null,
          trace: ctx.middlewareTrace ?? [],
        });
    case "naming_helpers":
      return () =>
        runtime.json(200, {
          normalized: {
            prod: runtime.normalizeStage("prod"),
            stg: runtime.normalizeStage("stg"),
            custom: runtime.normalizeStage("  Foo_Bar  "),
          },
          base: runtime.baseName("Pay Theory", "prod", "Tenant_1"),
          resource: runtime.resourceName(
            "Pay Theory",
            "WS Api",
            "prod",
            "Tenant_1",
          ),
        });
    case "stepfunctions_task_token_helpers":
      return () =>
        runtime.json(200, {
          from_taskToken: runtime.stepFunctionsTaskToken({
            taskToken: " tok-a ",
          }),
          from_TaskToken: runtime.stepFunctionsTaskToken({
            TaskToken: " tok-b ",
          }),
          from_task_token: runtime.stepFunctionsTaskToken({
            task_token: " tok-c ",
          }),
          from_precedence: runtime.stepFunctionsTaskToken({
            TaskToken: " tok-b ",
            task_token: " tok-c ",
            taskToken: " tok-a ",
          }),
          built: runtime.buildStepFunctionsTaskTokenEvent(" tok-built ", {
            foo: "bar",
            taskToken: "ignored",
          }),
        });
    case "large_response":
      return () => runtime.text(200, "12345");
    case "sse_single_event":
      return () =>
        runtime.sse(200, [{ id: "1", event: "message", data: { ok: true } }]);
    case "sse_stream_three_events":
      return async () => {
        const events = [
          { id: "1", event: "message", data: { a: 1, b: 2 } },
          { event: "note", data: "hello\nworld" },
          { id: "3", data: "" },
        ];

        const chunks = [];
        for await (const chunk of runtime.sseEventStream(events)) {
          chunks.push(Buffer.from(chunk));
        }

        return {
          status: 200,
          headers: {
            "content-type": ["text/event-stream"],
            "cache-control": ["no-cache"],
            connection: ["keep-alive"],
          },
          cookies: [],
          body: Buffer.concat(chunks),
          isBase64: false,
        };
      };
    case "sse_heartbeat_keepalive":
      return () => ({
        status: 200,
        headers: {
          "content-type": ["text/event-stream"],
          "cache-control": ["no-cache"],
          connection: ["keep-alive"],
        },
        cookies: [],
        body: Buffer.from(
          ': keep-alive\n\nid: 1\nevent: message\ndata: {"ok":true}\n\n',
          "utf8",
        ),
        isBase64: false,
      });
    case "sse_client_disconnect_mid_stream":
      return () => ({
        status: 200,
        headers: {
          "content-type": ["text/event-stream"],
          "cache-control": ["no-cache"],
          connection: ["keep-alive"],
        },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: (async function* () {
          yield Buffer.from(
            "id: 1\nevent: message\ndata: before-disconnect\n\n",
            "utf8",
          );
        })(),
        isBase64: false,
      });
    case "sse_late_error_after_first_byte":
      return () => ({
        status: 200,
        headers: {
          "content-type": ["text/event-stream"],
          "cache-control": ["no-cache"],
          connection: ["keep-alive"],
        },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: (async function* () {
          yield Buffer.from("data: hello\n\n", "utf8");
          throw new runtime.AppError("app.internal", "boom");
        })(),
        isBase64: false,
      });
    case "stream_mutate_headers_after_first_chunk":
      return () => {
        const resp = {
          status: 200,
          headers: {
            "content-type": ["text/plain; charset=utf-8"],
            "x-phase": ["before"],
          },
          cookies: ["a=b; Path=/"],
          body: Buffer.alloc(0),
          isBase64: false,
        };

        resp.bodyStream = (async function* () {
          yield Buffer.from("a", "utf8");
          resp.headers["x-phase"] = ["after"];
          resp.cookies.push("c=d; Path=/");
          yield Buffer.from("b", "utf8");
        })();

        return resp;
      };
    case "stream_error_after_first_chunk":
      return () => ({
        status: 200,
        headers: { "content-type": ["text/plain; charset=utf-8"] },
        cookies: [],
        body: Buffer.alloc(0),
        bodyStream: (async function* () {
          yield Buffer.from("hello", "utf8");
          throw new runtime.AppError("app.internal", "boom");
        })(),
        isBase64: false,
      });
    case "html_basic":
      return () => runtime.html(200, "<h1>Hello</h1>");
    case "html_stream_two_chunks":
      return () =>
        runtime.htmlStream(
          200,
          (async function* () {
            yield Buffer.from("<h1>", "utf8");
            yield Buffer.from("Hello</h1>", "utf8");
          })(),
        );
    case "safe_json_for_html":
      return () =>
        runtime.text(
          200,
          runtime.safeJSONForHTML({
            html: "</script><div>&</div><",
            amp: "a&b",
            ls: "line\u2028sep",
            ps: "para\u2029sep",
          }),
        );
    case "cookies_from_set_cookie_header":
      return () => ({
        status: 200,
        headers: {
          "content-type": ["text/plain; charset=utf-8"],
          "set-cookie": ["a=b; Path=/", "c=d; Path=/"],
        },
        cookies: ["e=f; Path=/"],
        body: Buffer.from("ok", "utf8"),
        isBase64: false,
      });
    case "header_multivalue":
      return () => ({
        status: 200,
        headers: {
          "content-type": ["text/plain; charset=utf-8"],
          "x-multi": ["a", "b"],
        },
        cookies: [],
        body: Buffer.from("ok", "utf8"),
        isBase64: false,
      });
    case "cache_helpers":
      return (ctx) => {
        const tag = runtime.etag("hello");
        return runtime.json(200, {
          cache_control_ssr: runtime.cacheControlSSR(),
          cache_control_ssg: runtime.cacheControlSSG(),
          cache_control_isr: runtime.cacheControlISR(60, 30),
          etag: tag,
          if_none_match_hit: runtime.matchesIfNoneMatch(
            ctx?.request?.headers ?? {},
            tag,
          ),
          vary: runtime.vary(["origin"], "accept-encoding", "Origin"),
        });
      };
    case "cloudfront_helpers":
      return (ctx) =>
        runtime.json(200, {
          origin_url: runtime.originURL(ctx?.request?.headers ?? {}),
          client_ip: runtime.clientIP(ctx?.request?.headers ?? {}),
        });
    case "source_provenance":
      return (ctx) => {
        const provenance = ctx.sourceProvenance();
        return runtime.json(200, {
          source_ip: ctx.sourceIP(),
          source_provenance: {
            source_ip: provenance.sourceIP,
            provider: provenance.provider,
            source: provenance.source,
            valid: provenance.valid,
          },
        });
      };
    default:
      return null;
  }
}

function builtInMiddleware(runtime, name) {
  switch (String(name ?? "").trim()) {
    case "mw_a":
      return async (ctx, next) => {
        ctx.set("mw", "ok");
        ctx.middlewareTrace.push("mw_a");
        const resp = await next(ctx);
        resp.headers["x-middleware"] = ["1"];
        return resp;
      };
    case "mw_b":
      return async (ctx, next) => {
        ctx.middlewareTrace.push("mw_b");
        return next(ctx);
      };
    case "timeout_5ms":
      return runtime.timeoutMiddleware({ defaultTimeoutMs: 5 });
    default:
      return null;
  }
}

function debugActualForExpected(actual, expected) {
  const hasBodyJson = Object.prototype.hasOwnProperty.call(
    expected,
    "body_json",
  );
  const debug = {
    status: actual.status,
    headers: canonicalizeHeaders(actual.headers ?? {}),
    cookies: actual.cookies ?? [],
    is_base64: actual.is_base64 ?? false,
  };
  if (hasBodyJson) {
    try {
      debug.body_json = JSON.parse(actual.body.toString("utf8"));
    } catch {
      debug.body = {
        encoding: "base64",
        value: actual.body.toString("base64"),
      };
    }
  } else {
    debug.body = { encoding: "base64", value: actual.body.toString("base64") };
  }
  return debug;
}


async function runFixtureVectorStore(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const backend = String(fixture.setup?.vectorstore?.backend ?? "fake").trim();
  if (backend !== "fake") {
    return { ok: false, reason: `vectorstore fixture backend ${JSON.stringify(backend)} is unsupported` };
  }
  const steps = fixture.input?.vectorstore?.steps ?? [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: "vectorstore fixture missing input.vectorstore.steps" };
  }
  const dimension = Number(fixture.setup?.vectorstore?.dimension ?? 3);
  const store = runtime.createFakeVectorStore(dimension);
  store.requiredMetadataKeys = Array.from(fixture.setup?.vectorstore?.required_metadata_keys ?? []);
  const embedder = new runtime.FakeEmbedder(fixture.setup?.vectorstore?.embeddings ?? {});
  if (fixture.setup?.vectorstore?.default_embedding) {
    embedder.defaultEmbedding = Array.from(fixture.setup.vectorstore.default_embedding);
  }
  const actualSteps = [];
  for (const step of steps) {
    actualSteps.push(await runVectorStoreStep(runtime, store, embedder, fixture.setup?.vectorstore ?? {}, dimension, step));
  }
  const actual = {
    steps: actualSteps,
    calls: vectorStoreCallsJson(store.calls()),
    embedder_calls: Array.from(embedder.calls),
  };
  return compareFixtureOutputJson(fixture, actual);
}

async function runVectorStoreStep(runtime, store, embedder, setup, dimension, step) {
  const operation = String(step.operation ?? "").trim().toLowerCase();
  const result = { name: step.name, operation };
  try {
    switch (operation) {
      case "put": {
        await store.putVectors({ records: vectorRecords(step.records ?? []) });
        break;
      }
      case "get": {
        const records = await store.getVectors({ keys: step.keys ?? [], returnMetadata: Boolean(step.return_metadata) });
        result.records = vectorRecordsJson(records, true);
        break;
      }
      case "delete": {
        await store.deleteVectors({ keys: step.keys ?? [] });
        break;
      }
      case "query": {
        const hits = await store.queryVectors({ vector: step.vector ?? [], topK: step.top_k ?? 0, filter: step.filter, returnMetadata: Boolean(step.return_metadata) });
        result.hits = vectorHitsJson(hits);
        break;
      }
      case "semantic_put": {
        const index = new runtime.SemanticIndex({ store, embedder, dimension, requiredMetadataKeys: setup.required_metadata_keys ?? [] });
        await index.putText(semanticRecords(step.records ?? []));
        break;
      }
      case "semantic_query": {
        const index = new runtime.SemanticIndex({ store, embedder, dimension, requiredMetadataKeys: setup.required_metadata_keys ?? [] });
        const hits = await index.queryText(step.text ?? "", { topK: step.top_k ?? 0, filter: step.filter, returnMetadata: Boolean(step.return_metadata) });
        result.hits = vectorHitsJson(hits);
        break;
      }
      case "titan_embed": {
        const embedding = setup?.titan?.embedding ?? setup?.default_embedding ?? [];
        const fake = new FakeBedrockRuntime(embedding);
        const emb = new runtime.TitanEmbedder({ client: fake, modelId: step.model_id, dimensions: step.dimensions || dimension, normalize: step.normalize ?? true });
        result.vector = await emb.embed(step.text ?? "");
        result.requests = fake.requests;
        break;
      }
      default: {
        throw new runtime.VectorStoreError(runtime.VECTORSTORE_ERROR_UNSUPPORTED_OPERATION, `vectorstore: unsupported operation: ${operation}`);
      }
    }
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = vectorStoreErrorJson(runtime, error);
  }
  return result;
}

class FakeBedrockRuntime {
  constructor(embedding) {
    this.embedding = Array.from(embedding ?? []);
    this.requests = [];
  }

  async send(command) {
    const input = command.input ?? {};
    const body = JSON.parse(new TextDecoder().decode(input.body));
    body.model_id = input.modelId;
    body.content_type = input.contentType;
    body.accept = input.accept;
    this.requests.push(body);
    return { body: new TextEncoder().encode(JSON.stringify({ embedding: this.embedding })) };
  }
}

function vectorRecords(records) {
  return records.map((record) => ({ key: record.key, data: Array.from(record.data ?? []), ...(record.metadata ? { metadata: cloneJson(record.metadata) } : {}) }));
}

function semanticRecords(records) {
  return records.map((record) => ({ key: record.key, text: record.text ?? "", ...(record.metadata ? { metadata: cloneJson(record.metadata) } : {}) }));
}

function vectorRecordsJson(records, includeMetadata) {
  return records.map((record) => {
    const item = { key: record.key, data: Array.from(record.data ?? []) };
    if (includeMetadata && record.metadata && Object.keys(record.metadata).length > 0) item.metadata = sortObject(record.metadata);
    return item;
  });
}

function vectorHitsJson(hits) {
  return hits.map((hit) => {
    const item = { key: hit.key, distance: hit.distance };
    if (hit.metadata && Object.keys(hit.metadata).length > 0) item.metadata = sortObject(hit.metadata);
    return item;
  });
}

function vectorStoreCallsJson(calls) {
  return calls.map((call) => {
    const item = { operation: call.operation };
    if (call.keys?.length) item.keys = Array.from(call.keys);
    if (call.records?.length) item.records = vectorRecordsJson(call.records, true);
    if (call.vector?.length) item.vector = Array.from(call.vector);
    if (call.topK !== undefined && call.topK !== 0) item.top_k = call.topK;
    if (call.filter && Object.keys(call.filter).length > 0) item.filter = sortObject(call.filter);
    if (call.returnMetadata) item.return_metadata = call.returnMetadata;
    return item;
  });
}

function vectorStoreErrorJson(runtime, error) {
  const message = error?.message ?? String(error);
  let code = error?.code ?? "vectorstore.error";
  if (message.startsWith("vectorstore: unsupported operation")) code = runtime.VECTORSTORE_ERROR_UNSUPPORTED_OPERATION;
  return { code, message };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObject(raw) {
  const out = {};
  for (const key of Object.keys(raw).sort()) out[key] = raw[key];
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const fixtureID = selectedFixtureID(args.id, args.filter);
  const { fixtures, failures, skipped } = await runAllFixtures({
    fixturesRoot: args.fixtures,
    fixtureID,
  });

  for (const f of failures) {
    const { fixture, result } = f;
    console.error(`FAIL ${fixture.id} — ${fixture.name}`);
    console.error(`  ${diagnosticReason(result.reason)}`);
    if ("expected_error" in result || "expected_output_json" in result) {
      if ("expected_error" in result) {
        console.error(
          `  expected.error: ${redactedDiagnostic()}`,
        );
        console.error(`  got.error: ${redactedDiagnostic()}`);
      }
      if ("expected_output_json" in result) {
        console.error(
          `  expected.output_json: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.output_json: ${redactedDiagnostic()}`,
        );
      }
      if ("actual_error" in result && !("expected_error" in result)) {
        console.error(`  got.error: ${redactedDiagnostic()}`);
      }
    } else {
      if ("expected_logging_profile_catalog" in result) {
        console.error(
          `  expected.logging_profile_catalog: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.logging_profile_catalog: ${redactedDiagnostic()}`,
        );
      } else if ("expected_profile_validation_errors" in result) {
        console.error(
          `  expected.profile_validation_errors: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.profile_validation_errors: ${redactedDiagnostic()}`,
        );
      } else if ("expected_profile_logs" in result) {
        console.error(
          `  expected.profile_logs: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.profile_logs: ${redactedDiagnostic()}`,
        );
      } else if ("expected_microvm_contract_validation" in result) {
        console.error(
          `  expected.microvm_contract_validation: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.microvm_contract_validation: ${redactedDiagnostic()}`,
        );
      } else if ("expected_microvm_execution_role" in result) {
        console.error(
          `  expected.microvm_execution_role: ${redactedDiagnostic()}`,
        );
        console.error(
          `  got.microvm_execution_role: ${redactedDiagnostic()}`,
        );
      } else {
        console.error(`  expected: ${redactedDiagnostic()}`);
        console.error(
          `  got: ${redactedDiagnostic()}`,
        );
      }
    }
    if ("expected_logs" in result) {
      console.error(
        `  expected.logs: ${redactedDiagnostic()}`,
      );
      console.error(`  got.logs: ${redactedDiagnostic()}`);
    }
    if ("expected_metrics" in result) {
      console.error(
        `  expected.metrics: ${redactedDiagnostic()}`,
      );
      console.error(`  got.metrics: ${redactedDiagnostic()}`);
    }
    if ("expected_spans" in result) {
      console.error(
        `  expected.spans: ${redactedDiagnostic()}`,
      );
      console.error(`  got.spans: ${redactedDiagnostic()}`);
    }
  }

  if (failures.length > 0) {
    console.error("\nFailed fixtures:");
    for (const f of failures
      .map((x) => x.fixture)
      .sort((a, b) => a.id.localeCompare(b.id))) {
      console.error(`- ${f.id}`);
    }
    process.exit(1);
  }

  const skippedCount = skipped.length;
  if (skippedCount > 0) {
    console.log(
      `contract-tests(ts): PASS (${fixtures.length} fixtures, skipped=${skippedCount})`,
    );
  } else {
    console.log(`contract-tests(ts): PASS (${fixtures.length} fixtures)`);
  }
}

async function runAllFixtures({ fixturesRoot, fixtureID = "" } = {}) {
  let fixtures = loadFixtures(fixturesRoot ?? "contract-tests/fixtures");
  if (fixtureID) {
    fixtures = filterFixturesByID(fixtures, fixtureID);
  }

  const failures = [];
  const skipped = [];
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    if (result.skipped) {
      skipped.push({ fixture, result });
      continue;
    }
    if (!result.ok) failures.push({ fixture, result });
  }

  return { fixtures, failures, skipped };
}

module.exports = {
  CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER,
  buildCloudWatchLogsSubscriptionExpectations,
  compareCloudWatchLogsSubscriptionDecodedRecord,
  makeCloudWatchLogsSubscriptionKinesisHandler,
  runAllFixtures,
};

if (require.main === module) {
  main().catch(() => {
    console.error("contract runner failed");
    process.exit(2);
  });
}
