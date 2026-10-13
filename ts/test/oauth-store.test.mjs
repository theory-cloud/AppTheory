import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ManualClock } from "../dist/clock.js";
import {
  MemoryAuthorizationCodeStore,
  MemoryClientStore,
  MemoryRateLimitStore,
  MemoryRouteRefreshBrokerStore,
  MemoryTransactionStore,
  runStoreConformance,
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
  readFileSync(path.join(FIXTURE_DIR, "facade-store-conformance.v1.json"), "utf8"),
);
const CASES = fixture.cases ?? [];
const EPOCH = new Date(fixture.clock?.epoch ?? "2026-01-01T00:00:00Z");
// The broker lock TTL is a store-level bound, so it is read from the table the
// rows exercise rather than hardcoded.
const LOCK_TTL_SECONDS = Math.max(
  1,
  ...CASES.map((c) => Number(c.params?.lock_ttl_seconds ?? 0)),
);
// Likewise the handle lifetime: every broker row starts at the fixture epoch,
// so the store's own TTL is what the boundary rows measure.
const ROUTE_REFRESH_TTL_SECONDS = Number(
  fixture.ttl_seconds?.route_refresh_broker ?? 900,
);

function newStores(clock) {
  const now = () => clock.now();
  return {
    transaction: new MemoryTransactionStore({ now }),
    authorizationCode: new MemoryAuthorizationCodeStore({ now }),
    client: new MemoryClientStore({ now }),
    routeRefreshBroker: new MemoryRouteRefreshBrokerStore({
      now,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      ttlSeconds: ROUTE_REFRESH_TTL_SECONDS,
    }),
    rateLimit: new MemoryRateLimitStore({ now }),
  };
}

// Non-vacuity negative controls: each broken store below breaks exactly one
// semantic the shared table pins, so the table must report at least one failure
// against it. The good baseline above must report none.

/** Deliberately broken: reports a replayed or expired consume as fresh. */
class NonTerminalCodeStore extends MemoryAuthorizationCodeStore {
  async consume(codeHash) {
    const result = await super.consume(codeHash);
    if (!result) return result;
    if (result.replayed || result.record?.status === "expired") {
      return { record: result.record, replayed: false };
    }
    return result;
  }
}

/** Deliberately broken: reports the pre-bump version for locked/revoked records. */
class NonBumpingBrokerStore extends MemoryRouteRefreshBrokerStore {
  async get(handleHash) {
    const record = await super.get(handleHash);
    if (
      record &&
      (record.status === "revoked" || record.status === "refreshing")
    ) {
      return { ...record, version: record.version - 1 };
    }
    return record;
  }
}

/** Deliberately broken: a handle lifetime far longer than the table's TTL. */
function newTTLIgnoringBrokerStores(clock) {
  const stores = newStores(clock);
  stores.routeRefreshBroker = new MemoryRouteRefreshBrokerStore({
    now: () => clock.now(),
    lockTtlSeconds: LOCK_TTL_SECONDS,
    ttlSeconds: 360_000,
  });
  return stores;
}

function newNonTerminalCodeStores(clock) {
  const stores = newStores(clock);
  stores.authorizationCode = new NonTerminalCodeStore({
    now: () => clock.now(),
  });
  return stores;
}

function newNonBumpingBrokerStores(clock) {
  const stores = newStores(clock);
  stores.routeRefreshBroker = new NonBumpingBrokerStore({
    now: () => clock.now(),
    lockTtlSeconds: LOCK_TTL_SECONDS,
    ttlSeconds: ROUTE_REFRESH_TTL_SECONDS,
  });
  return stores;
}

const BROKEN_BUNDLES = [
  {
    name: "non_terminal_code",
    build: newNonTerminalCodeStores,
    expectFailed: [
      "store.authorization_code.consume_is_single_use_then_replayed",
      "store.authorization_code.expired_consume_then_replay",
      "store.authorization_code.clock_back_after_consume_is_replayed",
      "store.authorization_code.clock_back_after_expired_burn_is_replayed",
    ],
  },
  {
    name: "ttl_ignoring_broker",
    build: newTTLIgnoringBrokerStores,
    expectFailed: [
      "store.route_refresh_broker.record_expired_at_ttl_boundary",
      "store.route_refresh_broker.expired_record_refuses_lock",
      "store.route_refresh_broker.expired_record_refuses_swap",
    ],
  },
  {
    name: "non_bumping_broker",
    build: newNonBumpingBrokerStores,
    expectFailed: [
      "store.route_refresh_broker.acquire_lock_bumps_version",
      "store.route_refresh_broker.revoke_bumps_version",
    ],
  },
];

/** Runs each row on its own so one broken bundle reports every failing row. */
async function failingCaseIds(build, cases) {
  const failed = [];
  for (const testCase of cases) {
    const clock = new ManualClock(EPOCH);
    try {
      await runStoreConformance(build(clock), [testCase], clock);
    } catch {
      failed.push(testCase.id);
    }
  }
  return failed;
}

test("store conformance fixture carries 33 cases", () => {
  assert.equal(CASES.length, 33);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 33);
});

test("the in-memory reference stores satisfy the store conformance table", async () => {
  const clock = new ManualClock(EPOCH);
  const result = await runStoreConformance(newStores(clock), CASES, clock);
  assert.equal(result.ran, 33);
  console.log(
    `store conformance: ${result.ran}/${CASES.length} cases passed (in-memory reference stores)`,
  );
});

