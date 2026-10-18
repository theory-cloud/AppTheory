import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/index.js";

test("serve logs the verified tenant after principal authentication", async () => {
  const logs = [];
  const app = createApp({
    tier: "p2",
    tenantClaim: "tenant",
    authPrincipalHook: () => ({
      identity: "subject-1",
      claims: { tenant: "verified-tenant" },
    }),
    observability: { log: (record) => logs.push(record) },
  });
  app.handle(
    "GET",
    "/protected",
    (ctx) => ({
      status: 200,
      headers: {},
      cookies: [],
      body: Buffer.from(ctx.tenantId, "utf8"),
      isBase64: false,
    }),
    { authRequired: true },
  );

  const resp = await app.serve({
    method: "GET",
    path: "/protected",
    headers: { "x-tenant-id": ["caller-tenant"] },
  });

  assert.equal(resp.status, 200);
  assert.equal(Buffer.from(resp.body).toString("utf8"), "verified-tenant");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].tenantId, "verified-tenant");
});
