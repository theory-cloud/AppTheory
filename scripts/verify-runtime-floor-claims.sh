#!/usr/bin/env bash
# Purpose: fail closed when AppTheory's Python/Node floor claims drift from
# package metadata, locked dependency artifacts, or CI matrix coverage.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
import base64
import email
import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - CI/local toolchains are 3.11+.
    print("runtime-floor-claims: FAIL (python3 with tomllib is required)", file=sys.stderr)
    raise SystemExit(1)


ROOT = Path.cwd()
LATEST_PROVEN_PYTHON = (3, 14)
LATEST_PROVEN_NODE_MAJOR = 24
TABLETHEORY_RELEASE_PREFIX = "https://github.com/theory-cloud/TableTheory/releases/download/"


def fail(message: str) -> None:
    print(f"runtime-floor-claims: FAIL ({message})", file=sys.stderr)
    raise SystemExit(1)


def parse_python_floor(spec: str, label: str) -> tuple[int, int]:
    match = re.fullmatch(r"\s*>=\s*(\d+)\.(\d+)\s*", spec)
    if not match:
        fail(f"{label} must use an exact >=X.Y floor, found {spec!r}")
    return (int(match.group(1)), int(match.group(2)))


def parse_ruff_target(target: str, label: str) -> tuple[int, int]:
    match = re.fullmatch(r"py(\d)(\d{2})", target)
    if not match:
        fail(f"{label} must use pyXY form, found {target!r}")
    return (int(match.group(1)), int(match.group(2)))


def parse_pyright_version(version: str, label: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)", version)
    if not match:
        fail(f"{label} must use X.Y form, found {version!r}")
    return (int(match.group(1)), int(match.group(2)))


def parse_node_floor(spec: str, label: str) -> int:
    match = re.fullmatch(r"\s*>=\s*(\d+)(?:\.\d+){0,2}\s*", spec)
    if not match:
        fail(f"{label} must use an exact >=N Node major floor, found {spec!r}")
    return int(match.group(1))


def version_text(version: tuple[int, int]) -> str:
    return f"{version[0]}.{version[1]}"


