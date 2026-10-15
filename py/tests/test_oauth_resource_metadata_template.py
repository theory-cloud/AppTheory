from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any

from apptheory import (
    RequireBearerTokenOptions,
    protected_resource_www_authenticate,
    require_bearer_token_middleware,
)
from apptheory.context import Context
from apptheory.request import Request

# This file pins the route-parameter template seam of the RFC 9728 challenge to
# the shared cross-runtime table in contract-tests/fixtures/routing/
# mcp-auth-facade/route-challenge.v1.json, so the Go, TypeScript, and Python
# middleware resolve the same rows to the same bytes. Every expectation is read
# from the fixture: an empty or shrunken table fails here rather than passing
# vacuously.

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade"
FIXTURE_NAME = "route-challenge.v1.json"


def _load_fixture() -> dict[str, Any]:
    with (FIXTURE_DIR / FIXTURE_NAME).open(encoding="utf-8") as handle:
        return json.load(handle)


def _request_context(params: dict[str, str]) -> Context:
    return Context(
        request=Request(method="GET", path="/mcp/alpha", headers={}),
        params=dict(params),
    )


def _next_handler(_ctx: Context) -> None:
    raise AssertionError("next handler must not run for a credential-free request")


class RouteChallengeResourceMetadataTemplateTests(unittest.TestCase):
    """Pins the `{param}` template seam of the challenge to the shared table."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.section = _load_fixture()["resource_metadata_template"]

    # _challenge_header drives the real middleware for one credential-free
    # request whose matched route supplies params, mirroring the Go reference's
    # challengeHeaderFor helper, and returns the WWW-Authenticate value.
    def _challenge_header(self, options: RequireBearerTokenOptions, params: dict[str, str]) -> str:
        middleware = require_bearer_token_middleware(options)
        response = middleware(_request_context(params), _next_handler)
        self.assertEqual(401, response.status)
        headers = response.headers["www-authenticate"]
        self.assertEqual(1, len(headers))
        return headers[0]

    def _assert_registration_failure(self, template: str) -> None:
        with self.assertRaises(ValueError) as caught:
            require_bearer_token_middleware(RequireBearerTokenOptions(resource_metadata_url_template=template))
        self.assertIn("invalid ResourceMetadataURLTemplate", str(caught.exception))

    def test_accept_rows_resolve_to_the_matched_route_url(self) -> None:
        accept = self.section["accept"]
        self.assertTrue(accept)
        for row in accept:
            with self.subTest(row=row):
                challenge = self._challenge_header(
                    RequireBearerTokenOptions(resource_metadata_url_template=row["template"]),
                    row["params"],
                )
                self.assertEqual(protected_resource_www_authenticate(row["expect_url"]), challenge)
                self.assertNotIn("{", challenge, "a literal placeholder must never be advertised")

    def test_refused_and_missing_values_fail_closed_to_bare_bearer(self) -> None:
        refused_value = self.section["refused_value"]
        missing_param = self.section["missing_param"]
        self.assertTrue(refused_value)
        self.assertTrue(missing_param)
        for row in [*refused_value, *missing_param]:
            with self.subTest(row=row):
                challenge = self._challenge_header(
                    RequireBearerTokenOptions(resource_metadata_url_template=self.section["template"]),
                    row["params"],
                )
                self.assertEqual("Bearer", challenge)

    def test_malformed_templates_fail_at_registration(self) -> None:
        refused_template = self.section["refused_template"]
        self.assertTrue(refused_template)
        for row in refused_template:
            with self.subTest(row=row):
                self._assert_registration_failure(row["template"])

    def test_precedence_matches_the_shared_fixture(self) -> None:
        precedence = self.section["precedence"]

        func_wins = precedence["func_wins"]
        func_challenge = self._challenge_header(
            RequireBearerTokenOptions(
                resource_metadata_url=func_wins["resource_metadata_url"],
                resource_metadata_url_func=lambda _ctx, value=func_wins["resource_metadata_url_func"]: value,
                resource_metadata_url_template=func_wins["template"],
            ),
            func_wins["params"],
        )
        self.assertEqual(protected_resource_www_authenticate(func_wins["expect_url"]), func_challenge)

        template_wins = precedence["template_wins"]
        template_challenge = self._challenge_header(
            RequireBearerTokenOptions(
                resource_metadata_url=template_wins["resource_metadata_url"],
                resource_metadata_url_template=template_wins["template"],
            ),
            template_wins["params"],
        )
        self.assertEqual(protected_resource_www_authenticate(template_wins["expect_url"]), template_challenge)


if __name__ == "__main__":
    unittest.main()
