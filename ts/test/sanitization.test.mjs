import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeFieldValue } from "../dist/index.js";

test("sanitizeFieldValue redacts authorization identifiers and token-like keys", () => {
  assert.equal(sanitizeFieldValue("authorization_id", "auth_123"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("authorizationId", "auth_123"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("session_token", "tok_123"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("csrfToken", "tok_123"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("authorizationToken", "tok_123"), "[REDACTED]");
  assert.equal(sanitizeFieldValue("sessionSecret", "sec_123"), "[REDACTED]");
});

test("sanitizeFieldValue preserves business keys while masking known sensitive aliases", () => {
  assert.equal(sanitizeFieldValue("authorizationCode", "ok_1"), "ok_1");
  assert.equal(sanitizeFieldValue("tokenization_method", "apple_pay"), "apple_pay");
  assert.equal(sanitizeFieldValue("mid", "mid_1"), "mid_1");
  assert.equal(sanitizeFieldValue("acceptorId", "acceptor_1"), "acceptor_1");
});

