import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TheorydbClient, TheorydbError } from "@theory-cloud/tabletheory-ts";
import { createStatefulDynamoDBClient } from "@theory-cloud/tabletheory-ts/testkit";

import { ManualClock } from "../dist/clock.js";
import { RateLimiterError } from "../dist/limited/errors.js";
import { DynamoRateLimiter } from "../dist/limited/limiter.js";
import { MultiWindowStrategy } from "../dist/limited/strategies.js";

// The shared multi-window cancellation table: one conformance table for how a
// DynamoDB-backed multi-window limiter reads a cancelled TransactWrite, driven
// here against the TypeScript runtime's REAL limiter over a REAL TableTheory
// client bound to TableTheory's stateful fake DynamoDB. The rows queue the
// cancellation shapes a real transaction produces, so the assertion is what the
// limiter does with them rather than what a stub claims to return.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  HERE,
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "limiter",
  "multi-window-cancellation.v1.json",
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const CASES = fixture.cases ?? [];

// The table has exactly this many rows: a row that is dropped or renamed must
// fail the run instead of silently shrinking what is covered.
const FIXTURE_CASE_COUNT = 13;

const LIMITER = fixture.limiter ?? {};
const EPOCH = new Date(LIMITER.clock_epoch);
const WINDOWS = (LIMITER.windows ?? []).map((window) => ({
  durationMs: Number(window.duration_seconds) * 1000,
  maxRequests: Number(window.max_requests),
}));
// The primary (first) window is the one the limiter reports as `limit`.
const PRIMARY_LIMIT = WINDOWS.length > 0 ? WINDOWS[0].maxRequests : 0;
const KEY = {
  identifier: LIMITER.key?.identifier ?? "",
  resource: LIMITER.key?.resource ?? "",
  operation: LIMITER.key?.operation ?? "",
};

const POLICIES = [
  { expectation: "fail_open", failOpen: true },
  { expectation: "fail_closed", failOpen: false },
];

const OUTCOMES = ["admitted", "soft_denial", "internal_error"];

// The one delivery a row may ask for beyond the fake's own seam.
const DELIVER_CANCELLED_EXCEPTION = "cancelled_exception";

// A reason's code and message survive at their position; a fixture reason that
// omits either one omits it here too, so "no code in this slot" and DynamoDB's
// explicit "None" placeholder stay distinguishable.
function cancellationReasons(testCase) {
  return (testCase.cancellation?.reasons ?? []).map((reason) => {
    const out = {};
    if ("code" in reason) out.Code = reason.code;
    if ("message" in reason) out.Message = reason.message;
    return out;
  });
}

// A fresh fake, client, strategy and limiter per run: the fake's queued failures
// persist until they are cleared, so a shared harness would leak one case's
// cancellation into the next.
//
// Every command the limiter sends is recorded, so a row can show that its
// outcome came from the limiter's own transaction reaching the fake through a
// real TableTheory client rather than from an early return.
function newHarness(failOpen) {
  const { client, fake } = createStatefulDynamoDBClient();
  const commands = [];
  const ddb = {
    send: (command, options) => {
      commands.push(command.constructor.name);
      return client.send(command, options);
    },
  };
  const limiter = new DynamoRateLimiter({
    theorydb: new TheorydbClient(ddb),
    config: { failOpen },
    strategy: new MultiWindowStrategy(WINDOWS),
    clock: new ManualClock(EPOCH),
  });
  return { commands, fake, limiter };
}

