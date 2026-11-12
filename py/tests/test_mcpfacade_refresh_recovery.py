"""Consume the vendored theorycloud_refresh_rotation_recovery.v0.1 corpus.

The documents are copied verbatim from the Factory contract (plan gate
docs/133/134/135); see the directory's PROVENANCE.md. This port implements the
contract's rule checks plus the facade-side rule (R7) against the runtime's own
terminal taxonomy, in both directions.
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path
from typing import Any

from apptheory.oauth.autheory import (
    is_per_request_token_verdict,
    is_terminal_token_verdict,
    terminal_token_verdict_codes,
)

CORPUS = (
    Path(__file__).resolve().parents[2]
    / "contract-tests"
    / "conformance"
    / "refresh-rotation-recovery-v0.1"
)

MINT_ACTIONS = {"rotate", "rescue_mint"}
FAIL_CLOSED_WIRES = {"temporarily_unavailable_503", "replay_budget_exhausted_503"}
TRANSIENT_WIRES = FAIL_CLOSED_WIRES
R5_TRIGGERS = {"out_of_window_replay", "containment", "explicit"}


class Violation(Exception):
    def __init__(self, rule: str, detail: str) -> None:
        super().__init__(f"{rule}: {detail}")
        self.rule = rule


def require_rule(rule: str, ok: bool, detail: str) -> None:
    if not ok:
        raise Violation(rule, detail)


def check_fixture(fixture: dict[str, Any]) -> None:
    cfg = fixture["stage_config"]
    events = fixture["scenario"]
    exp = fixture["expect"]

    offsets = [event["t_offset_seconds"] for event in events]
    require_rule("FX", offsets == sorted(offsets), "scenario t_offset_seconds must be non-decreasing")

    # R1 — chain continuity.
    for event in events:
        if event["action"] not in MINT_ACTIONS:
            continue
        require_rule(
            "R1",
            "minted" in event,
            f"{event['action']} at t={event['t_offset_seconds']} does not declare minted",
        )
        if event["minted"]:
            require_rule(
                "R1",
                event.get("artifact_atomic") is True,
                f"{event['action']} minted {event.get('successor')} without the artifact in the same transaction",
            )
            require_rule(
                "R1",
                event.get("generation") != event.get("successor"),
                f"{event['action']} minted a successor identical to the consumed generation",
            )
        else:
            require_rule(
                "R1",
                event.get("wire") in FAIL_CLOSED_WIRES,
                f"{event['action']} failed closed with wire {event.get('wire')!r}, expected a transient 503",
            )

    # R2 — one rescue mint per generation.
    minted_rescues = [event["generation"] for event in events if event["action"] == "rescue_mint" and event.get("minted")]
    require_rule("R2", len(minted_rescues) == len(set(minted_rescues)), "more than one rescue mint for a generation")

    # R3 — the serve window derives from measured recovery latency.
    require_rule(
        "R3",
        cfg.get("window_source", "measured_recovery_latency") != "steward_sleep",
        "serve window derived from steward sleep duration",
    )
    g_min = cfg["refresh_due_fraction"] * cfg["access_token_ttl_seconds"]
    require_rule("R3", g_min < cfg["serve_window_seconds"], f"g_min {g_min}s is not below the serve window")

    # R4 — the generation bound is a hop budget, never a revocation predicate.
    n_min = math.ceil(cfg["serve_window_seconds"] / g_min) * cfg["margin"]
    require_rule(
        "R4",
        cfg["generation_bound"] >= n_min,
        f"generation_bound {cfg['generation_bound']} < ceil(W/g_min) x margin = {n_min}",
    )
    for event in events:
        if event["action"] == "revoke":
            require_rule("R4", event.get("reason") != "count_exceeded", "generation count used as a revocation predicate")

    # R5 — the revocation triggers are exhaustive.
    for event in events:
        if event["action"] == "revoke":
            require_rule(
                "R5",
                event.get("reason") in R5_TRIGGERS,
                f"revocation trigger {event.get('reason')!r} is not one of {sorted(R5_TRIGGERS)}",
            )

    # R6 — the verdict transport.
    revoked = False
    for event in events:
        if event["action"] in ("revoke", "family_kill"):
            revoked = True
        if event["action"] == "present" and event.get("wire") == "invalid_grant":
            require_rule(
                "R6",
                event.get("in_window") is False or revoked,
                "recovery-available staleness answered with terminal invalid_grant",
            )

    # R7 — only a contract-terminal verdict may family-kill, checked through the
    # runtime's own taxonomy so the banned per-request case is impossible.
    for event in events:
        if event["action"] == "family_kill":
            require_rule(
                "R7",
                is_terminal_token_verdict(str(event.get("trigger_error") or "")),
                f"facade family-kill on non-terminal error {event.get('trigger_error')!r}",
            )

    # R8 — every revocation emits a receipt.
    revocations = [event for event in events if event["action"] in ("revoke", "family_kill")]
    require_rule(
        "R8",
        exp["receipt_emitted"] == bool(revocations),
        "receipt_emitted does not match the revocation events",
    )

    # FX — the expectation block must agree with the trace.
    require_rule("FX", exp["family_revoked"] == bool(revocations), "family_revoked does not match the revocation events")
    terminal = any(event["action"] == "present" and event.get("wire") == "invalid_grant" for event in events)
    require_rule(
        "FX",
        (exp["terminal_wire_error"] == "invalid_grant") == terminal,
        "terminal_wire_error does not match present events",
    )
    transients = {event["wire"] for event in events if event.get("wire") in TRANSIENT_WIRES}
    require_rule("FX", len(transients) <= 1, f"mixed transient wires {sorted(transients)}; keep one per fixture")
    expected_transient = transients.pop() if transients else "none"
    require_rule("FX", exp["transient_wire"] == expected_transient, "transient_wire does not match the trace")
    walked = any(event["action"] == "present" and event.get("recovery") == "walk_serve" for event in events)
    require_rule("FX", (exp["recovery"] == "walk_serve") == walked, "recovery does not match walk-serve events")


def load_corpus(kind: str) -> list[dict[str, Any]]:
    directory = CORPUS / "fixtures" / kind
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))]


class RefreshRotationRecoveryContractTests(unittest.TestCase):
    def test_corpus_is_complete(self) -> None:
        self.assertEqual(len(load_corpus("valid")), 6)
        self.assertEqual(len(load_corpus("invalid")), 8)

    def test_every_fixture_gets_its_declared_verdict(self) -> None:
        seen: set[str] = set()
        for kind in ("valid", "invalid"):
            for fixture in load_corpus(kind):
                label = f"{kind}/{fixture['case_id']}"
                with self.subTest(case=label):
                    self.assertEqual(fixture["contract"], "theorycloud_refresh_rotation_recovery.v0.1")
                    self.assertNotIn(fixture["case_id"], seen, f"duplicate case_id {fixture['case_id']}")
                    seen.add(fixture["case_id"])
                    self.assertEqual(
                        fixture["expected_outcome"],
                        "conformant" if kind == "valid" else "nonconformant",
                    )
                    if kind == "valid":
                        self.assertNotIn("expected_violation", fixture)
                        check_fixture(fixture)
                        continue
                    expected = fixture["expected_violation"]
                    with self.assertRaises(Violation) as caught:
                        check_fixture(fixture)
                    self.assertEqual(expected, caught.exception.rule, str(caught.exception))
        self.assertEqual(len(seen), 14)

    def test_terminal_taxonomy_matches_the_contract(self) -> None:
        self.assertEqual(terminal_token_verdict_codes(), ("invalid_grant",))
        for code in terminal_token_verdict_codes():
            self.assertTrue(is_terminal_token_verdict(code))
            self.assertFalse(is_per_request_token_verdict(code))
        for code in (
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
        ):
            self.assertFalse(is_terminal_token_verdict(code), code)
        for code in (
            "invalid_scope",
            "invalid_request",
            "access_denied",
            "expired_token",
            "invalid_token",
            "invalid_client",
            "unauthorized_client",
        ):
            self.assertTrue(is_per_request_token_verdict(code), code)


if __name__ == "__main__":
    unittest.main()
