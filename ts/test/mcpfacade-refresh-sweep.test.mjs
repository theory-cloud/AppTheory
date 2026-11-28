import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFRESH_BUDGET_SECONDS,
  MAX_REFRESH_BUDGET_SECONDS,
  MIN_REFRESH_BUDGET_SECONDS,
  ProviderError,
  RefreshSweeper,
  createApp,
  hashKey,
  registerMcpFacade,
} from "../dist/index.js";

import {
  CLIENT_ID,
  REFRESH_ACCESS_TOKEN,
  ROTATED_UPSTREAM_REFRESH_TOKEN,
  ROTATED_UPSTREAM_SCOPE,
  bodyString,
  newFrontChannelHarness,
} from "./mcpfacade-harness.mjs";

function refreshForm(handle) {
  return {
    grant_type: "refresh_token",
    refresh_token: handle,
    client_id: CLIENT_ID,
  };
}

function responseHandle(response) {
  const payload = JSON.parse(bodyString(response));
  assert.ok(
    typeof payload.refresh_token === "string" && payload.refresh_token !== "",
  );
  return payload.refresh_token;
}

async function mintedRefreshHandle(harness) {
  const { code } = await harness.authorizeAndCallback();
  const exchange = await harness.token(harness.tokenForm(code));
  assert.equal(exchange.status, 200, bodyString(exchange));
  return responseHandle(exchange);
}

async function brokerRecord(harness, handle) {
  const record = await harness.stores.routeRefreshBroker.get(hashKey(handle));
  assert.ok(record !== null, "the broker record must exist");
  return record;
}

async function familyRecords(harness, familyHash) {
  return await harness.stores.routeRefreshBroker.listFamily(familyHash);
}

function successorTokenSet() {
  return {
    accessToken: REFRESH_ACCESS_TOKEN,
    refreshToken: ROTATED_UPSTREAM_REFRESH_TOKEN,
    tokenType: "Bearer",
    expiresIn: 900,
    scope: ROTATED_UPSTREAM_SCOPE,
  };
}

function providerError(errorClass) {
  // The facade classifies by ProviderError, so the scripted failure stays in the
  // closed vocabulary rather than being string-matched.
  return new ProviderError(errorClass, "refresh");
}

/**
 * Replaces the provider's refresh call with a fixed script, so a row can drive
 * the upstream sequence the local fake cannot produce (a lost rotation, or a
 * verdict on a later attempt). Every other provider call still reaches the real
 * adapter.
 */
function scriptRefresh(harness, steps) {
  let calls = 0;
  harness.config.provider.refresh = async () => {
    const index = Math.min(calls, steps.length - 1);
    calls += 1;
    return steps[index]();
  };
  return () => calls;
}

function sweeperFor(harness, policyOverrides = {}) {
  return new RefreshSweeper({
    provider: harness.config.provider,
    stores: harness.stores,
    policy: {
      handleTTLSeconds: 900,
      reuseRateCeiling: 9,
      graceWindowSeconds: 120,
      ...policyOverrides,
    },
    now: () => harness.clock.now(),
  });
}

test("a per-request upstream error never families and the handle keeps working", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const calls = scriptRefresh(harness, [
    () => {
      throw providerError("upstream_error");
    },
    () => successorTokenSet(),
  ]);

  const refused = await harness.token(refreshForm(handle));
  assert.equal(refused.status, 502, bodyString(refused));
  assert.match(bodyString(refused), /"error":"upstream_error"/);
  const record = await brokerRecord(harness, handle);
  assert.notEqual(record.status, "revoked");

  const recovered = await harness.token(refreshForm(handle));
  assert.equal(recovered.status, 200, bodyString(recovered));
  assert.equal(calls(), 2);
});

test("a stale-or-replaced upstream signal is recoverable, not terminal", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  scriptRefresh(harness, [
    () => {
      throw providerError("temporarily_unavailable");
    },
    () => successorTokenSet(),
  ]);

  const transient = await harness.token(refreshForm(handle));
  assert.equal(transient.status, 503, bodyString(transient));
  assert.equal((await brokerRecord(harness, handle)).status, "issued");

  const recovered = await harness.token(refreshForm(handle));
  assert.equal(recovered.status, 200, bodyString(recovered));
});

