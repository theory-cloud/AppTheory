#!/usr/bin/env python3
"""Conformance runner for theorycloud_resource_naming.v0.1 fixtures."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CONTRACT = "theorycloud_resource_naming.v0.1"
NON_PROOF = ("deployment_proof", "journey_proof", "aws_behaviour_proof")


def load_naming() -> Any:
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root / "py" / "src"))
    import apptheory  # noqa: PLC0415

    return apptheory


def evaluate(apptheory: Any, scenario: dict[str, Any]) -> Any:
    kind = scenario["type"]
    if kind == "name":
        out = apptheory.physical_resource_name(
            scenario["context"],
            scenario["resource_type"],
            scenario["logical"],
            scenario.get("pins"),
        )
        return dict(out)
    if kind == "log_group":
        apptheory.validate_naming_context(scenario["context"])
        return {"name": apptheory.log_group_name(scenario["context"], scenario["logical"])}
    if kind == "compile":
        return apptheory.compile_visibility_policy(scenario["context"], scenario.get("rules", {}))
    if kind == "preview":
        return apptheory.visibility_preview(scenario["context"], scenario.get("rules", {}), scenario["sources"])
    if kind == "manifest":
        return apptheory.visibility_manifest(scenario["context"], scenario.get("rules", {}), scenario["sources"])
    if kind == "keeper":
        return {"answer": apptheory.keeper_decision(scenario.get("rules"), scenario["logical"], scenario.get("aws_result"))}
    if kind == "visible":
        return {"visible": apptheory.source_visible(scenario.get("rules", {}), scenario["logical"])}
    raise ValueError(f"unknown scenario type {kind}")


def check(apptheory: Any, fixture: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if fixture.get("contract") != CONTRACT:
        reasons.append("contract id")
    declared = set(fixture.get("proof", {}).get("does_not_prove", []))
    for required in NON_PROOF:
        if required not in declared:
            reasons.append(f"missing proof disclaimer {required}")

    expected = fixture.get("expected")
    expects_error = isinstance(expected, dict) and bool(expected.get("error"))
    try:
        got: Any = evaluate(apptheory, fixture["scenario"])
        error: Exception | None = None
    except Exception as exc:  # noqa: BLE001 - fixture rejection is the signal
        got, error = None, exc

    if error is not None:
        if not expects_error:
            reasons.append(f"contract rejects: {error}")
    elif expects_error:
        reasons.append("fixture expects rejection but contract accepts")
    elif got != expected:
        reasons.append(f"expected {json.dumps(expected, sort_keys=True)} != required {json.dumps(got, sort_keys=True)}")
    return reasons


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", default=str(Path("contract-tests") / "fixtures" / "resource-naming" / "v0.1"))
    args = parser.parse_args()

    apptheory = load_naming()
    passed = total = 0
    failures: list[str] = []
    for family in ("valid", "invalid"):
        directory = Path(args.fixtures) / family
        for path in sorted(directory.glob("*.json")):
            total += 1
            fixture = json.loads(path.read_text(encoding="utf-8"))
            reasons = check(apptheory, fixture)
            ok = bool(reasons) if family == "invalid" else not reasons
            if ok:
                passed += 1
                suffix = " (rejected)" if family == "invalid" else ""
                print(f"PASS {family}/{path.name}{suffix}")
                continue
            print(f"FAIL {family}/{path.name}")
            for reason in reasons or ["invalid fixture passed"]:
                failures.append(f"  {family}/{path.name}: {reason}")
    for failure in failures:
        print(failure, file=sys.stderr)
    if passed != total:
        print(f"resource-naming(py): FAIL ({passed}/{total} passed)", file=sys.stderr)
        return 1
    print(f"resource-naming(py): PASS ({total} fixtures)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
