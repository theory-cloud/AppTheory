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