def read_json(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def read_pyproject() -> dict:
    return tomllib.loads((ROOT / "py/pyproject.toml").read_text(encoding="utf-8"))


def clean_url_and_fragment(url: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    clean = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
    return clean, parsed.fragment


def verify_release_url(url: str, label: str) -> str:
    clean, _fragment = clean_url_and_fragment(url)
    if not clean.startswith(TABLETHEORY_RELEASE_PREFIX):
        fail(f"{label} must point at an immutable TableTheory GitHub Release asset, found {clean}")
    return clean


def download_and_verify(url: str, label: str) -> bytes:
    clean, fragment = clean_url_and_fragment(url)
    request = urllib.request.Request(clean, headers={"User-Agent": "apptheory-runtime-floor-proof"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()

    if fragment.startswith("sha256="):
        expected = fragment.removeprefix("sha256=")
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            fail(f"{label} sha256 mismatch: expected {expected}, got {actual}")
    elif fragment.startswith("sha512-"):
        expected = fragment.removeprefix("sha512-")
        actual = base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")
        if actual != expected:
            fail(f"{label} sha512 mismatch")
    else:
        fail(f"{label} URL must include a sha256= or sha512- fragment")

    return data


def python_metadata_from_artifact(url: str, label: str) -> email.message.Message:
    clean = verify_release_url(url, label)
    data = download_and_verify(url, label)
    if clean.endswith(".whl"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            metadata_name = next(
                (name for name in archive.namelist() if name.endswith(".dist-info/METADATA")),
                None,
            )
            if metadata_name is None:
                fail(f"{label} wheel missing dist-info/METADATA")
            return email.message_from_bytes(archive.read(metadata_name))
    if clean.endswith(".tar.gz"):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            metadata_member = next(
                (
                    member
                    for member in archive.getmembers()
                    if member.isfile()
                    and (member.name.endswith("/PKG-INFO") or member.name.endswith(".egg-info/PKG-INFO"))
                ),
                None,
            )
            if metadata_member is None:
                fail(f"{label} sdist missing PKG-INFO")
            extracted = archive.extractfile(metadata_member)
            if extracted is None:
                fail(f"{label} sdist PKG-INFO could not be read")
            return email.message_from_bytes(extracted.read())
    fail(f"{label} must be a Python wheel or sdist release asset, found {clean}")


def npm_package_from_artifact(url: str, label: str) -> dict:
    clean = verify_release_url(url, label)
    data = download_and_verify(url, label)
    if not clean.endswith(".tgz"):
        fail(f"{label} must be a npm .tgz release asset, found {clean}")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        if "package/package.json" not in archive.getnames():
            fail(f"{label} tarball missing package/package.json")
        package_member = archive.getmember("package/package.json")
        if package_member is None:
            fail(f"{label} tarball missing package/package.json")
        extracted = archive.extractfile(package_member)
        if extracted is None:
            fail(f"{label} package.json could not be read")
        return json.loads(extracted.read().decode("utf-8"))


def collect_versions_from_text(text: str, kind: str) -> set[str]:
    versions: set[str] = set()

    # Covers scalar values such as `node-version: "24"` and inline matrices
    # such as `node-version: [20, 24]`.
    for match in re.finditer(rf"{re.escape(kind)}-version:\s*([^\n]+)", text):
        versions.update(re.findall(r"\b\d+(?:\.\d+){0,2}\b", match.group(1)))

    return versions


def collect_ci_versions(kind: str) -> set[str]:
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    return collect_versions_from_text(workflow, kind)


def workflow_job_body(job: str) -> str:
    workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    lines = workflow.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line == f"  {job}:":
            start = index + 1
            break
    if start is None:
        fail(f".github/workflows/ci.yml must define {job} job")

    body: list[str] = []
    for line in lines[start:]:
        if re.fullmatch(r"  [A-Za-z0-9_-]+:", line):
            break
        body.append(line)
    return "\n".join(body)


def require_ci_python_version(required: tuple[int, int], present: set[str]) -> None:
    required_text = version_text(required)
    if required_text not in present:
        fail(f".github/workflows/ci.yml must include python-version {required_text}")


def require_ci_node_major(required: int, present: set[str]) -> None:
    if str(required) not in {version.split(".", 1)[0] for version in present}:
        fail(f".github/workflows/ci.yml must include node-version {required}")


def require_job_contains(job: str, body: str, needle: str) -> None:
    if needle not in body:
        fail(f".github/workflows/ci.yml {job} job must include {needle}")


def main() -> None:
    pyproject = read_pyproject()
    py_floor = parse_python_floor(pyproject["project"]["requires-python"], "py/pyproject.toml project.requires-python")
    ruff_floor = parse_ruff_target(pyproject["tool"]["ruff"]["target-version"], "py/pyproject.toml tool.ruff.target-version")
    pyright_floor = parse_pyright_version(pyproject["tool"]["pyright"]["pythonVersion"], "py/pyproject.toml tool.pyright.pythonVersion")

    if ruff_floor != py_floor:
        fail(f"ruff target {version_text(ruff_floor)} != Python floor {version_text(py_floor)}")
    if pyright_floor != py_floor:
        fail(f"pyright version {version_text(pyright_floor)} != Python floor {version_text(py_floor)}")

    tabletheory_py_url = None
    for dependency in pyproject["project"].get("dependencies", []):
        if dependency.startswith("tabletheory-py @ "):
            tabletheory_py_url = dependency.split(" @ ", 1)[1].strip()
            break
    if tabletheory_py_url is None:
        fail("py/pyproject.toml must declare tabletheory-py via a GitHub Release asset")

    requirements_lint = (ROOT / "py/requirements-lint.txt").read_text(encoding="utf-8")
    requirements_lint_url = None
    for line in requirements_lint.splitlines():
        if line.startswith("tabletheory-py @ "):
            requirements_lint_url = line.split(" @ ", 1)[1].strip()
            break
    if requirements_lint_url != tabletheory_py_url:
        fail(
            "py/requirements-lint.txt tabletheory-py URL "
            f"{requirements_lint_url!r} != py/pyproject.toml {tabletheory_py_url!r}"
        )

    tabletheory_py_metadata = python_metadata_from_artifact(tabletheory_py_url, "tabletheory-py")
    tabletheory_py_floor = parse_python_floor(
        tabletheory_py_metadata.get("Requires-Python", ""),
        "tabletheory-py Requires-Python",
    )
    if tabletheory_py_floor > py_floor:
        fail(
            "py/pyproject.toml claims Python "
            f">={version_text(py_floor)} but tabletheory-py requires >={version_text(tabletheory_py_floor)}"
        )

    ts_package = read_json("ts/package.json")
    ts_lock = read_json("ts/package-lock.json")
    ts_floor = parse_node_floor(ts_package["engines"]["node"], "ts/package.json engines.node")
    ts_lock_engine = ts_lock.get("packages", {}).get("", {}).get("engines", {}).get("node")
    if ts_lock_engine != ts_package["engines"]["node"]:
        fail(f"ts/package-lock.json root engines.node {ts_lock_engine!r} != ts/package.json {ts_package['engines']['node']!r}")

    tabletheory_ts_url = ts_package.get("dependencies", {}).get("@theory-cloud/tabletheory-ts")
    if not tabletheory_ts_url:
        fail("ts/package.json must depend on @theory-cloud/tabletheory-ts via a GitHub Release asset")
    ts_lock_tabletheory_url = ts_lock.get("packages", {}).get("", {}).get("dependencies", {}).get(
        "@theory-cloud/tabletheory-ts"
    )
    if ts_lock_tabletheory_url != tabletheory_ts_url:
        fail(
            "ts/package-lock.json root @theory-cloud/tabletheory-ts "
            f"{ts_lock_tabletheory_url!r} != ts/package.json {tabletheory_ts_url!r}"
        )
    ts_lock_tabletheory_package = ts_lock.get("packages", {}).get("node_modules/@theory-cloud/tabletheory-ts", {})
    if ts_lock_tabletheory_package.get("resolved") != tabletheory_ts_url:
        fail(
            "ts/package-lock.json node_modules/@theory-cloud/tabletheory-ts resolved "
            f"{ts_lock_tabletheory_package.get('resolved')!r} != ts/package.json {tabletheory_ts_url!r}"
        )
    tabletheory_ts_package = npm_package_from_artifact(tabletheory_ts_url, "@theory-cloud/tabletheory-ts")
    tabletheory_ts_floor = parse_node_floor(
        tabletheory_ts_package.get("engines", {}).get("node", ""),
        "@theory-cloud/tabletheory-ts engines.node",
    )
    ts_lock_tabletheory_floor = parse_node_floor(
        ts_lock_tabletheory_package.get("engines", {}).get("node", ""),
        "ts/package-lock.json @theory-cloud/tabletheory-ts engines.node",
    )
    if ts_lock_tabletheory_floor != tabletheory_ts_floor:
        fail(
            "ts/package-lock.json @theory-cloud/tabletheory-ts engines.node "
            f">={ts_lock_tabletheory_floor} != release asset >={tabletheory_ts_floor}"
        )
    if tabletheory_ts_floor > ts_floor:
        fail(
            f"ts/package.json claims Node >={ts_floor} but "
            f"@theory-cloud/tabletheory-ts requires >={tabletheory_ts_floor}"
        )

    cdk_package = read_json("cdk/package.json")
    cdk_lock = read_json("cdk/package-lock.json")
    cdk_floor = parse_node_floor(cdk_package["engines"]["node"], "cdk/package.json engines.node")
    cdk_lock_engine = cdk_lock.get("packages", {}).get("", {}).get("engines", {}).get("node")
    if cdk_lock_engine != cdk_package["engines"]["node"]:
        fail(
            f"cdk/package-lock.json root engines.node {cdk_lock_engine!r} "
            f"!= cdk/package.json {cdk_package['engines']['node']!r}"
        )

    ci_python_versions = collect_ci_versions("python")
    ci_node_versions = collect_ci_versions("node")
    require_ci_python_version(py_floor, ci_python_versions)
    if py_floor < LATEST_PROVEN_PYTHON:
        require_ci_python_version(LATEST_PROVEN_PYTHON, ci_python_versions)
    for node_floor in sorted({ts_floor, cdk_floor}):
        require_ci_node_major(node_floor, ci_node_versions)
    if min(ts_floor, cdk_floor) < LATEST_PROVEN_NODE_MAJOR:
        require_ci_node_major(LATEST_PROVEN_NODE_MAJOR, ci_node_versions)

    runtime_floor_job = workflow_job_body("runtime-floor-matrix")
    runtime_floor_python_versions = collect_versions_from_text(runtime_floor_job, "python")
    runtime_floor_node_versions = collect_versions_from_text(runtime_floor_job, "node")
    require_ci_python_version(py_floor, runtime_floor_python_versions)
    if py_floor < LATEST_PROVEN_PYTHON:
        require_ci_python_version(LATEST_PROVEN_PYTHON, runtime_floor_python_versions)
    require_ci_node_major(ts_floor, runtime_floor_node_versions)
    if ts_floor < LATEST_PROVEN_NODE_MAJOR:
        require_ci_node_major(LATEST_PROVEN_NODE_MAJOR, runtime_floor_node_versions)
    require_job_contains("runtime-floor-matrix", runtime_floor_job, "bash scripts/verify-runtime-floor-claims.sh")
    require_job_contains("runtime-floor-matrix", runtime_floor_job, "bash scripts/verify-ts-pack.sh")
    require_job_contains("runtime-floor-matrix", runtime_floor_job, "bash scripts/verify-python-build.sh")
    require_job_contains("runtime-floor-matrix", runtime_floor_job, "bash scripts/verify-contract-tests.sh")

    cdk_floor_job = workflow_job_body("cdk-floor-matrix")
    cdk_floor_node_versions = collect_versions_from_text(cdk_floor_job, "node")
    require_ci_node_major(cdk_floor, cdk_floor_node_versions)
    if cdk_floor < LATEST_PROVEN_NODE_MAJOR:
        require_ci_node_major(LATEST_PROVEN_NODE_MAJOR, cdk_floor_node_versions)
    require_job_contains("cdk-floor-matrix", cdk_floor_job, "bash scripts/verify-cdk-go-drift.sh")

    print(
        "runtime-floor-claims: PASS "
        f"(python>={version_text(py_floor)}; "
        f"tabletheory-py>={version_text(tabletheory_py_floor)}; "
        f"ts node>={ts_floor}; tabletheory-ts node>={tabletheory_ts_floor}; "
        f"cdk node>={cdk_floor})"
    )


main()
PY
