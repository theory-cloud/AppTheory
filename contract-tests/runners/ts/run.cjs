#!/usr/bin/env node

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { pathToFileURL } = require("node:url");
const util = require("node:util");

let cachedRuntime = null;

async function loadAppTheoryRuntime() {
  if (cachedRuntime) return cachedRuntime;
  const runtimePath = path.join(process.cwd(), "ts", "dist", "index.js");
  const runtimeUrl = pathToFileURL(runtimePath).href;
  cachedRuntime = await import(runtimeUrl);
  return cachedRuntime;
}

function parseArgs(argv) {
  const args = { fixtures: "contract-tests/fixtures" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixtures") {
      args.fixtures = argv[i + 1];
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

function deepEqual(a, b) {
  return util.isDeepStrictEqual(a, b);
}

function listFixtureFiles(fixturesRoot) {
  const tiers = ["p0", "p1", "p2"];
  const files = [];
  for (const tier of tiers) {
    const dir = path.join(fixturesRoot, tier);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      files.push(path.join(dir, entry));
    }
  }
  files.sort();
  return files;
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
  const out = {};
  if (!headers) return out;
  const keys = Object.keys(headers).sort();
  for (const key of keys) {
    const lower = String(key).trim().toLowerCase();
    if (!lower) continue;
    const values = Array.isArray(headers[key]) ? headers[key] : [headers[key]];
    if (!out[lower]) out[lower] = [];
    out[lower].push(...values);
  }
  return out;
}

function decodeFixtureBody(body) {
  if (!body) return Buffer.alloc(0);
  if (body.encoding === "utf8") return Buffer.from(body.value ?? "", "utf8");
  if (body.encoding === "base64") return Buffer.from(body.value ?? "", "base64");
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
  const method = String(inReq.method ?? "").trim().toUpperCase();
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
  const trimmed = String(p ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return [];
  return trimmed.split("/");
}

function matchPath(patternSegments, pathSegments) {
  if (patternSegments.length !== pathSegments.length) return { ok: false, params: {} };
  const params = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const pattern = patternSegments[i];
    const value = pathSegments[i];
    if (!value) return { ok: false, params: {} };
    const isParam = pattern.startsWith("{") && pattern.endsWith("}") && pattern.length > 2;
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
        body: Buffer.from(JSON.stringify({ trace: req.middleware_trace }), "utf8"),
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
  return String(method).toUpperCase() === "OPTIONS" && firstHeaderValue(headers, "access-control-request-method");
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
  const effects = { logs: [], metrics: [], spans: [] };

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
        requestId = firstHeaderValue(req.headers, "x-request-id") || "req_test_123";
        req.request_id = requestId;

        origin = firstHeaderValue(req.headers, "origin");
        req.tenant_id = extractTenantId(req.headers, req.query);

        req.middleware_trace.push("request_id", "recovery", "logging");
        if (origin) req.middleware_trace.push("cors");

        if (origin && isCorsPreflight(req.method, req.headers)) {
          const allow = firstHeaderValue(req.headers, "access-control-request-method");
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

        if (limits.max_request_bytes && req.body.length > limits.max_request_bytes) {
          errorCode = "app.too_large";
          return finish(appErrorResponse("app.too_large", "request too large", {}, requestId), errorCode);
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
        return finish(appErrorResponse("app.not_found", "not found", {}, requestId), errorCode);
      }

      if (enableP1 && match.route.auth_required) {
        req.middleware_trace.push("auth");
        const authz = firstHeaderValue(req.headers, "authorization");
        if (!authz.trim()) {
          errorCode = "app.unauthorized";
          return finish(appErrorResponse("app.unauthorized", "unauthorized", {}, requestId), errorCode);
        }
        req.auth_identity = "authorized";
      }
      if (enableP1) req.middleware_trace.push("handler");

      const handler = builtInHandler(match.route.handler);
      if (!handler) {
        errorCode = "app.internal";
        return finish(appErrorResponse("app.internal", "internal error", {}, requestId), errorCode);
      }

      let resp;
      try {
        const enriched = { ...req, path_params: match.params };
        resp = handler(enriched);
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && "message" in err) {
          errorCode = err.code;
          resp = appErrorResponse(err.code, err.message, {}, requestId);
        } else {
          errorCode = "app.internal";
          resp = appErrorResponse("app.internal", "internal error", {}, requestId);
        }
        return finish(resp, errorCode);
      }

      if (enableP1 && limits.max_response_bytes && resp.body.length > limits.max_response_bytes) {
        errorCode = "app.too_large";
        resp = appErrorResponse("app.too_large", "response too large", {}, requestId);
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

async function runFixture(fixture) {
  const tier = String(fixture.tier ?? "").trim().toLowerCase();

  if (tier === "p0") {
    const { actual, effects } = await runFixtureP0(fixture);
    return compareFixture(fixture, actual, effects);
  }
  if (tier === "p1") {
    const { actual, effects } = await runFixtureP1(fixture);
    return compareFixture(fixture, actual, effects);
  }
  if (tier === "p2") {
    const { actual, effects } = await runFixtureP2(fixture);
    return compareFixture(fixture, actual, effects);
  }

  const enableP1 = ["p1", "p2"].includes(tier);
  const enableP2 = tier === "p2";
  const app = newFixtureApp(fixture.setup?.routes ?? [], { enableP1, enableP2, limits: fixture.setup?.limits ?? {} });
  const req = canonicalizeRequest(fixture.input?.request ?? {}, fixture.input?.context ?? {});
  const actual = app.handle(req);
  const effects = app.effects ?? {};
  return compareFixture(fixture, actual, effects);
}

function compareFixture(fixture, actual, effects) {
  const expected = fixture.expect?.response ?? {};

  if (expected.status !== actual.status) {
    return { ok: false, reason: `status: expected ${expected.status}, got ${actual.status}`, actual, expected };
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

  const hasBodyJson = Object.prototype.hasOwnProperty.call(expected, "body_json");
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
  return { ok: true };
}

async function runFixtureP0(fixture) {
  const runtime = await loadAppTheoryRuntime();
  const app = runtime.createApp({ tier: "p0" });

  for (const route of fixture.setup?.routes ?? []) {
    const handler = builtInAppTheoryHandler(runtime, route.handler);
    if (!handler) {
      throw new Error(`unknown handler ${JSON.stringify(route.handler)}`);
    }
    app.handle(route.method, route.path, handler);
  }

  const awsEvent = fixture.input?.aws_event ?? null;
  if (awsEvent) {
    const source = String(awsEvent.source ?? "").trim().toLowerCase();
    const event = awsEvent.event ?? {};

    if (source === "apigw_v2") {
      const resp = await app.serveAPIGatewayV2(event);
      return { actual: canonicalResponseFromAPIGatewayV2Response(resp), effects: { logs: [], metrics: [], spans: [] } };
    }
    if (source === "lambda_function_url") {
      const resp = await app.serveLambdaFunctionURL(event);
      return {
        actual: canonicalResponseFromLambdaFunctionURLResponse(resp),
        effects: { logs: [], metrics: [], spans: [] },
      };
    }

    throw new Error(`unknown aws_event source ${JSON.stringify(awsEvent.source)}`);
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

  return { actual, effects: { logs: [], metrics: [], spans: [] } };
}

function canonicalResponseFromAPIGatewayV2Response(resp) {
  const status = Number(resp?.statusCode ?? 0);
  const isBase64Encoded = Boolean(resp?.isBase64Encoded);
  const bodyStr = String(resp?.body ?? "");
  const body = isBase64Encoded ? Buffer.from(bodyStr, "base64") : Buffer.from(bodyStr, "utf8");

  const headersSource =
    resp?.multiValueHeaders && Object.keys(resp.multiValueHeaders).length > 0 ? resp.multiValueHeaders : resp?.headers ?? {};

  const headers = {};
  for (const [key, value] of Object.entries(headersSource ?? {})) {
    headers[key] = Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
  }

  return {
    status,
    headers,
    cookies: Array.isArray(resp?.cookies) ? resp.cookies.map((c) => String(c)) : [],
    body,
    is_base64: isBase64Encoded,
  };
}

function canonicalResponseFromLambdaFunctionURLResponse(resp) {
  const status = Number(resp?.statusCode ?? 0);
  const isBase64Encoded = Boolean(resp?.isBase64Encoded);
  const bodyStr = String(resp?.body ?? "");
  const body = isBase64Encoded ? Buffer.from(bodyStr, "base64") : Buffer.from(bodyStr, "utf8");

  const headers = {};
  for (const [key, value] of Object.entries(resp?.headers ?? {})) {
    headers[key] = [String(value)];
  }

  return {
    status,
    headers,
    cookies: Array.isArray(resp?.cookies) ? resp.cookies.map((c) => String(c)) : [],
    body,
    is_base64: isBase64Encoded,
  };
}

async function runFixtureP1(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const limits = fixture.setup?.limits ?? {};
  const app = runtime.createApp({
    tier: "p1",
    ids,
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    authHook: (ctx) => {
      const authz = firstHeaderValue(ctx.request.headers ?? {}, "authorization").trim();
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
    app.handle(route.method, route.path, handler, { authRequired: Boolean(route.auth_required) });
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

  const runtimeCtx = { remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0) };
  const resp = await app.serve(req, runtimeCtx);
  const actual = {
    status: resp.status,
    headers: resp.headers ?? {},
    cookies: resp.cookies ?? [],
    body: Buffer.from(resp.body ?? []),
    is_base64: resp.isBase64 ?? false,
  };

  return { actual, effects: { logs: [], metrics: [], spans: [] } };
}

async function runFixtureP2(fixture) {
  const runtime = await loadAppTheoryRuntime();

  const ids = new runtime.ManualIdGenerator();
  ids.queue("req_test_123");

  const effects = { logs: [], metrics: [], spans: [] };

  const limits = fixture.setup?.limits ?? {};
  const app = runtime.createApp({
    tier: "p2",
    ids,
    limits: {
      maxRequestBytes: Number(limits.max_request_bytes ?? 0),
      maxResponseBytes: Number(limits.max_response_bytes ?? 0),
    },
    authHook: (ctx) => {
      const authz = firstHeaderValue(ctx.request.headers ?? {}, "authorization").trim();
      if (!authz) {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      }
      return "authorized";
    },
    policyHook: (ctx) => {
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-rate-limit")) {
        return { code: "app.rate_limited", message: "rate limited", headers: { "retry-after": ["1"] } };
      }
      if (firstHeaderValue(ctx.request.headers ?? {}, "x-force-shed")) {
        return { code: "app.overloaded", message: "overloaded", headers: { "retry-after": ["1"] } };
      }
      return null;
    },
    observability: {
      log: (r) => {
        effects.logs.push({
          level: r.level,
          event: r.event,
          request_id: r.requestId,
          tenant_id: r.tenantId,
          method: r.method,
          path: r.path,
          status: r.status,
          error_code: r.errorCode,
        });
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
    app.handle(route.method, route.path, handler, { authRequired: Boolean(route.auth_required) });
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

  const runtimeCtx = { remaining_ms: Number(fixture.input?.context?.remaining_ms ?? 0) };
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

function builtInAppTheoryHandler(runtime, name) {
  switch (name) {
    case "static_pong":
      return () => runtime.text(200, "pong");
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
    case "panic":
      return () => {
        throw new Error("boom");
      };
    case "binary_body":
      return () => runtime.binary(200, Buffer.from([0x00, 0x01, 0x02]), "application/octet-stream");
    case "unauthorized":
      return () => {
        throw new runtime.AppError("app.unauthorized", "unauthorized");
      };
    case "validation_failed":
      return () => {
        throw new runtime.AppError("app.validation_failed", "validation failed");
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
    case "large_response":
      return () => runtime.text(200, "12345");
    default:
      return null;
  }
}

function debugActualForExpected(actual, expected) {
  const hasBodyJson = Object.prototype.hasOwnProperty.call(expected, "body_json");
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
      debug.body = { encoding: "base64", value: actual.body.toString("base64") };
    }
  } else {
    debug.body = { encoding: "base64", value: actual.body.toString("base64") };
  }
  return debug;
}

async function main() {
  const args = parseArgs(process.argv);
  const fixtures = loadFixtures(args.fixtures);

  const failed = [];
  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    if (!result.ok) {
      console.error(`FAIL ${fixture.id} — ${fixture.name}`);
      console.error(`  ${result.reason}`);
      console.error(`  expected: ${stableStringify(result.expected)}`);
      console.error(`  got: ${stableStringify(debugActualForExpected(result.actual, result.expected))}`);
      if ("expected_logs" in result) {
        console.error(`  expected.logs: ${stableStringify(result.expected_logs)}`);
        console.error(`  got.logs: ${stableStringify(result.actual_logs)}`);
      }
      if ("expected_metrics" in result) {
        console.error(`  expected.metrics: ${stableStringify(result.expected_metrics)}`);
        console.error(`  got.metrics: ${stableStringify(result.actual_metrics)}`);
      }
      if ("expected_spans" in result) {
        console.error(`  expected.spans: ${stableStringify(result.expected_spans)}`);
        console.error(`  got.spans: ${stableStringify(result.actual_spans)}`);
      }
      failed.push(fixture);
    }
  }

  if (failed.length > 0) {
    console.error("\nFailed fixtures:");
    for (const f of failed.sort((a, b) => a.id.localeCompare(b.id))) {
      console.error(`- ${f.id}`);
    }
    process.exit(1);
  }

  console.log(`contract-tests(ts): PASS (${fixtures.length} fixtures)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
