#!/usr/bin/env python3
"""Fixture tests for the AppTheory MicroVM conformance harness."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "microvm_conformance.py"
spec = importlib.util.spec_from_file_location("microvm_conformance", MODULE_PATH)
if spec is None or spec.loader is None:  # pragma: no cover - import guard
    raise RuntimeError("unable to import microvm_conformance.py")
microvm_conformance = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = microvm_conformance
spec.loader.exec_module(microvm_conformance)

CONFIG_PATH = ROOT / "examples" / "microvm-conformance" / "equaltoai-host.config.example.json"
NO_LEAK_FIXTURE_PATH = ROOT / "examples" / "microvm-conformance" / "fixtures" / "no-leak-artifacts.json"
LEAK_FIXTURE_PATH = ROOT / "examples" / "microvm-conformance" / "fixtures" / "leak-artifacts.json"


class MicroVMConformanceScannerTests(unittest.TestCase):
    def test_scanner_passes_no_leak_fixture(self) -> None:
        scanner = microvm_conformance.LeakScanner(
            ["auth-token-DO-NOT-LOG-123456", "provider-token-DO-NOT-LOG-123456"]
        )
        scanner.assert_clean(
            {
                "no-leak": (
                    ROOT / "examples" / "microvm-conformance" / "fixtures" / "scanner-no-leak-artifacts.json"
                ).read_text(encoding="utf-8")
            }
        )

    def test_scanner_fails_closed_on_plaintext_sensitive_value(self) -> None:
        scanner = microvm_conformance.LeakScanner(["provider-token-DO-NOT-LOG-123456"])
        with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
            scanner.assert_clean({"leak": LEAK_FIXTURE_PATH.read_text(encoding="utf-8")})
        message = str(raised.exception)
        self.assertIn("token leak scanner failed closed", message)
        self.assertIn("forbidden-field", message)
        self.assertNotIn("provider-token-DO-NOT-LOG-123456", message)

    def test_scanner_fails_closed_on_bearer_log(self) -> None:
        scanner = microvm_conformance.LeakScanner([])
        with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
            scanner.assert_clean({"logs": "unexpected outbound Authorization: Bearer redactedbutstillcredential"})
        self.assertIn("bearer credential", str(raised.exception))

    def test_scanner_fails_closed_on_canonical_session_token_plaintext(self) -> None:
        scanner = microvm_conformance.LeakScanner([])
        leaked_value = "session-token-DO-NOT-LOG-123456"
        artifacts = {
            "response": json.dumps(
                {
                    "command": "auth-token",
                    "session_token_plaintext": leaked_value,
                }
            ),
            "registry": json.dumps(
                {
                    "records": [
                        {
                            "tenant_id": "tenant-example",
                            "namespace": "namespace-example",
                            "session_id": "session-fixture-001",
                            "session_token_plaintext": leaked_value,
                        }
                    ]
                }
            ),
            "logs": f"issued session_token_plaintext={leaked_value}",
        }
        for artifact, text in artifacts.items():
            with self.subTest(artifact=artifact):
                with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
                    scanner.assert_clean({artifact: text})
                message = str(raised.exception)
                self.assertIn("token leak scanner failed closed", message)
                self.assertIn("forbidden-field", message)
                self.assertIn("session_token_plaintext", message)
                self.assertNotIn(leaked_value, message)

    def test_scanner_does_not_treat_canonical_route_names_as_token_fields(self) -> None:
        scanner = microvm_conformance.LeakScanner([])
        scanner.assert_clean(
            {
                "routes": json.dumps(
                    {
                        "auth-token": {
                            "command": "auth-token",
                            "token_id": "auth-token-metadata-001",
                            "token_type": "auth",
                        },
                        "shell-auth-token": {
                            "command": "shell-auth-token",
                            "token_id": "shell-token-metadata-001",
                            "token_type": "shell",
                        },
                    }
                )
            }
        )

    def test_scanner_allows_sanitized_token_metadata(self) -> None:
        scanner = microvm_conformance.LeakScanner([])
        scanner.assert_clean(
            {
                "response": json.dumps(
                    {
                        "command": "shell-auth-token",
                        "token_id": "shell-token-metadata-001",
                        "token_type": "shell",
                        "expires_at": "2026-06-25T12:15:00Z",
                        "scope": ["shell"],
                    }
                )
            }
        )


class MicroVMConformanceHarnessTests(unittest.TestCase):
    def test_dry_run_validates_full_canonical_vocabulary(self) -> None:
        proofs = self._run_with_fixture(self._fixture())
        observed = {proof.command for proof in proofs if proof.command}
        self.assertTrue(set(microvm_conformance.CANONICAL_COMMANDS).issubset(observed))
        self.assertNotIn("shell-token", observed)
        self.assertIn("missing-auth", {proof.name for proof in proofs if proof.denied})
        self.assertIn("invalid-auth", {proof.name for proof in proofs if proof.denied})

    def test_harness_fails_when_shell_token_is_treated_as_canonical(self) -> None:
        fixture = self._fixture()
        fixture["responses"]["shell-auth-token"]["body"]["command"] = "shell-token"
        with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
            self._run_with_fixture(fixture)
        self.assertIn("shell-auth-token", str(raised.exception))

    def test_harness_fails_when_list_is_account_wide(self) -> None:
        fixture = self._fixture()
        fixture["responses"]["list"]["body"]["sessions"].append(
            {
                "tenant_id": "other-tenant",
                "namespace": "namespace-example",
                "session_id": "session-from-raw-account-list",
                "state": "running",
                "provider_microvm_id": "provider-microvm-other",
            }
        )
        with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
            self._run_with_fixture(fixture)
        self.assertIn("not tenant/namespace bound", str(raised.exception))

    def test_harness_scans_registry_artifacts_and_fails_on_cross_tenant_record(self) -> None:
        fixture = self._fixture()
        config = self._config()
        with tempfile.TemporaryDirectory() as tmp:
            registry_path = Path(tmp) / "registry.json"
            registry_path.write_text(
                json.dumps(
                    {
                        "records": [
                            {
                                "tenant_id": "other-tenant",
                                "namespace": "namespace-example",
                                "session_id": "session-fixture-001",
                                "state": "running",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            config["scanner"]["registry_artifact_paths"] = [str(registry_path)]
            with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
                self._run_with_fixture(fixture, config=config)
        self.assertIn("registry artifact", str(raised.exception))

    def test_harness_fails_closed_on_response_token_leak(self) -> None:
        fixture = self._fixture()
        fixture["responses"]["auth-token"]["body"]["token_value"] = "provider-token-DO-NOT-LOG-123456"
        with self.assertRaises(microvm_conformance.ConformanceFailure) as raised:
            self._run_with_fixture(fixture)
        self.assertIn("token leak scanner failed closed", str(raised.exception))

    def _run_with_fixture(self, fixture: dict[str, Any], *, config: dict[str, Any] | None = None) -> list[Any]:
        cfg = config or self._config()
        scanner = microvm_conformance.build_scanner(cfg)
        harness = microvm_conformance.MicroVMConformanceHarness(
            cfg,
            microvm_conformance.FixtureTransport(fixture),
            scanner,
        )
        return harness.run()

    def _config(self) -> dict[str, Any]:
        return copy.deepcopy(microvm_conformance.load_config(CONFIG_PATH))

    def _fixture(self) -> dict[str, Any]:
        return copy.deepcopy(microvm_conformance.load_config(NO_LEAK_FIXTURE_PATH))


if __name__ == "__main__":
    unittest.main()
