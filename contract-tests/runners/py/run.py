#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

_APPTHEORY_RUNTIME: Any | None = None
CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER = "kinesis_require_cloudwatch_logs_subscription"
CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER = "apptheory: cloudwatch logs subscription decoder helper missing"


@dataclass
class CanonicalRequest:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, list[str]]
    cookies: dict[str, str]
    body: bytes
    is_base64: bool
    path_params: dict[str, str]
    request_id: str
    tenant_id: str
    auth_identity: str
    remaining_ms: int
    middleware_trace: list[str]


@dataclass(frozen=True)
class CanonicalResponse:
    status: int
    headers: dict[str, list[str]]
    cookies: list[str]
    body: bytes
    is_base64: bool
    chunks: list[bytes] = field(default_factory=list)
    stream_error_code: str = ""


class AppError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False)


def list_fixture_files(fixtures_root: Path) -> list[Path]:
    files: list[Path] = []
    for tier in ("p0", "p1", "p2", "m1", "m2", "m3", "m12", "m14", "m15", "m16"):
        tier_dir = fixtures_root / tier
        if not tier_dir.exists():
            continue
        files.extend(sorted(tier_dir.glob("*.json")))
    return sorted(files)


def load_fixtures(fixtures_root: Path) -> list[dict[str, Any]]:
    files = list_fixture_files(fixtures_root)
    if not files:
        raise RuntimeError("no fixtures found")
    fixtures: list[dict[str, Any]] = []
    for file in files:
        raw = file.read_text(encoding="utf-8")
        fixture = json.loads(raw)
        if not fixture.get("id"):
            raise RuntimeError(f"fixture {file} missing id")
        fixtures.append(fixture)
    return fixtures


def canonicalize_headers(headers: dict[str, Any] | None) -> dict[str, list[str]]:
    if not headers:
        return {}
    out: dict[str, list[str]] = {}
    for key in sorted(headers.keys()):
        lower = str(key).strip().lower()
        if not lower:
            continue
        value = headers[key]
        values = value if isinstance(value, list) else [value]
        out.setdefault(lower, []).extend([str(v) for v in values])
    return out


def decode_fixture_body(body: dict[str, Any] | None) -> bytes:
    if not body:
        return b""
    encoding = body.get("encoding")
    value = body.get("value", "")
    if encoding == "utf8":
        return str(value).encode("utf-8")
    if encoding == "base64":
        return base64.b64decode(str(value))
    raise RuntimeError(f"unknown body encoding {encoding!r}")


def parse_cookies(cookie_headers: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for header in cookie_headers:
        for part in str(header).split(";"):
            trimmed = part.strip()
            if not trimmed:
                continue
            if "=" not in trimmed:
                continue
            name, value = trimmed.split("=", 1)
            name = name.strip()
            if not name:
                continue
            out[name] = value.strip()
    return out


def canonicalize_request(req: dict[str, Any], ctx: dict[str, Any] | None) -> CanonicalRequest:
    method = str(req.get("method", "")).strip().upper()
    path = str(req.get("path", "")).strip() or "/"
    if not path.startswith("/"):
        path = f"/{path}"

    headers = canonicalize_headers(req.get("headers"))

    body_bytes = decode_fixture_body(req.get("body"))
    is_base64 = bool(req.get("is_base64"))
    if is_base64:
        body_bytes = base64.b64decode(body_bytes.decode("utf-8"))

    cookies = parse_cookies(headers.get("cookie", []))

    return CanonicalRequest(
        method=method,
        path=path,
        query=req.get("query") or {},
        headers=headers,
        cookies=cookies,
        body=body_bytes,
        is_base64=is_base64,
        path_params={},
        request_id="",
        tenant_id="",
        auth_identity="",
        remaining_ms=int((ctx or {}).get("remaining_ms") or 0),
        middleware_trace=[],
    )


def split_path(path: str) -> list[str]:
    trimmed = path.strip().lstrip("/")
    if not trimmed:
        return []
    return trimmed.split("/")


def match_path(pattern_segments: list[str], path_segments: list[str]) -> tuple[bool, dict[str, str]]:
    if len(pattern_segments) != len(path_segments):
        return False, {}
    params: dict[str, str] = {}
    for pattern, value in zip(pattern_segments, path_segments, strict=True):
        if not value:
            return False, {}
        if pattern.startswith("{") and pattern.endswith("}") and len(pattern) > 2:
            params[pattern[1:-1]] = value
            continue
        if pattern != value:
            return False, {}
    return True, params


def format_allow_header(methods: list[str]) -> str:
    uniq = sorted({m.strip().upper() for m in methods if m.strip()})
    return ", ".join(uniq)


def status_for_error(code: str) -> int:
    return {
        "app.bad_request": 400,
        "app.validation_failed": 400,
        "app.unauthorized": 401,
        "app.forbidden": 403,
        "app.not_found": 404,
        "app.method_not_allowed": 405,
        "app.conflict": 409,
        "app.too_large": 413,
        "app.rate_limited": 429,
        "app.overloaded": 503,
        "app.internal": 500,
    }.get(code, 500)


def app_error_response(
    code: str,
    message: str,
    extra_headers: dict[str, list[str]] | None = None,
    request_id: str = "",
) -> CanonicalResponse:
    headers = canonicalize_headers(extra_headers or {})
    headers["content-type"] = ["application/json; charset=utf-8"]
    error: dict[str, Any] = {"code": code, "message": message}
    if request_id:
        error["request_id"] = request_id
    body = json.dumps({"error": error}, separators=(",", ":")).encode("utf-8")
    return CanonicalResponse(
        status=status_for_error(code),
        headers=headers,
        cookies=[],
        body=body,
        is_base64=False,
    )


def is_json_content_type(headers: dict[str, list[str]]) -> bool:
    for value in headers.get("content-type", []):
        if str(value).strip().lower().startswith("application/json"):
            return True
    return False


def built_in_handler(name: str):
    if name == "static_pong":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["text/plain; charset=utf-8"]},
                cookies=[],
                body=b"pong",
                is_base64=False,
            )

        return handler

    if name == "echo_path_params":

        def handler(req: CanonicalRequest) -> CanonicalResponse:
            body = json.dumps({"params": req.path_params}, separators=(",", ":")).encode("utf-8")
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "echo_request":

        def handler(req: CanonicalRequest) -> CanonicalResponse:
            body = json.dumps(
                {
                    "method": req.method,
                    "path": req.path,
                    "query": req.query,
                    "headers": req.headers,
                    "cookies": req.cookies,
                    "body_b64": base64.b64encode(req.body).decode("ascii"),
                    "is_base64": req.is_base64,
                },
                separators=(",", ":"),
            ).encode("utf-8")
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "echo_context":

        def handler(req: CanonicalRequest) -> CanonicalResponse:
            body = json.dumps(
                {
                    "request_id": req.request_id,
                    "tenant_id": req.tenant_id,
                    "auth_identity": req.auth_identity,
                    "remaining_ms": req.remaining_ms,
                },
                separators=(",", ":"),
            ).encode("utf-8")
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "echo_middleware_trace":

        def handler(req: CanonicalRequest) -> CanonicalResponse:
            body = json.dumps({"trace": req.middleware_trace}, separators=(",", ":")).encode("utf-8")
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "parse_json_echo":

        def handler(req: CanonicalRequest) -> CanonicalResponse:
            if not is_json_content_type(req.headers):
                raise AppError("app.bad_request", "invalid json")
            if len(req.body) == 0:
                body = b"null"
            else:
                try:
                    parsed = json.loads(req.body.decode("utf-8"))
                except Exception as exc:  # noqa: BLE001
                    raise AppError("app.bad_request", "invalid json") from exc
                body = json.dumps(parsed, separators=(",", ":")).encode("utf-8")

            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/json; charset=utf-8"]},
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "panic":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            raise RuntimeError("boom")

        return handler

    if name == "binary_body":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["application/octet-stream"]},
                cookies=[],
                body=bytes([0x00, 0x01, 0x02]),
                is_base64=True,
            )

        return handler

    if name == "unauthorized":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            raise AppError("app.unauthorized", "unauthorized")

        return handler

    if name == "validation_failed":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            raise AppError("app.validation_failed", "validation failed")

        return handler

    if name == "large_response":

        def handler(_req: CanonicalRequest) -> CanonicalResponse:
            return CanonicalResponse(
                status=200,
                headers={"content-type": ["text/plain; charset=utf-8"]},
                cookies=[],
                body=b"12345",
                is_base64=False,
            )

        return handler

    return None


def enable_p1_for_tier(tier: str) -> bool:
    return tier.strip().lower() in ("p1", "p2")


def enable_p2_for_tier(tier: str) -> bool:
    return tier.strip().lower() == "p2"


def first_header_value(headers: dict[str, list[str]], key: str) -> str:
    values = headers.get(key.strip().lower(), [])
    return values[0] if values else ""


def extract_tenant_id(headers: dict[str, list[str]], query: dict[str, list[str]]) -> str:
    tenant = first_header_value(headers, "x-tenant-id")
    if tenant:
        return tenant
    values = query.get("tenant", [])
    return values[0] if values else ""


def is_cors_preflight(method: str, headers: dict[str, list[str]]) -> bool:
    return method.strip().upper() == "OPTIONS" and first_header_value(headers, "access-control-request-method") != ""


def finalize_response(
    resp: CanonicalResponse,
    enable_p1: bool,
    request_id: str,
    origin: str,
) -> CanonicalResponse:
    headers = canonicalize_headers(resp.headers)
    if enable_p1:
        if request_id:
            headers["x-request-id"] = [request_id]
        if origin:
            headers["access-control-allow-origin"] = [origin]
            headers["vary"] = ["origin"]
    return CanonicalResponse(
        status=resp.status,
        headers=headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )


class FixtureApp:
    def __init__(self, routes: list[dict[str, Any]], tier: str, limits: dict[str, Any]) -> None:
        self.compiled = [
            {
                "method": str(r.get("method", "")).strip().upper(),
                "path": str(r.get("path", "")).strip(),
                "segments": split_path(str(r.get("path", ""))),
                "handler": str(r.get("handler", "")).strip(),
                "auth_required": bool(r.get("auth_required")),
            }
            for r in routes
        ]

        self.enable_p1 = enable_p1_for_tier(tier)
        self.enable_p2 = enable_p2_for_tier(tier)

        self.max_request_bytes = int(limits.get("max_request_bytes") or 0)
        self.max_response_bytes = int(limits.get("max_response_bytes") or 0)

        self.logs: list[dict[str, Any]] = []
        self.metrics: list[dict[str, Any]] = []
        self.spans: list[dict[str, Any]] = []

    def record_p2(self, req: CanonicalRequest, resp: CanonicalResponse, error_code: str) -> None:
        if not self.enable_p2:
            return

        level = "info"
        if resp.status >= 500:
            level = "error"
        elif resp.status >= 400:
            level = "warn"

        self.logs = [
            {
                "level": level,
                "event": "request.completed",
                "request_id": req.request_id,
                "tenant_id": req.tenant_id,
                "method": req.method,
                "path": req.path,
                "status": resp.status,
                "error_code": error_code,
            }
        ]

        self.metrics = [
            {
                "name": "apptheory.request",
                "value": 1,
                "tags": {
                    "method": req.method,
                    "path": req.path,
                    "status": str(resp.status),
                    "error_code": error_code,
                    "tenant_id": req.tenant_id,
                },
            }
        ]

        self.spans = [
            {
                "name": f"http {req.method} {req.path}",
                "attributes": {
                    "http.method": req.method,
                    "http.route": req.path,
                    "http.status_code": str(resp.status),
                    "request.id": req.request_id,
                    "tenant.id": req.tenant_id,
                    "error.code": error_code,
                },
            }
        ]

    def finish(
        self,
        req: CanonicalRequest,
        resp: CanonicalResponse,
        request_id: str,
        origin: str,
        error_code: str,
    ) -> CanonicalResponse:
        out = finalize_response(resp, self.enable_p1, request_id, origin)
        self.record_p2(req, out, error_code)
        return out

    def handle(self, req: CanonicalRequest) -> CanonicalResponse:
        self.logs = []
        self.metrics = []
        self.spans = []

        request_id = ""
        origin = ""
        error_code = ""

        if self.enable_p1:
            request_id = first_header_value(req.headers, "x-request-id") or "req_test_123"
            req.request_id = request_id

            origin = first_header_value(req.headers, "origin")
            req.tenant_id = extract_tenant_id(req.headers, req.query)

            req.middleware_trace.extend(["request_id", "recovery", "logging"])
            if origin:
                req.middleware_trace.append("cors")

            if origin and is_cors_preflight(req.method, req.headers):
                allow = first_header_value(req.headers, "access-control-request-method")
                return self.finish(
                    req,
                    CanonicalResponse(
                        status=204,
                        headers={"access-control-allow-methods": [allow]},
                        cookies=[],
                        body=b"",
                        is_base64=False,
                    ),
                    request_id,
                    origin,
                    error_code,
                )

            if self.max_request_bytes > 0 and len(req.body) > self.max_request_bytes:
                error_code = "app.too_large"
                return self.finish(
                    req,
                    app_error_response("app.too_large", "request too large", request_id=request_id),
                    request_id,
                    origin,
                    error_code,
                )

            if self.enable_p2:
                if first_header_value(req.headers, "x-force-rate-limit"):
                    error_code = "app.rate_limited"
                    return self.finish(
                        req,
                        app_error_response(
                            "app.rate_limited",
                            "rate limited",
                            {"retry-after": ["1"]},
                            request_id=request_id,
                        ),
                        request_id,
                        origin,
                        error_code,
                    )
                if first_header_value(req.headers, "x-force-shed"):
                    error_code = "app.overloaded"
                    return self.finish(
                        req,
                        app_error_response(
                            "app.overloaded",
                            "overloaded",
                            {"retry-after": ["1"]},
                            request_id=request_id,
                        ),
                        request_id,
                        origin,
                        error_code,
                    )

        match = None
        allowed: list[str] = []
        for route in self.compiled:
            ok, params = match_path(route["segments"], split_path(req.path))
            if not ok:
                continue
            allowed.append(route["method"])
            if route["method"] == req.method:
                match = (route, params)
                break

        if match is None:
            if allowed:
                error_code = "app.method_not_allowed"
                return self.finish(
                    req,
                    app_error_response(
                        "app.method_not_allowed",
                        "method not allowed",
                        {"allow": [format_allow_header(allowed)]},
                        request_id=request_id,
                    ),
                    request_id,
                    origin,
                    error_code,
                )
            error_code = "app.not_found"
            return self.finish(
                req,
                app_error_response("app.not_found", "not found", request_id=request_id),
                request_id,
                origin,
                error_code,
            )

        route, params = match
        if self.enable_p1 and route.get("auth_required"):
            req.middleware_trace.append("auth")
            authz = first_header_value(req.headers, "authorization")
            if not authz.strip():
                error_code = "app.unauthorized"
                return self.finish(
                    req,
                    app_error_response("app.unauthorized", "unauthorized", request_id=request_id),
                    request_id,
                    origin,
                    error_code,
                )
            req.auth_identity = "authorized"
        if self.enable_p1:
            req.middleware_trace.append("handler")

        handler = built_in_handler(route["handler"])
        if handler is None:
            error_code = "app.internal"
            return self.finish(
                req,
                app_error_response("app.internal", "internal error", request_id=request_id),
                request_id,
                origin,
                error_code,
            )

        try:
            req.path_params = params
            resp = handler(req)
            resp = CanonicalResponse(
                status=resp.status,
                headers=canonicalize_headers(resp.headers),
                cookies=resp.cookies,
                body=resp.body,
                is_base64=resp.is_base64,
            )
        except AppError as exc:
            error_code = exc.code
            return self.finish(
                req,
                app_error_response(exc.code, exc.message, request_id=request_id),
                request_id,
                origin,
                error_code,
            )
        except Exception:  # noqa: BLE001
            error_code = "app.internal"
            return self.finish(
                req,
                app_error_response("app.internal", "internal error", request_id=request_id),
                request_id,
                origin,
                error_code,
            )

        if self.enable_p1 and self.max_response_bytes > 0 and len(resp.body) > self.max_response_bytes:
            error_code = "app.too_large"
            resp = app_error_response("app.too_large", "response too large", request_id=request_id)

        return self.finish(req, resp, request_id, origin, error_code)


