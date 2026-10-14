from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from apptheory.oauth import canonicalize_issuer_url

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"
FIXTURE_NAME = "facade-conformance.v1.json"

ISSUER_PIN_GROUP = "issuer_pin"

# The number of issuer_pin rows the shared table must carry; a change to the
# table must also be a deliberate edit here and in the Go and TypeScript loaders,
# so no runtime can silently execute a smaller table.
ISSUER_PIN_CASE_COUNT = 27


def _load_fixture() -> dict[str, Any]:
    with (FIXTURE_DIR / FIXTURE_NAME).open("r", encoding="utf-8") as handle:
        return json.load(handle)


class IssuerPinConformanceTests(unittest.TestCase):
    """Pins the RFC 9207 ``iss`` check to the shared cross-runtime table.

    A row matches exactly when both the configured and the claimed value
    canonicalize and the canonical forms are byte-equal, so the host-case and
    fragment rows fail closed on a canonicalizer that lowercases the host
    (WHATWG URL) or drops the fragment (urllib).
    """

    fixture = _load_fixture()

    def test_fixture_carries_only_issuer_pin_rows(self) -> None:
        cases = self.fixture["cases"]
        self.assertEqual({case["group"] for case in cases}, {ISSUER_PIN_GROUP})
        self.assertEqual(len(cases), ISSUER_PIN_CASE_COUNT)

    def test_issuer_pin_cases(self) -> None:
        cases = self.fixture["cases"]
        executed = 0
        for case in cases:
            with self.subTest(case=case["id"]):
                self._run_case(case)
                executed += 1
        print(f"issuer pin conformance: {executed} cases run")
        self.assertEqual(executed, ISSUER_PIN_CASE_COUNT)

    def _run_case(self, case: dict[str, Any]) -> None:
        expect = case["expect"]
        self.assertIn(expect, ("match", "mismatch"))
        configured = canonicalize_issuer_url(case["configured"])
        claimed = canonicalize_issuer_url(case["claimed"])
        matched = configured is not None and claimed is not None and configured == claimed
        self.assertEqual(
            matched,
            expect == "match",
            f"configured {case['configured']!r} -> {configured!r}, claimed {case['claimed']!r} -> {claimed!r}",
        )


if __name__ == "__main__":
    unittest.main()
