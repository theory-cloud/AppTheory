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

# redirect_match, form_parse, method_status, dcr, bound_route, and refresh are
# the sibling groups the same shared table carries. They are executed by
# py/tests/test_mcpfacade_front_channel.py through the real handlers and mounted
# app, not here; the group ledger below keeps a new group from appearing without
# a loader.
REDIRECT_MATCH_GROUP = "redirect_match"
FORM_PARSE_GROUP = "form_parse"
METHOD_STATUS_GROUP = "method_status"
DCR_GROUP = "dcr"
# bound_route pins the registration route binding: a client registered through DCR
# is accepted only at the advertising route it registered at.
BOUND_ROUTE_GROUP = "bound_route"
# refresh pins the brokered refresh grant's contract: single-flight rotation, the
# bounded grace replay, reuse revocation, the scope and resource bindings of a
# refresh request, and the typed refusals.
REFRESH_GROUP = "refresh"
# metadata_registration pins the advertised registration_endpoint to the mounted
# /register route: the routed RFC 8414 document carries the member exactly while
# the front channel or an explicit register handler mounts that route.
METADATA_REGISTRATION_GROUP = "metadata_registration"
# authorize_provider_failure pins the authorize leg's provider-call failure
# class: a failing provider AuthorizationURL builder or a failing app-supplied
# providerHints is the gateway-class 502 upstream_error error page, while 400
# stays the facade's own client-caused vocabulary.
AUTHORIZE_PROVIDER_FAILURE_GROUP = "authorize_provider_failure"
# secure_app_mount is the SecureApp seam's authority table: the posture every
# facade route must declare on a closed-by-default app, the requests that must
# still be refused or served under the application's own principal authority, and
# the equality of the two registrars' route inventories. It is executed by the
# SecureApp seam test, not here; the group ledger below still lists it so a new
# group cannot appear without a loader.
SECURE_APP_MOUNT_GROUP = "secure_app_mount"
FIXTURE_GROUPS = (
    ISSUER_PIN_GROUP,
    REDIRECT_MATCH_GROUP,
    FORM_PARSE_GROUP,
    METHOD_STATUS_GROUP,
    DCR_GROUP,
    BOUND_ROUTE_GROUP,
    REFRESH_GROUP,
    METADATA_REGISTRATION_GROUP,
    AUTHORIZE_PROVIDER_FAILURE_GROUP,
    SECURE_APP_MOUNT_GROUP,
)

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

    def test_fixture_carries_only_the_known_conformance_groups(self) -> None:
        cases = self.fixture["cases"]
        self.assertEqual({case["group"] for case in cases}, set(FIXTURE_GROUPS))
        issuer_pin_cases = [case for case in cases if case["group"] == ISSUER_PIN_GROUP]
        self.assertEqual(len(issuer_pin_cases), ISSUER_PIN_CASE_COUNT)

    def test_issuer_pin_cases(self) -> None:
        cases = [case for case in self.fixture["cases"] if case["group"] == ISSUER_PIN_GROUP]
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