def new_fixture_app(routes: list[dict[str, Any]], tier: str, limits: dict[str, Any]) -> FixtureApp:
    return FixtureApp(routes, tier, limits)


def compare_headers(expected: dict[str, Any] | None, actual: dict[str, Any] | None) -> bool:
    return canonicalize_headers(expected) == canonicalize_headers(actual)


def is_logging_profile_contract_fixture(fixture: dict[str, Any]) -> bool:
    setup = fixture.get("setup", {}) or {}
    input_obj = fixture.get("input", {}) or {}
    expect_obj = fixture.get("expect", {}) or {}
    return (
        "logging_profile" in setup
        or "logging_event" in input_obj
        or "logging_profile_catalog" in input_obj
        or "profile_logs" in expect_obj
        or "profile_validation_errors" in expect_obj
        or "logging_profile_catalog" in expect_obj
    )


def compare_logging_profile_contract(
    fixture: dict[str, Any],
) -> tuple[bool, str, dict[str, Any], dict[str, Any], _DummyEffectsApp]:
    runtime = _load_apptheory_runtime()
    setup = fixture.get("setup", {}) or {}
    input_obj = fixture.get("input", {}) or {}
    expect_obj = fixture.get("expect", {}) or {}
    actual: dict[str, Any] = {
        "logging_profile_catalog": None,
        "profile_validation_errors": [],
        "profile_logs": [],
    }
    if "logging_profile_catalog" in expect_obj:
        actual["logging_profile_catalog"] = runtime.logging_profile_catalog()
        if actual["logging_profile_catalog"] == expect_obj.get("logging_profile_catalog"):
            return True, "", actual, expect_obj, _DummyEffectsApp()
        return False, "logging_profile_catalog mismatch", actual, expect_obj, _DummyEffectsApp()
    if "profile_validation_errors" in expect_obj:
        actual["profile_validation_errors"] = decode_logging_profile_validation_errors(
            runtime,
            setup.get("logging_profile"),
        )
        if actual["profile_validation_errors"] == (expect_obj.get("profile_validation_errors") or []):
            return True, "", actual, expect_obj, _DummyEffectsApp()
        return False, "profile_validation_errors mismatch", actual, expect_obj, _DummyEffectsApp()
    if "profile_logs" in expect_obj:
        try:
            config = runtime.decode_logging_profile_json(json.dumps(setup.get("logging_profile") or {}))
            actual["profile_logs"] = [
                runtime.encode_logging_profile_event(
                    config,
                    setup.get("environment") or {},
                    input_obj.get("logging_event") or {},
                )
            ]
        except Exception as exc:  # noqa: BLE001
            return False, f"profile_logs encode failed: {exc}", actual, expect_obj, _DummyEffectsApp()
        if actual["profile_logs"] == (expect_obj.get("profile_logs") or []):
            return True, "", actual, expect_obj, _DummyEffectsApp()
        return False, "profile_logs mismatch", actual, expect_obj, _DummyEffectsApp()
    return True, "", actual, expect_obj, _DummyEffectsApp()


def decode_logging_profile_validation_errors(runtime: Any, profile: Any) -> list[str]:
    try:
        runtime.decode_logging_profile_json(json.dumps(profile or {}))
    except Exception as exc:  # noqa: BLE001
        errors = getattr(exc, "errors", None)
        if isinstance(errors, list):
            return [str(error) for error in errors]
        return [str(exc)]
    return []


MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm"
MICROVM_CONTRACT_VERSION = "m15.microvm/v1"
MICROVM_REQUIRED_LIFECYCLE_HOOKS = ["prepare_image", "start", "readiness", "stop", "teardown", "failure"]
MICROVM_REQUIRED_LIFECYCLE_STATES = [
    "requested",
    "image_preparing",
    "image_prepared",
    "starting",
    "started",
    "readiness_probing",
    "ready",
    "stopping",
    "stopped",
    "tearing_down",
    "terminated",
    "failed",
]
MICROVM_REQUIRED_CONTROLLER_COMMANDS = ["create", "start", "stop", "status", "session"]
MICROVM_REQUIRED_ENVELOPE_FIELDS = ["command", "request_id", "tenant_id", "auth_context"]
MICROVM_REQUIRED_SESSION_FIELDS = [
    "tenant_id",
    "namespace",
    "session_id",
    "state",
    "desired_state",
    "image_ref",
    "controller_id",
    "created_at",
    "updated_at",
    "expires_at",
    "generation",
    "last_command_id",
    "auth_subject",
]


def compare_microvm_contract_fixture(
    fixture: dict[str, Any],
) -> tuple[bool, str, dict[str, Any], dict[str, Any], _DummyEffectsApp]:
    actual = validate_microvm_contract_fixture((fixture.get("setup") or {}).get("microvm_contract"))
    expected = (fixture.get("expect") or {}).get("microvm_contract_validation")
    if not isinstance(expected, dict):
        return (
            False,
            "missing expect.microvm_contract_validation",
            actual,
            {"microvm_contract_validation": None},
            _DummyEffectsApp(),
        )
    if actual == expected:
        return True, "", actual, expected, _DummyEffectsApp()
    return False, "microvm_contract_validation mismatch", actual, expected, _DummyEffectsApp()


def validate_microvm_contract_fixture(contract: Any) -> dict[str, Any]:
    if not isinstance(contract, dict):
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract fixture missing",
        )

    kind = str(contract.get("kind", "")).strip()
    version = str(contract.get("version", "")).strip()
    if str(contract.get("contract", "")).strip() != MICROVM_CONTRACT_NAME or version != MICROVM_CONTRACT_VERSION:
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract must be named and versioned",
        )
    if kind not in {"lifecycle", "controller_session"}:
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract kind is unsupported",
        )

    runtime = _load_apptheory_runtime()
    escape_hatches = contract.get("escape_hatches") or {}
    escape_hatch_error = validate_microvm_escape_hatches(runtime, kind, version, escape_hatches)
    if escape_hatch_error:
        return escape_hatch_error

    controller = contract.get("controller") or {}
    if kind == "controller_session" and not microvm_controller_auth_defaults_deny(controller.get("auth") or {}):
        return {
            "valid": False,
            "kind": kind,
            "version": version,
            "error_code": "m15.microvm.unauthenticated_controller",
            "error_message": "apptheory: microvm controller must default to authenticated deny",
        }

    if kind == "lifecycle":
        err = validate_microvm_lifecycle(contract.get("lifecycle") or {})
        if err:
            return invalid_microvm_contract("m15.microvm.lifecycle_incomplete", err)
    else:
        err = validate_microvm_controller(runtime, controller)
        if err:
            return invalid_microvm_contract("m15.microvm.controller_incomplete", err)
        err = validate_microvm_session_registry(runtime, contract.get("session_registry") or {})
        if err:
            return invalid_microvm_contract("m15.microvm.session_registry_incomplete", err)

    return {"valid": True, "kind": kind, "version": version}


def invalid_microvm_contract(error_code: str, error_message: str) -> dict[str, Any]:
    return {"valid": False, "error_code": error_code, "error_message": error_message}


def microvm_controller_auth_defaults_deny(auth: dict[str, Any]) -> bool:
    return auth.get("required") is True and str(auth.get("default", "")).strip().lower() == "deny"


def validate_microvm_lifecycle(lifecycle: dict[str, Any]) -> str:
    runtime = _load_apptheory_runtime()
    try:
        runtime.validate_microvm_lifecycle_contract(lifecycle)
        handlers = {hook: (lambda _event: None) for hook in MICROVM_REQUIRED_LIFECYCLE_HOOKS}
        adapter = runtime.create_microvm_lifecycle_adapter(contract=lifecycle, handlers=handlers)
        state = "requested"
        for hook in ["prepare_image", "start", "readiness", "stop", "teardown"]:
            result = adapter.handle(
                {
                    "request_id": "m15-lifecycle-fixture",
                    "tenant_id": "tenant-fixture",
                    "namespace": "namespace-fixture",
                    "session_id": "session-fixture",
                    "hook": hook,
                    "state": state,
                }
            )
            if result.error:
                return result.error.message
            state = str(result.state or "")
        if state != "terminated":
            return f"apptheory: microvm lifecycle adapter terminated at {state}"

        failure = adapter.handle(
            {
                "request_id": "m15-lifecycle-fixture-failure",
                "tenant_id": "tenant-fixture",
                "namespace": "namespace-fixture",
                "session_id": "session-fixture",
                "hook": "failure",
                "state": "starting",
            }
        )
        if failure.error:
            return failure.error.message
        if failure.state != "failed":
            return f"apptheory: microvm lifecycle failure hook produced {failure.state}"
        return ""
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def validate_microvm_escape_hatches(
    runtime: Any, kind: str, version: str, escape_hatches: dict[str, Any]
) -> dict[str, Any] | None:
    try:
        runtime.validate_microvm_escape_hatches(escape_hatches or {})
        return None
    except Exception as exc:  # noqa: BLE001
        return {
            "valid": False,
            "kind": kind,
            "version": version,
            "error_code": str(getattr(exc, "code", "m15.microvm.invalid_contract")),
            "error_message": str(getattr(exc, "message", str(exc))),
        }


def validate_microvm_controller(runtime: Any, controller: dict[str, Any]) -> str:
    try:
        runtime.validate_microvm_controller_contract(controller)
        exercise_microvm_controller(runtime)
        return ""
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def exercise_microvm_controller(runtime: Any) -> None:
    client = runtime.create_fake_microvm_client(now=1.0)
    controller = runtime.create_microvm_controller(
        client,
        controller_id="controller-fixture",
        id_generator=lambda: "session-fixture",
    )
    create = controller.handle(runtime_controller_request(runtime.COMMAND_CREATE, "m15-create", ""))
    if create.error:
        raise create.error
    require_create_response(create)

    start = controller.handle(runtime_controller_request(runtime.COMMAND_START, "m15-start", create.session_id))
    if start.error:
        raise start.error
    require_start_stop_response("start", start, create.session_id, "started")

    status = controller.handle(runtime_controller_request(runtime.COMMAND_STATUS, "m15-status", create.session_id))
    if status.error:
        raise status.error
    require_status_response(status, create.session_id)

    session = controller.handle(runtime_controller_request(runtime.COMMAND_SESSION, "m15-session", create.session_id))
    if session.error:
        raise session.error
    require_session_response(session, create.session_id)

    stop = controller.handle(runtime_controller_request(runtime.COMMAND_STOP, "m15-stop", create.session_id))
    if stop.error:
        raise stop.error
    require_start_stop_response("stop", stop, create.session_id, "stopped")


def require_create_response(response: Any) -> None:
    if not response.session_id or response.state != "requested" or not response.registry_version:
        raise RuntimeError("apptheory: microvm controller create response incomplete")


def require_start_stop_response(name: str, response: Any, session_id: str, desired_state: str) -> None:
    if response.session_id != session_id or not response.state or response.desired_state != desired_state:
        raise RuntimeError(f"apptheory: microvm controller {name} response incomplete")


def require_status_response(response: Any, session_id: str) -> None:
    if response.session_id != session_id or not response.lifecycle_state or not response.last_transition:
        raise RuntimeError("apptheory: microvm controller status response incomplete")


def require_session_response(response: Any, session_id: str) -> None:
    if (
        response.session_id != session_id
        or not response.tenant_id
        or not response.namespace
        or not response.registry_version
    ):
        raise RuntimeError("apptheory: microvm controller session response incomplete")


