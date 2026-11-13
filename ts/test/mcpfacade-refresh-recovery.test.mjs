import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isPerRequestTokenVerdict,
  isTerminalTokenVerdict,
  terminalTokenVerdictCodes,
} from "../dist/oauth/provider.js";

// The vendored theorycloud_refresh_rotation_recovery.v0.1 corpus (Factory
// contract, plan gate docs/133/134/135). The documents are copied verbatim; see
// the directory's PROVENANCE.md. This port implements the contract's rule checks
// plus the facade-side rule (R7) against the runtime's own terminal taxonomy.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(
  HERE,
  "..",
  "..",
  "contract-tests",
  "conformance",
  "refresh-rotation-recovery-v0.1",
);

const MINT_ACTIONS = new Set(["rotate", "rescue_mint"]);
const FAIL_CLOSED_WIRES = new Set([
  "temporarily_unavailable_503",
  "replay_budget_exhausted_503",
]);
const TRANSIENT_WIRES = FAIL_CLOSED_WIRES;
const R5_TRIGGERS = new Set(["out_of_window_replay", "containment", "explicit"]);

class Violation extends Error {
  constructor(rule, detail) {
    super(`${rule}: ${detail}`);
    this.rule = rule;
  }
}

function requireRule(rule, ok, detail) {
  if (!ok) throw new Violation(rule, detail);
}

function checkFixture(fixture) {
  const cfg = fixture.stage_config;
  const events = fixture.scenario;
  const exp = fixture.expect;

  for (let index = 1; index < events.length; index += 1) {
    requireRule(
      "FX",
      events[index].t_offset_seconds >= events[index - 1].t_offset_seconds,
      "scenario t_offset_seconds must be non-decreasing",
    );
  }

  // R1 — chain continuity.
  for (const event of events) {
    if (!MINT_ACTIONS.has(event.action)) continue;
    requireRule(
      "R1",
      "minted" in event,
      `${event.action} at t=${event.t_offset_seconds} does not declare minted`,
    );
    if (event.minted) {
      requireRule(
        "R1",
        event.artifact_atomic === true,
        `${event.action} minted ${event.successor} without the artifact in the same transaction`,
      );
      requireRule(
        "R1",
        event.generation !== event.successor,
        `${event.action} minted a successor identical to the consumed generation`,
      );
    } else {
      requireRule(
        "R1",
        FAIL_CLOSED_WIRES.has(event.wire),
        `${event.action} failed closed with wire ${event.wire}, expected a transient 503 before minting`,
      );
    }
  }

  // R2 — one rescue mint per generation.
  const rescues = new Set();
  for (const event of events) {
    if (event.action !== "rescue_mint" || !event.minted) continue;
    requireRule(
      "R2",
      !rescues.has(event.generation),
      "more than one rescue mint for a generation",
    );
    rescues.add(event.generation);
  }

  // R3 — the serve window derives from measured recovery latency.
  requireRule(
    "R3",
    (cfg.window_source ?? "measured_recovery_latency") !== "steward_sleep",
    "serve window derived from steward sleep duration",
  );
  const gMin = cfg.refresh_due_fraction * cfg.access_token_ttl_seconds;
  requireRule("R3", gMin < cfg.serve_window_seconds, `g_min ${gMin}s is not below the serve window`);

  // R4 — the generation bound is a hop budget, never a revocation predicate.
  const required = Math.ceil(cfg.serve_window_seconds / gMin) * cfg.margin;
  requireRule(
    "R4",
    cfg.generation_bound >= required,
    `generation_bound ${cfg.generation_bound} < ceil(W/g_min) x margin = ${required}`,
  );
  for (const event of events) {
    if (event.action === "revoke") {
      requireRule("R4", event.reason !== "count_exceeded", "generation count used as a revocation predicate");
    }
  }

  // R5 — the revocation triggers are exhaustive.
  for (const event of events) {
    if (event.action !== "revoke") continue;
    requireRule(
      "R5",
      R5_TRIGGERS.has(event.reason),
      `revocation trigger ${event.reason} is not one of the permitted triggers`,
    );
  }

  // R6 — the verdict transport.
  let revoked = false;
  for (const event of events) {
    if (event.action === "revoke" || event.action === "family_kill") revoked = true;
    if (event.action === "present" && event.wire === "invalid_grant") {
      requireRule(
        "R6",
        event.in_window === false || revoked,
        "recovery-available staleness answered with terminal invalid_grant",
      );
    }
  }

  // R7 — only a contract-terminal verdict may family-kill, checked through the
  // runtime's own taxonomy so the banned per-request case is impossible.
  for (const event of events) {
    if (event.action !== "family_kill") continue;
    requireRule(
      "R7",
      isTerminalTokenVerdict(event.trigger_error),
      `facade family-kill on non-terminal error ${event.trigger_error}`,
    );
  }

  // R8 — every revocation emits a receipt.
  const revocations = events.filter(
    (event) => event.action === "revoke" || event.action === "family_kill",
  ).length;
  requireRule("R8", exp.receipt_emitted === revocations > 0, "receipt_emitted does not match the revocation events");

  // FX — the expectation block must agree with the trace.
  requireRule("FX", exp.family_revoked === revocations > 0, "family_revoked does not match the revocation events");
  const terminal = events.some((event) => event.action === "present" && event.wire === "invalid_grant");
  requireRule(
    "FX",
    (exp.terminal_wire_error === "invalid_grant") === terminal,
    "terminal_wire_error does not match present events",
  );
  const transients = new Set(
    events.map((event) => event.wire).filter((wire) => TRANSIENT_WIRES.has(wire)),
  );
  requireRule("FX", transients.size <= 1, `mixed transient wires ${[...transients]}; keep one per fixture`);
  const expectedTransient = transients.size === 0 ? "none" : [...transients][0];
  requireRule("FX", exp.transient_wire === expectedTransient, "transient_wire does not match the trace");
  const walked = events.some((event) => event.action === "present" && event.recovery === "walk_serve");
  requireRule("FX", (exp.recovery === "walk_serve") === walked, "recovery does not match walk-serve events");
}