test("the reference stores expose every store SPI operation", () => {
  const expected = {
    transaction: ["put", "consume"],
    authorizationCode: ["put", "consume"],
    client: ["put", "get", "update"],
    routeRefreshBroker: ["get", "acquireLock", "compareAndSwap", "revoke"],
    rateLimit: ["checkAndIncrement"],
  };
  const stores = newStores(new ManualClock(EPOCH));
  for (const [store, methods] of Object.entries(expected)) {
    for (const method of methods) {
      assert.equal(
        typeof stores[store][method],
        "function",
        `${store}.${method} must be a function`,
      );
    }
  }
});

test("reference stores never hand out or retain their stored slices", async () => {
  const clock = new ManualClock(EPOCH);

  const codes = new MemoryAuthorizationCodeStore({ now: () => clock.now() });
  const code = {
    codeHash: "alias-code",
    clientIdHash: "client-hash",
    clientId: "conformance-client",
    redirectUri: "https://mcp.example.test/_oauth/mcp/callback",
    codeChallenge: "cc",
    codeChallengeMethod: "S256",
    scopes: ["scope-a"],
    canonicalResource: "https://mcp.example.test/mcp",
    endpointKind: "mcp",
    clientNamespace: "conformance",
    partnerId: "",
    agentId: "",
    routeRefreshHandleHash: "handle-hash",
    encryptedRouteRefreshHandle: "encrypted-handle",
    encryptedTokenResponse: "encrypted-token",
    status: "issued",
    expiresAt: new Date(EPOCH.getTime() + 60_000),
    version: 1,
  };
  await codes.put(code);
  code.scopes[0] = "mutated-caller";
  const first = await codes.consume("alias-code");
  assert.deepEqual(first.record.scopes, ["scope-a"]);
  first.record.scopes[0] = "mutated-returned";
  const replayed = await codes.consume("alias-code");
  assert.deepEqual(replayed.record.scopes, ["scope-a"]);

  const clients = new MemoryClientStore({ now: () => clock.now() });
  const client = {
    clientIdHash: "alias-client",
    clientId: "conformance-client",
    redirectUris: ["https://a.example.test/cb"],
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    boundRoute: "https://mcp.example.test/mcp",
    createdAt: new Date(0),
    version: 1,
  };
  await clients.put(client);
  client.redirectUris[0] = "mutated-caller";
  const stored = await clients.get("alias-client");
  assert.deepEqual(stored.redirectUris, ["https://a.example.test/cb"]);
  stored.redirectUris[0] = "mutated-returned";
  stored.grantTypes[0] = "mutated-returned";
  const again = await clients.get("alias-client");
  assert.deepEqual(again.redirectUris, ["https://a.example.test/cb"]);
  assert.deepEqual(again.grantTypes, ["authorization_code"]);

  const brokers = new MemoryRouteRefreshBrokerStore({
    now: () => clock.now(),
    lockTtlSeconds: 30,
  });
  const handle = {
    handleHash: "alias-broker",
    issuer: "https://auth.example.test",
    stage: "lab",
    canonicalResource: "https://mcp.example.test/mcp",
    clientNamespace: "conformance",
    endpointKind: "mcp",
    partnerId: "",
    agentId: "",
    clientIdHash: "client-hash",
    subjectIdHash: "subject-hash",
    scopes: ["scope-a"],
    scopeFingerprint: "fingerprint",
    encryptedUpstreamRefreshToken: "encrypted-refresh",
    upstreamRefreshTokenHash: "refresh-hash",
    upstreamClientId: "conformance-client",
    status: "active",
    version: 1,
  };
  await brokers.compareAndSwap(handle, 0);
  handle.scopes[0] = "mutated-caller";
  const storedHandle = await brokers.get("alias-broker");
  assert.deepEqual(storedHandle.scopes, ["scope-a"]);
  storedHandle.scopes[0] = "mutated-returned";
  const againHandle = await brokers.get("alias-broker");
  assert.deepEqual(againHandle.scopes, ["scope-a"]);
});

test("the conformance table reports zero failures for the good baseline", async () => {
  const clock = new ManualClock(EPOCH);
  const result = await runStoreConformance(newStores(clock), CASES, clock);
  assert.equal(result.ran, CASES.length);
});

for (const bundle of BROKEN_BUNDLES) {
  test(`the conformance table fails a deliberately-broken store: ${bundle.name}`, async () => {
    const clock = new ManualClock(EPOCH);
    await assert.rejects(
      runStoreConformance(bundle.build(clock), CASES, clock),
      `a broken store must make the conformance table throw (${bundle.name})`,
    );

    const failed = await failingCaseIds(bundle.build, CASES);
    assert.ok(
      failed.length >= 1,
      `${bundle.name}: the conformance table reported no failing row`,
    );
    for (const id of bundle.expectFailed) {
      assert.ok(
        failed.includes(id),
        `${bundle.name}: expected row ${id} to fail; failing rows: ${failed.join(", ")}`,
      );
    }
    console.log(
      `${bundle.name}: ${failed.length} failing row(s) [${failed.join(", ")}]`,
    );
  });
}