def runtime_controller_request(command: str, request_id: str, session_id: str) -> dict[str, Any]:
    request: dict[str, Any] = {
        "command": command,
        "request_id": request_id,
        "tenant_id": "tenant-fixture",
        "namespace": "namespace-fixture",
        "auth_context": {
            "subject": "subject-fixture",
            "tenant_id": "tenant-fixture",
        },
        "session_id": session_id,
    }
    if command == "create":
        request["image_ref"] = "image-fixture"
        request["network_connector_ref"] = "network-fixture"
    return request


def validate_microvm_session_registry(runtime: Any, registry: dict[str, Any]) -> str:
    try:
        runtime.validate_microvm_session_registry_contract(registry)
        exercise_microvm_session_registry(runtime)
        return ""
    except Exception as exc:  # noqa: BLE001
        return str(exc)


def exercise_microvm_session_registry(runtime: Any) -> None:
    record = runtime.MicroVMSessionRecord(
        tenant_id="tenant-fixture",
        namespace="namespace-fixture",
        session_id="session-fixture",
        state="starting",
        desired_state="started",
        endpoint="https://microvm.example.test/session-fixture",
        microvm_id="microvm-fixture",
        provider_id="apptheory.microvm.registry",
        provider_microvm_id="session-fixture",
        provider_state="starting",
        aws_lifecycle_state="starting",
        image_ref="image-fixture",
        network_connector_ref="network-fixture",
        controller_id="controller-fixture",
        created_at=100.0,
        updated_at=160.0,
        last_observed_at=160.0,
        expires_at=3700.0,
        generation=3,
        last_action="start",
        last_command_id="m15-registry",
        auth_subject="subject-fixture",
        metadata={"safe": "ok"},
    )
    registry_record = runtime.microvm_session_record_to_registry_record(record)
    if (
        registry_record.pk != runtime.microvm_session_registry_partition_key(record.tenant_id, record.namespace)
        or registry_record.sk != runtime.microvm_session_registry_sort_key(record.session_id)
        or registry_record.ttl != int(record.expires_at)
        or registry_record.endpoint != record.endpoint
        or registry_record.microvm_id != record.microvm_id
        or registry_record.last_action != "start"
    ):
        raise RuntimeError("apptheory: microvm session registry canonical record incomplete")
    round_trip = runtime.microvm_session_from_registry_record(registry_record)
    if (
        round_trip.endpoint != record.endpoint
        or round_trip.microvm_id != record.microvm_id
        or round_trip.last_action != record.last_action
    ):
        raise RuntimeError("apptheory: microvm session registry round trip incomplete")
    store = runtime.create_memory_microvm_session_registry()
    stored = store.put(record)
    if stored.last_action != "start":
        raise RuntimeError("apptheory: microvm memory registry lost last action")
    client = runtime.create_microvm_registry_client(store, ttl_seconds=1800)
    created = client.create(
        runtime.MicroVMCreateSessionInput(
            request_id="m15-registry-create",
            tenant_id="tenant-fixture",
            namespace="namespace-fixture",
            session_id="session-registry-client",
            image_ref="image-fixture",
            network_connector_ref="network-fixture",
            session_spec=runtime.MicroVMSessionSpec(metadata={"safe": "ok"}),
            controller_id="controller-fixture",
            auth_subject="subject-fixture",
            now=100.0,
        )
    )
    if created.last_action != "create" or created.expires_at - created.created_at != 1800:
        raise RuntimeError("apptheory: microvm registry client create record incomplete")
    status = client.status(
        runtime.MicroVMSessionQueryInput(
            request_id="m15-registry-status",
            tenant_id=created.tenant_id,
            namespace=created.namespace,
            session_id=created.session_id,
            auth_subject=created.auth_subject,
        )
    )
    if status.last_action != "create" or status.registry_version != created.generation:
        raise RuntimeError("apptheory: microvm registry client status incomplete")


def missing_strings(required: list[str], got: Any) -> list[str]:
    values = got if isinstance(got, list) else []
    seen = {str(value).strip() for value in values if str(value).strip()}
    return sorted(value for value in required if value not in seen)


def compare_microvm_real_contract_fixture(
    fixture: dict[str, Any],
) -> tuple[bool, str, dict[str, Any], dict[str, Any], _DummyEffectsApp]:
    if "microvm_lifecycle_adapter" in (fixture.get("expect") or {}):
        return compare_microvm_real_lifecycle_adapter_fixture(fixture)
    if "microvm_controller_route" in (fixture.get("expect") or {}):
        return compare_microvm_controller_route_fixture(fixture)

    actual = validate_microvm_real_contract_fixture((fixture.get("setup") or {}).get("microvm_contract"))
    expected = (fixture.get("expect") or {}).get("microvm_contract_validation")
    if not isinstance(expected, dict):
        return (
            False,
            "missing expect.microvm_contract_validation",
            actual,
            {"microvm_contract_validation": None},
            _DummyEffectsApp(),
        )
    if actual == expected:
        return True, "", actual, expected, _DummyEffectsApp()
    return False, "microvm_contract_validation mismatch", actual, expected, _DummyEffectsApp()


def validate_microvm_real_contract_fixture(contract: Any) -> dict[str, Any]:
    if not isinstance(contract, dict):
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract fixture missing",
        )

    kind = str(contract.get("kind", "")).strip()
    version = str(contract.get("version", "")).strip()
    if str(contract.get("contract", "")).strip() != MICROVM_CONTRACT_NAME or version != "m16.microvm/v1":
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract must be named and versioned",
        )
    if kind not in {"lifecycle", "operation"}:
        return invalid_microvm_contract(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract kind is unsupported",
        )

    runtime = _load_apptheory_microvm_runtime()
    escape_hatch_error = validate_microvm_escape_hatches(runtime, kind, version, contract.get("escape_hatches") or {})
    if escape_hatch_error:
        return escape_hatch_error

    try:
        if kind == "lifecycle":
            runtime.validate_microvm_real_lifecycle_contract(contract.get("lifecycle") or {})
        else:
            runtime.validate_microvm_operation_contract(contract.get("operation_contract") or {})
    except Exception as exc:  # noqa: BLE001
        return {
            "valid": False,
            "kind": kind,
            "version": version,
            "error_code": str(getattr(exc, "code", "m16.microvm.operation_contract_incomplete")),
            "error_message": str(getattr(exc, "message", str(exc))),
        }

    return {"valid": True, "kind": kind, "version": version}


def compare_microvm_real_lifecycle_adapter_fixture(
    fixture: dict[str, Any],
) -> tuple[bool, str, dict[str, Any], dict[str, Any], _DummyEffectsApp]:
    actual = validate_microvm_real_lifecycle_adapter_fixture((fixture.get("setup") or {}).get("microvm_contract"))
    expected = (fixture.get("expect") or {}).get("microvm_lifecycle_adapter")
    if not isinstance(expected, dict):
        return (
            False,
            "missing expect.microvm_lifecycle_adapter",
            actual,
            {"microvm_lifecycle_adapter": None},
            _DummyEffectsApp(),
        )
    if actual == expected:
        return True, "", actual, expected, _DummyEffectsApp()
    return False, "microvm_lifecycle_adapter mismatch", actual, expected, _DummyEffectsApp()


def validate_microvm_real_lifecycle_adapter_fixture(contract: Any) -> dict[str, Any]:
    if not isinstance(contract, dict):
        return invalid_microvm_lifecycle_adapter(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract fixture missing",
        )

    kind = str(contract.get("kind", "")).strip()
    version = str(contract.get("version", "")).strip()
    if str(contract.get("contract", "")).strip() != MICROVM_CONTRACT_NAME or version != "m16.microvm/v1":
        return invalid_microvm_lifecycle_adapter(
            "m15.microvm.invalid_contract",
            "apptheory: microvm contract must be named and versioned",
        )
    if kind != "lifecycle":
        return invalid_microvm_lifecycle_adapter(
            "m15.microvm.invalid_contract",
            "apptheory: microvm lifecycle adapter requires lifecycle contract kind",
        )

    runtime = _load_apptheory_runtime()
    escape_hatch_error = validate_microvm_escape_hatches(runtime, kind, version, contract.get("escape_hatches") or {})
    if escape_hatch_error:
        return invalid_microvm_lifecycle_adapter(
            str(escape_hatch_error.get("error_code", "")),
            str(escape_hatch_error.get("error_message", "")),
        )

    lifecycle = contract.get("lifecycle") or {}
    try:
        runtime.validate_microvm_real_lifecycle_contract(lifecycle)
    except Exception as exc:  # noqa: BLE001
        return microvm_lifecycle_adapter_from_error(exc, "m16.microvm.lifecycle_incomplete")

    handler_states: list[str] = []

    def record_state(event: Any) -> None:
        handler_states.append(str(getattr(event, "state", "")))

    handlers = {hook: record_state for hook in microvm_real_lifecycle_fixture_hooks()}
    try:
        adapter = runtime.create_microvm_lifecycle_adapter(contract=lifecycle, handlers=handlers)
    except Exception as exc:  # noqa: BLE001
        return microvm_lifecycle_adapter_from_error(exc, "m16.microvm.lifecycle_incomplete")

    state = "requested"
    for hook in ["validate", "run", "ready", "suspend", "resume", "terminate"]:
        result = adapter.handle(
            {
                "request_id": "m16-lifecycle-adapter-fixture",
                "tenant_id": "tenant-fixture",
                "namespace": "namespace-fixture",
                "session_id": "session-fixture",
                "hook": hook,
                "state": state,
            }
        )
        if result.error:
            return invalid_microvm_lifecycle_adapter(result.error.code, result.error.message)
        state = str(result.state or "")

    failure = adapter.handle(
        {
            "request_id": "m16-lifecycle-adapter-fixture-failure",
            "tenant_id": "tenant-fixture",
            "namespace": "namespace-fixture",
            "session_id": "session-fixture",
            "hook": "failure",
            "state": "running",
        }
    )
    if failure.error:
        return invalid_microvm_lifecycle_adapter(failure.error.code, failure.error.message)

    return {
        "valid": True,
        "version": version,
        "final_state": state,
        "failure_state": str(failure.state or ""),
        "handler_states": handler_states,
    }


def microvm_real_lifecycle_fixture_hooks() -> list[str]:
    return ["validate", "run", "ready", "suspend", "resume", "terminate", "failure"]


def invalid_microvm_lifecycle_adapter(error_code: str, error_message: str) -> dict[str, Any]:
    return {"valid": False, "error_code": error_code, "error_message": error_message}


def microvm_lifecycle_adapter_from_error(exc: Exception, default_code: str) -> dict[str, Any]:
    return invalid_microvm_lifecycle_adapter(
        str(getattr(exc, "code", default_code)),
        str(getattr(exc, "message", str(exc))),
    )


def compare_microvm_controller_route_fixture(
    fixture: dict[str, Any],
) -> tuple[bool, str, Any, dict[str, Any], _DummyEffectsApp]:
    runtime = _load_apptheory_runtime()
    setup = normalize_microvm_controller_route_setup((fixture.get("setup") or {}).get("microvm_controller_route") or {})
    expected = (fixture.get("expect") or {}).get("microvm_controller_route") or {}
    provider = runtime.create_fake_microvm_provider(now=1_700_000_000.0)
    registry = runtime.create_memory_microvm_session_registry()
    controller = runtime.create_real_microvm_controller(
        provider,
        registry,
        id_generator=lambda: setup["session_id"],
        clock=lambda: 1_700_000_000.0,
    )
    if setup["seed_session"]:
        seeded = controller.handle(microvm_controller_route_run_request(runtime, setup))
        if getattr(seeded, "error", None):
            return (
                False,
                f"seed microvm_controller_route session failed: {seeded.error.message}",
                _empty_route_response(runtime),
                expected,
                _DummyEffectsApp(),
            )

    kwargs: dict[str, Any] = {"tier": "p1"}
    if setup["authenticated"]:
        kwargs["auth_hook"] = lambda _ctx: "subject-1"
    route_app = runtime.create_app(**kwargs)
    runtime.register_microvm_controller_routes(route_app, controller)

    req = canonicalize_request(
        (fixture.get("input") or {}).get("request") or {}, (fixture.get("input") or {}).get("context") or {}
    )
    actual = route_app.serve(
        runtime.Request(
            method=req.method,
            path=req.path,
            query=req.query,
            headers=req.headers,
            cookies=req.cookies,
            body=req.body,
            is_base64=req.is_base64,
        )
    )

    ok, reason, _body = compare_microvm_controller_route_expected(expected, actual)
    if not ok:
        return False, reason, actual, expected, _DummyEffectsApp()

    if isinstance(expected.get("registry_token_metadata_count"), int):
        try:
            record = registry.get((setup["tenant_id"], setup["namespace"], setup["session_id"]))
        except Exception as exc:  # noqa: BLE001
            return (
                False,
                f"read microvm_controller_route registry record failed: {exc}",
                actual,
                expected,
                _DummyEffectsApp(),
            )
        count = len(getattr(record, "token_metadata", []) or [])
        if count != expected["registry_token_metadata_count"]:
            return (
                False,
                f"registry_token_metadata_count: expected {expected['registry_token_metadata_count']}, got {count}",
                actual,
                expected,
                _DummyEffectsApp(),
            )
        record_text = stable_json(asdict(record) if hasattr(record, "__dataclass_fields__") else str(record))
        for forbidden in expected.get("forbidden_body_substrings") or []:
            if forbidden and str(forbidden) in record_text:
                return (
                    False,
                    f"microvm_controller_route registry record contains forbidden substring {forbidden!r}",
                    actual,
                    expected,
                    _DummyEffectsApp(),
                )

    return True, "", actual, expected, _DummyEffectsApp()


