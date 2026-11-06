#!/usr/bin/env python3
"""Run the MicroVM conformance harness locally through the AppTheory runner.

The checked-in conformance harness has three modes: a deterministic dry run, a
token-leak scanner, and a live run against a supplied controller endpoint. This
wrapper runs the first two and, when ``--config`` is supplied, the live mode
against the locally run `apptheory-local` microvm-controller. The local
controller reaches the managed MicroVM provider boundary and stops there: the
live mode is expected to fail at its first provider-backed operation, after the
auth refusals have already passed. That is the named L3 gap; no EqualToAI/Host
live proof is claimed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE = ROOT / "scripts" / "microvm_conformance.py"
EXAMPLE_CONFIG = ROOT / "examples/microvm-conformance/equaltoai-host.config.example.json"
NO_LEAK_FIXTURE = ROOT / "examples/microvm-conformance/fixtures/no-leak-artifacts.json"
SCANNER_FIXTURE = ROOT / "examples/microvm-conformance/fixtures/scanner-no-leak-artifacts.json"
SENSITIVE_VALUES = (
    "auth-token-DO-NOT-LOG-123456",
    "provider-token-DO-NOT-LOG-123456",
)


def run(argv: list[str], *, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(
        argv,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise SystemExit(
            "microvm-conformance-local: FAIL\n"
            + (result.stdout or "")
            + (result.stderr or "")
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run MicroVM conformance modes locally")
    parser.add_argument("--config", help="live config JSON pointing at the local controller")
    args = parser.parse_args()

    run([sys.executable, str(ROOT / "scripts/test_microvm_conformance.py")])
    dry = run(
        [
            sys.executable,
            str(CONFORMANCE),
            "run",
            "--config",
            str(EXAMPLE_CONFIG),
            "--dry-run",
            "--fixture",
            str(NO_LEAK_FIXTURE),
        ]
    )
    if "microvm-conformance: PASS mode=dry-run" not in dry.stdout:
        print(dry.stdout, file=sys.stderr)
        print("microvm-conformance-local: FAIL (dry run did not report PASS)", file=sys.stderr)
        return 1
    scan_argv = [sys.executable, str(CONFORMANCE), "scan", "--artifact", f"no-leak={SCANNER_FIXTURE}"]
    for value in SENSITIVE_VALUES:
        scan_argv.extend(["--sensitive-value", value])
    scan = run(scan_argv)
    if "microvm-token-scan: PASS" not in scan.stdout:
        print(scan.stdout, file=sys.stderr)
        print("microvm-conformance-local: FAIL (leak scan did not report PASS)", file=sys.stderr)
        return 1

    if not args.config:
        print("microvm-conformance-local: PASS modes=dry-run,scan (no live endpoint supplied)")
        return 0

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    token_env = str(config.get("auth_token_env") or "").strip()
    if not token_env:
        print("microvm-conformance-local: FAIL (live config has no auth_token_env)", file=sys.stderr)
        return 1
    live = run(
        [sys.executable, str(CONFORMANCE), "run", "--config", args.config],
        check=False,
    )
    output = (live.stdout or "") + (live.stderr or "")
    if live.returncode == 0:
        print(output, file=sys.stderr)
        print(
            "microvm-conformance-local: FAIL (the live run unexpectedly passed; this wrapper only claims "
            "the provider-boundary observation)",
            file=sys.stderr,
        )
        return 1
    if "run failed with HTTP 502" not in output:
        print(output, file=sys.stderr)
        print(
            "microvm-conformance-local: FAIL (the live run did not stop at the expected provider boundary)",
            file=sys.stderr,
        )
        return 1
    token = os.environ.get(token_env, "")
    if token and token in output:
        print("microvm-conformance-local: FAIL (the demo bearer token leaked in the failure output)", file=sys.stderr)
        return 1
    print("microvm-conformance-local: PASS modes=dry-run,scan,live-boundary")
    print(
        "microvm-conformance-local: the live run passed the auth refusals and stopped at the managed "
        "MicroVM provider boundary; no EqualToAI/Host live proof is claimed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