test("a lost rotation keeps the family and recovers through the persisted intent", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  scriptRefresh(harness, [
    () => {
      throw providerError("temporarily_unavailable");
    },
    () => successorTokenSet(),
  ]);

  const lost = await harness.token(refreshForm(handle));
  assert.equal(lost.status, 503, bodyString(lost));
  const marked = await brokerRecord(harness, handle);
  assert.ok(
    marked.rotationUnconfirmedAt instanceof Date,
    "the lost rotation must leave the marker",
  );
  assert.equal(marked.status, "issued");
  assert.ok(!marked.refreshLockOwner);

  const recovered = await harness.token(refreshForm(handle));
  assert.equal(recovered.status, 200, bodyString(recovered));
  assert.notEqual(responseHandle(recovered), handle);
  const rotated = await brokerRecord(harness, handle);
  assert.equal(rotated.status, "active");
  assert.equal(
    rotated.rotationUnconfirmedAt,
    undefined,
    "a confirmed rotation clears the marker",
  );
});

test("an ambiguous invalid_grant is transient inside the horizon and terminal after it", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  scriptRefresh(harness, [
    () => {
      throw providerError("temporarily_unavailable");
    },
    () => {
      throw providerError("invalid_grant");
    },
  ]);

  assert.equal((await harness.token(refreshForm(handle))).status, 503);
  const ambiguous = await harness.token(refreshForm(handle));
  assert.equal(ambiguous.status, 503, bodyString(ambiguous));
  assert.equal((await brokerRecord(harness, handle)).status, "issued");

  harness.clock.advance(121_000);
  const terminal = await harness.token(refreshForm(handle));
  assert.equal(terminal.status, 400, bodyString(terminal));
  assert.match(bodyString(terminal), /"error":"invalid_grant"/);
  await assert.rejects(
    async () => await harness.stores.routeRefreshBroker.get(hashKey(handle)),
    /revoked/i,
    "a revoked family is not readable",
  );
});

test("the sweeper rotates the live head and the request path serves the predecessor", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const familyHash = (await brokerRecord(harness, handle)).familyHash;
  assert.ok(familyHash);

  const result = await sweeperFor(harness).sweepFamily(familyHash);
  assert.equal(result.outcome, "rotated");
  assert.equal(result.presentedHandleHash, hashKey(handle));
  assert.ok(result.successorHandleHash);
  assert.equal(result.chainGeneration, 2);

  const served = await harness.token(refreshForm(handle));
  assert.equal(served.status, 200, bodyString(served));
  assert.equal(hashKey(responseHandle(served)), result.successorHandleHash);
});

test("the sweeper defers while the request path holds the lock", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const record = await brokerRecord(harness, handle);
  await harness.stores.routeRefreshBroker.acquireLock(
    record.handleHash,
    "request-owner",
    record.version,
  );

  const result = await sweeperFor(harness).sweepFamily(record.familyHash);
  assert.equal(result.outcome, "deferred");
  assert.equal(result.deferredReason, "lock_contention");
  assert.equal((await familyRecords(harness, record.familyHash)).length, 1);
});

test("the sweeper never revokes on a contract-terminal verdict", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const familyHash = (await brokerRecord(harness, handle)).familyHash;
  scriptRefresh(harness, [
    () => {
      throw providerError("invalid_grant");
    },
  ]);

  const result = await sweeperFor(harness).sweepFamily(familyHash);
  assert.equal(result.outcome, "terminal_verdict");
  assert.ok((await brokerRecord(harness, handle)).status !== "revoked");
});

test("the refresh budget is encoded configuration with derived bounds", () => {
  assert.equal(DEFAULT_REFRESH_BUDGET_SECONDS, 10);
  assert.equal(MIN_REFRESH_BUDGET_SECONDS, 1);
  // The ceiling leaves the commit margin inside the 15 s broker lock TTL.
  assert.equal(MAX_REFRESH_BUDGET_SECONDS, 12);
});