def normalize_microvm_controller_route_setup(setup: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(setup.get("tenant_id") or "tenant-1").strip() or "tenant-1"
    namespace = str(setup.get("namespace") or "namespace-1").strip() or "namespace-1"
    session_id = str(setup.get("session_id") or "fixture-session").strip() or "fixture-session"
    return {
        "authenticated": setup.get("authenticated") is True,
        "seed_session": setup.get("seed_session") is True,
        "tenant_id": tenant_id,
        "namespace": namespace,
        "session_id": session_id,
    }


def microvm_controller_route_run_request(runtime: Any, setup: dict[str, Any]) -> dict[str, Any]:
    return {
        "command": runtime.COMMAND_RUN,
        "request_id": "req-m16-route-seed",
        "tenant_id": setup["tenant_id"],
        "namespace": setup["namespace"],
        "auth_context": {
            "subject": "subject-1",
            "tenant_id": setup["tenant_id"],
            "namespace": setup["namespace"],
        },
        "image_ref": "image-ref",
        "image_version": "1",
        "network_connector_ref": "network-ref",
        "session_spec": {"metadata": {"safe": "ok"}},
    }


def compare_microvm_controller_route_expected(
    expected: dict[str, Any], actual: Any
) -> tuple[bool, str, dict[str, Any]]:
    if expected.get("status") != actual.status:
        return False, f"status: expected {expected.get('status')}, got {actual.status}", {}
    text = actual.body.decode("utf-8")
    for forbidden in expected.get("forbidden_body_substrings") or []:
        if forbidden and str(forbidden) in text:
            return False, f"microvm_controller_route body contains forbidden substring {forbidden!r}", {}
    try:
        body = json.loads(text) if text.strip() else {}
    except Exception:  # noqa: BLE001
        return False, "microvm_controller_route response json mismatch", {}
    for expected_field in ["command", "tenant_id", "namespace", "session_id", "state", "token_type"]:
        if expected.get(expected_field) and body.get(expected_field) != expected.get(expected_field):
            return (
                False,
                f"{expected_field}: expected {expected.get(expected_field)!r}, got {body.get(expected_field)!r}",
                body,
            )
    if expected.get("scope") and body.get("scope", []) != expected.get("scope"):
        return False, f"scope: expected {expected.get('scope')!r}, got {body.get('scope', [])!r}", body
    if expected.get("error_code") and microvm_controller_route_error_code(body) != expected.get("error_code"):
        return (
            False,
            f"error_code: expected {expected.get('error_code')!r}, got {microvm_controller_route_error_code(body)!r}",
            body,
        )
    return True, "", body


def microvm_controller_route_error_code(body: dict[str, Any]) -> str:
    error = body.get("error")
    if not isinstance(error, dict):
        return ""
    return str(error.get("code") or "")


def _empty_route_response(runtime: Any) -> Any:
    return runtime.Response(status=0, headers={}, cookies=[], body=b"", is_base64=False)


def _load_apptheory_microvm_runtime() -> Any:
    repo_root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo_root / "py" / "src"))
    import importlib

    return importlib.import_module("apptheory.microvm")


def run_fixture(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    tier = str(fixture.get("tier", "")).strip().lower()
    if tier == "p0":
        return run_fixture_p0(fixture)
    if tier == "p1":
        return run_fixture_p1(fixture)
    if tier == "p2":
        if is_logging_profile_contract_fixture(fixture):
            return compare_logging_profile_contract(fixture)
        expect_obj = fixture.get("expect", {}) or {}
        if "output_json" in expect_obj or "error" in expect_obj:
            return run_fixture_p2_output(fixture)
        return run_fixture_p2(fixture)
    if tier == "m1":
        return run_fixture_m1(fixture)
    if tier == "m2":
        return run_fixture_m2(fixture)
    if tier == "m3":
        return run_fixture_m3(fixture)
    if tier == "m12":
        return run_fixture_m12(fixture)
    if tier == "m14":
        return run_fixture_m14(fixture)
    if tier == "m15":
        return compare_microvm_contract_fixture(fixture)
    if tier == "m16":
        return compare_microvm_real_contract_fixture(fixture)

    setup = fixture.get("setup", {})
    input_ = fixture.get("input", {})
    app = new_fixture_app(setup.get("routes", []), fixture.get("tier", ""), setup.get("limits", {}) or {})
    req = canonicalize_request(input_.get("request", {}), input_.get("context", {}))
    actual = app.handle(req)
    expected = fixture.get("expect", {}).get("response", {})

    if expected.get("status") != actual.status:
        return False, f"status: expected {expected.get('status')}, got {actual.status}", actual, expected, app

    if bool(expected.get("is_base64")) != actual.is_base64:
        return False, "is_base64 mismatch", actual, expected, app

    if (expected.get("cookies") or []) != actual.cookies:
        return False, "cookies mismatch", actual, expected, app

    if not compare_headers(expected.get("headers"), actual.headers):
        return False, "headers mismatch", actual, expected, app

    if "body_json" in expected:
        try:
            actual_json = json.loads(actual.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return False, "body_json mismatch", actual, expected, app
        if expected["body_json"] != actual_json:
            return False, "body_json mismatch", actual, expected, app

        if (fixture.get("expect", {}).get("logs") or []) != app.logs:
            return False, "logs mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
            return False, "metrics mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("spans") or []) != app.spans:
            return False, "spans mismatch", actual, expected, app

        return True, "", actual, expected, app

    if expected.get("body") is not None:
        expected_bytes = decode_fixture_body(expected.get("body"))
        if expected_bytes != actual.body:
            return False, "body mismatch", actual, expected, app

        if (fixture.get("expect", {}).get("logs") or []) != app.logs:
            return False, "logs mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
            return False, "metrics mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("spans") or []) != app.spans:
            return False, "spans mismatch", actual, expected, app

        return True, "", actual, expected, app

    if actual.body != b"":
        return False, "body mismatch", actual, expected, app

    if (fixture.get("expect", {}).get("logs") or []) != app.logs:
        return False, "logs mismatch", actual, expected, app
    if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
        return False, "metrics mismatch", actual, expected, app
    if (fixture.get("expect", {}).get("spans") or []) != app.spans:
        return False, "spans mismatch", actual, expected, app

    return True, "", actual, expected, app


class _DummyEffectsApp:
    def __init__(self) -> None:
        self.logs: list[Any] = []
        self.metrics: list[Any] = []
        self.spans: list[Any] = []


def _load_apptheory_runtime():
    global _APPTHEORY_RUNTIME
    if _APPTHEORY_RUNTIME is not None:
        return _APPTHEORY_RUNTIME

    repo_root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo_root / "py" / "src"))

    import apptheory  # type: ignore

    _APPTHEORY_RUNTIME = apptheory
    return apptheory


def _cooperative_cancelled(value: Any) -> bool:
    if isinstance(value, threading.Event):
        return value.is_set()

    event = getattr(value, "cancelled", None)
    if isinstance(event, threading.Event):
        return event.is_set()

    return False


def _built_in_apptheory_handler(runtime: Any, name: str, effects: Any | None = None):
    if name == "static_pong":
        return lambda _ctx: runtime.text(200, "pong")

    if name == "sleep_50ms":

        def handler(_ctx):
            import time

            time.sleep(0.05)
            return runtime.text(200, "done")

        return handler

    if name == "cooperative_cancel_side_effect":

        def handler(ctx):
            deadline = time.monotonic() + 0.02
            while time.monotonic() < deadline:
                if _cooperative_cancelled(getattr(ctx, "ctx", None)):
                    return runtime.text(200, "cancelled")
                time.sleep(0.001)
            if effects is not None:
                effects.metrics.append(
                    {
                        "name": "timeout.side_effect_committed",
                        "value": 1,
                        "tags": {"handler": "cooperative_cancel_side_effect"},
                    }
                )
            return runtime.text(200, "late")

        return handler

    if name == "echo_path_params":
        return lambda ctx: runtime.json(200, {"params": ctx.params})

    if name == "echo_request":

        def handler(ctx):
            return runtime.json(
                200,
                {
                    "method": ctx.request.method,
                    "path": ctx.request.path,
                    "query": ctx.request.query,
                    "headers": ctx.request.headers,
                    "cookies": ctx.request.cookies,
                    "body_b64": base64.b64encode(ctx.request.body).decode("ascii"),
                    "is_base64": ctx.request.is_base64,
                },
            )

        return handler

    if name == "parse_json_echo":
        return lambda ctx: runtime.json(200, ctx.json_value())

    if name == "echo_appsync_context":

        def handler(ctx):
            appsync = ctx.as_appsync()
            return runtime.json(
                200,
                {
                    "field_name": getattr(appsync, "field_name", "") if appsync is not None else "",
                    "parent_type_name": getattr(appsync, "parent_type_name", "") if appsync is not None else "",
                    "arguments": getattr(appsync, "arguments", {}) if appsync is not None else {},
                    "identity": getattr(appsync, "identity", {}) if appsync is not None else {},
                    "source": getattr(appsync, "source", {}) if appsync is not None else {},
                    "variables": getattr(appsync, "variables", {}) if appsync is not None else {},
                    "stash": getattr(appsync, "stash", {}) if appsync is not None else {},
                    "prev": getattr(appsync, "prev", None) if appsync is not None else None,
                    "request_headers": getattr(appsync, "request_headers", {}) if appsync is not None else {},
                    "raw_event_field": ((getattr(appsync, "raw_event", {}) or {}).get("info") or {}).get(
                        "fieldName", ""
                    )
                    if appsync is not None
                    else "",
                    "ctx_trigger_type": ctx.get("apptheory.trigger_type"),
                    "ctx_field_name": ctx.get("apptheory.appsync.field_name"),
                    "ctx_parent_type": ctx.get("apptheory.appsync.parent_type_name"),
                    "ctx_request_headers": ctx.get("apptheory.appsync.request_headers"),
                },
            )

        return handler

    if name == "panic":

        def handler(_ctx):
            raise RuntimeError("boom")

        return handler

    if name == "unexpected_error":

        def handler(_ctx):
            raise RuntimeError("boom")

        return handler

    if name == "binary_body":
        return lambda _ctx: runtime.binary(200, bytes([0, 1, 2]), content_type="application/octet-stream")

    if name == "unauthorized":

        def handler(_ctx):
            raise runtime.AppError("app.unauthorized", "unauthorized")

        return handler

    if name == "validation_failed":

        def handler(_ctx):
            raise runtime.AppError("app.validation_failed", "validation failed")

        return handler

    if name == "portable_error":

        def handler(_ctx):
            raise runtime.AppTheoryError(
                code="app.conflict",
                message="conflict",
                status_code=409,
                details={"field": "email", "retryable": False},
                trace_id="trace_456",
                timestamp="2024-01-02T03:04:05Z",
                stack_trace="stack:line",
            )

        return handler

    if name == "echo_context":

        def handler(ctx):
            return runtime.json(
                200,
                {
                    "request_id": getattr(ctx, "request_id", ""),
                    "tenant_id": getattr(ctx, "tenant_id", ""),
                    "auth_identity": getattr(ctx, "auth_identity", ""),
                    "remaining_ms": int(getattr(ctx, "remaining_ms", 0) or 0),
                },
            )

        return handler

    if name == "echo_middleware_trace":

        def handler(ctx):
            return runtime.json(200, {"trace": getattr(ctx, "middleware_trace", [])})

        return handler

    if name == "echo_ctx_value_and_trace":

        def handler(ctx):
            return runtime.json(
                200,
                {
                    "mw": ctx.get("mw"),
                    "trace": getattr(ctx, "middleware_trace", []),
                },
            )

        return handler

    if name == "naming_helpers":

        def handler(_ctx):
            return runtime.json(
                200,
                {
                    "normalized": {
                        "prod": runtime.normalize_stage("prod"),
                        "stg": runtime.normalize_stage("stg"),
                        "custom": runtime.normalize_stage("  Foo_Bar  "),
                    },
                    "base": runtime.base_name("Pay Theory", "prod", "Tenant_1"),
                    "resource": runtime.resource_name("Pay Theory", "WS Api", "prod", "Tenant_1"),
                },
            )

        return handler

    if name == "stepfunctions_task_token_helpers":

        def handler(_ctx):
            return runtime.json(
                200,
                {
                    "from_taskToken": runtime.stepfunctions_task_token({"taskToken": " tok-a "}),
                    "from_TaskToken": runtime.stepfunctions_task_token({"TaskToken": " tok-b "}),
                    "from_task_token": runtime.stepfunctions_task_token({"task_token": " tok-c "}),
                    "from_precedence": runtime.stepfunctions_task_token(
                        {
                            "TaskToken": " tok-b ",
                            "task_token": " tok-c ",
                            "taskToken": " tok-a ",
                        }
                    ),
                    "built": runtime.build_stepfunctions_task_token_event(
                        " tok-built ",
                        {"foo": "bar", "taskToken": "ignored"},
                    ),
                },
            )

        return handler

    if name == "large_response":
        return lambda _ctx: runtime.text(200, "12345")

    if name == "sse_single_event":

        def handler(_ctx):
            return runtime.sse(
                200,
                [
                    runtime.SSEEvent(id="1", event="message", data={"ok": True}),
                ],
            )

        return handler

    if name == "sse_stream_three_events":

        def handler(_ctx):
            events = [
                runtime.SSEEvent(id="1", event="message", data={"a": 1, "b": 2}),
                runtime.SSEEvent(event="note", data="hello\nworld"),
                runtime.SSEEvent(id="3", data=""),
            ]
            body = b"".join(runtime.sse_event_stream(events))
            return runtime.Response(
                status=200,
                headers={
                    "content-type": ["text/event-stream"],
                    "cache-control": ["no-cache"],
                    "connection": ["keep-alive"],
                },
                cookies=[],
                body=body,
                is_base64=False,
            )

        return handler

    if name == "stream_mutate_headers_after_first_chunk":

        def handler(_ctx):
            resp = runtime.Response(
                status=200,
                headers={
                    "content-type": ["text/plain; charset=utf-8"],
                    "x-phase": ["before"],
                },
                cookies=["a=b; Path=/"],
                body=b"",
                is_base64=False,
            )

            def gen():
                yield b"a"
                resp.headers["x-phase"] = ["after"]
                resp.cookies.append("c=d; Path=/")
                yield b"b"

            resp.body_stream = gen()
            return resp

        return handler

    if name == "stream_error_after_first_chunk":

        def handler(_ctx):
            def gen():
                yield b"hello"
                raise runtime.AppError("app.internal", "boom")

            return runtime.Response(
                status=200,
                headers={"content-type": ["text/plain; charset=utf-8"]},
                cookies=[],
                body=b"",
                is_base64=False,
                body_stream=gen(),
            )

        return handler

    if name == "html_basic":
        return lambda _ctx: runtime.html(200, "<h1>Hello</h1>")

    if name == "html_stream_two_chunks":

        def handler(_ctx):
            def gen():
                yield b"<h1>"
                yield b"Hello</h1>"

            return runtime.html_stream(200, gen())

        return handler

    if name == "safe_json_for_html":

        def handler(_ctx):
            return runtime.text(
                200,
                runtime.safe_json_for_html(
                    {
                        "html": "</script><div>&</div><",
                        "amp": "a&b",
                        "ls": "line\u2028sep",
                        "ps": "para\u2029sep",
                    }
                ),
            )

        return handler

    if name == "cookies_from_set_cookie_header":

        def handler(_ctx):
            return runtime.Response(
                status=200,
                headers={
                    "content-type": ["text/plain; charset=utf-8"],
                    "set-cookie": ["a=b; Path=/", "c=d; Path=/"],
                },
                cookies=["e=f; Path=/"],
                body=b"ok",
                is_base64=False,
            )

        return handler

    if name == "header_multivalue":

        def handler(_ctx):
            return runtime.Response(
                status=200,
                headers={"content-type": ["text/plain; charset=utf-8"], "x-multi": ["a", "b"]},
                cookies=[],
                body=b"ok",
                is_base64=False,
            )

        return handler

    if name == "cache_helpers":

        def handler(ctx):
            tag = runtime.etag("hello")
            return runtime.json(
                200,
                {
                    "cache_control_ssr": runtime.cache_control_ssr(),
                    "cache_control_ssg": runtime.cache_control_ssg(),
                    "cache_control_isr": runtime.cache_control_isr(60, 30),
                    "etag": tag,
                    "if_none_match_hit": runtime.matches_if_none_match(
                        getattr(getattr(ctx, "request", None), "headers", {}) or {},
                        tag,
                    ),
                    "vary": runtime.vary(["origin"], "accept-encoding", "Origin"),
                },
            )

        return handler

    if name == "cloudfront_helpers":

        def handler(ctx):
            headers = getattr(getattr(ctx, "request", None), "headers", {}) or {}
            return runtime.json(
                200,
                {
                    "origin_url": runtime.origin_url(headers),
                    "client_ip": runtime.client_ip(headers),
                },
            )

        return handler

    if name == "source_provenance":

        def handler(ctx):
            provenance = ctx.source_provenance()
            return runtime.json(
                200,
                {
                    "source_ip": ctx.source_ip(),
                    "source_provenance": {
                        "source_ip": provenance.source_ip,
                        "provider": provenance.provider,
                        "source": provenance.source,
                        "valid": provenance.valid,
                    },
                },
            )

        return handler

    return None