// Queues the row's transaction failure onto the fake. Position matters to the
// runtime under test: a reason with no code, and DynamoDB's "None" placeholder,
// both occupy their slot without being a genuine failure, and only the first
// genuine reason classifies the cancellation.
//
// A row may ask for the hand-built delivery instead of the fake's synthesized
// one. The fake synthesizes the service message from the reason list, so a row
// whose premise is the message text would be vacuous through that seam: the
// hand-built exception carries the row's own message and reasons verbatim.
function queueFailure(fake, testCase) {
  if (testCase.deliver === DELIVER_CANCELLED_EXCEPTION) {
    fake.queueTransactionError(
      new TransactionCanceledException({
        message: String(testCase.cancellation?.message ?? ""),
        CancellationReasons: cancellationReasons(testCase),
      }),
    );
    return;
  }

  if (testCase.cancellation) {
    fake.queueTransactionCancellation(cancellationReasons(testCase));
    return;
  }

  if (testCase.transport_error) {
    fake.queueTransactionError(
      new Error(String(testCase.transport_error.message ?? "")),
    );
    return;
  }

  throw new Error(
    `${testCase.id}: fixture row carries neither a cancellation nor a transport_error`,
  );
}

async function runCase(failOpen, testCase) {
  const { commands, fake, limiter } = newHarness(failOpen);
  queueFailure(fake, testCase);
  try {
    return { commands, decision: await limiter.checkAndIncrement(KEY) };
  } catch (error) {
    return { commands, error };
  }
}

// A row delivered as a hand-built cancellation exception must be read back as
// such: the client maps it into a TheorydbError, the mapper's code comes from
// this row's ordered reasons, and the row's message text is on the mapped cause.
// A delivery that never reached the classifier would leave the row's premise
// untested, so the whole chain is pinned for these rows.
function assertHandBuiltDelivery(testCase, label, rejection) {
  const mapped = rejection.cause;
  assert.ok(
    mapped instanceof TheorydbError,
    `${label}: the client must map the delivered exception into a TheorydbError`,
  );
  assert.equal(mapped.code, "ErrTransactionFailed", `${label}: mapped code`);
  assert.deepEqual(
    (mapped.cancellationReasons ?? []).map((reason) => reason.code),
    (testCase.cancellation?.reasons ?? []).map((reason) => reason.code ?? ""),
    `${label}: the mapped reasons keep this row's order and its placeholders`,
  );
  const delivered = mapped.cause;
  assert.ok(
    delivered instanceof TransactionCanceledException,
    `${label}: the mapped cause is the hand-built exception`,
  );
  assert.equal(
    delivered.message,
    testCase.cancellation?.message,
    `${label}: this row's message text reaches the classifier`,
  );
}

function assertOutcome(testCase, policy, result) {
  const label = `${testCase.id} (${policy.expectation})`;
  const expected = testCase.expect?.[policy.expectation];
  assert.ok(
    OUTCOMES.includes(expected),
    `${label}: unknown expected outcome ${JSON.stringify(expected)}`,
  );

  // The limiter must have minted its transaction and sent it to the fake: a
  // limiter that never calls the transaction would let a row's expectation pass
  // without the queued failure ever being consulted.
  assert.ok(
    result.commands.includes("TransactWriteItemsCommand"),
    `${label}: the limiter sent no TransactWriteItems through the client`,
  );

  if (expected === "internal_error") {
    assert.ok(
      result.error !== undefined,
      `${label}: expected a rejection, got ${JSON.stringify(result.decision)}`,
    );
    assert.ok(
      result.error instanceof RateLimiterError,
      `${label}: expected a RateLimiterError, got ${result.error}`,
    );
    assert.equal(result.error.type, "internal_error", `${label}: error type`);
    if (testCase.deliver === DELIVER_CANCELLED_EXCEPTION) {
      assertHandBuiltDelivery(testCase, label, result.error);
    }
    return;
  }

  assert.equal(
    result.error,
    undefined,
    `${label}: expected ${expected} but the limiter rejected with ${result.error}`,
  );
  const decision = result.decision;
  assert.equal(decision.allowed, expected === "admitted", `${label}: allowed`);
  assert.equal(decision.limit, PRIMARY_LIMIT, `${label}: primary window limit`);

  if (expected === "soft_denial") {
    assert.notEqual(
      decision.retryAfterMs,
      undefined,
      `${label}: a soft denial carries a retry-after`,
    );
    assert.notEqual(
      decision.retryAfterMs,
      null,
      `${label}: a soft denial carries a retry-after`,
    );
    assert.ok(
      typeof decision.retryAfterMs === "number" &&
        Number.isFinite(decision.retryAfterMs),
      `${label}: retry-after must be a finite number, got ${decision.retryAfterMs}`,
    );
  }
}

