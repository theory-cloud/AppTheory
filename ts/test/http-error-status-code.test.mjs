import test from "node:test";
import assert from "node:assert/strict";

import { App, AppError, AppTheoryError } from "../dist/index.js";

// The nested envelope must always report the status the runtime actually sent
// (issue #1161). Each case drives a producer class through the serve path and
// asserts error.status_code === response status.
function statusCodeOf(response) {
  const body = JSON.parse(Buffer.from(response.body).toString("utf8"));
  return body.error.status_code;
}

const ok = async () => ({ status: 200, headers: {}, cookies: [], body: "" });

test("served error envelopes carry the status code of the served response", async () => {
  const cases = [
    {
      name: "routing not found",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/ping", ok);
        return app;
      },
      request: { method: "GET", path: "/missing", headers: {}, body: "" },
    },
    {
      name: "routing method not allowed",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/ping", ok);
        return app;
      },
      request: { method: "DELETE", path: "/ping", headers: {}, body: "" },
    },
    {
      name: "panic recovery",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/panic", () => {
          throw new Error("boom");
        });
        return app;
      },
      request: { method: "GET", path: "/panic", headers: {}, body: "" },
    },
    {
      name: "policy rate limit",
      build: () =>
        new App({
          tier: "p2",
          policy: async () => ({ code: "app.rate_limited" }),
        }),
      request: { method: "GET", path: "/limited", headers: {}, body: "" },
    },
    {
      name: "policy load shed",
      build: () =>
        new App({
          tier: "p2",
          policy: async () => ({ code: "app.overloaded" }),
        }),
      request: { method: "GET", path: "/shed", headers: {}, body: "" },
    },
    {
      name: "request too large",
      build: () => new App({ tier: "p2", limits: { maxRequestBytes: 1 } }),
      request: { method: "GET", path: "/big", headers: {}, body: "too big" },
    },
    {
      name: "response too large",
      build: () => {
        const app = new App({ tier: "p2", limits: { maxResponseBytes: 1 } });
        app.get("/big", async () => ({
          status: 200,
          headers: {},
          cookies: [],
          body: "too big",
        }));
        return app;
      },
      request: { method: "GET", path: "/big", headers: {}, body: "" },
    },
    {
      name: "legacy AppError from a handler",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/legacy", async () => {
          throw new AppError("app.bad_request", "invalid json");
        });
        return app;
      },
      request: { method: "GET", path: "/legacy", headers: {}, body: "" },
    },
    {
      name: "portable error without a status",
      build: () => {
        const app = new App({ tier: "p0" });
        app.get("/portable", async () => {
          throw new AppTheoryError("app.not_found", "not found");
        });
        return app;
      },
      request: { method: "GET", path: "/portable", headers: {}, body: "" },
    },
  ];

  for (const tc of cases) {
    await test(tc.name, async () => {
      const response = await tc.build().serve(tc.request);
      assert.equal(statusCodeOf(response), response.status, tc.name);
    });
  }
});

test("flat-legacy error envelopes stay byte-identical and carry no status_code", async () => {
  const app = new App({ tier: "p0", httpErrorFormat: "flat_legacy" });
  app.get("/ping", ok);

  const missing = await app.serve({
    method: "GET",
    path: "/missing",
    headers: {},
    body: "",
  });
  assert.equal(
    Buffer.from(missing.body).toString("utf8"),
    '{"code":"app.not_found","message":"not found"}',
  );

  const portable = await app.serve({
    method: "GET",
    path: "/ping",
    headers: {},
    body: "",
  });
  assert.equal(portable.status, 200);
});

// An AppTheoryError whose details carry a value that genuinely has no JSON
// representation cannot be serialized, so the response is the internal-error
// fallback (issue #1161 boundary). A bigint is one such value and a cycle is
// another: sortKeysDeep rejects the cycle before JSON.stringify would recurse
// without bound.
async function serveTeapotWithDetails(format, details) {
  const app = new App({
    tier: "p0",
    ...(format ? { httpErrorFormat: format } : {}),
  });
  app.get("/teapot", async () => {
    const err = new AppTheoryError("teapot", "I am a teapot");
    err.statusCode = 418;
    err.details = details;
    throw err;
  });
  return app.serve({ method: "GET", path: "/teapot", headers: {}, body: "" });
}

function bodyText(response) {
  return Buffer.from(response.body).toString("utf8");
}

function cyclicDetails() {
  const details = { reason: "x" };
  details.self = details;
  return details;
}

test("a nested envelope carrying a bigint is sent as the internal-error fallback with status 500", async () => {
  const response = await serveTeapotWithDetails(null, {
    reason: "x",
    count: 10n,
  });
  assert.equal(response.status, 500);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"app.internal","message":"internal error","status_code":500}}',
  );
  assert.deepEqual(response.headers["content-type"], [
    "application/json; charset=utf-8",
  ]);
});

test("a flat-legacy envelope carrying a bigint is sent as the internal-error fallback with status 500", async () => {
  const response = await serveTeapotWithDetails("flat_legacy", {
    reason: "x",
    count: 10n,
  });
  assert.equal(response.status, 500);
  assert.equal(
    bodyText(response),
    '{"code":"app.internal","message":"internal error"}',
  );
  assert.deepEqual(response.headers["content-type"], [
    "application/json; charset=utf-8",
  ]);
});