def _built_in_m12_middleware(runtime: Any, name: str):
    if name == "mw_a":

        def mw(ctx, next_handler):
            ctx.set("mw", "ok")
            getattr(ctx, "middleware_trace", []).append("mw_a")
            resp = next_handler(ctx)
            resp.headers["x-middleware"] = ["1"]
            return resp

        return mw

    if name == "mw_b":

        def mw(ctx, next_handler):
            getattr(ctx, "middleware_trace", []).append("mw_b")
            return next_handler(ctx)

        return mw

    if name == "timeout_5ms":
        return runtime.timeout_middleware(runtime.TimeoutConfig(default_timeout_ms=5))

    return None


def _built_in_event_middleware(name: str):
    if name == "evt_mw_a":

        def mw(ctx, _event, next_handler):
            ctx.set("mw", "ok")
            ctx.set("trace", ["evt_mw_a"])
            return next_handler()

        return mw

    if name == "evt_mw_b":

        def mw(ctx, _event, next_handler):
            existing = ctx.get("trace")
            trace = list(existing) if isinstance(existing, list) else []
            trace.append("evt_mw_b")
            ctx.set("trace", trace)
            return next_handler()

        return mw

    return None


def _built_in_sqs_handler(name: str):
    if name == "sqs_noop":
        return lambda _ctx, _msg: None

    if name == "sqs_always_fail":

        def handler(_ctx, _msg):
            raise RuntimeError("fail")

        return handler

    if name == "sqs_fail_on_body":

        def handler(_ctx, msg):
            if str((msg or {}).get("body") or "").strip() == "fail":
                raise RuntimeError("fail")

        return handler

    if name == "sqs_requires_event_middleware":

        def handler(ctx, _msg):
            if ctx.get("mw") != "ok":
                raise RuntimeError("missing middleware value")
            trace = ctx.get("trace")
            if not isinstance(trace, list) or ",".join(trace) != "evt_mw_a,evt_mw_b":
                raise RuntimeError("bad trace")

        return handler

    return None


def _built_in_kinesis_handler(runtime: Any, name: str, fixture: dict[str, Any]):
    if name == "kinesis_noop":
        return lambda _ctx, _record: None

    if name == "kinesis_always_fail":

        def handler(_ctx, _record):
            raise RuntimeError("fail")

        return handler

    if name == "kinesis_fail_on_data":

        def handler(_ctx, record):
            data_b64 = str(((record or {}).get("kinesis") or {}).get("data") or "").strip()
            decoded = base64.b64decode(data_b64) if data_b64 else b""
            if decoded.decode("utf-8", errors="ignore").strip() == "fail":
                raise RuntimeError("fail")

        return handler

    if name == "kinesis_requires_event_middleware":

        def handler(ctx, _record):
            if ctx.get("mw") != "ok":
                raise RuntimeError("missing middleware value")
            trace = ctx.get("trace")
            if not isinstance(trace, list) or ",".join(trace) != "evt_mw_a,evt_mw_b":
                raise RuntimeError("bad trace")

        return handler

    if name == CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER:
        return make_cloudwatch_logs_subscription_kinesis_handler(
            fixture,
            _runtime_cloudwatch_logs_subscription_decoder(runtime),
        )

    return None


def _built_in_sns_handler(name: str):
    if name == "sns_static_a":
        return lambda _ctx, _record: {"handler": "a"}
    if name == "sns_static_b":
        return lambda _ctx, _record: {"handler": "b"}
    if name == "sns_echo_event_middleware":
        return lambda ctx, _record: {"mw": ctx.get("mw"), "trace": ctx.get("trace")}
    return None


def _built_in_dynamodb_stream_handler(runtime: Any, name: str):
    if name == "ddb_noop":
        return lambda _ctx, _record: None

    if name == "ddb_always_fail":

        def handler(_ctx, _record):
            raise RuntimeError("fail")

        return handler

    if name == "ddb_fail_on_event_name_remove":

        def handler(_ctx, record):
            if str((record or {}).get("eventName") or "").strip() == "REMOVE":
                raise RuntimeError("fail")

        return handler

    if name == "ddb_requires_event_middleware":

        def handler(ctx, _record):
            if ctx.get("mw") != "ok":
                raise RuntimeError("missing middleware value")
            trace = ctx.get("trace")
            if not isinstance(trace, list) or ",".join(trace) != "evt_mw_a,evt_mw_b":
                raise RuntimeError("bad trace")

        return handler

    if name == "ddb_require_normalized_summary":
        return lambda _ctx, record: _require_dynamodb_safe_summary(runtime, record, False)

    if name == "ddb_require_normalized_summary_fail_on_remove":
        return lambda _ctx, record: _require_dynamodb_safe_summary(runtime, record, True)

    if name == "ddb_observed_fail_on_remove":

        def handler(ctx, record):
            _require_dynamodb_safe_summary(runtime, record, False)
            if str((record or {}).get("eventName") or "").strip() == "REMOVE":
                raise RuntimeError("raw dynamodb remove failure: do-not-log")

        return handler

    return None


def _require_dynamodb_safe_summary(runtime: Any, record: Any, fail_on_remove: bool) -> None:
    summary = runtime.normalize_dynamodb_stream_record(record)
    for key in ("table_name", "event_id", "event_name", "sequence_number", "stream_view_type"):
        if not str(summary.get(key) or "").strip():
            raise RuntimeError(f"missing normalized dynamodb {key}")
    serialized_summary = json.dumps(summary, sort_keys=True)
    if not str(summary.get("safe_log") or "").strip() or any(
        sentinel in serialized_summary for sentinel in ("release#rel_123", "do-not-log", "previous-secret")
    ):
        raise RuntimeError("unsafe dynamodb stream summary")
    if fail_on_remove and str((record or {}).get("eventName") or "").strip() == "REMOVE":
        raise RuntimeError("fail")


def _built_in_eventbridge_handler(runtime: Any, name: str):
    if name == "eventbridge_static_a":
        return lambda _ctx, _event: {"handler": "a"}
    if name == "eventbridge_static_b":
        return lambda _ctx, _event: {"handler": "b"}
    if name == "eventbridge_echo_event_middleware":
        return lambda ctx, _event: {"mw": ctx.get("mw"), "trace": ctx.get("trace")}
    if name == "eventbridge_workload_envelope":
        return lambda ctx, event: runtime.normalize_eventbridge_workload_envelope(ctx, event)
    if name == "eventbridge_scheduled_summary":
        return lambda ctx, event: runtime.normalize_eventbridge_scheduled_workload(ctx, event)
    if name == "eventbridge_observed_success":
        return lambda ctx, event: runtime.normalize_eventbridge_workload_envelope(ctx, event)
    if name == "eventbridge_observed_panic":

        def handler(_ctx, _event):
            raise RuntimeError("raw eventbridge panic: do-not-log")

        return handler
    if name == "eventbridge_require_workload_envelope":
        return lambda ctx, event: runtime.require_eventbridge_workload_envelope(ctx, event)
    return None


class _FixtureLambdaContext:
    def __init__(self, values: dict[str, Any]) -> None:
        self.aws_request_id = str(values.get("aws_request_id") or "").strip()
        self.awsRequestId = self.aws_request_id
        self.remaining_ms = int(values.get("remaining_ms") or 0)

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_ms if self.remaining_ms > 0 else 0


def _fixture_lambda_context(values: dict[str, Any] | None) -> _FixtureLambdaContext:
    return _FixtureLambdaContext(values or {})


@dataclass(slots=True)
class WebSocketCall:
    op: str
    endpoint: str
    connection_id: str
    data: bytes = b""


class FakeWebSocketManagementClient:
    def __init__(self, endpoint: str) -> None:
        self.endpoint = str(endpoint or "").strip()
        self.calls: list[WebSocketCall] = []

    def post_to_connection(self, connection_id: str, data: bytes) -> None:
        self.calls.append(
            WebSocketCall(
                op="post_to_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
                data=bytes(data or b""),
            )
        )

    def get_connection(self, connection_id: str) -> dict[str, Any]:
        self.calls.append(
            WebSocketCall(
                op="get_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
            )
        )
        return {}

    def delete_connection(self, connection_id: str) -> None:
        self.calls.append(
            WebSocketCall(
                op="delete_connection",
                endpoint=self.endpoint,
                connection_id=str(connection_id or "").strip(),
            )
        )


def _built_in_websocket_handler(runtime: Any, name: str):
    if name == "ws_connect_ok":

        def handler(ctx):
            ws = ctx.as_websocket()
            if ws is None:
                raise RuntimeError("missing websocket context")
            return runtime.json(
                200,
                {
                    "handler": "connect",
                    "route_key": ws.route_key,
                    "event_type": ws.event_type,
                    "connection_id": ws.connection_id,
                    "management_endpoint": ws.management_endpoint,
                    "request_id": getattr(ctx, "request_id", ""),
                },
            )

        return handler

    if name == "ws_disconnect_ok":

        def handler(ctx):
            ws = ctx.as_websocket()
            if ws is None:
                raise RuntimeError("missing websocket context")
            return runtime.json(
                200,
                {
                    "handler": "disconnect",
                    "route_key": ws.route_key,
                    "event_type": ws.event_type,
                    "connection_id": ws.connection_id,
                    "management_endpoint": ws.management_endpoint,
                    "request_id": getattr(ctx, "request_id", ""),
                },
            )

        return handler

    if name == "ws_default_send_json_ok":

        def handler(ctx):
            ws = ctx.as_websocket()
            if ws is None:
                raise RuntimeError("missing websocket context")
            ws.send_json_message({"ok": True})
            return runtime.json(
                200,
                {
                    "handler": "default",
                    "sent": True,
                    "route_key": ws.route_key,
                    "event_type": ws.event_type,
                    "connection_id": ws.connection_id,
                    "management_endpoint": ws.management_endpoint,
                    "request_id": getattr(ctx, "request_id", ""),
                },
            )

        return handler

    if name == "ws_bad_request":

        def handler(_ctx):
            raise runtime.AppError("app.bad_request", "bad request")

        return handler

    return None


