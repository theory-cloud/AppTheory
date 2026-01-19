#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class CanonicalRequest:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, list[str]]
    cookies: dict[str, str]
    body: bytes
    is_base64: bool
    path_params: dict[str, str]


@dataclass(frozen=True)
class CanonicalResponse:
    status: int
    headers: dict[str, list[str]]
    cookies: list[str]
    body: bytes
    is_base64: bool


class AppError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False)


def list_fixture_files(fixtures_root: Path) -> list[Path]:
    files: list[Path] = []
    for tier in ("p0", "p1", "p2"):
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


def canonicalize_request(req: dict[str, Any]) -> CanonicalRequest:
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
        "app.internal": 500,
    }.get(code, 500)


def app_error_response(code: str, message: str, extra_headers: dict[str, list[str]] | None = None) -> CanonicalResponse:
    headers = canonicalize_headers(extra_headers or {})
    headers["content-type"] = ["application/json; charset=utf-8"]
    body = json.dumps({"error": {"code": code, "message": message}}, separators=(",", ":")).encode("utf-8")
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

    return None


def new_fixture_app(routes: list[dict[str, Any]]):
    compiled = []
    for r in routes:
        compiled.append(
            {
                "method": str(r.get("method", "")).strip().upper(),
                "path": str(r.get("path", "")).strip(),
                "segments": split_path(str(r.get("path", ""))),
                "handler": str(r.get("handler", "")).strip(),
            }
        )

    def handle(req: CanonicalRequest) -> CanonicalResponse:
        match = None
        allowed: list[str] = []
        for route in compiled:
            ok, params = match_path(route["segments"], split_path(req.path))
            if not ok:
                continue
            allowed.append(route["method"])
            if route["method"] == req.method:
                match = (route, params)
                break

        if match is None:
            if allowed:
                return app_error_response(
                    "app.method_not_allowed",
                    "method not allowed",
                    {"allow": [format_allow_header(allowed)]},
                )
            return app_error_response("app.not_found", "not found")

        route, params = match
        handler = built_in_handler(route["handler"])
        if handler is None:
            return app_error_response("app.internal", "internal error")

        try:
            enriched = CanonicalRequest(
                method=req.method,
                path=req.path,
                query=req.query,
                headers=req.headers,
                cookies=req.cookies,
                body=req.body,
                is_base64=req.is_base64,
                path_params=params,
            )
            resp = handler(enriched)
            return CanonicalResponse(
                status=resp.status,
                headers=canonicalize_headers(resp.headers),
                cookies=resp.cookies,
                body=resp.body,
                is_base64=resp.is_base64,
            )
        except AppError as exc:
            return app_error_response(exc.code, exc.message)
        except Exception:  # noqa: BLE001
            return app_error_response("app.internal", "internal error")

    return handle


def compare_headers(expected: dict[str, Any] | None, actual: dict[str, Any] | None) -> bool:
    return canonicalize_headers(expected) == canonicalize_headers(actual)


def run_fixture(fixture: dict[str, Any]) -> tuple[bool, str, CanonicalResponse, dict[str, Any]]:
    app = new_fixture_app(fixture.get("setup", {}).get("routes", []))
    req = canonicalize_request(fixture.get("input", {}).get("request", {}))
    actual = app(req)
    expected = fixture.get("expect", {}).get("response", {})

    if expected.get("status") != actual.status:
        return False, f"status: expected {expected.get('status')}, got {actual.status}", actual, expected

    if bool(expected.get("is_base64")) != actual.is_base64:
        return False, f"is_base64 mismatch", actual, expected

    if (expected.get("cookies") or []) != actual.cookies:
        return False, "cookies mismatch", actual, expected

    if not compare_headers(expected.get("headers"), actual.headers):
        return False, "headers mismatch", actual, expected

    if "body_json" in expected:
        try:
            actual_json = json.loads(actual.body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return False, "body_json mismatch", actual, expected
        if expected["body_json"] != actual_json:
            return False, "body_json mismatch", actual, expected
        return True, "", actual, expected

    if expected.get("body") is not None:
        expected_bytes = decode_fixture_body(expected.get("body"))
        if expected_bytes != actual.body:
            return False, "body mismatch", actual, expected
        return True, "", actual, expected

    if actual.body != b"":
        return False, "body mismatch", actual, expected
    return True, "", actual, expected


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
        ok, reason, actual, expected = run_fixture(fixture)
        if ok:
            continue
        print(f"FAIL {fixture['id']} — {fixture.get('name', '')}", file=sys.stderr)
        print(f"  {reason}", file=sys.stderr)
        print(f"  expected: {stable_json(expected)}", file=sys.stderr)
        print(f"  got: {stable_json(debug_actual_for_expected(actual, expected))}", file=sys.stderr)
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

