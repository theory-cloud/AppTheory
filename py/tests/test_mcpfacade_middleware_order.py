"""Runtime-bearer ordering for the MCP facade transport routes.

The Go suite in ``runtime/mcpfacade`` and the TypeScript suite in ``ts/test``
read the same ``facade-middleware-order.v1.json`` rows: the route-level bearer
guard must run before application middleware, so a short-circuiting cache or a
write-performing pass-through middleware cannot observe a credential-free
request. Policy rows pin that the pre-authorization PolicyHook keeps running
before the bearer guard.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from apptheory import (
    BearerTokenRecord,
    FacadeConfig,
    PolicyDecision,
    RequireBearerTokenOptions,
    SecureApp,
    bearer_token_claims_from_context,
    create_app,
    new_memory_bearer_token_validator,
    register_mcp_facade,
    register_mcp_facade_secure,
)
from apptheory.mcproutes import EndpointPath
from apptheory.request import Request
from apptheory.response import Response

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = (
    REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "mcp-auth-facade" / "facade-middleware-order.v1.json"
)

GROUP = "middleware_order"
CASE_COUNT = 16


def _response(status: int, body: str = "") -> Response:
    return Response(status=status, headers={}, cookies=[], body=body.encode("utf-8"), is_base64=False)


def _request(method: str, path: str, headers: dict[str, list[str]] | None = None) -> Request:
    return Request(method=method, path=path, headers=dict(headers or {}), query={}, body=b"", is_base64=False)


def _header(headers: dict[str, list[str]], name: str) -> str:
    for key, values in headers.items():
        if str(key).lower() == name.lower():
            return values[0] if values else ""
    return ""


def _headers_for(mount: dict[str, object], credential: str) -> dict[str, list[str]]:
    if credential == "missing":
        return {}
    token = mount["invalid_token"] if credential == "invalid" else mount["valid_token"]
    return {"authorization": [f"Bearer {token}"]}


def _record_claims(ctx, recorder: dict[str, object]) -> None:
    claims = bearer_token_claims_from_context(ctx)
    if claims is None:
        return
    recorder["claimsSeen"] = True
    recorder["claimsSubject"] = claims.subject
    recorder["claimsScopes"] = list(claims.scopes)


def _middleware(name: str, recorder: dict[str, object]):
    if name == "short_circuit_cache":

        def short_circuit(ctx, _next):
            recorder["middlewareInvocations"] += 1
            recorder["cacheLookups"] += 1
            recorder["order"].append("middleware")
            _record_claims(ctx, recorder)
            return _response(200, "cached-protected")

        return short_circuit

    if name == "pass_through_writer":

        def pass_through(ctx, next_handler):
            recorder["middlewareInvocations"] += 1
            recorder["middlewareWrites"] += 1
            recorder["order"].append("middleware")
            _record_claims(ctx, recorder)
            return next_handler(ctx)

        return pass_through

    raise AssertionError(f"unknown middleware_order middleware {name}")


def _policy(name: str, recorder: dict[str, object]):
    if name == "allow":

        def allow(_ctx):
            recorder["policyInvocations"] += 1
            recorder["order"].append("policy")
            return None

        return allow

    if name == "deny":

        def deny(_ctx):
            recorder["policyInvocations"] += 1
            recorder["order"].append("policy")
            return PolicyDecision(code="app.rate_limited", message="rate limited")

        return deny

    return None


def _config(mount: dict[str, object], recorder: dict[str, object]) -> FacadeConfig:
    claims_validator = new_memory_bearer_token_validator(
        [
            BearerTokenRecord(
                token=str(mount["valid_token"]),
                subject=str(mount["subject"]),
                audience=str(mount["audience"]),
                scopes=list(mount["scopes"]["namespace"]),
            )
        ]
    )

    def record_and_validate(ctx, token):
        recorder["order"].append("bearer")
        return claims_validator(ctx, token)

    return FacadeConfig(
        issuer_url=str(mount["issuer_url"]),
        jwks_uri=str(mount["jwks_uri"]),
        url_mode="public_base_url",
        public_base_url=str(mount["public_base_url"]),
        scopes={key: list(value) for key, value in mount["scopes"].items()},
        mcp_handler=lambda _ctx: _handler(recorder),
        transport_posture="runtime-bearer",
        require_bearer_token=RequireBearerTokenOptions(
            resource_metadata_url=str(mount["resource_metadata_url"]),
            claims_validator=record_and_validate,
        ),
    )


def _handler(recorder: dict[str, object]) -> Response:
    recorder["handlerInvocations"] += 1
    recorder["order"].append("handler")
    return _response(204)


class MiddlewareOrderConformanceTest(unittest.TestCase):
    def setUp(self) -> None:
        document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.mount = document["mount"]
        self.cases = [case for case in document["cases"] if case.get("group") == GROUP]
        self.assertEqual(CASE_COUNT, len(self.cases))
        self.assertEqual("valid-token", self.mount["valid_token"])
        self.path = EndpointPath(kind="namespace", client_namespace=str(self.mount["client_namespace"])).mcp_path()

    def test_runtime_bearer_guard_runs_before_application_middleware(self) -> None:
        for case in self.cases:
            for method in case["methods"]:
                with self.subTest(case=case["id"], method=method):
                    self._run_case(case, method)

    def _run_case(self, case: dict[str, object], method: str) -> None:
        recorder: dict[str, object] = {
            "order": [],
            "middlewareInvocations": 0,
            "cacheLookups": 0,
            "middlewareWrites": 0,
            "handlerInvocations": 0,
            "policyInvocations": 0,
            "claimsSeen": False,
            "claimsSubject": "",
            "claimsScopes": [],
        }
        config = _config(self.mount, recorder)
        middleware = _middleware(str(case["middleware"]), recorder)

        surface = case["surface"]
        if surface == "plain":
            app = create_app(tier=str(case["tier"]))
            app.use(middleware)
            register_mcp_facade(app, config)
        elif surface == "secure":
            app = SecureApp(tier=str(case["tier"]), policy_hook=_policy(str(case["policy"]), recorder))
            app.use(middleware)
            register_mcp_facade_secure(app, config)
        else:
            raise AssertionError(f"unknown middleware_order surface {surface}")

        actual = app.serve(_request(method, self.path, _headers_for(self.mount, str(case["credential"]))))
        expected = case["expect"]

        self.assertEqual(expected["status"], actual.status)
        if "www_authenticate" in expected:
            self.assertEqual(expected["www_authenticate"], _header(actual.headers, "www-authenticate"))
        self.assertEqual(expected["order"], recorder["order"])
        self.assertEqual(expected["middleware_invocations"], recorder["middlewareInvocations"])
        self.assertEqual(expected["cache_lookups"], recorder["cacheLookups"])
        self.assertEqual(expected["middleware_writes"], recorder["middlewareWrites"])
        self.assertEqual(expected["handler_invocations"], recorder["handlerInvocations"])
        self.assertEqual(expected["policy_hook_invocations"], recorder["policyInvocations"])
        if case["credential"] == "valid" and case["policy"] != "deny":
            self.assertTrue(recorder["claimsSeen"])
            self.assertEqual(self.mount["subject"], recorder["claimsSubject"])
            self.assertEqual(self.mount["scopes"]["namespace"], recorder["claimsScopes"])
        else:
            self.assertFalse(recorder["claimsSeen"])
        if "body" in expected:
            self.assertEqual(expected["body"], actual.body.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