def run_fixture_m1(fixture: dict[str, Any]) -> tuple[bool, str, Any, Any, _DummyEffectsApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")
    effects = _DummyEffectsApp()
    app = runtime.create_app(
        tier="p0",
        clock=runtime.ManualClock(),
        id_generator=ids,
        observability=runtime.ObservabilityHooks(
            log=lambda record: effects.logs.append(_m1_log_record(record)),
            metric=lambda record: effects.metrics.append(
                {"name": record.name, "value": record.value, "tags": record.tags}
            ),
            span=lambda record: effects.spans.append({"name": record.name, "attributes": record.attributes}),
        ),
    )

    setup = fixture.get("setup", {}) or {}
    for name in setup.get("middlewares", []) or []:
        mw = _built_in_event_middleware(str(name or "").strip())
        if mw is None:
            raise RuntimeError(f"unknown event middleware {name!r}")
        app.use_events(mw)

    for route in setup.get("sqs", []) or []:
        handler = _built_in_sqs_handler(str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown sqs handler {route.get('handler')!r}")
        app.sqs(str(route.get("queue") or ""), handler)

    for route in setup.get("kinesis", []) or []:
        handler = _built_in_kinesis_handler(runtime, str(route.get("handler") or ""), fixture)
        if handler is None:
            raise RuntimeError(f"unknown kinesis handler {route.get('handler')!r}")
        app.kinesis(str(route.get("stream") or ""), handler)

    for route in setup.get("sns", []) or []:
        handler = _built_in_sns_handler(str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown sns handler {route.get('handler')!r}")
        app.sns(str(route.get("topic") or ""), handler)

    for route in setup.get("dynamodb", []) or []:
        handler = _built_in_dynamodb_stream_handler(runtime, str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown dynamodb handler {route.get('handler')!r}")
        app.dynamodb(str(route.get("table") or ""), handler)

    for route in setup.get("eventbridge", []) or []:
        handler = _built_in_eventbridge_handler(runtime, str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown eventbridge handler {route.get('handler')!r}")
        selector = runtime.EventBridgeSelector(
            rule_name=str(route.get("rule_name") or "").strip(),
            source=str(route.get("source") or "").strip(),
            detail_type=str(route.get("detail_type") or "").strip(),
        )
        app.event_bridge(selector, handler)

    input_ = fixture.get("input", {}) or {}
    aws_event = (input_ or {}).get("aws_event") or {}
    event = (aws_event or {}).get("event")
    if not isinstance(event, dict):
        raise RuntimeError("fixture missing input.aws_event.event")

    actual_output = None
    actual_error: Exception | None = None
    try:
        actual_output = app.handle_lambda(event, ctx=_fixture_lambda_context(input_.get("context") or {}))
    except Exception as exc:  # noqa: BLE001
        actual_error = exc
    expect_obj = fixture.get("expect", {}) or {}
    if "error" in expect_obj:
        if "output_json" in expect_obj:
            return (
                False,
                "fixture expect cannot set both error and output_json",
                {"message": str(actual_error or "").strip()} if actual_error else None,
                expect_obj.get("error"),
                _DummyEffectsApp(),
            )
        expected_error = expect_obj.get("error") or {}
        expected_msg = str((expected_error or {}).get("message") or "").strip()
        if actual_error is None:
            return False, "expected error, got none", actual_output, expected_error, _DummyEffectsApp()
        actual_msg = str(actual_error).strip()
        if expected_msg and actual_msg != expected_msg:
            return False, "error mismatch", {"message": actual_msg}, expected_error, _DummyEffectsApp()
        return _compare_m1_side_effects_if_expected(fixture, effects, {"message": actual_msg}, expected_error)

    if "output_json" not in expect_obj:
        return False, "missing expect.output_json or expect.error", actual_output, None, _DummyEffectsApp()
    if actual_error is not None:
        return (
            False,
            "unexpected error",
            {"message": str(actual_error).strip()},
            expect_obj.get("output_json"),
            _DummyEffectsApp(),
        )

    expected_output = expect_obj.get("output_json")
    if stable_json(expected_output) != stable_json(actual_output):
        return False, "output_json mismatch", actual_output, expected_output, _DummyEffectsApp()

    return _compare_m1_side_effects_if_expected(fixture, effects, actual_output, expected_output)


def _compare_m1_side_effects_if_expected(
    fixture: dict[str, Any],
    effects: _DummyEffectsApp,
    actual: Any,
    expected: Any,
) -> tuple[bool, str, Any, Any, _DummyEffectsApp]:
    expect_obj = fixture.get("expect", {}) or {}
    if "logs" not in expect_obj and "metrics" not in expect_obj and "spans" not in expect_obj:
        return True, "", actual, expected, effects
    if (expect_obj.get("logs") or []) != effects.logs:
        return False, "logs mismatch", actual, expected, effects
    if (expect_obj.get("metrics") or []) != effects.metrics:
        return False, "metrics mismatch", actual, expected, effects
    if (expect_obj.get("spans") or []) != effects.spans:
        return False, "spans mismatch", actual, expected, effects
    return True, "", actual, expected, effects


def uses_cloudwatch_logs_subscription_handler(fixture: dict[str, Any]) -> bool:
    setup = fixture.get("setup", {}) or {}
    return any(
        str((route or {}).get("handler") or "").strip() == CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER
        for route in setup.get("kinesis", []) or []
    )


def build_cloudwatch_logs_subscription_expectations(
    fixture: dict[str, Any],
) -> dict[str, dict[str, Any]] | None:
    uses_handler = uses_cloudwatch_logs_subscription_handler(fixture)
    expectation_root = (fixture.get("expect", {}) or {}).get("cloudwatch_logs_subscription")
    if not expectation_root:
        if uses_handler:
            raise RuntimeError("fixture missing expect.cloudwatch_logs_subscription")
        return None
    if not uses_handler:
        raise RuntimeError(
            "expect.cloudwatch_logs_subscription requires kinesis_require_cloudwatch_logs_subscription handler"
        )

    expected_records = expectation_root.get("records") or []
    if not isinstance(expected_records, list) or not expected_records:
        raise RuntimeError("fixture missing expect.cloudwatch_logs_subscription.records")

    input_records = (((fixture.get("input", {}) or {}).get("aws_event") or {}).get("event") or {}).get("Records")
    if not isinstance(input_records, list) or not input_records:
        raise RuntimeError("cloudwatch logs subscription fixture missing kinesis input records")

    by_record_id: dict[str, dict[str, Any]] = {}
    for index, expected in enumerate(expected_records):
        record_id = str((expected or {}).get("record_id") or "").strip()
        if not record_id:
            raise RuntimeError(f"expect.cloudwatch_logs_subscription.records[{index}] missing record_id")
        if record_id in by_record_id:
            raise RuntimeError(f"duplicate cloudwatch logs subscription expectation for record_id {record_id!r}")
        normalized = dict(expected or {})
        normalized["record_id"] = record_id
        validate_cloudwatch_logs_subscription_expectation_record(normalized)
        by_record_id[record_id] = normalized

    seen_input_record_ids: set[str] = set()
    for index, record in enumerate(input_records):
        record_id = str((record or {}).get("eventID") or "").strip()
        if not record_id:
            raise RuntimeError(
                f"kinesis input Records[{index}] missing eventID for cloudwatch logs subscription expectation"
            )
        if record_id in seen_input_record_ids:
            raise RuntimeError(f"duplicate kinesis input record_id {record_id!r}")
        seen_input_record_ids.add(record_id)
        if record_id not in by_record_id:
            raise RuntimeError(f"missing cloudwatch logs subscription expectation for kinesis record_id {record_id!r}")

    for record_id in by_record_id:
        if record_id not in seen_input_record_ids:
            raise RuntimeError(f"extra cloudwatch logs subscription expectation for record_id {record_id!r}")

    return by_record_id


def validate_cloudwatch_logs_subscription_expectation_record(expected: dict[str, Any]) -> None:
    record_id = str((expected or {}).get("record_id") or "").strip()
    if expected.get("decode_error") is True:
        has_decoded_fields = (
            str(expected.get("message_type") or "").strip()
            or str(expected.get("owner") or "").strip()
            or str(expected.get("log_group") or "").strip()
            or str(expected.get("log_stream") or "").strip()
            or bool(expected.get("subscription_filters") or [])
            or bool(expected.get("log_events") or [])
            or bool(expected.get("safe_summary") or {})
            or bool(expected.get("forbidden_safe_log_substrings") or [])
        )
        if has_decoded_fields:
            raise RuntimeError(
                f"cloudwatch logs subscription record_id {record_id!r} has decode_error=true and decoded fields"
            )
        return

    missing: list[str] = []
    if not str(expected.get("message_type") or "").strip():
        missing.append("message_type")
    if not str(expected.get("owner") or "").strip():
        missing.append("owner")
    if not str(expected.get("log_group") or "").strip():
        missing.append("log_group")
    if not str(expected.get("log_stream") or "").strip():
        missing.append("log_stream")
    if not isinstance(expected.get("subscription_filters"), list) or not expected.get("subscription_filters"):
        missing.append("subscription_filters")
    if not isinstance(expected.get("log_events"), list) or not expected.get("log_events"):
        missing.append("log_events")
    safe_summary = expected.get("safe_summary")
    if not isinstance(safe_summary, dict) or not safe_summary:
        missing.append("safe_summary")
    if missing:
        raise RuntimeError(
            f"cloudwatch logs subscription record_id {record_id!r} expectation missing {', '.join(missing)}; "
            "malformed records must set decode_error=true"
        )

    for index, value in enumerate(expected.get("subscription_filters") or []):
        if not str(value or "").strip():
            raise RuntimeError(
                f"cloudwatch logs subscription record_id {record_id!r} subscription_filters[{index}] is empty"
            )
    for index, event in enumerate(expected.get("log_events") or []):
        if not str((event or {}).get("id") or "").strip():
            raise RuntimeError(f"cloudwatch logs subscription record_id {record_id!r} log_events[{index}] missing id")
        if not str((event or {}).get("message") or "").strip():
            raise RuntimeError(
                f"cloudwatch logs subscription record_id {record_id!r} log_events[{index}] missing message"
            )
    if cloudwatch_logs_safe_summary_contains_forbidden(
        safe_summary,
        expected.get("forbidden_safe_log_substrings") or [],
    ):
        raise RuntimeError(
            f"cloudwatch logs subscription record_id {record_id!r} safe_summary contains forbidden raw log substring"
        )


def _runtime_cloudwatch_logs_subscription_decoder(runtime: Any):
    helper = getattr(runtime, "decode_cloudwatch_logs_subscription_record", None)
    if not callable(helper):
        helper = getattr(runtime, "decode_cloudwatch_logs_subscription", None)
    if not callable(helper):
        return missing_cloudwatch_logs_subscription_decoder
    return lambda record: helper(record)


def missing_cloudwatch_logs_subscription_decoder(_record: Any) -> dict[str, Any]:
    raise RuntimeError(CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER)


def make_cloudwatch_logs_subscription_kinesis_handler(
    fixture: dict[str, Any],
    decoder: Any | None = None,
):
    expectations = build_cloudwatch_logs_subscription_expectations(fixture)
    if decoder is None:
        decoder = missing_cloudwatch_logs_subscription_decoder

    def handler(_ctx: Any, record: dict[str, Any]) -> None:
        if expectations is None:
            raise RuntimeError("fixture missing validated cloudwatch logs subscription expectations")
        record_id = str((record or {}).get("eventID") or "").strip()
        expected = expectations.get(record_id)
        if expected is None:
            raise RuntimeError(f"missing cloudwatch logs subscription expectation for kinesis record_id {record_id!r}")

        actual = decoder(record)
        if expected.get("decode_error") is True:
            raise RuntimeError(
                f"cloudwatch logs subscription record_id {record_id!r} expected decode_error=true, got decoded record"
            )

        ok, reason = compare_cloudwatch_logs_subscription_decoded_record(expected, actual)
        if not ok:
            raise RuntimeError(reason)

    return handler


def compare_cloudwatch_logs_subscription_decoded_record(
    expected: dict[str, Any],
    actual: dict[str, Any],
) -> tuple[bool, str]:
    record_id = str((expected or {}).get("record_id") or "").strip()
    actual_record_id = str((actual or {}).get("record_id") or "").strip()
    if actual_record_id and actual_record_id != record_id:
        return (
            False,
            f"cloudwatch logs subscription record_id mismatch: expected {record_id!r}, got {actual_record_id!r}",
        )
    for key in ("message_type", "owner", "log_group", "log_stream"):
        if str((actual or {}).get(key) or "").strip() != str((expected or {}).get(key) or "").strip():
            return False, f"cloudwatch logs subscription record_id {record_id!r} {key} mismatch"
    expected_filters = (expected or {}).get("subscription_filters") or []
    actual_filters = (actual or {}).get("subscription_filters") or []
    if expected_filters != actual_filters:
        return False, f"cloudwatch logs subscription record_id {record_id!r} subscription_filters mismatch"
    expected_events = (expected or {}).get("log_events") or []
    actual_events = (actual or {}).get("log_events") or []
    if expected_events != actual_events:
        return False, f"cloudwatch logs subscription record_id {record_id!r} log_events mismatch"
    expected_summary = (expected or {}).get("safe_summary") or {}
    actual_summary = (actual or {}).get("safe_summary") or {}
    if expected_summary != actual_summary:
        return False, f"cloudwatch logs subscription record_id {record_id!r} safe_summary mismatch"
    if cloudwatch_logs_safe_summary_contains_forbidden(
        actual_summary,
        (expected or {}).get("forbidden_safe_log_substrings") or [],
    ):
        return (
            False,
            f"cloudwatch logs subscription record_id {record_id!r} safe_summary contains forbidden raw log substring",
        )
    return True, ""


def cloudwatch_logs_safe_summary_contains_forbidden(safe_summary: Any, forbidden_substrings: Any) -> bool:
    if not isinstance(safe_summary, dict) or not isinstance(forbidden_substrings, list):
        return False
    serialized = json.dumps(safe_summary, sort_keys=True, separators=(",", ":"))
    return any(str(substring or "") and str(substring) in serialized for substring in forbidden_substrings)


def _m1_log_record(record: Any) -> dict[str, Any]:
    output = {
        "level": getattr(record, "level", ""),
        "event": getattr(record, "event", ""),
        "request_id": getattr(record, "request_id", ""),
        "tenant_id": getattr(record, "tenant_id", ""),
        "method": getattr(record, "method", ""),
        "path": getattr(record, "path", ""),
        "status": getattr(record, "status", 0),
        "error_code": getattr(record, "error_code", ""),
    }
    for name in (
        "trigger",
        "correlation_id",
        "source",
        "detail_type",
        "table_name",
        "event_id",
        "event_name",
    ):
        value = str(getattr(record, name, "") or "").strip()
        if value:
            output[name] = value
    return output


def canonical_response_from_apigw_proxy(resp: dict[str, Any]) -> CanonicalResponse:
    status = int(resp.get("statusCode") or 0)
    is_base64 = bool(resp.get("isBase64Encoded"))
    body_str = str(resp.get("body") or "")
    body = base64.b64decode(body_str) if is_base64 else body_str.encode("utf-8")

    headers: dict[str, list[str]] = {}
    multi = resp.get("multiValueHeaders") or {}
    if isinstance(multi, dict):
        for key, values in multi.items():
            headers[str(key)] = [str(v) for v in (values or [])]
    single = resp.get("headers") or {}
    if isinstance(single, dict):
        for key, value in single.items():
            if key in headers:
                continue
            headers[str(key)] = [str(value)]

    headers = canonicalize_headers(headers)
    cookies = list(headers.get("set-cookie", []))
    if "set-cookie" in headers:
        del headers["set-cookie"]

    return CanonicalResponse(
        status=status,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=is_base64,
    )


def compare_websocket_calls(expected: list[dict[str, Any]] | None, fake: FakeWebSocketManagementClient | None) -> str:
    exp_calls = expected or []
    if not exp_calls:
        if fake is None or not fake.calls:
            return ""
        return f"unexpected ws_calls ({len(fake.calls)})"
    if fake is None:
        return "expected ws_calls but client was not created"
    if len(exp_calls) != len(fake.calls):
        return f"ws_calls length mismatch: expected {len(exp_calls)}, got {len(fake.calls)}"

    for i, exp in enumerate(exp_calls):
        got = fake.calls[i]
        if str(exp.get("op") or "").strip() != got.op:
            return f"ws_calls[{i}].op mismatch"
        endpoint = str(exp.get("endpoint") or "").strip()
        if endpoint and endpoint != got.endpoint:
            return f"ws_calls[{i}].endpoint mismatch"
        if str(exp.get("connection_id") or "").strip() != got.connection_id:
            return f"ws_calls[{i}].connection_id mismatch"

        data_obj = exp.get("data")
        if data_obj is None:
            if got.data:
                return f"ws_calls[{i}].data mismatch"
            continue
        want = decode_fixture_body(data_obj)
        if want != got.data:
            return f"ws_calls[{i}].data mismatch"

    return ""


def run_fixture_m2(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()

    fake: FakeWebSocketManagementClient | None = None

    def websocket_client_factory(endpoint: str, _ctx):
        nonlocal fake
        if fake is None:
            fake = FakeWebSocketManagementClient(endpoint)
        return fake

    app = runtime.create_app(
        tier="p0",
        websocket_client_factory=websocket_client_factory,
    )

    setup = fixture.get("setup", {}) or {}
    for route in setup.get("websockets", []) or []:
        handler = _built_in_websocket_handler(runtime, str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown websocket handler {route.get('handler')!r}")
        app.websocket(str(route.get("route_key") or ""), handler)

    input_ = fixture.get("input", {}) or {}
    aws_event = (input_ or {}).get("aws_event") or {}
    event = (aws_event or {}).get("event")
    if not isinstance(event, dict):
        raise RuntimeError("fixture missing input.aws_event.event")

    out = app.handle_lambda(event, ctx={})
    if not isinstance(out, dict):
        raise RuntimeError(f"expected websocket proxy response, got {type(out)!r}")

    actual = canonical_response_from_apigw_proxy(out)
    expected = fixture.get("expect", {}).get("response", {})
    ok, reason, actual, expected, dummy = run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())
    if not ok:
        return ok, reason, actual, expected, dummy

    ws_reason = compare_websocket_calls((fixture.get("expect", {}) or {}).get("ws_calls"), fake)
    if ws_reason:
        return False, ws_reason, actual, expected, dummy

    return True, "", actual, expected, dummy


def run_fixture_m3(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    app = runtime.create_app(tier="p0")

    setup = fixture.get("setup", {}) or {}
    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    input_ = fixture.get("input", {}) or {}
    aws_event = (input_ or {}).get("aws_event") or {}
    event = (aws_event or {}).get("event")
    if not isinstance(event, dict):
        raise RuntimeError("fixture missing input.aws_event.event")

    out = app.handle_lambda(event, ctx={})
    if not isinstance(out, dict):
        raise RuntimeError(f"expected apigw proxy response, got {type(out)!r}")

    actual = canonical_response_from_apigw_proxy(out)
    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())


def run_fixture_m12(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")
    effects = _DummyEffectsApp()

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    app = runtime.create_app(
        tier="p1",
        http_error_format=str(setup.get("http_error_format") or ""),
        id_generator=ids,
        limits=runtime.Limits(
            max_request_bytes=int(limits.get("max_request_bytes") or 0),
            max_response_bytes=int(limits.get("max_response_bytes") or 0),
        ),
        auth_hook=lambda ctx: _fixture_auth_hook(runtime, ctx),
    )

    for name in setup.get("middlewares", []) or []:
        mw = _built_in_m12_middleware(runtime, str(name or "").strip())
        if mw is None:
            raise RuntimeError(f"unknown middleware {name!r}")
        app.use(mw)

    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name, effects)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    input_ = fixture.get("input", {}).get("request", {})
    req_body = decode_fixture_body(input_.get("body"))
    req = runtime.Request(
        method=input_.get("method", ""),
        path=input_.get("path", ""),
        query=input_.get("query") or {},
        headers=input_.get("headers") or {},
        body=req_body,
        is_base64=bool(input_.get("is_base64")),
    )

    runtime_ctx = {"remaining_ms": int((fixture.get("input", {}).get("context", {}) or {}).get("remaining_ms") or 0)}
    resp = app.serve(req, runtime_ctx)
    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )

    expected = fixture.get("expect", {}).get("response", {})
    time.sleep(0.03)
    return run_fixture_compare(fixture, actual, expected, effects)


def run_fixture_m14(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    app = runtime.create_app(
        tier="p1",
        http_error_format=str(setup.get("http_error_format") or ""),
        id_generator=ids,
        limits=runtime.Limits(
            max_request_bytes=int(limits.get("max_request_bytes") or 0),
            max_response_bytes=int(limits.get("max_response_bytes") or 0),
        ),
        auth_hook=lambda ctx: _fixture_auth_hook(runtime, ctx),
    )

    for name in setup.get("middlewares", []) or []:
        mw = _built_in_m12_middleware(runtime, str(name or "").strip())
        if mw is None:
            raise RuntimeError(f"unknown middleware {name!r}")
        app.use(mw)

    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    input_ = fixture.get("input", {}).get("request", {})
    req_body = decode_fixture_body(input_.get("body"))
    req = runtime.Request(
        method=input_.get("method", ""),
        path=input_.get("path", ""),
        query=input_.get("query") or {},
        headers=input_.get("headers") or {},
        body=req_body,
        is_base64=bool(input_.get("is_base64")),
    )

    runtime_ctx = {"remaining_ms": int((fixture.get("input", {}).get("context", {}) or {}).get("remaining_ms") or 0)}
    resp = app.serve(req, runtime_ctx)

    chunks: list[bytes] = []
    parts: list[bytes] = []
    if resp.body:
        chunks.append(bytes(resp.body))
        parts.append(bytes(resp.body))

    stream_error_code = ""
    stream = getattr(resp, "body_stream", None)
    if stream is not None:
        try:
            for chunk in stream:
                b = bytes(chunk or b"")
                chunks.append(b)
                parts.append(b)
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, runtime.AppError):
                stream_error_code = str(exc.code or "")
            else:
                stream_error_code = "app.internal"

    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=b"".join(parts),
        is_base64=resp.is_base64,
        chunks=chunks,
        stream_error_code=stream_error_code,
    )

    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())


def run_fixture_p0(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    app = runtime.create_app(tier="p0")

    setup = fixture.get("setup", {})
    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(route.get("method", ""), route.get("path", ""), handler)

    aws_event = (fixture.get("input", {}) or {}).get("aws_event")
    if aws_event:
        source = str((aws_event or {}).get("source") or "").strip().lower()
        event = (aws_event or {}).get("event") or {}
        if source == "apigw_v2":
            out = app.serve_apigw_v2(event)
            actual = canonical_response_from_apigw_v2(out)
        elif source == "lambda_function_url":
            out = app.serve_lambda_function_url(event)
            actual = canonical_response_from_lambda_function_url(out)
        elif source == "alb":
            out = app.serve_alb(event)
            actual = canonical_response_from_apigw_proxy(out)
        else:
            raise RuntimeError(f"unknown aws_event source {source!r}")

        expected = fixture.get("expect", {}).get("response", {})
        return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())

    input_ = fixture.get("input", {}).get("request", {})
    req_body = decode_fixture_body(input_.get("body"))
    req = runtime.Request(
        method=input_.get("method", ""),
        path=input_.get("path", ""),
        query=input_.get("query") or {},
        headers=input_.get("headers") or {},
        body=req_body,
        is_base64=bool(input_.get("is_base64")),
    )

    resp = app.serve(req)
    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )

    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())


def canonical_response_from_apigw_v2(resp: dict[str, Any]) -> CanonicalResponse:
    status = int(resp.get("statusCode") or 0)
    is_base64 = bool(resp.get("isBase64Encoded"))
    body_str = str(resp.get("body") or "")
    body = base64.b64decode(body_str) if is_base64 else body_str.encode("utf-8")

    headers: dict[str, list[str]] = {}
    multi = resp.get("multiValueHeaders") or {}
    if isinstance(multi, dict) and len(multi) > 0:
        for key, values in multi.items():
            headers[str(key)] = [str(v) for v in (values or [])]
    else:
        single = resp.get("headers") or {}
        for key, value in (single or {}).items():
            headers[str(key)] = [str(value)]

    cookies = [str(c) for c in (resp.get("cookies") or [])]

    return CanonicalResponse(
        status=status,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=is_base64,
    )


def canonical_response_from_lambda_function_url(resp: dict[str, Any]) -> CanonicalResponse:
    status = int(resp.get("statusCode") or 0)
    is_base64 = bool(resp.get("isBase64Encoded"))
    body_str = str(resp.get("body") or "")
    body = base64.b64decode(body_str) if is_base64 else body_str.encode("utf-8")

    headers: dict[str, list[str]] = {}
    for key, value in (resp.get("headers") or {}).items():
        headers[str(key)] = [str(value)]

    cookies = [str(c) for c in (resp.get("cookies") or [])]

    return CanonicalResponse(
        status=status,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=is_base64,
    )


def run_fixture_p1(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    cors_setup = setup.get("cors", None)
    cors = None
    if isinstance(cors_setup, dict):
        allowed_origins = None
        if "allowed_origins" in cors_setup:
            raw = cors_setup.get("allowed_origins")
            allowed_origins = [str(v) for v in raw] if isinstance(raw, list) else []

        allow_headers = None
        if "allow_headers" in cors_setup:
            raw = cors_setup.get("allow_headers")
            allow_headers = [str(v) for v in raw] if isinstance(raw, list) else []

        if allowed_origins is not None or allow_headers is not None or bool(cors_setup.get("allow_credentials")):
            cors = runtime.CORSConfig(
                allowed_origins=allowed_origins,
                allow_credentials=bool(cors_setup.get("allow_credentials")),
                allow_headers=allow_headers,
            )
    app = runtime.create_app(
        tier="p1",
        http_error_format=str(setup.get("http_error_format") or ""),
        id_generator=ids,
        limits=runtime.Limits(
            max_request_bytes=int(limits.get("max_request_bytes") or 0),
            max_response_bytes=int(limits.get("max_response_bytes") or 0),
        ),
        cors=cors,
        auth_hook=lambda ctx: _fixture_auth_hook(runtime, ctx),
    )

    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    input_ = fixture.get("input", {}).get("request", {})
    req_body = decode_fixture_body(input_.get("body"))
    req = runtime.Request(
        method=input_.get("method", ""),
        path=input_.get("path", ""),
        query=input_.get("query") or {},
        headers=input_.get("headers") or {},
        body=req_body,
        is_base64=bool(input_.get("is_base64")),
    )

    runtime_ctx = {"remaining_ms": int((fixture.get("input", {}).get("context", {}) or {}).get("remaining_ms") or 0)}
    resp = app.serve(req, runtime_ctx)
    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )

    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())