test("a policy outside the refresh budget bounds is a registration error", async (t) => {
  const harness = await newFrontChannelHarness(t);
  // Zero selects the default, so the below-floor case is a negative budget.
  for (const budget of [-1, MAX_REFRESH_BUDGET_SECONDS + 1]) {
    const app = createApp({ tier: "p0", clock: harness.clock });
    assert.throws(
      () =>
        registerMcpFacade(app, {
          ...harness.config,
          routeRefreshPolicy: {
            handleTTLSeconds: 900,
            reuseRateCeiling: 9,
            refreshBudgetSeconds: budget,
          },
        }),
      /refresh budget/,
    );
  }
});

// --- issue #1283: sweep deferrals are reported, and the budget is honored ---

/**
 * A provider that answers the transport-bound reporter question, so a row can
 * register a policy the transport can or cannot honor. Every other leg is the
 * harness adapter.
 */
function reportingProvider(harness, fetchTimeoutSeconds) {
  const inner = harness.config.provider;
  return {
    discovery: (...args) => inner.discovery(...args),
    authorizationUrl: (...args) => inner.authorizationUrl(...args),
    exchangeCode: (...args) => inner.exchangeCode(...args),
    refresh: (...args) => inner.refresh(...args),
    validateAccessToken: (...args) => inner.validateAccessToken(...args),
    upstreamFetchTimeoutSeconds: () => fetchTimeoutSeconds,
  };
}

/** Builds a sweeper over a harness with overrides the shared helper cannot carry. */
function sweeperConfigured(
  harness,
  { policy = {}, provider = null, events = null } = {},
) {
  return new RefreshSweeper({
    provider: provider ?? harness.config.provider,
    stores: harness.stores,
    policy: {
      handleTTLSeconds: 900,
      reuseRateCeiling: 9,
      graceWindowSeconds: 120,
      ...policy,
    },
    events: events ?? undefined,
    now: () => harness.clock.now(),
  });
}

function stateFailures(events) {
  return events.filter((event) => event.class === "state_failure");
}

test("every sweep deferral is reported as exactly one state_failure event", async (t) => {
  const stages = [
    {
      name: "unreadable_family",
      reason: "family_state_unavailable",
      stage: (harness) => {
        harness.stores.routeRefreshBroker.listFamily = async () => {
          throw new Error("store unavailable");
        };
      },
    },
    {
      name: "lock_contention",
      reason: "lock_contention",
      stage: async (harness, record) => {
        await harness.stores.routeRefreshBroker.acquireLock(
          record.handleHash,
          "request-owner",
          record.version,
        );
      },
    },
    {
      name: "rotation_intent_write_failure",
      reason: "rewrite_failure",
      stage: (harness) => {
        harness.stores.routeRefreshBroker.compareAndSwap = async () => {
          throw new Error("store unavailable");
        };
      },
    },
    {
      name: "upstream_rejected",
      reason: "upstream_rejected",
      // This branch defers after the family head is resolved, so the event keeps
      // the identity the existing upstream failure event already carries.
      carriesHead: true,
      stage: (harness) => {
        scriptRefresh(harness, [
          () => {
            throw providerError("temporarily_unavailable");
          },
        ]);
      },
    },
    {
      name: "commit_race",
      reason: "rewrite_failure",
      stage: (harness) => {
        harness.stores.routeRefreshBroker.rotateFamily = async () => {
          throw new Error("transaction unavailable");
        };
      },
    },
  ];

  for (const testCase of stages) {
    const harness = await newFrontChannelHarness(t);
    const handle = await mintedRefreshHandle(harness);
    const record = await brokerRecord(harness, handle);
    await testCase.stage(harness, record);
    const events = [];
    const result = await sweeperConfigured(harness, {
      events: (event) => events.push(event),
    }).sweepFamily(record.familyHash);

    assert.equal(result.outcome, "deferred", testCase.name);
    assert.equal(result.deferredReason, testCase.reason, testCase.name);

    const failures = stateFailures(events);
    assert.equal(
      failures.length,
      1,
      `${testCase.name}: every deferred tick reports exactly one state_failure event, saw ${JSON.stringify(events)}`,
    );
    assert.equal(failures[0].reason, testCase.reason, testCase.name);
    if (testCase.carriesHead === true) {
      assert.equal(failures[0].handleHash, record.handleHash, testCase.name);
    } else {
      // A deferral that resolved no record invents no identity for it.
      assert.equal(failures[0].handleHash, undefined, testCase.name);
      assert.equal(failures[0].familyHash, undefined, testCase.name);
      assert.equal(failures[0].successorHandleHash, undefined, testCase.name);
    }
    assert.ok(failures[0].at instanceof Date, testCase.name);

    // A deferral is never a family event: the handle stays live and unrevoked.
    const after = await brokerRecord(harness, handle);
    assert.notEqual(after.status, "revoked", testCase.name);
    assert.equal(after.familyHash, record.familyHash, testCase.name);
  }
});

