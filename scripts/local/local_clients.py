#!/usr/bin/env python3
"""Drive real MCP clients against the local MCP auth-facade example.

This is a maintained local target (``make local-clients``), never a CI job. It
replays the client behaviours that broke on the old refresh policy — a long
session, a restart, concurrent work, retries, a lost response — against the
example app, and records what each client actually does.

Isolation rules, in order of precedence:

* every client gets its own home under one scratch directory, created with mode
  0700 and deleted when the run ends (``--keep`` retains it for inspection);
* the operator's real client homes are never modified and are never read for
  MCP state: no MCP entry and no MCP OAuth store is ever copied;
* exactly one model-provider credential per client is carried into that
  client's isolated home (mode 0600, deleted with the scratch). For Claude Code
  the credential is the keychain item's ``claudeAiOauth`` subtree only — its
  ``mcpOAuth`` store is deliberately dropped; for Codex it is ``auth.json``,
  which holds model auth only (MCP servers live in ``config.toml``);
* the copied credential is never printed by this script.

A profile that cannot be exercised for an environmental reason (no model
credential configured for that client, or no headless login surface) is
reported BLOCKED with the exact reason and is not counted as proof. A profile
that acts wrongly is a FAILURE.
"""

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL_RUNNER = Path.home() / ".cache" / "apptheory-examples-local" / "bin" / "apptheory-local"
DEMO_APP = "examples/cdk/local-mcp-auth-facade"
TLS_HOST = "mcp.localhost"
PORT = 8240
SCRATCH = Path.home() / ".cache" / "apptheory-local-clients"
CLIENTS = {
    "codex": Path("/Users/theorycloud/.local/bin/codex"),
    "claude_code": Path("/Users/theorycloud/.local/bin/claude"),
    "kimi_code": Path("/Users/theorycloud/.kimi-code/bin/kimi"),
    "vibe": Path("/Users/theorycloud/.local/bin/vibe"),
}
TOOL_PROMPT = (
    "Call the example MCP server's echo tool with message 'hello-from-client' and reply with "
    "exactly its output."
)
ANSI = re.compile(r"\x1b\]8;;.*?\x07|\x1b\[[0-9;?]*[A-Za-z]|\x07")


class Blocked(RuntimeError):
    """The profile cannot be exercised on this machine, with a reason."""


class Failed(RuntimeError):
    """The profile acted wrongly."""


def log(message: str) -> None:
    print(message, flush=True)


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


def http_get(url: str, ca_file: str) -> tuple[int, str]:
    context = ssl.create_default_context(cafile=ca_file)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
    try:
        with opener.open(urllib.request.Request(url), timeout=20) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("location") or ""
    except urllib.error.URLError as exc:
        raise Failed(f"fetching {url} failed: {exc}") from exc


def follow_authorize(url: str, ca_file: str, local_prefixes: tuple[str, ...]) -> str:
    """Act as the browser: follow the authorize chain to the client's callback."""
    target = url
    for _ in range(10):
        if target.startswith(local_prefixes):
            return target
        status, location = http_get(target, ca_file)
        if status in (301, 302, 303, 307) and location:
            target = location
            continue
        raise Failed(f"the authorize chain answered {status} at {target[:120]}")
    raise Failed("the authorize chain never reached the client callback")


def drive_pty(command: list[str], env: dict, ca_file: str, local_prefixes: tuple[str, ...], timeout: float = 90) -> str:
    """Run a client's headless login and complete its callback paste."""
    master, slave = pty.openpty()
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    buffer = b""
    url = None
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 1.0)
            if not ready:
                if process.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
            text = strip_ansi(buffer.decode("utf-8", "replace"))
            match = re.search(r"https://[^\s]+/authorize\?[^\s]+", text)
            if match:
                url = match.group(0)
            if url and re.search(r"(?i)(paste|callback url|redirect url)", text):
                break
        text = strip_ansi(buffer.decode("utf-8", "replace"))
        if not url:
            raise Blocked(f"the client printed no authorization URL: {text[-600:]}")
        callback = follow_authorize(url, ca_file, local_prefixes)
        os.write(master, (callback + "\r").encode())
        time.sleep(2)
        settle = time.time() + 10
        while time.time() < settle:
            ready, _, _ = select.select([master], [], [], 1.0)
            if not ready:
                if process.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            buffer += chunk
        text = strip_ansi(buffer.decode("utf-8", "replace"))
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            raise Failed(f"the client did not finish its login: {text[-800:]}") from None
        if process.returncode != 0:
            raise Failed(f"the login exited {process.returncode}: {text[-800:]}")
        if re.search(r"(?i)(failed|error:)", text):
            raise Failed(f"the login reported a failure: {text[-800:]}")
        return text
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if process.poll() is None:
            process.kill()