def run_fixture_p2(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")

    effects = _DummyEffectsApp()

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    cors_setup = setup.get("cors", None)
    cors = None
    if isinstance(cors_setup, dict):
        allowed_origins = None
        if "allowed_origins" in cors_setup:
            raw = cors_setup.get("allowed_origins")
            allowed_origins = [str(v) for v in raw] if isinstance(raw, list) else []

        allow_headers = None
        if "allow_headers" in cors_setup:
            raw = cors_setup.get("allow_headers")
            allow_headers = [str(v) for v in raw] if isinstance(raw, list) else []

        if allowed_origins is not None or allow_headers is not None or bool(cors_setup.get("allow_credentials")):
            cors = runtime.CORSConfig(
                allowed_origins=allowed_origins,
                allow_credentials=bool(cors_setup.get("allow_credentials")),
                allow_headers=allow_headers,
            )
    app = runtime.create_app(
        tier="p2",
        http_error_format=str(setup.get("http_error_format") or ""),
        id_generator=ids,
        limits=runtime.Limits(
            max_request_bytes=int(limits.get("max_request_bytes") or 0),
            max_response_bytes=int(limits.get("max_response_bytes") or 0),
        ),
        cors=cors,
        auth_hook=lambda ctx: _fixture_auth_hook(runtime, ctx),
        policy_hook=lambda ctx: _fixture_policy_hook(runtime, ctx),
        observability=runtime.ObservabilityHooks(
            log=lambda r: effects.logs.append(
                {
                    "level": r.level,
                    "event": r.event,
                    "request_id": r.request_id,
                    "tenant_id": r.tenant_id,
                    "method": r.method,
                    "path": r.path,
                    "status": r.status,
                    "error_code": r.error_code,
                }
            ),
            metric=lambda r: effects.metrics.append({"name": r.name, "value": r.value, "tags": r.tags}),
            span=lambda r: effects.spans.append({"name": r.name, "attributes": r.attributes}),
        ),
    )

    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    input_ = fixture.get("input", {}).get("request", {})
    req_body = decode_fixture_body(input_.get("body"))
    req = runtime.Request(
        method=input_.get("method", ""),
        path=input_.get("path", ""),
        query=input_.get("query") or {},
        headers=input_.get("headers") or {},
        body=req_body,
        is_base64=bool(input_.get("is_base64")),
    )

    runtime_ctx = {"remaining_ms": int((fixture.get("input", {}).get("context", {}) or {}).get("remaining_ms") or 0)}
    resp = app.serve(req, runtime_ctx)
    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )

    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, effects)


