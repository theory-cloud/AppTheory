import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

import {
  buildKinesisEvent,
  cloudWatchLogsSubscriptionData,
  decodeCloudWatchLogsSubscription,
  kinesisCloudWatchLogsSubscriptionRecord,
} from "../dist/index.js";

const streamArn =
  "arn:aws:kinesis:us-east-1:000000000000:stream/contract-logs-stream";

test("decodeCloudWatchLogsSubscription decodes payload and omits raw messages from safe summary", () => {
  const rawMessage = "contract log line alpha";
  const event = buildKinesisEvent(streamArn, [
    kinesisCloudWatchLogsSubscriptionRecord({
      eventID: "kin-cwl-1",
      partitionKey: "pk-cwl-1",
      subscription: {
        messageType: "DATA_MESSAGE",
        owner: "111122223333",
        logGroup: "/aws/lambda/apptheory-contract",
        logStream: "2026/05/26/[$LATEST]contract-a",
        subscriptionFilters: ["apptheory-contract-filter"],
        logEvents: [
          {
            id: "cwl-event-a1",
            timestamp: 1779806400000,
            message: rawMessage,
          },
          {
            id: "cwl-event-a2",
            timestamp: 1779806401000,
            message: "contract log line beta",
          },
        ],
      },
    }),
  ]);

  const decoded = decodeCloudWatchLogsSubscription(event.Records[0]);

  assert.equal(decoded.record_id, "kin-cwl-1");
  assert.equal(decoded.message_type, "DATA_MESSAGE");
  assert.equal(decoded.owner, "111122223333");
  assert.equal(decoded.log_group, "/aws/lambda/apptheory-contract");
  assert.equal(decoded.log_stream, "2026/05/26/[$LATEST]contract-a");
  assert.deepEqual(decoded.subscription_filters, [
    "apptheory-contract-filter",
  ]);
  assert.deepEqual(decoded.log_events, [
    {
      id: "cwl-event-a1",
      timestamp: 1779806400000,
      message: rawMessage,
    },
    {
      id: "cwl-event-a2",
      timestamp: 1779806401000,
      message: "contract log line beta",
    },
  ]);
  assert.deepEqual(decoded.safe_summary, {
    record_id: "kin-cwl-1",
    message_type: "DATA_MESSAGE",
    owner: "111122223333",
    log_group: "/aws/lambda/apptheory-contract",
    log_stream: "2026/05/26/[$LATEST]contract-a",
    subscription_filter_count: 1,
    log_event_count: 2,
    safe_log:
      "record_id=kin-cwl-1 owner=111122223333 " +
      "log_group=/aws/lambda/apptheory-contract " +
      "log_stream=2026/05/26/[$LATEST]contract-a " +
      "message_type=DATA_MESSAGE log_events=2 subscription_filters=1",
  });

  const safeSummaryJson = JSON.stringify(decoded.safe_summary);
  assert.equal(safeSummaryJson.includes(rawMessage), false);
  assert.equal(safeSummaryJson.includes("contract log line beta"), false);
});

test("decodeCloudWatchLogsSubscription failures do not leak raw payload data", () => {
  const secret = "do-not-log-customer-message";

  assert.throws(
    () =>
      decodeCloudWatchLogsSubscription({
        eventID: "kin-cwl-bad",
        kinesis: {
          data: Buffer.from(`{"message":"${secret}"}`).toString("base64"),
        },
      }),
    (error) => {
      assert.match(String(error?.message ?? ""), /invalid payload/);
      assert.equal(String(error?.message ?? "").includes(secret), false);
      return true;
    },
  );

  assert.throws(
    () =>
      decodeCloudWatchLogsSubscription({
        eventID: "kin-cwl-missing",
        kinesis: {
          data: gzipPayload({
            messageType: "DATA_MESSAGE",
            logEvents: [{ id: "cwl-event-a1", message: secret }],
          }).toString("base64"),
        },
      }),
    (error) => {
      assert.match(String(error?.message ?? ""), /missing owner, logGroup/);
      assert.equal(String(error?.message ?? "").includes(secret), false);
      return true;
    },
  );
});

test("cloudWatchLogsSubscriptionData builds synthetic payloads that decode through runtime", () => {
  const event = buildKinesisEvent(streamArn, [
    {
      eventID: "kin-cwl-data",
      data: cloudWatchLogsSubscriptionData({
        logEvents: [
          {
            id: "cwl-event-custom",
            timestamp: 42,
            message: "custom test line",
          },
        ],
      }),
    },
  ]);

  const decoded = decodeCloudWatchLogsSubscription(event.Records[0]);

  assert.equal(decoded.record_id, "kin-cwl-data");
  assert.equal(decoded.message_type, "DATA_MESSAGE");
  assert.equal(decoded.owner, "000000000000");
  assert.equal(decoded.log_group, "/aws/lambda/apptheory-test");
  assert.equal(decoded.log_stream, "1970/01/01/[$LATEST]apptheory-test");
  assert.deepEqual(decoded.subscription_filters, ["apptheory-test-filter"]);
  assert.deepEqual(decoded.log_events, [
    {
      id: "cwl-event-custom",
      timestamp: 42,
      message: "custom test line",
    },
  ]);
  assert.equal(decoded.safe_summary.log_event_count, 1);
});

function gzipPayload(value) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}
