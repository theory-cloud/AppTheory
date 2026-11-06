#!/usr/bin/env python3
"""Runtime API conformance suite: the runner's Runtime API against the RIE.

The suite builds one handler set per language on the real, digest-pinned Lambda
runtime images and runs the same cases twice through `apptheory-local invoke`:
once with the image's embedded Runtime Interface Emulator (`--rie`) and once
with the runner's own Lambda Runtime API (the default). It compares status,
headers, body bytes, handler error type and message, the timeout outcome and
the initialization-failure outcome.

The AWS pages are the authority, not the emulator:

* runtime API: https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
* custom runtime contract: https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
* execution environment lifecycle: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
* response streaming: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

Python buffers: "Lambda supports response streaming on Node.js managed
runtimes. For other languages, including Python, you can use a custom runtime
with a custom Runtime API integration to stream responses or use the Lambda Web
Adapter." (configuration-response-streaming.html)
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "scripts" / "local" / "conformance" / "handlers"
PASS_MARKER = "runtime-api-conformance: PASS"
FAIL_MARKER = "runtime-api-conformance: FAIL"

LANGUAGES = {
    "go": {
        "runtime": "provided.al2023",
        "handler": "bootstrap",
        "stream_handler": "bootstrap",
        "fixture": "go",
        "init_fixture": "go-init",
        "build": "go",
    },
    "node": {
        "runtime": "nodejs24.x",
        "handler": "index.handler",
        "stream_handler": "index.stream",
        "fixture": "node",
        "init_fixture": "init-node",
    },
    "python": {
        "runtime": "python3.14",
        "handler": "handler.handler",
        "fixture": "python",
        "init_fixture": "init-python",
    },
}

WARM_CASES = [
    {
        "name": "buffered-json",
        "event": {"case": "json"},
        "expect": {"raw": True},
    },
    {
        "name": "proxy",
        "event": {"case": "proxy"},
        "expect": {"status": 201, "header": {"x-case": "proxy"}, "cookies": ["a=1", "b=2"]},
    },
    {
        "name": "handler-error",
        "event": {"case": "error"},
        "expect": {"error": True},
    },
    {
        "name": "streaming",
        "event": {"case": "stream"},
        "expect": {"streamed": True},
        # Python cannot stream through its managed runtime; the page says so.
        "languages": ["go", "node"],
    },
]

PROXY_BODY = {
    "go": "go proxy body",
    "node": "node proxy body",
    "python": "python proxy body",
}


class SuiteFailure(Exception):
    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.output = output


def docker_arch() -> str:
    result = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Arch}}"], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise SuiteFailure("docker is unavailable", result.stderr.strip())
    arch = result.stdout.strip().lower()
    if arch in ("arm64", "aarch64"):
        return "arm64"
    if arch in ("amd64", "x86_64"):
        return "amd64"
    raise SuiteFailure(f"unsupported docker architecture {arch!r}")


def build_handlers(workdir: Path, arch: str) -> dict[str, dict[str, Path]]:
    go_arch = "arm64" if arch == "arm64" else "amd64"
    env = {**os.environ, "GOOS": "linux", "GOARCH": go_arch, "CGO_ENABLED": "0"}
    handlers: dict[str, dict[str, Path]] = {}
    for language, spec in LANGUAGES.items():
        directory = workdir / language
        directory.mkdir(parents=True, exist_ok=True)
        if spec.get("build") == "go":
            subprocess.run(
                ["go", "build", "-o", str(directory / "bootstrap"), "./scripts/local/conformance/handlers/go"],
                cwd=ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
        else:
            source = FIXTURES / spec["fixture"]
            for entry in source.iterdir():
                target = directory / entry.name
                if entry.is_dir():
                    shutil.copytree(entry, target)
                else:
                    shutil.copy2(entry, target)
        init_dir = workdir / f"{language}-init"
        init_dir.mkdir(parents=True, exist_ok=True)
        if spec.get("build") == "go":
            subprocess.run(
                ["go", "build", "-o", str(init_dir / "bootstrap"), "./scripts/local/conformance/handlers/go-init"],
                cwd=ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
        else:
            source = FIXTURES / spec["init_fixture"]
            for entry in source.iterdir():
                shutil.copy2(entry, init_dir / entry.name)
        handlers[language] = {"warm": directory, "init": init_dir}
    return handlers


def base_env() -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("AWS_") and not key.upper().endswith("_PROXY")
    }
    env.update(
        {
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": "dummy",
            "AWS_SECRET_ACCESS_KEY": "dummy",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "NO_PROXY": "*",
        }
    )
    return env


def invoke(
    runner: Path,
    profile: Path,
    prefix: str,
    handler_dir: Path,
    runtime: str,
    handler: str,
    events: list[dict],
    *,
    rie: bool,
    function_timeout: int,
    timeout: float = 180.0,
) -> tuple[list[dict], str, int]:
    argv = [
        str(runner),
        "invoke",
        "--handler-dir",
        str(handler_dir),
        "--runtime",
        runtime,
        "--handler",
        handler,
        "--profile",
        str(profile),
        "--name-prefix",
        prefix,
        "--timeout",
        str(function_timeout),
        "--stdio",
    ]
    if rie:
        argv.append("--rie")
    process = subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env=base_env(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        assert process.stdin is not None
        for event in events:
            process.stdin.write(json.dumps(event) + "\n")
        process.stdin.close()
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise SuiteFailure(f"invoke did not answer within {timeout}s ({prefix})")
    results = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            results.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise SuiteFailure(f"invoke returned non-JSON output: {exc}", line) from exc
    return results, stderr, process.returncode


def normalize(result: dict) -> dict:
    headers = {}
    for name, values in (result.get("headers") or {}).items():
        headers[name.lower()] = list(values) if isinstance(values, list) else [str(values)]
    return {
        "proxy": bool(result.get("proxy")),
        "status": int(result.get("statusCode") or 0),
        "headers": headers,
        "body": result.get("body") or "",
        "raw": result.get("raw"),
        "rawText": result.get("rawText"),
        "streamed": bool(result.get("streamed")),
        "handlerError": result.get("handlerError") or "",
    }


def describe(result: dict) -> str:
    if result.get("handlerError"):
        return "handlerError=" + result["handlerError"]
    if result.get("raw") is not None:
        return "raw=" + json.dumps(result["raw"], sort_keys=True)
    if result.get("rawText"):
        return "rawText=" + repr(result["rawText"])
    return f"status={result['status']} body={result['body']!r}"


def error_class(text: str) -> str:
    lowered = text.lower()
    if "sandbox.timedout" in lowered or "timed out" in lowered:
        return "timeout"
    if "runtime.exit" in lowered or "exited" in lowered:
        return "exit"
    if "runtime.invalidentrypoint" in lowered:
        return "invalid-entrypoint"
    if "error" in lowered:
        return "function-error"
    return "other"


def check_case(language: str, case: dict, result: dict) -> tuple[bool, str]:
    expect = case["expect"]
    if expect.get("error"):
        if not result["handlerError"]:
            return False, "expected a handler error, got " + describe(result)
        return True, result["handlerError"]
    if expect.get("raw"):
        if result["raw"] is None:
            return False, "expected a raw JSON result, got " + describe(result)
        body = result["raw"]
        if not isinstance(body, dict) or body.get("ok") is not True or body.get("runtime") != language:
            return False, f"unexpected raw payload {body!r}"
        return True, json.dumps(body, sort_keys=True)
    if expect.get("status"):
        if result["status"] != expect["status"]:
            return False, f"status {result['status']} != {expect['status']}"
        for name, value in (expect.get("header") or {}).items():
            if value not in (result["headers"].get(name) or []):
                return False, f"header {name}={result['headers'].get(name)} does not contain {value!r}"
        if result["body"] != PROXY_BODY[language]:
            return False, f"body {result['body']!r} != {PROXY_BODY[language]!r}"
        return True, f"status {result['status']}, x-case=cookie/{len(expect.get('cookies') or [])} cookies"
    if expect.get("streamed"):
        payload = result["body"] if result["proxy"] else (result["rawText"] or "")
        for needle in (f"{language}-1", f"{language}-2"):
            if needle not in payload:
                return False, f"streamed body is missing {needle!r}: {payload!r}"
        return True, "streamed frame carried both chunks"
    return False, "the case has no expectation"


def run_language(
    runner: Path,
    profile: Path,
    prefix_root: str,
    language: str,
    handlers: dict[str, Path],
    mode: str,
    results: dict,
) -> None:
    spec = LANGUAGES[language]
    rie = mode == "rie"
    prefix = f"{prefix_root}-{language}-{mode}"
    buffered_cases = [case for case in WARM_CASES if case["name"] != "streaming"]
    buffered_results, stderr, code = invoke(
        runner, profile, prefix, handlers["warm"], spec["runtime"], spec["handler"],
        [case["event"] for case in buffered_cases], rie=rie, function_timeout=5,
    )
    if code != 0 and len(buffered_results) != len(buffered_cases):
        raise SuiteFailure(f"{language}/{mode}: the buffered invocations failed", stderr)
    for case, result in zip(buffered_cases, buffered_results):
        results[(language, mode, case["name"])] = normalize(result)

    if "stream_handler" in spec:
        stream_results, stderr, code = invoke(
            runner, profile, prefix, handlers["warm"], spec["runtime"], spec["stream_handler"],
            [{"case": "stream"}], rie=rie, function_timeout=5,
        )
        if not stream_results:
            raise SuiteFailure(f"{language}/{mode}: the streaming invocation returned nothing", stderr)
        results[(language, mode, "streaming")] = normalize(stream_results[0])

    timeout_results, stderr, code = invoke(
        runner, profile, prefix, handlers["warm"], spec["runtime"], spec["handler"],
        [{"case": "timeout"}], rie=rie, function_timeout=1, timeout=120.0,
    )
    timeout_result = normalize(timeout_results[0]) if timeout_results else {}
    timeout_detail = " ".join(
        part for part in (
            timeout_result.get("handlerError", ""),
            timeout_result.get("rawText", ""),
            json.dumps(timeout_result.get("raw") or ""),
            stderr,
        ) if part
    )
    results[(language, mode, "timeout")] = {
        "outcome": "failed" if code != 0 or timeout_result.get("handlerError") else "answered",
        "detail": timeout_detail.strip(),
        "class": error_class(timeout_detail),
    }

    init_results, stderr, code = invoke(
        runner, profile, prefix, handlers["init"], spec["runtime"], spec["handler"],
        [{"case": "json"}], rie=rie, function_timeout=5, timeout=120.0,
    )
    init_result = normalize(init_results[0]) if init_results else {}
    init_detail = " ".join(
        part for part in (
            init_result.get("handlerError", ""),
            init_result.get("rawText", ""),
            json.dumps(init_result.get("raw") or ""),
            stderr,
        ) if part
    )
    results[(language, mode, "init-failure")] = {
        "outcome": "failed" if code != 0 or init_result.get("handlerError") else "answered",
        "detail": init_detail.strip(),
        "class": error_class(init_detail),
    }


def compare(results: dict) -> tuple[list[str], list[str]]:
    differences: list[str] = []
    failures: list[str] = []
    for language in LANGUAGES:
        for case in WARM_CASES:
            if language not in case.get("languages", list(LANGUAGES)):
                continue
            name = case["name"]
            rie = results.get((language, "rie", name))
            runner = results.get((language, "runner", name))
            if rie is None or runner is None:
                failures.append(f"{language}/{name}: a mode produced no result")
                continue
            if case["expect"].get("streamed"):
                # The emulator buffers the whole stream; the bytes must match.
                rie_payload = rie["body"] if rie["proxy"] else (rie["rawText"] or "")
                runner_payload = runner["body"] if runner["proxy"] else (runner["rawText"] or "")
                if rie_payload != runner_payload:
                    differences.append(f"{language}/{name}: RIE and runner streamed bodies differ")
                if rie["proxy"] != runner["proxy"]:
                    differences.append(f"{language}/{name}: RIE and runner streamed framing differ")
            elif case["expect"].get("error"):
                if error_class(rie["handlerError"]) != error_class(runner["handlerError"]):
                    differences.append(
                        f"{language}/{name}: error class RIE={error_class(rie['handlerError'])} "
                        f"runner={error_class(runner['handlerError'])}"
                    )
            else:
                for field in ("status", "body", "proxy", "streamed"):
                    if rie[field] != runner[field]:
                        differences.append(f"{language}/{name}: {field} RIE={rie[field]!r} runner={runner[field]!r}")
                for header in ("x-case", "content-type", "set-cookie"):
                    if (rie["headers"].get(header) or []) != (runner["headers"].get(header) or []):
                        differences.append(f"{language}/{name}: header {header} differs")
            ok, detail = check_case(language, case, runner)
            if not ok:
                failures.append(f"{language}/{name}: the runner does not match the page: {detail}")
        for name in ("timeout", "init-failure"):
            rie = results.get((language, "rie", name))
            runner = results.get((language, "runner", name))
            if rie is None or runner is None:
                failures.append(f"{language}/{name}: a mode produced no result")
                continue
            if runner["outcome"] != "failed":
                failures.append(f"{language}/{name}: the runner answered instead of failing")
            if rie["outcome"] != runner["outcome"]:
                differences.append(
                    f"{language}/{name}: outcome RIE={rie['outcome']} runner={runner['outcome']} "
                    f"(RIE: {rie['detail'][:180]!r}; runner: {runner['detail'][:180]!r})"
                )
            elif rie["class"] != runner["class"]:
                differences.append(
                    f"{language}/{name}: error class RIE={rie['class']} runner={runner['class']} "
                    f"(RIE: {rie['detail'][:180]!r}; runner: {runner['detail'][:180]!r})"
                )
    return differences, failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Runtime API conformance suite")
    parser.add_argument("--runner", required=True, help="the built apptheory-local binary")
    parser.add_argument("--profile", required=True, help="the checked-in local execution profile")
    parser.add_argument("--workdir", default=None, help="scratch directory (default: a new directory under $HOME)")
    parser.add_argument("--language", action="append", default=None, help="limit to one language (repeatable)")
    args = parser.parse_args(argv)

    languages = args.language or list(LANGUAGES)
    for language in languages:
        if language not in LANGUAGES:
            print(f"{FAIL_MARKER}: unknown language {language!r}", file=sys.stderr)
            return 2

    # Colima shares $HOME, not the system temporary directory; the runner
    # refuses a code directory outside $HOME and the checkout.
    workdir = Path(args.workdir) if args.workdir else Path.home() / ".cache" / f"apptheory-runtime-api-conformance-{os.getpid()}"
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)
    runner = Path(args.runner)
    profile = Path(args.profile)
    if not runner.is_file():
        print(f"{FAIL_MARKER}: the runner binary {runner} does not exist", file=sys.stderr)
        return 2
    try:
        arch = docker_arch()
        print(f"runtime API conformance: {len(languages)} language(s), docker {arch}")
        handlers = build_handlers(workdir, arch)
        results: dict = {}
        for language in languages:
            for mode in ("rie", "runner"):
                print(f"  {language}/{mode}: running")
                run_language(runner, profile, f"r3a-conformance-{os.getpid()}", language, handlers[language], mode, results)
        differences, failures = compare(results)

        print()
        print("  case                         RIE                         runner")
        for language in languages:
            for case in WARM_CASES:
                if language not in case.get("languages", list(LANGUAGES)):
                    continue
                name = case["name"]
                rie = results.get((language, "rie", name))
                runner_result = results.get((language, "runner", name))
                print(f"  {language}/{name:<20} {describe(rie) if rie else 'missing':<28} {describe(runner_result) if runner_result else 'missing'}")
            for name in ("timeout", "init-failure"):
                rie = results.get((language, "rie", name))
                runner_result = results.get((language, "runner", name))
                print(
                    f"  {language}/{name:<20} {rie['outcome'] + '/' + rie['class'] if rie else 'missing':<28} "
                    f"{runner_result['outcome'] + '/' + runner_result['class'] if runner_result else 'missing'}"
                )
        if differences:
            print()
            print("  differences (the page decides which mode is right):")
            for difference in differences:
                print(f"    - {difference}")
        if failures:
            print()
            print("  failures:")
            for failure in failures:
                print(f"    - {failure}")
            print(FAIL_MARKER)
            return 1
        print()
        print(PASS_MARKER)
        return 0
    except SuiteFailure as failure:
        print(f"{failure.message}", file=sys.stderr)
        if failure.output:
            print(failure.output, file=sys.stderr)
        print(FAIL_MARKER)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"building the conformance handlers failed: {exc}", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        print(FAIL_MARKER)
        return 1
    finally:
        if args.workdir is None:
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
