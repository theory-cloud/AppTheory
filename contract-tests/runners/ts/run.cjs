#!/usr/bin/env node

/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const util = require("node:util");

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

function canonicalizeRequest(inReq) {
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
    case "app.internal":
      return 500;
    default:
      return 500;
  }
}

function appErrorResponse(code, message, extraHeaders) {
  const headers = canonicalizeHeaders(extraHeaders ?? {});
  headers["content-type"] = ["application/json; charset=utf-8"];
  const bodyJson = { error: { code, message } };
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
    default:
      return null;
  }
}

function newFixtureApp(routes) {
  const compiled = (routes ?? []).map((r) => ({
    method: String(r.method).trim().toUpperCase(),
    path: String(r.path).trim(),
    segments: splitPath(r.path),
    handler: String(r.handler).trim(),
  }));

  return {
    handle(req) {
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
          return appErrorResponse("app.method_not_allowed", "method not allowed", {
            allow: [formatAllowHeader(allowed)],
          });
        }
        return appErrorResponse("app.not_found", "not found", {});
      }

      const handler = builtInHandler(match.route.handler);
      if (!handler) return appErrorResponse("app.internal", "internal error", {});

      try {
        const enriched = { ...req, path_params: match.params };
        const resp = handler(enriched);
        return {
          ...resp,
          headers: canonicalizeHeaders(resp.headers ?? {}),
          cookies: resp.cookies ?? [],
        };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && "message" in err) {
          return appErrorResponse(err.code, err.message, {});
        }
        return appErrorResponse("app.internal", "internal error", {});
      }
    },
  };
}

function compareHeaders(expectedHeaders, actualHeaders) {
  const e = canonicalizeHeaders(expectedHeaders ?? {});
  const a = canonicalizeHeaders(actualHeaders ?? {});
  return deepEqual(e, a);
}

function runFixture(fixture) {
  const app = newFixtureApp(fixture.setup?.routes ?? []);
  const req = canonicalizeRequest(fixture.input?.request ?? {});
  const actual = app.handle(req);
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
    return { ok: true };
  }

  if (expected.body) {
    const expectedBytes = decodeFixtureBody(expected.body);
    if (!expectedBytes.equals(actual.body)) {
      return { ok: false, reason: "body mismatch", actual, expected };
    }
    return { ok: true };
  }

  if (!Buffer.alloc(0).equals(actual.body)) {
    return { ok: false, reason: "body mismatch", actual, expected };
  }
  return { ok: true };
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

function main() {
  const args = parseArgs(process.argv);
  const fixtures = loadFixtures(args.fixtures);

  const failed = [];
  for (const fixture of fixtures) {
    const result = runFixture(fixture);
    if (!result.ok) {
      console.error(`FAIL ${fixture.id} — ${fixture.name}`);
      console.error(`  ${result.reason}`);
      console.error(`  expected: ${stableStringify(result.expected)}`);
      console.error(`  got: ${stableStringify(debugActualForExpected(result.actual, result.expected))}`);
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

main();

