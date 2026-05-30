import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  createKinesisJsonRecord,
  reportKinesisPutRecordsFailures,
} from "../dist/index.js";

test("createKinesisJsonRecord encodes deterministic payload bytes and safe summary", () => {
  const record = createKinesisJsonRecord({
    partitionKey: " tenant#1 ",
    explicitHashKey: "0007",
    payload: {
      b: 2,
      a: {
        z: "<ok>&",
        m: [true, null],
      },
    },
  });

  assert.equal(
    Buffer.from(record.data).toString("utf8"),
    '{"a":{"m":[true,null],"z":"<ok>&"},"b":2}',
  );
  assert.equal(record.partition_key, "tenant#1");
  assert.equal(record.explicit_hash_key, "7");
  assert.equal(record.safe_summary.data_byte_length, record.data.byteLength);

  const summaryJson = JSON.stringify(record.safe_summary);
  for (const forbidden of ["<ok>&", '"b":2', "true"]) {
    assert.equal(summaryJson.includes(forbidden), false);
    assert.equal(record.safe_summary.safe_log.includes(forbidden), false);
  }
});

test("createKinesisJsonRecord sanitizes unsafe partition keys in safe_log", () => {
  const partitionKey = "tenant\nforged=true\rcontrol=\u001f key=value\tpercent%";
  const record = createKinesisJsonRecord({
    partitionKey,
    payload: { ok: true },
  });

  assert.equal(record.partition_key, partitionKey);
  assertSafeLogCannotForgeFields(record.safe_summary.safe_log);
  assert.equal(
    record.safe_summary.safe_log.includes(
      "partition_key=tenant%0Aforged%3Dtrue%0Dcontrol%3D%1F%20key%3Dvalue%09percent%25",
    ),
    true,
  );
});

test("createKinesisJsonRecord fails closed for invalid inputs", () => {
  assert.throws(
    () => createKinesisJsonRecord({ partitionKey: "", payload: { ok: true } }),
    /partition key is required/,
  );
  assert.throws(
    () =>
      createKinesisJsonRecord({
        partitionKey: "pk-1",
        explicitHashKey: "not-decimal",
        payload: { ok: true },
      }),
    /explicit hash key must be decimal digits/,
  );
  assert.throws(
    () =>
      createKinesisJsonRecord({
        partitionKey: "pk-1",
        payload: { bad: Number.POSITIVE_INFINITY },
      }),
    /non-finite number/,
  );
});

test("reportKinesisPutRecordsFailures aligns failures and omits payload bodies", () => {
  const first = createKinesisJsonRecord({
    partitionKey: "pk-1",
    payload: { customer: "alpha" },
  });
  const second = createKinesisJsonRecord({
    partitionKey: "pk-2",
    explicitHashKey: "9",
    payload: { customer: "bravo" },
  });

  const report = reportKinesisPutRecordsFailures(
    [first, second],
    [
      { sequence_number: "1", shard_id: "shardId-000000000000" },
      {
        error_code: "ProvisionedThroughputExceededException",
        error_message: 'failed payload {"customer":"bravo"}',
      },
    ],
  );

  assert.equal(report.record_count, 2);
  assert.equal(report.failed_record_count, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].index, 1);
  assert.equal(report.failures[0].partition_key, "pk-2");
  assert.equal(report.failures[0].explicit_hash_key, "9");
  assert.equal(report.failures[0].error_message_present, true);
  assert.equal(report.failures[0].error_message_byte_length > 0, true);

  const reportJson = JSON.stringify(report);
  for (const forbidden of ["alpha", "bravo", "customer", "failed payload"]) {
    assert.equal(reportJson.includes(forbidden), false);
  }
  assert.equal(
    report.safe_summary.safe_log.includes("failed_record_count=1"),
    true,
  );
});

test("reportKinesisPutRecordsFailures sanitizes partition keys in failure safe_log", () => {
  const record = createKinesisJsonRecord({
    partitionKey: "tenant\nerror_code=ForgedException key=value",
    payload: { ok: true },
  });

  const report = reportKinesisPutRecordsFailures(
    [record],
    [{ error_code: "ProvisionedThroughputExceededException" }],
  );

  assert.equal(report.failures.length, 1);
  const safeLog = report.failures[0].safe_log;
  assertSafeLogCannotForgeFields(safeLog);
  assert.equal(safeLog.includes("error_code=ForgedException"), false);
  assert.equal(safeLog.includes("%0Aerror_code%3D"), true);
});

test("reportKinesisPutRecordsFailures fails closed for shape drift", () => {
  const record = createKinesisJsonRecord({
    partitionKey: "pk-1",
    payload: { ok: true },
  });

  assert.throws(
    () => reportKinesisPutRecordsFailures([record], []),
    /records\/results length mismatch/,
  );
  assert.throws(
    () =>
      reportKinesisPutRecordsFailures([record], [
        { error_message: "message without code" },
      ]),
    /error message without error code/,
  );
});

function assertSafeLogCannotForgeFields(safeLog) {
  for (const forbidden of [
    "\n",
    "\r",
    "\t",
    "\u001f",
    " forged=",
    " key=value",
  ]) {
    assert.equal(
      safeLog.includes(forbidden),
      false,
      `safe_log permits forged delimiter or field ${JSON.stringify(forbidden)}: ${safeLog}`,
    );
  }
}
