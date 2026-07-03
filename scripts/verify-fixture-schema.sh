#!/usr/bin/env bash
# Purpose: validate every contract fixture against the fixture schema and negative self-test.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "fixture-schema: BLOCKED (python3 not found)" >&2
  exit 1
fi

schema_path="contract-tests/fixtures/fixture.schema.json"
fixtures_dir="contract-tests/fixtures"
mode="validate"

if [[ "${1:-}" == "--self-test" ]]; then
  mode="self-test"
elif [[ -n "${1:-}" ]]; then
  fixtures_dir="$1"
fi

python3 - "${schema_path}" "${fixtures_dir}" "${mode}" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

schema_path = Path(sys.argv[1])
fixtures_dir = Path(sys.argv[2])
mode = sys.argv[3]

class ValidationError(Exception):
    pass


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def type_matches(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    raise ValidationError(f"unsupported schema type {expected!r}")


def resolve_ref(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValidationError(f"unsupported $ref {ref!r}")
    current: Any = root
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or part not in current:
            raise ValidationError(f"unresolvable $ref {ref!r}")
        current = current[part]
    if not isinstance(current, dict):
        raise ValidationError(f"$ref {ref!r} does not resolve to an object schema")
    return current


def validate(root: dict[str, Any], schema: dict[str, Any], value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []

    if "$ref" in schema:
        return validate(root, resolve_ref(root, str(schema["$ref"])), value, path)

    if "anyOf" in schema:
        choices = schema["anyOf"]
        if not isinstance(choices, list) or not choices:
            raise ValidationError(f"{path}: anyOf must be a non-empty list")
        nested_errors: list[str] = []
        for choice in choices:
            if not isinstance(choice, dict):
                raise ValidationError(f"{path}: anyOf entries must be schema objects")
            choice_errors = validate(root, choice, value, path)
            if not choice_errors:
                return []
            nested_errors.extend(choice_errors)
        return [f"{path}: does not match any allowed schema"] + nested_errors

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: expected one of {schema['enum']!r}, got {value!r}")

    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}, got {value!r}")

    if "type" in schema:
        expected_raw = schema["type"]
        expected = expected_raw if isinstance(expected_raw, list) else [expected_raw]
        if not any(type_matches(value, str(t)) for t in expected):
            errors.append(f"{path}: expected type {expected!r}, got {json_type(value)}")
            return errors

    if isinstance(value, str):
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")
        if "pattern" in schema and re.search(str(schema["pattern"]), value) is None:
            errors.append(f"{path}: does not match pattern {schema['pattern']!r}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                errors.extend(validate(root, item_schema, item, f"{path}[{index}]"))

    if isinstance(value, dict):
        required = schema.get("required", [])
        if isinstance(required, list):
            for key in required:
                if key not in value:
                    errors.append(f"{path}: missing required property {key!r}")

        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            properties = {}

        for key, prop_schema in properties.items():
            if key in value and isinstance(prop_schema, dict):
                errors.extend(validate(root, prop_schema, value[key], f"{path}.{key}"))

        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                continue
            if additional is False:
                errors.append(f"{path}: unexpected property {key!r}")
            elif isinstance(additional, dict):
                errors.extend(validate(root, additional, item, f"{path}.{key}"))

    return errors


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"{path}: invalid JSON: {exc}") from exc


FIXTURE_DOMAIN_TIERS = {
    "http-core": "p0",
    "middleware-guardrails": "p1",
    "appsync-observability-policies": "p2",
    "event-sources": "m1",
    "websockets": "m2",
    "api-gateway-rest-sse": "m3",
    "middleware-timeout-sse": "m12",
    "edge-streaming-html": "m14",
    "microvm-foundation": "m15",
    "microvm-operations": "m16",
    "errors": "p0",
    "routing": "p0",
    "binding": "p0",
    "validation": "p0",
    "openapi": "p0",
}


def fixture_errors(root: dict[str, Any], fixture: Any, path: Path | None = None) -> list[str]:
    errors = validate(root, root, fixture)
    if isinstance(fixture, dict):
        tier = fixture.get("tier")
        fixture_id = fixture.get("id")
        if isinstance(tier, str) and isinstance(fixture_id, str) and not (
            fixture_id.startswith(f"{tier}.") or fixture_id.startswith(f"{tier}_")
        ):
            errors.append(f"$: id {fixture_id!r} must start with tier prefix {tier!r}")
        if path is not None and isinstance(tier, str):
            path_tier = FIXTURE_DOMAIN_TIERS.get(path.parent.name)
            if path_tier is None:
                errors.append(f"$: fixture directory {path.parent.name!r} is not a known behavior domain")
            elif path_tier != tier:
                errors.append(
                    f"$: fixture directory {path.parent.name!r} maps to tier {path_tier!r}, not fixture tier {tier!r}"
                )
    return errors


schema = load_json(schema_path)
if not isinstance(schema, dict):
    raise SystemExit("fixture-schema: FAIL (schema root is not an object)")

if mode == "self-test":
    malformed = {"tier": "p0", "name": "missing id should fail", "expect": {"response": {}}}
    errors = fixture_errors(schema, malformed)
    if not errors:
        raise SystemExit("fixture-schema: FAIL (self-test malformed fixture unexpectedly passed)")
    print("fixture-schema: self-test PASS")
    raise SystemExit(0)

files = sorted(fixtures_dir.glob("*/*.json"))
if not files:
    raise SystemExit(f"fixture-schema: FAIL (no fixtures found under {fixtures_dir})")

all_errors: list[str] = []
for fixture_path in files:
    try:
        fixture = load_json(fixture_path)
    except ValidationError as exc:
        all_errors.append(str(exc))
        continue
    for error in fixture_errors(schema, fixture, fixture_path):
        all_errors.append(f"{fixture_path}: {error}")

negative = {"tier": "p0", "name": "missing id should fail", "expect": {"response": {}}}
if not fixture_errors(schema, negative):
    all_errors.append("negative self-test: malformed fixture unexpectedly passed")

if all_errors:
    print("fixture-schema: FAIL", file=sys.stderr)
    for error in all_errors:
        print(f"  - {error}", file=sys.stderr)
    raise SystemExit(1)

print(f"fixture-schema: PASS (fixtures={len(files)}, negative=PASS)")
PY
