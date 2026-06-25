#!/usr/bin/env python3
"""AppTheory MicroVM conformance harness and token leak scanner.

This script is intentionally dependency-free so external consumers can copy or
run it from a pinned AppTheory GitHub release asset without provisioning live AWS
credentials on the AppTheory side. Live mode talks only to a supplied AppTheory
MicroVM controller endpoint. Dry-run mode uses deterministic fixture transport
and makes no network calls.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

CANONICAL_COMMANDS: tuple[str, ...] = (
    "run",
    "get",
    "list",
    "suspend",
    "resume",
    "terminate",
    "auth-token",
    "shell-auth-token",
)

TERMINAL_STATES = {"terminated", "terminating", "stopped", "deleted", "deleting"}
DENIAL_STATUSES = {400, 401, 403, 404, 410, 422, 502}
AUTH_DENIAL_STATUSES = {401, 403}

SAFE_TOKEN_FIELD_NAMES = {
    "token_id",
    "token_type",
    "token_metadata",
    "tokens_metadata",
    "expires_at",
    "scope",
    "allowed_port_scope",
}

FORBIDDEN_FIELD_NAMES = {
    "account_wide_list_token",
    "authorization",
    "authorization_header",
    "auth_header",
    "auth_token",
    "auth_token_value",
    "bearer",
    "bearer_token",
    "credential",
    "credentials",
    "password",
    "plaintext_token",
    "provider_error",
    "provider_exception",
    "private_key",
    "provider_auth_token",
    "provider_secret",
    "provider_shell_token",
    "provider_token",
    "provider_token_value",
    "raw_aws_credentials",
    "raw_lifecycle_hook_payload",
    "raw_provider_error",
    "raw_provider_exception",
    "raw_secret",
    "raw_sdk_client",
    "raw_token",
    "refresh_token",
    "secret",
    "secret_access_key",
    "secret_key",
    "secret_value",
    "session_token",
    "session_token_plaintext",
    "shell_token",
    "token",
    "token_value",
    "x_amz_security_token",
    "x_aws_proxy_auth",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
}

SECRET_KEY_FRAGMENTS = (
    "secret",
    "password",
    "credential",
    "private_key",
)

SESSION_TOKEN_PLAINTEXT_TEXT_PATTERN = re.compile(
    r"(?i)(?:^|[^A-Za-z0-9_])session[_-]?token[_-]?plaintext(?![A-Za-z0-9_])"
    r"\s*[:=]\s*[\"']?[A-Za-z0-9._~+/=-]{1,}"
)

TEXT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer credential", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")),
    ("aws access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "secret-looking key/value",
        re.compile(
            r"(?i)\b(?!token_id\b|token_type\b|token_metadata\b)"
            r"(?:token|auth[_-]?token|secret|password|credential|api[_-]?key|private[_-]?key)"
            r"\s*[:=]\s*[\"']?[A-Za-z0-9._~+/=-]{8,}"
        ),
    ),
)


class ConformanceFailure(RuntimeError):
    """Raised when the harness cannot prove the requested contract boundary."""


@dataclasses.dataclass(slots=True)
class LeakFinding:
    artifact: str
    path: str
    kind: str
    message: str

    def format(self) -> str:
        location = f"{self.artifact}:{self.path}" if self.path else self.artifact
        return f"{location}: {self.kind}: {self.message}"


@dataclasses.dataclass(slots=True)
class HTTPResult:
    status: int
    body: str
    headers: Mapping[str, str] = dataclasses.field(default_factory=dict)

    def json(self) -> Any:
        if not self.body.strip():
            return None
        return json.loads(self.body)


@dataclasses.dataclass(slots=True)
class OperationProof:
    name: str
    status: int
    command: str = ""
    session_id: str = ""
    denied: bool = False


class LeakScanner:
    """Scans response, registry, and log artifacts for secret leakage.

    The scanner intentionally favors fail-closed findings over optimistic
    "sanitized" claims. It allows AppTheory's sanitized token metadata fields
    (`token_id`, `token_type`, `expires_at`, and `scope`) but treats plaintext
    token fields, bearer values, provider token values, and supplied sensitive
    values as leaks.
    """

    def __init__(self, sensitive_values: Iterable[str] = ()) -> None:
        self.sensitive_values = tuple(
            value.strip() for value in sensitive_values if isinstance(value, str) and value.strip()
        )

    def scan_text(self, artifact: str, text: str) -> list[LeakFinding]:
        findings: list[LeakFinding] = []
        for sensitive in self.sensitive_values:
            if sensitive and sensitive in text:
                findings.append(
                    LeakFinding(
                        artifact=artifact,
                        path="$",
                        kind="sensitive-value",
                        message="a supplied sensitive value appears in plaintext",
                    )
                )
        for kind, pattern in TEXT_PATTERNS:
            if pattern.search(text):
                findings.append(
                    LeakFinding(
                        artifact=artifact,
                        path="$",
                        kind=kind,
                        message="secret-looking text appears in artifact",
                    )
                )
        if SESSION_TOKEN_PLAINTEXT_TEXT_PATTERN.search(text):
            findings.append(
                LeakFinding(
                    artifact=artifact,
                    path="$",
                    kind="forbidden-field",
                    message="field 'session_token_plaintext' must not carry plaintext credentials or provider tokens",
                )
            )
        payload = _parse_json_maybe(text)
        if payload is not _NOT_JSON:
            findings.extend(self.scan_json(artifact, payload))
        return _dedupe_findings(findings)

    def scan_json(self, artifact: str, payload: Any) -> list[LeakFinding]:
        findings: list[LeakFinding] = []

        def visit(value: Any, path: str) -> None:
            if isinstance(value, Mapping):
                for raw_key, raw_child in value.items():
                    key = str(raw_key)
                    child_path = f"{path}.{key}" if path else key
                    normalized = _normalize_key(key)
                    if _is_safe_structural_key(key, raw_child):
                        visit(raw_child, child_path)
                        continue
                    if _is_forbidden_field(normalized) and _has_non_empty_value(raw_child):
                        findings.append(
                            LeakFinding(
                                artifact=artifact,
                                path=child_path,
                                kind="forbidden-field",
                                message=f"field {key!r} must not carry plaintext credentials or provider tokens",
                            )
                        )
                    elif _is_secret_looking_field(normalized) and _has_non_empty_value(raw_child):
                        findings.append(
                            LeakFinding(
                                artifact=artifact,
                                path=child_path,
                                kind="secret-looking-field",
                                message=f"field {key!r} looks credential-bearing and is not sanitized metadata",
                            )
                        )
                    visit(raw_child, child_path)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    visit(child, f"{path}[{index}]")
            elif isinstance(value, str):
                for sensitive in self.sensitive_values:
                    if sensitive and sensitive in value:
                        findings.append(
                            LeakFinding(
                                artifact=artifact,
                                path=path or "$",
                                kind="sensitive-value",
                                message="a supplied sensitive value appears in plaintext",
                            )
                        )
                for kind, pattern in TEXT_PATTERNS:
                    if pattern.search(value):
                        findings.append(
                            LeakFinding(
                                artifact=artifact,
                                path=path or "$",
                                kind=kind,
                                message="secret-looking text appears in JSON value",
                            )
                        )

        visit(payload, "$")
        return _dedupe_findings(findings)

    def assert_clean(self, artifacts: Mapping[str, str]) -> None:
        findings: list[LeakFinding] = []
        for name, text in artifacts.items():
            findings.extend(self.scan_text(name, text))
        if findings:
            formatted = "\n".join(finding.format() for finding in findings)
            raise ConformanceFailure(f"token leak scanner failed closed:\n{formatted}")


class MicroVMConformanceHarness:
    def __init__(self, config: Mapping[str, Any], transport: "Transport", scanner: LeakScanner) -> None:
        self.config = config
        self.transport = transport
        self.scanner = scanner
        self.tenant_id = _required_string(config, "tenant_id")
        self.namespace = _required_string(config, "namespace")
        negative = config.get("negative", {})
        if not isinstance(negative, Mapping):
            negative = {}
        self.negative_tenant_id = str(negative.get("tenant_id") or f"{self.tenant_id}-negative")
        self.negative_namespace = str(negative.get("namespace") or f"{self.namespace}-negative")
        self.response_artifacts: dict[str, str] = {}
        self.proofs: list[OperationProof] = []

    def run(self) -> list[OperationProof]:
        self._prove_auth_fail_closed()
        run_payload = self._request_json("POST", "/microvms", self._run_body(), "run")
        session_id = _required_payload_string(run_payload, "session_id", "run response")
        self._expect_success(run_payload, "run", session_id=session_id)

        self._expect_success(
            self._request_json("GET", f"/microvms/{_quote_path(session_id)}", None, "get"),
            "get",
            session_id=session_id,
        )
        self._prove_registry_list_is_tenant_bound(session_id)
        self._prove_tenant_and_namespace_fail_closed(session_id)

        self._expect_success(
            self._request_json("POST", f"/microvms/{_quote_path(session_id)}/suspend", {}, "suspend"),
            "suspend",
            session_id=session_id,
        )
        self._expect_success(
            self._request_json("POST", f"/microvms/{_quote_path(session_id)}/resume", {}, "resume"),
            "resume",
            session_id=session_id,
        )
        self._expect_token_metadata(
            self._request_json(
                "POST",
                f"/microvms/{_quote_path(session_id)}/auth-token",
                {"allowed_port_scope": [{"port": 443}]},
                "auth-token",
            ),
            "auth-token",
            session_id,
        )
        self._expect_token_metadata(
            self._request_json(
                "POST",
                f"/microvms/{_quote_path(session_id)}/shell-auth-token",
                {},
                "shell-auth-token",
            ),
            "shell-auth-token",
            session_id,
        )
        self._expect_success(
            self._request_json("DELETE", f"/microvms/{_quote_path(session_id)}", {}, "terminate"),
            "terminate",
            session_id=session_id,
        )
        self._prove_terminal_or_denied(session_id)
        self._scan_supplied_artifacts(session_id)
        self.scanner.assert_clean(self.response_artifacts)
        self._assert_full_vocabulary()
        return self.proofs

    def _prove_auth_fail_closed(self) -> None:
        missing = self._request("GET", "/microvms?max_results=1", None, "missing-auth", auth_mode="missing")
        self._expect_denied("missing-auth", missing, AUTH_DENIAL_STATUSES)
        invalid = self._request("GET", "/microvms?max_results=1", None, "invalid-auth", auth_mode="invalid")
        self._expect_denied("invalid-auth", invalid, AUTH_DENIAL_STATUSES)

    def _prove_registry_list_is_tenant_bound(self, session_id: str) -> None:
        payload = self._request_json("GET", "/microvms?max_results=50", None, "list")
        self._expect_success(payload, "list", session_id=session_id, allow_empty_session=True)
        sessions = payload.get("sessions") if isinstance(payload, Mapping) else None
        if not isinstance(sessions, list):
            raise ConformanceFailure("list response must include a tenant-bound sessions array")
        if not any(isinstance(item, Mapping) and item.get("session_id") == session_id for item in sessions):
            raise ConformanceFailure("list response did not include the session created by this harness")
        self._assert_records_tenant_bound(sessions, session_id, "list response")
        self.proofs.append(OperationProof(name="list", status=200, command="list", session_id=session_id))

    def _prove_tenant_and_namespace_fail_closed(self, session_id: str) -> None:
        tenant_result = self._request(
            "GET",
            f"/microvms/{_quote_path(session_id)}?tenant_id={urllib.parse.quote(self.negative_tenant_id)}",
            None,
            "tenant-mismatch-get",
        )
        self._expect_denied("tenant-mismatch-get", tenant_result, DENIAL_STATUSES)

        namespace_result = self._request(
            "GET",
            f"/microvms/{_quote_path(session_id)}",
            None,
            "namespace-mismatch-get",
            namespace=self.negative_namespace,
        )
        if 200 <= namespace_result.status < 300:
            payload = self._json_or_fail(namespace_result, "namespace-mismatch-get")
            if isinstance(payload, Mapping) and payload.get("session_id") == session_id:
                raise ConformanceFailure("namespace-mismatch-get returned the tenant session instead of failing closed")
        else:
            self._expect_denied("namespace-mismatch-get", namespace_result, DENIAL_STATUSES)

    def _prove_terminal_or_denied(self, session_id: str) -> None:
        result = self._request("GET", f"/microvms/{_quote_path(session_id)}", None, "post-terminate-get")
        if 200 <= result.status < 300:
            payload = self._json_or_fail(result, "post-terminate-get")
            if not isinstance(payload, Mapping):
                raise ConformanceFailure("post-terminate-get returned non-object JSON")
            state_text = " ".join(
                str(payload.get(field) or "") for field in ("state", "lifecycle_state", "provider_state")
            ).lower()
            if not any(state in state_text for state in TERMINAL_STATES):
                raise ConformanceFailure("post-terminate-get did not report a terminal state")
            self.proofs.append(
                OperationProof(
                    name="post-terminate-get",
                    status=result.status,
                    command=str(payload.get("command") or "get"),
                    session_id=session_id,
                )
            )
            return
        self._expect_denied("post-terminate-get", result, DENIAL_STATUSES)

    def _scan_supplied_artifacts(self, session_id: str) -> None:
        artifacts: dict[str, str] = {}
        scanner_config = self.config.get("scanner", {})
        if not isinstance(scanner_config, Mapping):
            scanner_config = {}
        for group_name, key in (("registry", "registry_artifact_paths"), ("logs", "log_artifact_paths")):
            for artifact_path in _string_list(scanner_config.get(key)):
                path = Path(artifact_path)
                if not path.is_file():
                    raise ConformanceFailure(f"{group_name} artifact not found: {path}")
                text = path.read_text(encoding="utf-8")
                artifacts[f"{group_name}:{path}"] = text
                if group_name == "registry":
                    self._validate_registry_artifact(path, text, session_id)
        self.scanner.assert_clean(artifacts)

    def _validate_registry_artifact(self, path: Path, text: str, session_id: str) -> None:
        payload = _parse_json_maybe(text)
        if payload is _NOT_JSON:
            raise ConformanceFailure(f"registry artifact must be JSON so tenant binding can be checked: {path}")
        records = _find_record_like_objects(payload)
        if not records:
            raise ConformanceFailure(f"registry artifact contains no registry-record-like objects: {path}")
        self._assert_records_tenant_bound(records, session_id, f"registry artifact {path}")

    def _assert_records_tenant_bound(self, records: Sequence[Any], session_id: str, label: str) -> None:
        for index, item in enumerate(records):
            if not isinstance(item, Mapping):
                continue
            item_session = item.get("session_id") or item.get("SessionID")
            if not item_session:
                continue
            tenant = item.get("tenant_id") or item.get("TenantID")
            namespace = item.get("namespace") or item.get("Namespace")
            if tenant != self.tenant_id or namespace != self.namespace:
                raise ConformanceFailure(
                    f"{label} is not tenant/namespace bound at record {index}: session={item_session!r}"
                )
            if item_session == session_id and not (tenant and namespace):
                raise ConformanceFailure(f"{label} record for harness session is missing tenant or namespace")

    def _run_body(self) -> dict[str, Any]:
        run = self.config.get("run", {})
        if not isinstance(run, Mapping):
            raise ConformanceFailure("config.run must be an object")
        body: dict[str, Any] = {
            "tenant_id": self.tenant_id,
            "namespace": self.namespace,
            "image_ref": _required_string(run, "image_ref", "run"),
            "network_connector_ref": _required_string(run, "network_connector_ref", "run"),
            "session_spec": run.get("session_spec") if isinstance(run.get("session_spec"), Mapping) else {},
        }
        for key in (
            "image_version",
            "ingress_network_connector_refs",
            "egress_network_connector_refs",
            "idle_policy",
            "maximum_duration_seconds",
            "ttl_seconds",
        ):
            if key in run:
                body[key] = run[key]
        return body

    def _request_json(self, method: str, path: str, body: Any, name: str) -> Mapping[str, Any]:
        result = self._request(method, path, body, name)
        if not (200 <= result.status < 300):
            raise ConformanceFailure(f"{name} failed with HTTP {result.status}; response body suppressed")
        payload = self._json_or_fail(result, name)
        if not isinstance(payload, Mapping):
            raise ConformanceFailure(f"{name} returned non-object JSON")
        return payload

    def _request(
        self,
        method: str,
        path: str,
        body: Any,
        name: str,
        *,
        auth_mode: str = "valid",
        namespace: str | None = None,
    ) -> HTTPResult:
        result = self.transport.request(
            method,
            path,
            body,
            self._headers(auth_mode=auth_mode, namespace=namespace),
            name,
        )
        self.response_artifacts[f"response:{name}"] = result.body
        self.scanner.assert_clean({f"response:{name}": result.body})
        return result

    def _headers(self, *, auth_mode: str, namespace: str | None = None) -> dict[str, str]:
        headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "x-tenant-id": self.tenant_id,
            "x-namespace-id": namespace or self.namespace,
            "x-request-id": f"apptheory-conformance-{int(time.time())}",
        }
        extra_headers = self.config.get("headers", {})
        if isinstance(extra_headers, Mapping):
            for key, value in extra_headers.items():
                if isinstance(key, str) and isinstance(value, str):
                    headers[key] = value
        if auth_mode == "valid":
            token = _auth_token_from_config(self.config)
            if token:
                headers["authorization"] = f"Bearer {token}"
        elif auth_mode == "invalid":
            headers["authorization"] = "Bearer apptheory-conformance-invalid-token"
        elif auth_mode != "missing":
            raise ConformanceFailure(f"unknown auth mode {auth_mode!r}")
        return headers

    def _expect_success(
        self,
        payload: Mapping[str, Any],
        command: str,
        *,
        session_id: str,
        allow_empty_session: bool = False,
    ) -> None:
        actual = str(payload.get("command") or "")
        if actual != command:
            raise ConformanceFailure(f"expected command {command!r}, got {actual!r}")
        if actual == "shell-token":
            raise ConformanceFailure("shell-token is not canonical; expected shell-auth-token")
        if str(payload.get("tenant_id") or "") not in {"", self.tenant_id}:
            raise ConformanceFailure(f"{command} response crossed tenant boundary")
        if str(payload.get("namespace") or "") not in {"", self.namespace}:
            raise ConformanceFailure(f"{command} response crossed namespace boundary")
        payload_session = str(payload.get("session_id") or "")
        if not allow_empty_session and payload_session != session_id:
            raise ConformanceFailure(f"{command} response returned wrong session binding")
        if payload.get("error"):
            raise ConformanceFailure(f"{command} response carried an error envelope")
        self.proofs.append(OperationProof(name=command, status=200, command=actual, session_id=session_id))

    def _expect_token_metadata(self, payload: Mapping[str, Any], command: str, session_id: str) -> None:
        self._expect_success(payload, command, session_id=session_id)
        if not payload.get("token_id") or not payload.get("token_type") or not payload.get("expires_at"):
            raise ConformanceFailure(f"{command} did not return sanitized token metadata")
        forbidden = {
            "token_value",
            "bearer_token",
            "provider_token",
            "shell_token",
            "auth_token",
            "session_token_plaintext",
        }
        present = sorted(field for field in forbidden if field in payload and payload[field])
        if present:
            raise ConformanceFailure(f"{command} returned forbidden plaintext token fields: {', '.join(present)}")

    def _expect_denied(self, name: str, result: HTTPResult, statuses: set[int]) -> None:
        if result.status not in statuses:
            raise ConformanceFailure(f"{name} expected fail-closed status {sorted(statuses)}, got {result.status}")
        self.proofs.append(OperationProof(name=name, status=result.status, denied=True))

    def _json_or_fail(self, result: HTTPResult, name: str) -> Any:
        try:
            return result.json()
        except json.JSONDecodeError as exc:
            raise ConformanceFailure(f"{name} did not return valid JSON") from exc

    def _assert_full_vocabulary(self) -> None:
        observed = {proof.command for proof in self.proofs if proof.command}
        missing = [command for command in CANONICAL_COMMANDS if command not in observed]
        if missing:
            raise ConformanceFailure(f"harness did not prove canonical commands: {', '.join(missing)}")
        if "shell-token" in observed:
            raise ConformanceFailure("harness observed legacy shell-token as a canonical command")


class Transport:
    def request(
        self,
        method: str,
        path: str,
        body: Any,
        headers: Mapping[str, str],
        name: str,
    ) -> HTTPResult:
        raise NotImplementedError


class HTTPTransport(Transport):
    def __init__(self, endpoint: str, timeout_seconds: float = 30.0) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.timeout_seconds = timeout_seconds
        parsed = urllib.parse.urlparse(self.endpoint)
        if parsed.scheme not in {"https", "http"} or not parsed.netloc:
            raise ConformanceFailure("config.endpoint must be an http(s) URL")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ConformanceFailure("live conformance endpoints carrying bearer tokens must use https")

    def request(
        self,
        method: str,
        path: str,
        body: Any,
        headers: Mapping[str, str],
        name: str,
    ) -> HTTPResult:
        del name
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint + path,
            data=data,
            headers=dict(headers),
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
                return HTTPResult(
                    status=response.status,
                    body=response.read().decode("utf-8", errors="replace"),
                    headers=dict(response.headers.items()),
                )
        except urllib.error.HTTPError as exc:
            return HTTPResult(
                status=exc.code,
                body=exc.read().decode("utf-8", errors="replace"),
                headers=dict(exc.headers.items()) if exc.headers else {},
            )
        except urllib.error.URLError as exc:
            raise ConformanceFailure(f"live conformance request failed: {exc.reason}") from exc


class FixtureTransport(Transport):
    def __init__(self, fixture: Mapping[str, Any]) -> None:
        responses = fixture.get("responses")
        if not isinstance(responses, Mapping):
            raise ConformanceFailure("dry-run fixture must contain a responses object")
        self.responses = responses

    def request(
        self,
        method: str,
        path: str,
        body: Any,
        headers: Mapping[str, str],
        name: str,
    ) -> HTTPResult:
        del method, path, body, headers
        raw = self.responses.get(name)
        if not isinstance(raw, Mapping):
            raise ConformanceFailure(f"dry-run fixture missing response for {name}")
        status = int(raw.get("status", 200))
        payload = raw.get("body", {})
        text = payload if isinstance(payload, str) else json.dumps(payload, sort_keys=True)
        return HTTPResult(status=status, body=text, headers={})


def load_config(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConformanceFailure(f"invalid JSON config: {path}") from exc
    if not isinstance(payload, dict):
        raise ConformanceFailure("config root must be a JSON object")
    return payload


def build_scanner(config: Mapping[str, Any], cli_sensitive_values: Sequence[str] = ()) -> LeakScanner:
    values: list[str] = list(cli_sensitive_values)
    token = _auth_token_from_config(config)
    if token:
        values.append(token)
    scanner_config = config.get("scanner", {})
    if isinstance(scanner_config, Mapping):
        values.extend(_string_list(scanner_config.get("sensitive_values")))
        for env_name in _string_list(scanner_config.get("sensitive_value_env")):
            env_value = os.environ.get(env_name, "")
            if env_value:
                values.append(env_value)
    return LeakScanner(values)


def run_harness(args: argparse.Namespace) -> int:
    config = load_config(Path(args.config))
    scanner = build_scanner(config)
    if args.dry_run:
        fixture_path = Path(args.fixture) if args.fixture else Path("examples/microvm-conformance/fixtures/no-leak-artifacts.json")
        fixture = load_config(fixture_path)
        transport: Transport = FixtureTransport(fixture)
    else:
        if not _auth_token_from_config(config):
            raise ConformanceFailure("live mode requires auth_token_env or auth_token to resolve a non-empty token")
        endpoint = _required_string(config, "endpoint")
        timeout = float(config.get("timeout_seconds", 30.0))
        transport = HTTPTransport(endpoint, timeout)
    proofs = MicroVMConformanceHarness(config, transport, scanner).run()
    commands = ",".join(command for command in CANONICAL_COMMANDS if any(p.command == command for p in proofs))
    denied = ",".join(proof.name for proof in proofs if proof.denied)
    mode = "dry-run" if args.dry_run else "live"
    print(f"microvm-conformance: PASS mode={mode} commands={commands} denied_checks={denied}")
    if args.dry_run:
        print("microvm-conformance: dry-run fixture proof only; no live AWS or EqualToAI/Host lab proof claimed")
    return 0


def run_scan(args: argparse.Namespace) -> int:
    sensitive_values = list(args.sensitive_value or [])
    for env_name in args.sensitive_env or []:
        env_value = os.environ.get(env_name, "")
        if env_value:
            sensitive_values.append(env_value)
    scanner = LeakScanner(sensitive_values)
    artifacts: dict[str, str] = {}
    for item in args.artifact or []:
        if "=" not in item:
            raise ConformanceFailure("--artifact must be NAME=PATH")
        name, raw_path = item.split("=", 1)
        path = Path(raw_path)
        if not path.is_file():
            raise ConformanceFailure(f"artifact not found: {path}")
        artifacts[name] = path.read_text(encoding="utf-8")
    scanner.assert_clean(artifacts)
    print(f"microvm-token-scan: PASS artifacts={len(artifacts)}")
    return 0


def _auth_token_from_config(config: Mapping[str, Any]) -> str:
    token_env = str(config.get("auth_token_env") or "").strip()
    if token_env:
        return os.environ.get(token_env, "")
    return str(config.get("auth_token") or "").strip()


def _required_string(config: Mapping[str, Any], key: str, scope: str = "config") -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConformanceFailure(f"{scope}.{key} is required")
    return value.strip()


def _required_payload_string(payload: Mapping[str, Any], key: str, label: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConformanceFailure(f"{label} missing {key}")
    return value.strip()


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item.strip()]
    return []


def _quote_path(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_")


def _is_forbidden_field(normalized: str) -> bool:
    return normalized in FORBIDDEN_FIELD_NAMES


def _is_safe_structural_key(key: str, value: Any) -> bool:
    # Canonical operation names are often used as fixture/artifact map keys.
    # Treat only mapping containers as structural; a scalar auth-token field is
    # still suspicious and will be evaluated through normalized field rules.
    return key in {"auth-token", "shell-auth-token"} and isinstance(value, Mapping)


def _is_secret_looking_field(normalized: str) -> bool:
    if normalized in SAFE_TOKEN_FIELD_NAMES:
        return False
    if normalized in FORBIDDEN_FIELD_NAMES:
        return True
    return any(fragment in normalized for fragment in SECRET_KEY_FRAGMENTS)


def _has_non_empty_value(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(value)
    if isinstance(value, Mapping):
        return bool(value)
    return True


_NOT_JSON = object()


def _parse_json_maybe(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return _NOT_JSON


def _dedupe_findings(findings: Sequence[LeakFinding]) -> list[LeakFinding]:
    seen: set[tuple[str, str, str, str]] = set()
    out: list[LeakFinding] = []
    for finding in findings:
        key = (finding.artifact, finding.path, finding.kind, finding.message)
        if key in seen:
            continue
        seen.add(key)
        out.append(finding)
    return out


def _find_record_like_objects(payload: Any) -> list[Mapping[str, Any]]:
    records: list[Mapping[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, Mapping):
            keys = {_normalize_key(str(key)) for key in value}
            if "session_id" in keys and ("tenant_id" in keys or "namespace" in keys):
                records.append(value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return records


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AppTheory MicroVM conformance harness and token leak scanner")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run the MicroVM conformance harness")
    run_parser.add_argument("--config", required=True, help="path to conformance config JSON")
    run_parser.add_argument("--dry-run", action="store_true", help="use deterministic fixture transport; no network")
    run_parser.add_argument("--fixture", help="dry-run fixture JSON path")
    run_parser.set_defaults(func=run_harness)

    scan_parser = subparsers.add_parser("scan", help="scan response/registry/log artifacts for token leaks")
    scan_parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        help="artifact to scan as NAME=PATH; repeat for responses, registry records, and logs",
    )
    scan_parser.add_argument("--sensitive-value", action="append", default=[], help="sensitive plaintext value to detect")
    scan_parser.add_argument("--sensitive-env", action="append", default=[], help="environment variable containing a value to detect")
    scan_parser.set_defaults(func=run_scan)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ConformanceFailure as exc:
        print(f"microvm-conformance: FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
