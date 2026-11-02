#!/usr/bin/env python3
"""Prove the CDK TypeScript/Python Lambda assets load in the official runtime.

``scripts/verify-cdk-synth.sh`` proves the templates are deterministic; this
script proves the *code* those templates deploy actually runs. It synthesizes
the hello-world TypeScript and Python stacks and the multilang TypeScript and
Python assets, finds the asset directories CDK produced, and invokes each one in
the official Lambda runtime image (``public.ecr.aws/lambda/nodejs:24`` /
``python:3.14``, both of which embed the Runtime Interface Emulator).

Running the built asset, not an in-process import, is the point: LOCAL-A0 found
that the staged TypeScript assets shipped only ``ts/dist`` and failed at init in
a clean runtime with ``ERR_MODULE_NOT_FOUND`` for
``@theory-cloud/tabletheory-ts``. An in-process test that resolves modules from
the checkout cannot see that failure.

Every container and the scratch synthesis tree live under ``$HOME`` (the
Docker/colima share) and are removed afterwards. Nothing here contacts AWS:
the images and the local Docker daemon are the only dependencies.

The script is runnable standalone on a fresh checkout: when the ``cdk/`` or
``ts/`` dependency trees the examples link against are missing, it installs
them with ``npm ci`` (the same prerequisite the synth gate provisions) and
prints what it is doing. A Docker daemon is always required.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORK = Path.home() / ".cache" / "apptheory-lambda-assets"
SYNTH_TIMEOUT = 900
INVOKE_TIMEOUT = 120
READY_TIMEOUT = 120
INVOCATION_PATH = "/2015-03-31/functions/function/invocations"


@dataclass(frozen=True)
class AssetCase:
    name: str
    example: str
    language: str
    synth_args: tuple[str, ...]
    asset_marker: str
    path: str
    expected: dict
    environment: dict


CASES: tuple[AssetCase, ...] = (
    AssetCase(
        name="hello-world-ts",
        example="examples/cdk/hello-world",
        language="ts",
        synth_args=("-c", "lang=ts"),
        asset_marker="vendor/apptheory/index.js",
        path="/hello/AppTheory",
        expected={"message": "hello AppTheory", "runtime": "ts"},
        environment={"APPTHEORY_HELLO_LANG": "ts", "APPTHEORY_TIER": "p2"},
    ),
    AssetCase(
        name="hello-world-py",
        example="examples/cdk/hello-world",
        language="py",
        synth_args=("-c", "lang=py"),
        asset_marker="apptheory/__init__.py",
        path="/hello/AppTheory",
        expected={"message": "hello AppTheory", "runtime": "py"},
        environment={"APPTHEORY_HELLO_LANG": "py", "APPTHEORY_TIER": "p2"},
    ),
    AssetCase(
        name="multilang-ts",
        example="examples/cdk/multilang",
        language="ts",
        synth_args=(),
        asset_marker="vendor/apptheory/index.js",
        path="/",
        expected={"ok": True, "lang": "ts"},
        environment={
            "APPTHEORY_LANG": "ts",
            "APPTHEORY_TIER": "p2",
            "APPTHEORY_DEMO_NAME": "apptheory-multilang",
        },
    ),
    AssetCase(
        name="multilang-py",
        example="examples/cdk/multilang",
        language="py",
        synth_args=(),
        asset_marker="apptheory/__init__.py",
        path="/",
        expected={"ok": True, "lang": "py"},
        environment={
            "APPTHEORY_LANG": "py",
            "APPTHEORY_TIER": "p2",
            "APPTHEORY_DEMO_NAME": "apptheory-multilang",
        },
    ),
)

IMAGES = {
    "ts": "public.ecr.aws/lambda/nodejs:24",
    "py": "public.ecr.aws/lambda/python:3.14",
}


class AssetFailure(Exception):
    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.output = output


def run(argv: list[str], *, cwd: Path | None = None, env: dict | None = None, timeout: int) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            argv,
            cwd=str(cwd or ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AssetFailure(f"{argv[0]} is not available: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        output = "\n".join(
            part.decode("utf-8", "replace") if isinstance(part, bytes) else part
            for part in (exc.stdout, exc.stderr)
            if part
        )
        raise AssetFailure(f"timed out after {timeout}s: {' '.join(argv)}", output) from exc


def combined(result: subprocess.CompletedProcess) -> str:
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


def synth_env() -> dict:
    """Dummy, endpoint-free AWS surface for every synthesis child."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("AWS_")}
    for key in ("CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION", "CDK_CONTEXT_JSON", "CDK_OUTDIR"):
        env.pop(key, None)
    env.update(
        {
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": "dummy",
            "AWS_SECRET_ACCESS_KEY": "dummy",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
        }
    )
    return env


