import test from "node:test";
import assert from "node:assert/strict";

import { DynamoJobLedger } from "../dist/index.js";

test("DynamoJobLedger rejects pathological semaphore limits before attempting storage writes", async () => {
  let registerCalls = 0;
  const ledger = new DynamoJobLedger({
    theorydb: {
      register() {
        registerCalls += 1;
      },
    },
  });

  await assert.rejects(
    ledger.acquireSemaphoreSlot({
      scope: "email",
      subject: "customer_1",
      limit: 10_000,
      owner: "worker_a",
      leaseDurationMs: 60_000,
    }),
    (err) => {
      assert.equal(err?.type, "invalid_input");
      assert.match(String(err?.message ?? ""), /limit must be <= 256/);
      return true;
    },
  );

  assert.equal(registerCalls, 1);
});

test("DynamoJobLedger release operations use owner-conditional deletes", async () => {
  const transactWrites = [];
  let deleteCalls = 0;
  const ledger = new DynamoJobLedger({
    theorydb: {
      register() {},
      async transactWrite(actions) {
        transactWrites.push(actions);
      },
      async delete() {
        deleteCalls += 1;
        throw new Error("release must not issue unconditional deletes");
      },
    },
  });

  await ledger.releaseLease({ jobId: "job_1", owner: "worker_a" });
  await ledger.releaseSemaphoreSlot({
    scope: "email",
    subject: "customer_1",
    slot: 2,
    owner: "worker_b",
  });

  assert.equal(deleteCalls, 0);
  assert.equal(transactWrites.length, 2);
  assert.deepEqual(transactWrites[0][0], {
    kind: "delete",
    model: "JobLedgerItem",
    key: { pk: "JOB#job_1", sk: "LOCK" },
    conditionExpression: "#lease_owner = :owner",
    expressionAttributeNames: { "#lease_owner": "lease_owner" },
    expressionAttributeValues: { ":owner": { S: "worker_a" } },
  });
  assert.deepEqual(transactWrites[1][0], {
    kind: "delete",
    model: "JobLedgerItem",
    key: { pk: "SEM#email#customer_1", sk: "SLOT#000000002" },
    conditionExpression: "#lease_owner = :owner",
    expressionAttributeNames: { "#lease_owner": "lease_owner" },
    expressionAttributeValues: { ":owner": { S: "worker_b" } },
  });
});

test("DynamoJobLedger releaseLease preserves owner conflicts", async () => {
  const ledger = new DynamoJobLedger({
    theorydb: {
      register() {},
      async transactWrite() {
        const err = new Error("condition failed");
        err.code = "ErrConditionFailed";
        throw err;
      },
      async get() {
        return { lease_owner: "worker_b" };
      },
    },
  });

  await assert.rejects(
    ledger.releaseLease({ jobId: "job_1", owner: "worker_a" }),
    (err) => {
      assert.equal(err?.type, "conflict");
      assert.match(String(err?.message ?? ""), /lease not owned/);
      return true;
    },
  );
});
