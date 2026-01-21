#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_APPTHEORY_RUNTIME: Any | None = None


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
    for tier in ("p0", "p1", "p2", "m1", "m2", "m3", "m12", "m14"):
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


def run_fixture(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    tier = str(fixture.get("tier", "")).strip().lower()
    if tier == "p0":
        return run_fixture_p0(fixture)
    if tier == "p1":
        return run_fixture_p1(fixture)
    if tier == "p2":
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

    setup = fixture.get("setup", {})
    input_ = fixture.get("input", {})
    app = new_fixture_app(setup.get("routes", []), fixture.get("tier", ""), setup.get("limits", {}) or {})
    req = canonicalize_request(input_.get("request", {}), input_.get("context", {}))
    actual = app.handle(req)
    expected = fixture.get("expect", {}).get("response", {})

    if expected.get("status") != actual.status:
        return False, f"status: expected {expected.get('status')}, got {actual.status}", actual, expected, app

    if bool(expected.get("is_base64")) != actual.is_base64:
        return False, f"is_base64 mismatch", actual, expected, app

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


def _built_in_apptheory_handler(runtime: Any, name: str):
    if name == "static_pong":
        return lambda _ctx: runtime.text(200, "pong")

    if name == "sleep_50ms":
        def handler(_ctx):
            import time

            time.sleep(0.05)
            return runtime.text(200, "done")

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

    if name == "panic":
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


def _built_in_dynamodb_stream_handler(name: str):
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

    return None


def _built_in_eventbridge_handler(name: str):
    if name == "eventbridge_static_a":
        return lambda _ctx, _event: {"handler": "a"}
    if name == "eventbridge_static_b":
        return lambda _ctx, _event: {"handler": "b"}
    if name == "eventbridge_echo_event_middleware":
        return lambda ctx, _event: {"mw": ctx.get("mw"), "trace": ctx.get("trace")}
    return None


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
    app = runtime.create_app(tier="p0")

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

    for route in setup.get("dynamodb", []) or []:
        handler = _built_in_dynamodb_stream_handler(str(route.get("handler") or ""))
        if handler is None:
            raise RuntimeError(f"unknown dynamodb handler {route.get('handler')!r}")
        app.dynamodb(str(route.get("table") or ""), handler)

    for route in setup.get("eventbridge", []) or []:
        handler = _built_in_eventbridge_handler(str(route.get("handler") or ""))
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

    actual_output = app.handle_lambda(event, ctx={})
    expect_obj = fixture.get("expect", {}) or {}
    if "output_json" not in expect_obj:
        return False, "missing expect.output_json", actual_output, None, _DummyEffectsApp()

    expected_output = expect_obj.get("output_json")
    if stable_json(expected_output) != stable_json(actual_output):
        return False, "output_json mismatch", actual_output, expected_output, _DummyEffectsApp()

    return True, "", actual_output, expected_output, _DummyEffectsApp()


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

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    app = runtime.create_app(
        tier="p1",
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
    actual = CanonicalResponse(
        status=resp.status,
        headers=resp.headers,
        cookies=resp.cookies,
        body=resp.body,
        is_base64=resp.is_base64,
    )

    expected = fixture.get("expect", {}).get("response", {})
    return run_fixture_compare(fixture, actual, expected, _DummyEffectsApp())


def run_fixture_m14(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any], FixtureApp]:
    runtime = _load_apptheory_runtime()
    ids = runtime.ManualIdGenerator()
    ids.push("req_test_123")

    setup = fixture.get("setup", {})
    limits = setup.get("limits", {}) or {}
    app = runtime.create_app(
        tier="p1",
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

        expected_body = decode_fixture_body(expected.get("body")) if expected.get("body") is not None else b"".join(expected_chunks)
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
        if "output_json" in (fixture.get("expect", {}) or {}):
            print(f"  expected.output_json: {stable_json(expected)}", file=sys.stderr)
            print(f"  got.output_json: {stable_json(actual)}", file=sys.stderr)
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