def npm_ci(project_dir: Path) -> None:
    print(f"  ... installing {project_dir.relative_to(ROOT)} dependencies (npm ci)")
    result = run(
        ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=project_dir,
        timeout=1800,
    )
    if result.returncode != 0:
        raise AssetFailure(
            f"npm ci failed for {project_dir.relative_to(ROOT)}; the CDK examples need this dependency tree "
            "before they can be synthesized (run `make examples-local` or `scripts/verify-cdk-synth.sh` "
            "to provision it)",
            combined(result),
        )


def ensure_cdk_dependencies() -> None:
    """Install the cdk/ tree the examples link against, when it is missing."""
    cdk_dir = ROOT / "cdk"
    if not cdk_dir.is_dir():
        raise AssetFailure(f"missing {cdk_dir}; run this script from an AppTheory checkout")
    complete = (cdk_dir / "node_modules" / "constructs" / "package.json").is_file() and (
        cdk_dir / "node_modules" / "aws-cdk-lib" / "package.json"
    ).is_file()
    if complete:
        return
    npm_ci(cdk_dir)
    if not (cdk_dir / "node_modules" / "constructs" / "package.json").is_file():
        raise AssetFailure(
            "cdk/node_modules is still incomplete after npm ci (missing constructs); "
            "run `cd cdk && npm ci --ignore-scripts` and retry"
        )


def ensure_ts_dependencies() -> None:
    """Install the ts/ tree whose dist and dependency closure the assets vendor."""
    ts_dir = ROOT / "ts"
    if not ts_dir.is_dir():
        raise AssetFailure(f"missing {ts_dir}; run this script from an AppTheory checkout")
    marker = ts_dir / "node_modules" / "@theory-cloud" / "tabletheory-ts" / "package.json"
    if marker.is_file():
        return
    npm_ci(ts_dir)
    if not marker.is_file():
        raise AssetFailure(
            "ts/node_modules is still incomplete after npm ci (missing @theory-cloud/tabletheory-ts); "
            "run `cd ts && npm ci --ignore-scripts` and retry"
        )


def ensure_example_dependencies(example_dir: Path) -> None:
    cdk = example_dir / "node_modules" / ".bin" / "cdk"
    if cdk.is_file():
        return
    if not example_dir.is_dir():
        raise AssetFailure(
            f"example directory is missing: {example_dir.relative_to(ROOT)} "
            "(run this script from the AppTheory checkout root)"
        )
    npm_ci(example_dir)
    if not cdk.is_file():
        raise AssetFailure(f"cdk CLI is still missing after npm ci: {cdk}")


def synthesize(case: AssetCase, out_dir: Path) -> Path:
    example_dir = ROOT / case.example
    ensure_example_dependencies(example_dir)
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    result = run(
        [
            str(example_dir / "node_modules" / ".bin" / "cdk"),
            "synth",
            *case.synth_args,
            "--quiet",
            "--no-notices",
            "--no-version-reporting",
            "-o",
            str(out_dir),
        ],
        cwd=example_dir,
        env=synth_env(),
        timeout=SYNTH_TIMEOUT,
    )
    if result.returncode != 0:
        raise AssetFailure(f"cdk synth failed for {case.name}", combined(result))

    candidates = sorted(
        directory
        for directory in out_dir.glob("asset.*")
        if directory.is_dir() and (directory / case.asset_marker).is_file()
    )
    if len(candidates) != 1:
        raise AssetFailure(
            f"{case.name}: expected exactly one asset containing {case.asset_marker}, found {len(candidates)}"
        )
    return candidates[0]


def event_body(case: AssetCase) -> bytes:
    payload = {
        "version": "2.0",
        "routeKey": f"GET {case.path}",
        "rawPath": case.path,
        "rawQueryString": "",
        "headers": {"host": "127.0.0.1"},
        "requestContext": {
            "http": {
                "method": "GET",
                "path": case.path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
            },
            "requestId": f"lambda-assets-{case.name}",
            "stage": "$default",
        },
        "isBase64Encoded": False,
    }
    return json.dumps(payload).encode("utf-8")


def container_name(case: AssetCase, checkout: str) -> str:
    return f"apptheory-lambda-assets-{checkout}-{case.name}"


def remove_container(name: str) -> None:
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True, check=False)


