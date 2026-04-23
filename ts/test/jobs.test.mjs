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