test("the shared multi-window cancellation table carries 13 cases", () => {
  assert.equal(CASES.length, FIXTURE_CASE_COUNT);
  assert.equal(
    new Set(CASES.map((testCase) => testCase.id)).size,
    FIXTURE_CASE_COUNT,
    "every row has its own id",
  );
  for (const testCase of CASES) {
    assert.notEqual(
      Boolean(testCase.cancellation),
      Boolean(testCase.transport_error),
      `${testCase.id}: exactly one of cancellation/transport_error is present`,
    );
    // `deliver` is either absent or the one delivery this table defines: a
    // typo'd field must fail the run rather than silently fall back to the
    // fake's seam and leave the row's premise untested.
    assert.ok(
      testCase.deliver === undefined ||
        testCase.deliver === DELIVER_CANCELLED_EXCEPTION,
      `${testCase.id}: deliver ${JSON.stringify(testCase.deliver)} is neither absent nor ${DELIVER_CANCELLED_EXCEPTION}`,
    );
    if (testCase.deliver === DELIVER_CANCELLED_EXCEPTION) {
      assert.ok(
        testCase.cancellation,
        `${testCase.id}: a hand-built cancellation needs a cancellation block`,
      );
      assert.equal(
        typeof testCase.cancellation.message,
        "string",
        `${testCase.id}: a hand-built cancellation needs its own message`,
      );
    }
    for (const policy of POLICIES) {
      assert.ok(
        OUTCOMES.includes(testCase.expect?.[policy.expectation]),
        `${testCase.id}: expect.${policy.expectation} is one of ${OUTCOMES.join(", ")}`,
      );
    }
  }

  assert.equal(LIMITER.strategy, "multi_window");
  assert.equal(WINDOWS.length, 2);
  assert.ok(
    KEY.identifier !== "" && KEY.resource !== "" && KEY.operation !== "",
    "the fixture key names an identifier, a resource and an operation",
  );
  assert.ok(!Number.isNaN(EPOCH.valueOf()), "the fixture clock epoch parses");
});

test("the cancellation table is not vacuous", () => {
  const expected = CASES.flatMap((testCase) => [
    testCase.expect?.fail_open,
    testCase.expect?.fail_closed,
  ]);
  assert.ok(
    expected.includes("soft_denial"),
    "at least one row expects a soft denial",
  );
  assert.ok(
    expected.includes("admitted"),
    "at least one row expects an admission",
  );
  assert.ok(
    expected.includes("internal_error"),
    "at least one row expects an internal error",
  );
  assert.ok(
    CASES.some((testCase) => testCase.deliver === DELIVER_CANCELLED_EXCEPTION),
    "at least one row is delivered as a hand-built cancellation exception",
  );
});

test("every row's expectation follows its own cancellation class", () => {
  // Independent of any runtime: only a genuine condition failure is a soft
  // denial, and every other class (throttle, transaction conflict, ambiguous,
  // transport) follows the configured failOpen policy. A row whose class and
  // expectations disagree would make the table judge a conforming runtime
  // wrongly, so the table is checked against its own classification.
  for (const testCase of CASES) {
    const conditionFailure = testCase.class === "condition_failure";
    assert.equal(
      testCase.expect?.fail_open,
      conditionFailure ? "soft_denial" : "admitted",
      `${testCase.id}: expect.fail_open`,
    );
    assert.equal(
      testCase.expect?.fail_closed,
      conditionFailure ? "soft_denial" : "internal_error",
      `${testCase.id}: expect.fail_closed`,
    );
  }
});

for (const testCase of CASES) {
  for (const policy of POLICIES) {
    test(`limiter multi-window cancellation: ${testCase.id} under ${policy.expectation}`, async () => {
      assertOutcome(testCase, policy, await runCase(policy.failOpen, testCase));
    });
  }
}