class Demo:
    """The example app under the local runner."""

    def __init__(self, scratch: Path) -> None:
        self.scratch = scratch
        self.process: subprocess.Popen | None = None
        self.log_path = scratch / "demo.log"
        self.base = f"https://{TLS_HOST}:{PORT}"
        self.ca = ""

    def __enter__(self) -> "Demo":
        if not LOCAL_RUNNER.is_file():
            raise Blocked(
                f"the local runner is not built at {LOCAL_RUNNER}; run 'go build -o {LOCAL_RUNNER} "
                "./cmd/apptheory-local'"
            )
        handle = open(self.log_path, "w", encoding="utf-8")
        self.process = subprocess.Popen(
            [
                str(LOCAL_RUNNER),
                "run",
                "--app",
                DEMO_APP,
                "--profile",
                str(ROOT / "scripts/local/examples-local.json"),
                "--port-base",
                str(PORT),
                "--name-prefix",
                "local-clients",
                "--tls",
                "--tls-host",
                TLS_HOST,
                "-c",
                f"publicBaseUrl={self.base}",
                "-c",
                "accessTTL=30s",
            ],
            cwd=str(ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + 180
        while time.time() < deadline:
            text = self.log_path.read_text(encoding="utf-8", errors="replace")
            match = re.search(r"CA (/[^\s]+ca\.pem)", text)
            if match and "local-run: ready" in text:
                self.ca = match.group(1)
                return self
            if self.process.poll() is not None:
                raise Failed(f"the example app exited during startup:\n{text[-2000:]}")
            time.sleep(0.5)
        raise Failed("the example app did not become ready in 180s")

    def __exit__(self, *_exc) -> bool:
        if self.process is not None and self.process.poll() is None:
            try:
                os.killpg(os.getpgid(self.process.pid), 15)
                self.process.wait(timeout=30)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(os.getpgid(self.process.pid), 9)
                except ProcessLookupError:
                    pass
        return False

    def state(self) -> dict:
        context = ssl.create_default_context(cafile=self.ca)
        with urllib.request.urlopen(self.base + "/_state", context=context, timeout=20) as response:
            return json.loads(response.read().decode())


def copy_codex_model_auth(home: Path) -> None:
    source = Path.home() / ".codex" / "auth.json"
    if not source.is_file():
        raise Blocked("no ~/.codex/auth.json model credential to carry into the isolated home")
    target = home / "auth.json"
    target.write_bytes(source.read_bytes())
    target.chmod(0o600)


def copy_claude_model_auth(home: Path) -> str:
    """Carry only the model OAuth subtree, never the operator's MCP OAuth store."""
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        raise Blocked("no Claude Code model credential in the login keychain") from None
    store = json.loads(raw)
    oauth = store.get("claudeAiOauth")
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        raise Blocked("the Claude Code credential carries no model OAuth token")
    # mcpOAuth is deliberately not copied: it is the operator's MCP state.
    target = home / ".credentials.json"
    target.write_text(json.dumps({"claudeAiOauth": oauth}))
    target.chmod(0o600)
    return str(oauth["accessToken"])


def copy_kimi_model_auth(home: Path) -> None:
    sources = sorted((Path.home() / ".kimi-code" / "credentials").glob("kimi-code-env-*.json"))
    if not sources:
        raise Blocked("no Kimi Code model credential file to carry into the isolated home")
    credentials = home / "credentials"
    credentials.mkdir(parents=True, exist_ok=True)
    target = credentials / sources[0].name
    target.write_bytes(sources[0].read_bytes())
    target.chmod(0o600)


def vibe_model_key() -> str | None:
    """Return Mistral's model API key, or None when it is not configured.

    Only the key value is used, in the child's environment; nothing is copied
    and nothing is printed.
    """
    if os.environ.get("MISTRAL_API_KEY"):
        return os.environ["MISTRAL_API_KEY"]
    config = Path.home() / ".vibe" / "config.toml"
    if not config.is_file():
        return None
    try:
        import tomllib
    except ImportError:
        return None
    try:
        document = tomllib.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for table in (document, document.get("api") or {}, document.get("model") or {}):
        for key, value in table.items():
            if key.lower() in {"api_key", "apikey", "mistral_api_key"} and isinstance(value, str) and value:
                return value
    return None


def profile_codex(demo: Demo, home: Path, name: str) -> dict:
    copy_codex_model_auth(home)
    (home / "config.toml").write_text(
        f'[mcp_servers.{name}]\nurl = "{demo.base}/acme/mcp"\n', encoding="utf-8"
    )
    env = os.environ.copy()
    env["CODEX_HOME"] = str(home)
    env["CODEX_CA_CERTIFICATE"] = demo.ca
    login = drive_pty(
        [str(CLIENTS["codex"]), "mcp", "login", name, "--no-browser"],
        env,
        demo.ca,
        ("http://127.0.0.1", "http://localhost"),
    )
    before = demo.state()
    first = subprocess.run(
        [
            str(CLIENTS["codex"]),
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            TOOL_PROMPT,
        ],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    middle = demo.state()
    second = subprocess.run(
        [
            str(CLIENTS["codex"]),
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            TOOL_PROMPT.replace("hello-from-client", "hello-after-restart"),
        ],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    after = demo.state()
    return observe("codex", login, before, middle, after, first, second, demo)


def profile_claude(demo: Demo, home: Path, name: str) -> dict:
    token = copy_claude_model_auth(home)
    env = os.environ.copy()
    env["CLAUDE_CONFIG_DIR"] = str(home)
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    env["NODE_EXTRA_CA_CERTS"] = demo.ca
    added = subprocess.run(
        [
            str(CLIENTS["claude_code"]),
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "http",
            name,
            demo.base + "/acme/mcp",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if added.returncode != 0:
        raise Failed(f"claude mcp add failed: {added.stdout[-400:]} {added.stderr[-400:]}")
    login = drive_pty(
        [str(CLIENTS["claude_code"]), "mcp", "login", name, "--no-browser"],
        env,
        demo.ca,
        ("http://127.0.0.1", "http://localhost"),
    )
    before = demo.state()
    first = subprocess.run(
        [
            str(CLIENTS["claude_code"]),
            "-p",
            "--allowedTools",
            f"mcp__{name}__echo",
            "--dangerously-skip-permissions",
            TOOL_PROMPT,
        ],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    middle = demo.state()
    second = subprocess.run(
        [
            str(CLIENTS["claude_code"]),
            "-p",
            "--allowedTools",
            f"mcp__{name}__echo",
            "--dangerously-skip-permissions",
            TOOL_PROMPT.replace("hello-from-client", "hello-after-restart"),
        ],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    after = demo.state()
    return observe("claude_code", login, before, middle, after, first, second, demo)


def profile_kimi(demo: Demo, home: Path, name: str) -> dict:
    copy_kimi_model_auth(home)
    env = os.environ.copy()
    env["KIMI_CODE_HOME"] = str(home)
    env["NODE_EXTRA_CA_CERTS"] = demo.ca
    (home / "config.toml").write_text(
        f'[mcp_servers.{name}]\nurl = "{demo.base}/acme/mcp"\n', encoding="utf-8"
    )
    before = demo.state()
    first = subprocess.run(
        [str(CLIENTS["kimi_code"]), "-p", TOOL_PROMPT],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    after = demo.state()
    if int(after.get("toolCalls") or 0) <= int(before.get("toolCalls") or 0):
        detail = " ".join((first.stdout + first.stderr).strip().splitlines()[:3])
        raise Blocked(f"Kimi Code could not run a prompt in its isolated home: {detail}")
    return observe("kimi_code", "", before, after, after, first, None, demo)


def profile_vibe(demo: Demo, home: Path, name: str) -> dict:
    key = vibe_model_key()
    if not key:
        raise Blocked("no Mistral model API key is configured for Vibe")
    env = os.environ.copy()
    env["VIBE_HOME"] = str(home)
    env["MISTRAL_API_KEY"] = key
    env["SSL_CERT_FILE"] = demo.ca
    env["REQUESTS_CA_BUNDLE"] = demo.ca
    added = subprocess.run(
        [
            str(CLIENTS["vibe"]),
            "mcp",
            "add",
            "--url",
            demo.base + "/acme/mcp",
            "--name",
            name,
            "--scope",
            "mcp:tools",
            "--no-login",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if added.returncode != 0:
        raise Failed(f"vibe mcp add failed: {added.stdout[-400:]} {added.stderr[-400:]}")
    before = demo.state()
    first = subprocess.run(
        [str(CLIENTS["vibe"]), "-p", TOOL_PROMPT],
        cwd=str(home.parent / "work"),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    after = demo.state()
    if int(after.get("toolCalls") or 0) <= int(before.get("toolCalls") or 0):
        detail = " ".join((first.stdout + first.stderr).strip().splitlines()[:3])
        raise Blocked(f"Vibe could not run a prompt in its isolated home: {detail}")
    return observe("vibe", "", before, after, after, first, None, demo)


def observe(
    client: str,
    login: str,
    before: dict,
    middle: dict,
    after: dict,
    first: subprocess.CompletedProcess,
    second: subprocess.CompletedProcess | None,
    demo: Demo,
) -> dict:
    tool_calls = int(after.get("toolCalls") or 0) - int(before.get("toolCalls") or 0)
    refreshed = int((after.get("upstream") or {}).get("refreshed") or 0) - int(
        (before.get("upstream") or {}).get("refreshed") or 0
    )
    refusals = len((after.get("refusals") or [])) - len((before.get("refusals") or []))
    reused = int((after.get("upstream") or {}).get("reused") or 0)
    output = (first.stdout or "") + (second.stdout if second else "")
    if tool_calls < (2 if second else 1):
        raise Failed(
            f"{client} made no successful echo tool call (tool calls +{tool_calls}); "
            f"last output: {(first.stdout or first.stderr or '')[-500:]}"
        )
    if "hello-from-client" not in output and "hello-from-client" not in first.stdout:
        raise Failed(f"{client} never showed the tool's output: {(first.stdout or '')[-500:]}")
    if refusals != 0:
        raise Failed(f"{client} met {refusals} new refusal(s) on its normal behaviour")
    if reused != 0:
        raise Failed(f"{client} made the upstream detect refresh reuse ({reused})")
    return {
        "client": client,
        "status": "PASS",
        "tool_calls": tool_calls,
        "refreshes": refreshed,
        "refusals": refusals,
        "login": bool(login),
    }


PROFILES = {
    "codex": profile_codex,
    "claude_code": profile_claude,
    "kimi_code": profile_kimi,
    "vibe": profile_vibe,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Drive real MCP clients against the local example")
    parser.add_argument("--clients", default=",".join(PROFILES), help="comma-separated profiles")
    parser.add_argument("--keep", action="store_true", help="keep the scratch directory")
    args = parser.parse_args(argv)

    selected = [name for name in args.clients.split(",") if name]
    unknown = [name for name in selected if name not in PROFILES]
    if unknown:
        parser.error(f"unknown client profiles: {', '.join(unknown)}")
    missing = [name for name in selected if not CLIENTS[name].is_file()]
    if missing:
        parser.error(f"client binaries not installed: {', '.join(missing)}")

    run_id = time.strftime("%Y%m%dT%H%M%S")
    scratch = SCRATCH / run_id
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / "work").mkdir(exist_ok=True)
    results = []
    try:
        with Demo(scratch) as demo:
            log(f"example app ready at {demo.base} (CA {demo.ca})")
            for name in selected:
                home = scratch / name / "home"
                home.mkdir(parents=True)
                (home.parent / "work").mkdir(exist_ok=True)
                log(f"[{name}] starting")
                try:
                    results.append(PROFILES[name](demo, home, "example"))
                    log(f"[{name}] PASS")
                except Blocked as blocker:
                    results.append({"client": name, "status": "BLOCKED", "reason": str(blocker)})
                    log(f"[{name}] BLOCKED: {blocker}")
                except (Failed, subprocess.TimeoutExpired) as failure:
                    results.append({"client": name, "status": "FAIL", "reason": str(failure)})
                    log(f"[{name}] FAIL: {failure}")
    finally:
        if args.keep:
            log(f"scratch kept at {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)

    log("")
    log("local MCP client profiles")
    for result in results:
        detail = result.get("reason") or (
            f"{result.get('tool_calls')} tool calls, {result.get('refreshes')} refreshes, "
            f"{result.get('refusals')} refusals"
        )
        log(f"  {result['client']:<12} {result['status']:<8} {detail}")
    failures = [result for result in results if result["status"] == "FAIL"]
    blocked = [result for result in results if result["status"] == "BLOCKED"]
    log("")
    log(f"result: {len(results) - len(failures) - len(blocked)} passed, {len(failures)} failed, {len(blocked)} blocked")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