test("a nested envelope carrying a cycle is sent as the internal-error fallback with status 500", async () => {
  const response = await serveTeapotWithDetails(null, cyclicDetails());
  assert.equal(response.status, 500);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"app.internal","message":"internal error","status_code":500}}',
  );
});

test("a flat-legacy envelope carrying a cycle is sent as the internal-error fallback with status 500", async () => {
  const response = await serveTeapotWithDetails("flat_legacy", cyclicDetails());
  assert.equal(response.status, 500);
  assert.equal(
    bodyText(response),
    '{"code":"app.internal","message":"internal error"}',
  );
});

// `details: { reason: "x", hint: undefined }` is a handler error carrying an
// absent optional field. Standard JSON.stringify omits the key, so the response
// is the normal 4xx envelope with status_code matching the status on the wire;
// only a value that cannot be serialized at all triggers the fallback.
test("details with an undefined property keep the nested envelope and omit the key", async () => {
  const response = await serveTeapotWithDetails(null, {
    reason: "x",
    hint: undefined,
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"reason":"x"},"message":"I am a teapot","status_code":418}}',
  );
  const body = JSON.parse(bodyText(response));
  assert.equal(body.error.status_code, response.status);
  assert.equal("hint" in body.error.details, false);
});

test("details with an undefined property keep the flat-legacy envelope and omit the key", async () => {
  const response = await serveTeapotWithDetails("flat_legacy", {
    reason: "x",
    hint: undefined,
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"code":"teapot","message":"I am a teapot","details":{"reason":"x"}}',
  );
  assert.equal("hint" in JSON.parse(bodyText(response)).details, false);
});

test("details with a function-valued property keep the nested envelope and omit it", async () => {
  const response = await serveTeapotWithDetails(null, {
    reason: "x",
    onDone: () => {},
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"reason":"x"},"message":"I am a teapot","status_code":418}}',
  );
  const body = JSON.parse(bodyText(response));
  assert.equal(body.error.status_code, response.status);
  assert.equal("onDone" in body.error.details, false);
});

// A Date carries `toJSON` on its prototype, so sorting the nested envelope must
// resolve that hook before it copies keys or the value silently becomes `{}`.
test("a Date in nested details is rendered through its toJSON hook", async () => {
  const response = await serveTeapotWithDetails(null, {
    at: new Date("2026-01-02T03:04:05Z"),
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"at":"2026-01-02T03:04:05.000Z"},"message":"I am a teapot","status_code":418}}',
  );
});

test("a Date inside an array in nested details is rendered through its toJSON hook", async () => {
  const response = await serveTeapotWithDetails(null, {
    times: [new Date("2026-01-02T03:04:05Z")],
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"times":["2026-01-02T03:04:05.000Z"]},"message":"I am a teapot","status_code":418}}',
  );
});

// Decimal, money, and temporal types keep `toJSON` on the class prototype, the same
// shape as Date. The hook's result is itself key-sorted, so scale precedes units.
class PrototypeToJSON {
  constructor(units) {
    this.units = units;
  }

  toJSON() {
    return { units: this.units, scale: 2 };
  }
}

test("a class instance with a prototype toJSON is rendered through the hook and key-sorted", async () => {
  const response = await serveTeapotWithDetails(null, {
    price: new PrototypeToJSON("250"),
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"price":{"scale":2,"units":"250"}},"message":"I am a teapot","status_code":418}}',
  );
});

test("an object with an own toJSON property is rendered through the hook", async () => {
  const response = await serveTeapotWithDetails(null, {
    tenant: {
      name: "acme",
      toJSON() {
        return { zeta: 1, alpha: "acme" };
      },
    },
  });
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"error":{"code":"teapot","details":{"tenant":{"alpha":"acme","zeta":1}},"message":"I am a teapot","status_code":418}}',
  );
});

// The reference serializer sorts only the keys of plain objects, through a replacer
// that JSON.stringify invokes after it has applied a value's `toJSON` hook. It is
// independent of the runtime's own sortKeysDeep, so agreement between the two is a
// real parity check rather than a restatement of the implementation.
function canonicalJSON(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = value[key];
    }
    return sorted;
  });
}

test("a nested body is byte-identical to JSON.stringify of the same envelope after key sorting", async () => {
  const details = {
    at: new Date("2026-01-02T03:04:05Z"),
    times: [new Date("2025-12-31T23:59:59Z")],
    counts: new Number(7),
    labels: new Set(["x"]),
    index: new Map([["k", "v"]]),
    price: new PrototypeToJSON("250"),
    tenant: { name: "acme", toJSON: () => ({ zeta: 1, alpha: "acme" }) },
  };
  const response = await serveTeapotWithDetails(null, details);
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    canonicalJSON({
      error: {
        code: "teapot",
        message: "I am a teapot",
        status_code: 418,
        details,
      },
    }),
  );
});

// Flat-legacy hands the envelope straight to JSON.stringify, so a Date in details was
// never at risk from sorting. Pinning it shows the fix left that path alone.
test("a flat-legacy envelope renders a Date in details exactly as JSON.stringify does", async () => {
  const details = { at: new Date("2026-01-02T03:04:05Z") };
  const response = await serveTeapotWithDetails("flat_legacy", details);
  assert.equal(response.status, 418);
  assert.equal(
    bodyText(response),
    '{"code":"teapot","message":"I am a teapot","details":{"at":"2026-01-02T03:04:05.000Z"}}',
  );
  assert.equal(
    bodyText(response),
    JSON.stringify({
      code: "teapot",
      message: "I am a teapot",
      details,
    }),
  );
});