def run_fixture_p2_output(fixture: dict[str, Any]) -> tuple[bool, str, dict[str, Any], dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")

    effects = _DummyEffectsApp()

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    cors_setup = setup.get("cors", None)
    cors = None
    if isinstance(cors_setup, dict):
        allowed_origins = None
        if "allowed_origins" in cors_setup:
            raw = cors_setup.get("allowed_origins")
            allowed_origins = [str(v) for v in raw] if isinstance(raw, list) else []

        allow_headers = None
        if "allow_headers" in cors_setup:
            raw = cors_setup.get("allow_headers")
            allow_headers = [str(v) for v in raw] if isinstance(raw, list) else []

        if allowed_origins is not None or allow_headers is not None or bool(cors_setup.get("allow_credentials")):
            cors = runtime.CORSConfig(
                allowed_origins=allowed_origins,
                allow_credentials=bool(cors_setup.get("allow_credentials")),
                allow_headers=allow_headers,
            )
    app = runtime.create_app(
        tier="p2",
        id_generator=ids,
        limits=runtime.Limits(
            max_request_bytes=int(limits.get("max_request_bytes") or 0),
            max_response_bytes=int(limits.get("max_response_bytes") or 0),
        ),
        cors=cors,
        auth_hook=lambda ctx: _fixture_auth_hook(runtime, ctx),
        policy_hook=lambda ctx: _fixture_policy_hook(runtime, ctx),
        observability=runtime.ObservabilityHooks(
            log=lambda r: effects.logs.append(
                {
                    "level": r.level,
                    "event": r.event,
                    "request_id": r.request_id,
                    "tenant_id": r.tenant_id,
                    "method": r.method,
                    "path": r.path,
                    "status": r.status,
                    "error_code": r.error_code,
                }
            ),
            metric=lambda r: effects.metrics.append({"name": r.name, "value": r.value, "tags": r.tags}),
            span=lambda r: effects.spans.append({"name": r.name, "attributes": r.attributes}),
        ),
    )

    for route in setup.get("routes", []) or []:
        name = str(route.get("handler", ""))
        handler = _built_in_apptheory_handler(runtime, name)
        if handler is None:
            raise RuntimeError(f"unknown handler {name!r}")
        app.handle(
            route.get("method", ""),
            route.get("path", ""),
            handler,
            auth_required=bool(route.get("auth_required")),
        )

    aws_event = (fixture.get("input", {}) or {}).get("aws_event")
    if not aws_event:
        raise RuntimeError("fixture missing input.aws_event")
    source = str((aws_event or {}).get("source") or "").strip().lower()
    if source != "appsync":
        raise RuntimeError(f"unknown aws_event source {source!r}")

    actual_output = None
    actual_error: Exception | None = None
    try:
        actual_output = app.handle_lambda(
            (aws_event or {}).get("event") or {},
            ctx=_fixture_lambda_context((fixture.get("input", {}) or {}).get("context") or {}),
        )
    except Exception as exc:  # noqa: BLE001
        actual_error = exc

    expect_obj = fixture.get("expect", {}) or {}
    if "error" in expect_obj:
        if "output_json" in expect_obj:
            return (
                False,
                "fixture expect cannot set both error and output_json",
                {"message": str(actual_error or "").strip()} if actual_error else None,
                expect_obj.get("error"),
                effects,
            )
        expected_error = expect_obj.get("error") or {}
        expected_msg = str((expected_error or {}).get("message") or "").strip()
        if actual_error is None:
            return False, "expected error, got none", actual_output, expected_error, effects
        actual_msg = str(actual_error).strip()
        if expected_msg and actual_msg != expected_msg:
            return False, "error mismatch", {"message": actual_msg}, expected_error, effects
        return True, "", {"message": actual_msg}, expected_error, effects

    if "output_json" not in expect_obj:
        return False, "missing expect.output_json or expect.error", actual_output, None, effects
    if actual_error is not None:
        return False, "unexpected error", {"message": str(actual_error).strip()}, expect_obj.get("output_json"), effects

    expected_output = expect_obj.get("output_json")
    if stable_json(expected_output) != stable_json(actual_output):
        return False, "output_json mismatch", actual_output, expected_output, effects

    return True, "", actual_output, expected_output, effects


def _fixture_policy_hook(runtime, ctx):
    headers = getattr(getattr(ctx, "request", None), "headers", {}) or {}
    if str((headers.get("x-force-rate-limit-content-type") or [""])[0]).strip():
        return runtime.PolicyDecision(
            code="app.rate_limited",
            message="rate limited",
            headers={"retry-after": ["1"], "Content-Type": ["text/plain; charset=utf-8"]},
        )
    if str((headers.get("x-force-rate-limit") or [""])[0]).strip():
        return runtime.PolicyDecision(
            code="app.rate_limited",
            message="rate limited",
            headers={"retry-after": ["1"]},
        )
    if str((headers.get("x-force-shed") or [""])[0]).strip():
        return runtime.PolicyDecision(
            code="app.overloaded",
            message="overloaded",
            headers={"retry-after": ["1"]},
        )
    return None


def _fixture_auth_hook(runtime, ctx):
    headers = getattr(getattr(ctx, "request", None), "headers", {}) or {}
    values = headers.get("authorization", [])
    authz = str(values[0]) if values else ""
    if not authz.strip():
        raise runtime.AppError("app.unauthorized", "unauthorized")
    if str((headers.get("x-force-forbidden") or [""])[0]).strip():
        raise runtime.AppError("app.forbidden", "forbidden")
    return "authorized"


def run_fixture_compare(
    fixture: dict[str, Any],
    actual: CanonicalResponse,
    expected: dict[str, Any],
    app: FixtureApp,
) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    if expected.get("status") != actual.status:
        return False, f"status: expected {expected.get('status')}, got {actual.status}", actual, expected, app

    if bool(expected.get("is_base64")) != actual.is_base64:
        return False, "is_base64 mismatch", actual, expected, app

    if (expected.get("cookies") or []) != actual.cookies:
        return False, "cookies mismatch", actual, expected, app

    if not compare_headers(expected.get("headers"), actual.headers):
        return False, "headers mismatch", actual, expected, app

    expected_stream_error_code = str(expected.get("stream_error_code") or "")
    if expected_stream_error_code != actual.stream_error_code:
        return False, "stream_error_code mismatch", actual, expected, app

    if "body_json" in expected:
        try:
            actual_json = json.loads(actual.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return False, "body_json mismatch", actual, expected, app
        if expected["body_json"] != actual_json:
            return False, "body_json mismatch", actual, expected, app

        if (fixture.get("expect", {}).get("logs") or []) != app.logs:
            return False, "logs mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
            return False, "metrics mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("spans") or []) != app.spans:
            return False, "spans mismatch", actual, expected, app

        return True, "", actual, expected, app

    expected_chunks_raw = expected.get("chunks")
    if isinstance(expected_chunks_raw, list) and len(expected_chunks_raw) > 0:
        expected_chunks = [decode_fixture_body(b) for b in expected_chunks_raw]
        if expected_chunks != actual.chunks:
            return False, "chunks mismatch", actual, expected, app

        expected_body = (
            decode_fixture_body(expected.get("body")) if expected.get("body") is not None else b"".join(expected_chunks)
        )
        if expected_body != actual.body:
            return False, "body mismatch", actual, expected, app

        if (fixture.get("expect", {}).get("logs") or []) != app.logs:
            return False, "logs mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
            return False, "metrics mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("spans") or []) != app.spans:
            return False, "spans mismatch", actual, expected, app

        return True, "", actual, expected, app

    if expected.get("body") is not None:
        expected_bytes = decode_fixture_body(expected.get("body"))
        if expected_bytes != actual.body:
            return False, "body mismatch", actual, expected, app

        if (fixture.get("expect", {}).get("logs") or []) != app.logs:
            return False, "logs mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
            return False, "metrics mismatch", actual, expected, app
        if (fixture.get("expect", {}).get("spans") or []) != app.spans:
            return False, "spans mismatch", actual, expected, app

        return True, "", actual, expected, app

    if actual.body != b"":
        return False, "body mismatch", actual, expected, app

    if (fixture.get("expect", {}).get("logs") or []) != app.logs:
        return False, "logs mismatch", actual, expected, app
    if (fixture.get("expect", {}).get("metrics") or []) != app.metrics:
        return False, "metrics mismatch", actual, expected, app
    if (fixture.get("expect", {}).get("spans") or []) != app.spans:
        return False, "spans mismatch", actual, expected, app

    return True, "", actual, expected, app


def debug_actual_for_expected(actual: CanonicalResponse, expected: dict[str, Any]) -> dict[str, Any]:
    debug: dict[str, Any] = {
        "status": actual.status,
        "headers": canonicalize_headers(actual.headers),
        "cookies": actual.cookies,
        "is_base64": actual.is_base64,
    }
    if "body_json" in expected:
        try:
            debug["body_json"] = json.loads(actual.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            debug["body"] = {
                "encoding": "base64",
                "value": base64.b64encode(actual.body).decode("ascii"),
            }
    else:
        debug["body"] = {
            "encoding": "base64",
            "value": base64.b64encode(actual.body).decode("ascii"),
        }
    return debug


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", default="contract-tests/fixtures")
    args = parser.parse_args()

    fixtures_root = Path(args.fixtures)
    fixtures = load_fixtures(fixtures_root)

    failed: list[dict[str, Any]] = []
    for fixture in fixtures:
        ok, reason, actual, expected, app = run_fixture(fixture)
        if ok:
            continue
        print(f"FAIL {fixture['id']} — {fixture.get('name', '')}", file=sys.stderr)
        print(f"  {reason}", file=sys.stderr)
        expect_obj = fixture.get("expect", {}) or {}
        if "output_json" in expect_obj or "error" in expect_obj:
            if "error" in expect_obj:
                print(f"  expected.error: {stable_json(expected)}", file=sys.stderr)
                print(f"  got.error: {stable_json(actual)}", file=sys.stderr)
            else:
                print(f"  expected.output_json: {stable_json(expected)}", file=sys.stderr)
                if "error" in reason:
                    print(f"  got.error: {stable_json(actual)}", file=sys.stderr)
                else:
                    print(f"  got.output_json: {stable_json(actual)}", file=sys.stderr)
        elif (
            "logging_profile_catalog" in expect_obj
            or "profile_validation_errors" in expect_obj
            or "profile_logs" in expect_obj
        ):
            if "logging_profile_catalog" in expect_obj:
                print(
                    f"  expected.logging_profile_catalog: {stable_json(expect_obj.get('logging_profile_catalog'))}",
                    file=sys.stderr,
                )
                print(
                    f"  got.logging_profile_catalog: {stable_json(actual.get('logging_profile_catalog'))}",
                    file=sys.stderr,
                )
            if "profile_validation_errors" in expect_obj:
                print(
                    f"  expected.profile_validation_errors: {stable_json(expect_obj.get('profile_validation_errors'))}",
                    file=sys.stderr,
                )
                print(
                    f"  got.profile_validation_errors: {stable_json(actual.get('profile_validation_errors'))}",
                    file=sys.stderr,
                )
            if "profile_logs" in expect_obj:
                print(f"  expected.profile_logs: {stable_json(expect_obj.get('profile_logs'))}", file=sys.stderr)
                print(f"  got.profile_logs: {stable_json(actual.get('profile_logs'))}", file=sys.stderr)
        elif "microvm_contract_validation" in expect_obj:
            print(f"  expected.microvm_contract_validation: {stable_json(expected)}", file=sys.stderr)
            print(f"  got.microvm_contract_validation: {stable_json(actual)}", file=sys.stderr)
        else:
            print(f"  expected: {stable_json(expected)}", file=sys.stderr)
            print(f"  got: {stable_json(debug_actual_for_expected(actual, expected))}", file=sys.stderr)
            print(f"  expected.logs: {stable_json(fixture.get('expect', {}).get('logs') or [])}", file=sys.stderr)
            print(f"  got.logs: {stable_json(app.logs)}", file=sys.stderr)
            print(f"  expected.metrics: {stable_json(fixture.get('expect', {}).get('metrics') or [])}", file=sys.stderr)
            print(f"  got.metrics: {stable_json(app.metrics)}", file=sys.stderr)
            print(f"  expected.spans: {stable_json(fixture.get('expect', {}).get('spans') or [])}", file=sys.stderr)
            print(f"  got.spans: {stable_json(app.spans)}", file=sys.stderr)
        failed.append(fixture)

    if failed:
        print("\nFailed fixtures:", file=sys.stderr)
        for fixture in sorted(failed, key=lambda f: f["id"]):
            print(f"- {fixture['id']}", file=sys.stderr)
        return 1

    print(f"contract-tests(py): PASS ({len(fixtures)} fixtures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