function loadCorpus(kind) {
  const directory = join(CORPUS, "fixtures", kind);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

test("the vendored refresh-rotation-recovery corpus is complete", () => {
  assert.equal(loadCorpus("valid").length, 6);
  assert.equal(loadCorpus("invalid").length, 8);
});

test("every valid fixture conforms and every invalid one fails with its declared rule", () => {
  const seen = new Set();
  for (const kind of ["valid", "invalid"]) {
    for (const fixture of loadCorpus(kind)) {
      const label = `${kind}/${fixture.case_id}`;
      assert.equal(fixture.contract, "theorycloud_refresh_rotation_recovery.v0.1", label);
      assert.equal(fixture.case_id, fixture.case_id.trim(), label);
      assert.equal(seen.has(fixture.case_id), false, `duplicate case_id ${fixture.case_id}`);
      seen.add(fixture.case_id);
      assert.equal(
        fixture.expected_outcome,
        kind === "valid" ? "conformant" : "nonconformant",
        label,
      );
      if (kind === "valid") {
        assert.equal(fixture.expected_violation, undefined, label);
        assert.doesNotThrow(() => checkFixture(fixture), label);
        continue;
      }
      assert.ok(fixture.expected_violation, label);
      let thrown = null;
      try {
        checkFixture(fixture);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Violation, `${label} must violate a rule`);
      assert.equal(thrown.rule, fixture.expected_violation, `${label}: ${thrown.message}`);
    }
  }
  assert.equal(seen.size, 14);
});

test("the runtime's terminal taxonomy matches the contract's R7 set", () => {
  assert.deepEqual(terminalTokenVerdictCodes(), ["invalid_grant"]);
  for (const code of terminalTokenVerdictCodes()) {
    assert.equal(isTerminalTokenVerdict(code), true, code);
    assert.equal(isPerRequestTokenVerdict(code), false, code);
  }
  for (const code of [
    "invalid_scope",
    "invalid_request",
    "access_denied",
    "expired_token",
    "invalid_token",
    "invalid_client",
    "unauthorized_client",
    "reauth_required",
    "temporarily_unavailable",
    "something_new",
  ]) {
    assert.equal(isTerminalTokenVerdict(code), false, `${code} must not be a family verdict`);
  }
  for (const code of [
    "invalid_scope",
    "invalid_request",
    "access_denied",
    "expired_token",
    "invalid_token",
    "invalid_client",
    "unauthorized_client",
  ]) {
    assert.equal(isPerRequestTokenVerdict(code), true, code);
  }
});