test("a refresh budget the provider transport cannot honor is refused", async (t) => {
  const harness = await newFrontChannelHarness(t);

  // 12 s encoded against a 10 s transport bound: the transport would end the call
  // first, so the encoded budget would be a claim the deployment contradicts
  // (issue #1283: every upstream timeout fired at exactly 10.0 s).
  assert.throws(
    () =>
      sweeperConfigured(harness, {
        provider: reportingProvider(harness, DEFAULT_REFRESH_BUDGET_SECONDS),
        policy: { refreshBudgetSeconds: 12 },
      }),
    (err) => {
      assert.match(err.message, /12s/);
      assert.match(err.message, /10s/);
      assert.match(err.message, /upstream fetch timeout/);
      assert.match(err.message, /raise the provider's fetch timeout/);
      return true;
    },
  );

  // The same pair through facade registration.
  const app = createApp({ tier: "p0", clock: harness.clock });
  assert.throws(
    () =>
      registerMcpFacade(app, {
        ...harness.config,
        provider: reportingProvider(harness, DEFAULT_REFRESH_BUDGET_SECONDS),
        routeRefreshPolicy: {
          handleTTLSeconds: 900,
          reuseRateCeiling: 9,
          refreshBudgetSeconds: 12,
        },
      }),
    (err) => {
      assert.match(err.message, /12s/);
      assert.match(err.message, /10s/);
      return true;
    },
  );

  // The comparison is against the reported bound, not a constant.
  assert.throws(
    () =>
      sweeperConfigured(harness, {
        provider: reportingProvider(harness, 2),
        policy: { refreshBudgetSeconds: 5 },
      }),
    (err) => {
      assert.match(err.message, /5s/);
      assert.match(err.message, /2s/);
      return true;
    },
  );
});

test("a refresh budget the transport can honor stays the binding deadline", async (t) => {
  const harness = await newFrontChannelHarness(t);

  // An equal bound and a longer bound are both accepted, and a provider that
  // states no bound at all is unchecked: the reporter is how a provider becomes
  // answerable, never a new requirement.
  for (const fetchTimeoutSeconds of [
    MAX_REFRESH_BUDGET_SECONDS,
    MAX_REFRESH_BUDGET_SECONDS * 2,
  ]) {
    const sweeper = sweeperConfigured(harness, {
      provider: reportingProvider(harness, fetchTimeoutSeconds),
      policy: { refreshBudgetSeconds: MAX_REFRESH_BUDGET_SECONDS },
    });
    assert.ok(sweeper instanceof RefreshSweeper);
  }
  assert.ok(sweeperConfigured(harness) instanceof RefreshSweeper);

  // The budget, not the 10 s transport default, ends an upstream call that never
  // answers: one second is the floor the policy accepts.
  const handle = await mintedRefreshHandle(harness);
  const record = await brokerRecord(harness, handle);
  harness.config.provider.refresh = () => new Promise(() => {});
  const events = [];
  const started = Date.now();
  const result = await sweeperConfigured(harness, {
    provider: reportingProvider(harness, MAX_REFRESH_BUDGET_SECONDS),
    policy: { refreshBudgetSeconds: MIN_REFRESH_BUDGET_SECONDS },
    events: (event) => events.push(event),
  }).sweepFamily(record.familyHash);
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, "deferred");
  assert.equal(result.deferredReason, "upstream_rejected");
  assert.ok(
    elapsed >= MIN_REFRESH_BUDGET_SECONDS * 1000 - 100,
    `the encoded budget is the deadline the call ran under, waited ${elapsed}ms`,
  );
  assert.ok(elapsed < DEFAULT_REFRESH_BUDGET_SECONDS * 1000);
  assert.equal(stateFailures(events).length, 1);
});
