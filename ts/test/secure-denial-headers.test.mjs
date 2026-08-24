import test from "node:test";
import assert from "node:assert/strict";

import { AppError, AppTheoryError } from "../dist/errors.js";
import {
  Authenticated,
  SecureApp,
} from "../dist/index.js";

const ok = async () => ({ status: 200, headers: {}, cookies: [], body: "" });

const ids = { newId: () => "req_denial" };
const challenge =
  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

test("secure denial without headers renders today's envelope without a challenge", async () => {
  const app = new SecureApp({
    tier: "p2",
    ids,
    principalResolver: async () => {
      throw new AppError("app.unauthorized", "unauthorized");
    },
  });
  app.get("/mcp", ok, Authenticated());

  const resp = await app.serve({
    method: "GET",
    path: "/mcp",
    headers: {},
    body: "",
  });

  assert.equal(resp.status, 401);
  assert.equal(resp.headers["www-authenticate"], undefined);
  assert.equal(resp.headers["content-type"]?.[0], "application/json; charset=utf-8");
  assert.equal(resp.headers["x-request-id"]?.[0], "req_denial");
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: {
      code: "app.unauthorized",
      message: "unauthorized",
      request_id: "req_denial",
    },
  });
});

test("secure denial can carry a WWW-Authenticate challenge header", async () => {
  const app = new SecureApp({
    tier: "p2",
    ids,
    principalResolver: async () => {
      throw new AppTheoryError("app.unauthorized", "unauthorized").withHeaders({
        "WWW-Authenticate": [challenge],
      });
    },
  });
  app.get("/mcp", ok, Authenticated());

  const resp = await app.serve({
    method: "GET",
    path: "/mcp",
    headers: {},
    body: "",
  });

  assert.equal(resp.status, 401);
  assert.equal(resp.headers["www-authenticate"]?.[0], challenge);
  assert.equal(resp.headers["content-type"]?.[0], "application/json; charset=utf-8");
  assert.equal(resp.headers["x-request-id"]?.[0], "req_denial");
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: {
      code: "app.unauthorized",
      message: "unauthorized",
      request_id: "req_denial",
    },
  });
});

test("secure forbidden denial can carry a bounded arbitrary header set", async () => {
  const app = new SecureApp({
    tier: "p2",
    ids,
    principalResolver: async () => {
      throw new AppTheoryError("app.forbidden", "forbidden").withHeaders({
        "WWW-Authenticate": [challenge],
        "X-Denial-Reason": ["insufficient_scope"],
      });
    },
  });
  app.get("/scoped", ok, Authenticated("write"));

  const resp = await app.serve({
    method: "GET",
    path: "/scoped",
    headers: {},
    body: "",
  });

  assert.equal(resp.status, 403);
  assert.equal(resp.headers["www-authenticate"]?.[0], challenge);
  assert.equal(resp.headers["x-denial-reason"]?.[0], "insufficient_scope");
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: {
      code: "app.forbidden",
      message: "forbidden",
      request_id: "req_denial",
    },
  });
});
