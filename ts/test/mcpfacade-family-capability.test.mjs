import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, registerMcpFacade } from "../dist/index.js";
import {
  MemoryAuthorizationCodeStore,
  MemoryClientStore,
  MemoryRateLimitStore,
  MemoryRouteRefreshBrokerStore,
  MemoryTransactionStore,
} from "../dist/oauth/store.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "mcp-auth-facade",
);
const fixture = JSON.parse(
  readFileSync(
    path.join(FIXTURE_DIR, "facade-family-capability.v1.json"),
    "utf8",
  ),
);

function noContent() {
  return {
    status: 204,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function provider() {
  return {
    discovery: async () => ({ issuer: "https://id.example.com" }),
    authorizationUrl: async () => "https://id.example.com/authorize",
    exchangeCode: async () => ({
      accessToken: "upstream",
      tokenType: "Bearer",
    }),
    refresh: async () => ({ accessToken: "upstream", tokenType: "Bearer" }),
    validateAccessToken: async () => ({ subject: "subject" }),
  };
}

function frontChannelConfig(stores) {
  return {
    issuerURL: "https://front.example.com/",
    jwksURI: "https://id.example.com/jwks.json",
    urlMode: "public_base_url",
    publicBaseURL: "https://front.example.com/",
    scopes: {
      namespace: ["namespace:use"],
      partner_namespace: ["partner_namespace:use"],
      agent: ["agent:use"],
      partner_agent: ["partner_agent:use"],
    },
    mcpHandler: () => noContent(),
    transportPosture: "iam",
    provider: provider(),
    stores,
    upstreamClientID: "upstream-client",
    upstreamIssuer: "https://id.example.com",
    routeRefreshPolicy: { handleTTLSeconds: 900, reuseRateCeiling: 9 },
  };
}

/** Builds the broker variant a fixture row names from the reference store. */
function brokerVariant(variant) {
  const reference = new MemoryRouteRefreshBrokerStore();
  const base = {
    put: reference.put.bind(reference),
    get: reference.get.bind(reference),
    acquireLock: reference.acquireLock.bind(reference),
    compareAndSwap: reference.compareAndSwap.bind(reference),
    revoke: reference.revoke.bind(reference),
  };
  const legacy = {
    ...base,
    listFamily: reference.listFamily.bind(reference),
    revokeFamily: reference.revokeFamily.bind(reference),
  };
  const create = reference.createFamily.bind(reference);
  const rotate = reference.rotateFamily.bind(reference);
  switch (variant) {
    case "base_stores_only":
      return base;
    case "legacy_family_only":
      return legacy;
    case "missing_create_family":
      return { ...legacy, rotateFamily: rotate };
    case "missing_rotate_family":
      return { ...legacy, createFamily: create };
    case "missing_list_family":
      return {
        ...base,
        createFamily: create,
        rotateFamily: rotate,
        revokeFamily: legacy.revokeFamily,
      };
    case "missing_revoke_family":
      return {
        ...base,
        createFamily: create,
        rotateFamily: rotate,
        listFamily: legacy.listFamily,
      };
    case "complete":
      return {
        ...legacy,
        createFamily: create,
        rotateFamily: rotate,
      };
    default:
      throw new Error(`unknown variant ${variant}`);
  }
}

function storesFor(variant) {
  return {
    transaction: new MemoryTransactionStore(),
    authorizationCode: new MemoryAuthorizationCodeStore(),
    client: new MemoryClientStore(),
    routeRefreshBroker: brokerVariant(variant),
    rateLimit: new MemoryRateLimitStore(),
  };
}

test("registration requires the transactional family capability", () => {
  assert.equal(fixture.cases.length, 7);
  for (const row of fixture.cases) {
    const app = createApp({ tier: "p0" });
    const config = frontChannelConfig(storesFor(row.variant));
    if (row.expect === "accepted") {
      const inventory = registerMcpFacade(app, config);
      assert.ok(inventory, row.id);
      continue;
    }
    assert.throws(
      () => registerMcpFacade(app, config),
      (err) => {
        const message = String(err?.message ?? err);
        const wanted =
          row.missing === "transactional_family"
            ? "transactional refresh-family"
            : {
                create_family: "createFamily",
                rotate_family: "rotateFamily",
                list_family: "listFamily",
                revoke_family: "revokeFamily",
              }[row.missing];
        assert.ok(wanted, `unknown missing capability ${row.missing}`);
        assert.ok(
          message.includes(wanted),
          `${row.id}: error ${message} must name ${wanted}`,
        );
        return true;
      },
    );
  }
});
