#!/usr/bin/env python3
"""Unit tests for the local real-client target's pure helpers.

The suite itself drives installed client binaries against the example app and is
never a CI job; these tests cover the parts that decide where Vibe's keychain
items live and what the suite records, with every shell command mocked, so a
mistake in the dedicated-alias handling fails here before any real keychain is
touched.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import local_clients as suite


class TtlTests(unittest.TestCase):
    def test_seconds_from_ttl(self) -> None:
        self.assertEqual(30, suite._seconds_from_ttl("30s"))
        self.assertEqual(600, suite._seconds_from_ttl("600"))
        self.assertEqual(30, suite._seconds_from_ttl("not-a-lifetime"))


class VibeActionLogTests(unittest.TestCase):
    def test_reads_only_open_url_actions(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "actions.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"kind": "open_url", "url": "https://one.example/authorize"}),
                        json.dumps({"kind": "clipboard", "text": "ignored"}),
                        "not json",
                        json.dumps({"kind": "open_url", "url": "https://two.example/authorize"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                ["https://one.example/authorize", "https://two.example/authorize"],
                suite.vibe_action_urls(path),
            )

    def test_missing_action_log_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            self.assertEqual([], suite.vibe_action_urls(Path(scratch) / "absent.jsonl"))


class VibeObservationTests(unittest.TestCase):
    def test_the_three_observed_outcomes(self) -> None:
        self.assertEqual(
            "login",
            suite.vibe_terminal_observation(
                "OAuth refresh failed for MCP server 'x'. Run `/mcp login x` to re-authenticate."
            ),
        )
        self.assertEqual(
            "login", suite.vibe_terminal_observation("This MCP server requires authentication")
        )
        self.assertEqual(
            "login",
            suite.vibe_terminal_observation(
                "The echo call failed with error code `mcp_authorization_required`"
            ),
        )
        self.assertEqual(
            "waited", suite.vibe_terminal_observation("Waiting for the OAuth callback")
        )
        self.assertEqual("none", suite.vibe_terminal_observation("Calling 1 tool, thinking"))


def _completed(returncode: int) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr="")


class VibeKeychainTests(unittest.TestCase):
    def test_accounts_use_metadata_only_find_without_w(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, **_kwargs):
            calls.append(list(command))
            return _completed(0 if command[-1].endswith(":tokens") else 1)

        with mock.patch("local_clients.subprocess.run", side_effect=fake_run):
            present = suite.vibe_keychain_accounts("apptheory-local-clients")

        self.assertEqual(["mcp-oauth:apptheory-local-clients:tokens"], present)
        self.assertEqual(3, len(calls))
        for command in calls:
            self.assertEqual("/usr/bin/security", command[0])
            self.assertIn("find-generic-password", command)
            self.assertNotIn("-w", command)
            self.assertNotIn("-g", command)
            self.assertEqual(["ai.mistral.vibe"], [command[command.index("-s") + 1]])
            account = command[command.index("-a") + 1]
            self.assertTrue(account.startswith("mcp-oauth:apptheory-local-clients:"))

    def test_delete_only_names_the_alias_three_accounts(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, **_kwargs):
            calls.append(list(command))
            return _completed(0)

        with mock.patch("local_clients.subprocess.run", side_effect=fake_run):
            suite.vibe_keychain_delete("apptheory-local-clients")

        self.assertEqual(3, len(calls))
        accounts = sorted(command[command.index("-a") + 1] for command in calls)
        self.assertEqual(
            [
                "mcp-oauth:apptheory-local-clients:client_info",
                "mcp-oauth:apptheory-local-clients:fingerprint",
                "mcp-oauth:apptheory-local-clients:tokens",
            ],
            accounts,
        )
        for command in calls:
            self.assertIn("delete-generic-password", command)
            self.assertNotIn("-w", command)
            self.assertEqual(["ai.mistral.vibe"], [command[command.index("-s") + 1]])

    def test_clear_reports_what_still_exists(self) -> None:
        responses = [
            _completed(0),  # pre-check: tokens exists
            _completed(1),
            _completed(1),
            _completed(0),  # delete three
            _completed(0),
            _completed(0),
            _completed(1),  # post-check: only client_info remains
            _completed(0),
            _completed(1),
        ]
        with mock.patch("local_clients.subprocess.run", side_effect=responses):
            remaining = suite.vibe_keychain_clear("apptheory-local-clients")
        self.assertEqual(["mcp-oauth:apptheory-local-clients:client_info"], remaining)


class ScratchCleanupTests(unittest.TestCase):
    def test_remove_scratch_handles_read_only_directories(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch) / "run"
            plugin = root / "home" / "logs" / "plugins" / "pkg"
            plugin.mkdir(parents=True)
            (plugin / "SKILL.md").write_text("x", encoding="utf-8")
            plugin.chmod(0o500)
            suite.remove_scratch(root)
            self.assertFalse(root.exists())


class PromptCommandTests(unittest.TestCase):
    def test_vibe_prompt_is_trusted_and_auto_approved(self) -> None:
        command = suite.vibe_prompt_command("prompt text")
        self.assertEqual("-p", command[1])
        self.assertIn("--trust", command)
        self.assertIn("--auto-approve", command)

    def test_other_clients_keep_their_own_flags(self) -> None:
        self.assertEqual("-p", suite.client_prompt_command("kimi_code", "example", "p")[1])
        with self.assertRaises(ValueError):
            suite.client_prompt_command("not-a-client", "example", "p")


if __name__ == "__main__":
    unittest.main()
