import test from "node:test";
import assert from "node:assert/strict";

import { createEMFMetricSink } from "../dist/index.js";

test("EMF request metrics dimension on bounded route and status class", () => {
  const lines = [];
  const sink = createEMFMetricSink({
    write: (line) => lines.push(line),
    clock: () => new Date(25),
  });

  sink.recordMetric({
    name: "apptheory.request",
    value: 1,
    durationMs: 25,
    tags: {
      method: "GET",
      route: "/users/{id}",
      path: "/users/attacker-unique-path",
      status: "200",
      tenant_id: "attacker-tenant",
      error_code: "",
    },
  });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed._aws.CloudWatchMetrics[0].Dimensions, [
    ["service", "method", "route", "status_class", "error_code"],
  ]);
  assert.equal(parsed.route, "/users/{id}");
  assert.equal(parsed.status_class, "2xx");
  assert.equal(parsed.RequestCount, 1);

  // The attacker-selected path and unverified tenant hint must not reach the
  // metric envelope as values or dimensions.
  assert.equal(lines[0].includes("attacker-unique-path"), false);
  assert.equal(lines[0].includes("attacker-tenant"), false);
});

test("EMF request metrics mark an unmatched route without a per-path dimension", () => {
  const lines = [];
  const sink = createEMFMetricSink({ write: (line) => lines.push(line) });

  sink.recordMetric({
    name: "apptheory.request",
    value: 1,
    tags: {
      method: "GET",
      path: "/random/xyz",
      status: "404",
      error_code: "app.not_found",
      tenant_id: "attacker",
    },
  });

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.route, "unmatched");
  assert.equal(parsed.status_class, "4xx");
  assert.equal(lines[0].includes("xyz"), false);
  assert.equal(lines[0].includes("attacker"), false);
});