def start_container(case: AssetCase, asset: Path, name: str) -> None:
    remove_container(name)
    result = run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "-p",
            "127.0.0.1:0:8080",
            "-v",
            f"{asset}:/var/task:ro",
            *[item for key, value in case.environment.items() for item in ("-e", f"{key}={value}")],
            IMAGES[case.language],
            "handler.handler",
        ],
        timeout=900,
    )
    if result.returncode != 0:
        raise AssetFailure(f"{case.name}: docker run failed", combined(result))


def host_port(name: str) -> int:
    result = run(
        [
            "docker",
            "inspect",
            "-f",
            '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
            name,
        ],
        timeout=60,
    )
    if result.returncode != 0:
        raise AssetFailure(f"{name}: docker inspect failed", combined(result))
    try:
        return int(result.stdout.strip())
    except ValueError as exc:
        raise AssetFailure(f"{name}: unexpected published port {result.stdout.strip()!r}") from exc


def invoke(name: str, port: int, case: AssetCase) -> dict:
    deadline = time.monotonic() + READY_TIMEOUT
    last_error = ""
    while time.monotonic() < deadline:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{INVOCATION_PATH}",
            data=event_body(case),
            method="POST",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=INVOKE_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(0.5)
    logs = run(["docker", "logs", name], timeout=60)
    raise AssetFailure(f"{case.name}: runtime never answered ({last_error})", combined(logs))


def assert_invocation(case: AssetCase, result: dict) -> None:
    if "errorType" in result:
        raise AssetFailure(f"{case.name}: runtime returned {result.get('errorType')}: {result.get('errorMessage')}")
    status = result.get("statusCode")
    if status != 200:
        raise AssetFailure(f"{case.name}: statusCode {status!r}, want 200", json.dumps(result))
    body_text = result.get("body")
    if not isinstance(body_text, str):
        raise AssetFailure(f"{case.name}: body is not a string: {body_text!r}")
    body = json.loads(body_text)
    for key, expected in case.expected.items():
        if body.get(key) != expected:
            raise AssetFailure(
                f"{case.name}: body[{key!r}] is {body.get(key)!r}, want {expected!r}",
                body_text,
            )


def run_case(case: AssetCase, work_dir: Path, checkout: str, keep: bool) -> str:
    name = container_name(case, checkout)
    asset = synthesize(case, work_dir / case.name)
    try:
        start_container(case, asset, name)
        port = host_port(name)
        result = invoke(name, port, case)
        assert_invocation(case, result)
        return f"{case.name} loaded and answered {case.path} in {IMAGES[case.language]}"
    finally:
        remove_container(name)
        if not keep:
            shutil.rmtree(work_dir / case.name, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the built Lambda assets in the official runtime images")
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--keep", action="store_true", help="keep the synthesized assets for inspection")
    args = parser.parse_args(argv)

    if subprocess.run(["docker", "info"], capture_output=True, text=True, check=False).returncode != 0:
        print("lambda-assets: FAIL (Docker is unavailable; start Colima/Docker first)", file=sys.stderr)
        return 1

    checkout = hashlib.sha256(str(ROOT.resolve()).encode("utf-8")).hexdigest()[:8]
    args.work_dir.mkdir(parents=True, exist_ok=True)

    print("lambda-assets: built assets in the official Lambda runtime images")
    try:
        ensure_cdk_dependencies()
        ensure_ts_dependencies()
    except AssetFailure as failure:
        print(f"  FAIL  {failure.message}", file=sys.stderr)
        for line in failure.output.strip().splitlines()[-40:]:
            print(f"        | {line}", file=sys.stderr)
        print("lambda-assets: FAIL", file=sys.stderr)
        return 1
    staged = run(
        ["node", "examples/cdk/hello-world/handlers/ts/staged-asset.test.mjs"],
        timeout=300,
    )
    if staged.returncode != 0 or "staged-asset.test.mjs: PASS" not in staged.stdout:
        print("  FAIL  staged TypeScript asset self-test failed", file=sys.stderr)
        for line in combined(staged).strip().splitlines()[-40:]:
            print(f"        | {line}", file=sys.stderr)
        print("lambda-assets: FAIL", file=sys.stderr)
        return 1
    print("  PASS  staged TypeScript asset resolves its dependencies without the checkout")
    for case in CASES:
        try:
            detail = run_case(case, args.work_dir, checkout, args.keep)
        except AssetFailure as failure:
            print(f"  FAIL  {failure.message}", file=sys.stderr)
            if failure.output.strip():
                for line in failure.output.strip().splitlines()[-40:]:
                    print(f"        | {line}", file=sys.stderr)
            print("lambda-assets: FAIL", file=sys.stderr)
            return 1
        print(f"  PASS  {detail}")

    if not args.keep:
        try:
            args.work_dir.rmdir()
        except OSError:
            pass
    print("lambda-assets: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
