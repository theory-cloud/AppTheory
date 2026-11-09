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
  which holds model auth only (MCP servers live in ``config.toml``); for Kimi
  Code it is the model settings parsed out of ``config.toml`` plus its
  credential file (never an ``mcp_servers`` entry);
* the copied credential is never printed by this script.

A profile that cannot be exercised for an environmental reason (no model
credential configured for that client, or no headless login surface) is
reported BLOCKED with the exact reason and is not counted as proof. A profile
that acts wrongly is a FAILURE.

Vibe's MCP OAuth store is the one deliberate exception. On macOS the client
bypasses the Python keyring library and writes the real Keychain through
``/usr/bin/security``; the operator authorized that write only under the
dedicated server alias ``apptheory-local-clients``, so every item Vibe creates
for this suite lives under the account prefix ``mcp-oauth:apptheory-local-clients:``
and is deleted in the run's ``finally`` path, on success or failure. The account
names are the three ``<kind>`` values the installed source writes
(``vibe/core/auth/mcp_oauth.py::_kr_username``): ``tokens``, ``client_info`` and
``fingerprint``. Every check is metadata-only (``find-generic-password`` without
``-w``); no item outside that prefix is read, modified or deleted, and no
credential value is ever printed.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import ssl
import struct
import subprocess
import sys
import termios
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
# The dedicated Vibe server alias the operator authorized. It is the ``<alias>``
# in every account Vibe writes: ``mcp-oauth:<alias>:<kind>``.
VIBE_ALIAS = "apptheory-local-clients"
VIBE_TUI_SETTLE_SECONDS = 0.03
VIBE_CALLBACK_PREFIXES = ("http://127.0.0.1", "http://localhost")
VIBE_PROMPTS = {
    "first": (
        "Call the example MCP server's echo tool with message 'hello-from-client' and reply with "
        "exactly its output."
    ),
    "second": (
        "Call the example MCP server's echo tool with message 'hello-after-refresh' and reply "
        "with exactly its output."
    ),
}
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


def run_prompt_pty(
    command: list[str],
    env: dict,
    ca_file: str,
    local_prefixes: tuple[str, ...],
    timeout: float = 300,
    *,
    cwd: Path | None = None,
    paste_callback: bool = False,
) -> subprocess.CompletedProcess:
    """Run one prompt, completing an MCP OAuth authorization if the client asks.

    A client with no dedicated login command prints an authorize URL on first
    use. The driver acts as the browser and follows the chain. A client that
    runs its own callback listener (Kimi Code) receives the code when the
    callback URL is fetched; a client that expects the URL pasted back into its
    prompt (Codex, Claude Code) gets it on stdin. A prompt that never asks for
    authorization runs to completion unchanged.
    """
    master, slave = pty.openpty()
    process = subprocess.Popen(
        command, cwd=str(cwd) if cwd else None, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True
    )
    os.close(slave)
    buffer = b""
    authorized = False
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 1.0)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                if not authorized:
                    text = strip_ansi(buffer.decode("utf-8", "replace"))
                    match = re.search(r"https?://[^\s]+/authorize\?[^\s]+", text)
                    if match:
                        callback = follow_authorize(match.group(0), ca_file, local_prefixes)
                        if paste_callback:
                            os.write(master, (callback + "\r").encode())
                        else:
                            # The client listens on the callback URL itself;
                            # fetching it delivers the authorization code.
                            http_get(callback, ca_file)
                        authorized = True
            elif process.poll() is not None:
                break
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            raise Failed(
                f"the prompt did not finish within {timeout:.0f}s: "
                f"{strip_ansi(buffer.decode('utf-8', 'replace'))[-600:]}"
            ) from None
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if process.poll() is None:
            process.kill()
    text = strip_ansi(buffer.decode("utf-8", "replace"))
    return subprocess.CompletedProcess(command, process.returncode, text, "")


def remove_scratch(path: Path) -> None:
    """Delete a scratch tree even when a client left read-only directories.

    Vibe's plugin cache unpacks package directories mode 0555; unlinking their
    contents then needs the directory writable again.
    """
    for root, _dirs, _files in os.walk(path):
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


def _seconds_from_ttl(value: str) -> int:
    """The access-token lifetime the demo serves, in whole seconds."""
    match = re.fullmatch(r"\s*(\d+)\s*s?\s*", value)
    return int(match.group(1)) if match else 30


class Demo:
    """The example app under the local runner."""
    def __init__(
        self, scratch: Path, *, port: int = PORT, access_ttl: str = "30s", prefix: str = "local-clients"
    ) -> None:
        self.scratch = scratch
        self.port = port
        self.access_ttl = access_ttl
        self.ttl_seconds = _seconds_from_ttl(access_ttl)
        self.prefix = prefix
        self.process: subprocess.Popen | None = None
        self.log_path = scratch / "demo.log"
        self.base = f"https://{TLS_HOST}:{port}"
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
                str(self.port),
                "--name-prefix",
                self.prefix,
                "--tls",
                "--tls-host",
                TLS_HOST,
                "-c",
                f"publicBaseUrl={self.base}",
                "-c",
                f"accessTTL={self.access_ttl}",
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

    def revoke_upstream(self) -> None:
        """Make every upstream grant terminal, the way an admin revocation does."""
        context = ssl.create_default_context(cafile=self.ca)
        request = urllib.request.Request(self.base + "/_state/revoke-upstream-grant", data=b"", method="POST")
        with urllib.request.urlopen(request, context=context, timeout=20) as response:
            json.loads(response.read().decode())

    def revoke_family(self) -> None:
        """Tombstone every facade family, the incident-response branch."""
        context = ssl.create_default_context(cafile=self.ca)
        request = urllib.request.Request(self.base + "/_state/revoke-family", data=b"", method="POST")
        with urllib.request.urlopen(request, context=context, timeout=20) as response:
            json.loads(response.read().decode())


def family_probe(
    demo: "Demo",
    login_command: list[str],
    command: list[str],
    env: dict,
    cwd: Path,
    timeout: float = 90,
    observe_live_token: bool = False,
) -> dict:
    """Observe what a client does when its family was revoked while its token lives.

    A fresh login mints an access token; the family is tombstoned immediately
    afterwards. With the demo's default 30-second lifetime the token is spent
    before the call, so a client either refreshes (and meets the tombstone at
    the token endpoint) or presents it. With a long lifetime the presentation
    reaches the resource server. ``observe_live_token`` records that outcome
    instead of requiring no tool call, because the example's resource server
    accepts every credential the facade issued for the lifetime the token
    response stated, and a live token it accepted is not a failure.
    """
    drive_pty(login_command, env, demo.ca, ("http://127.0.0.1", "http://localhost"))
    demo.revoke_family()
    before = demo.state()
    login = "none"
    output = ""
    try:
        result = subprocess.run(command, cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout)
        output = ((result.stdout or "") + (result.stderr or ""))[-1500:]
    except subprocess.TimeoutExpired as expired:
        login = "waited"
        if expired.stdout:
            output = str(expired.stdout)[-1500:]
    time.sleep(2)
    after = demo.state()
    refusals = (after.get("refusals") or [])[len(before.get("refusals") or []):]
    events = (after.get("refreshEvents") or [])[len(before.get("refreshEvents") or []):]
    statuses = sorted({int(entry.get("status") or 0) for entry in refusals if entry.get("status")})
    codes = [event.get("errorCode") for event in events]
    tool_calls = int(after.get("toolCalls") or 0) - int(before.get("toolCalls") or 0)
    revoked = any(family.get("revoked") for family in after.get("families") or [])
    probe = {
        "login": login,
        "mcpStatuses": statuses,
        "errorCodes": codes,
        "events": len(events),
        "revoked": revoked,
        "toolCalls": tool_calls,
        "observedLiveToken": observe_live_token,
        "output": output,
    }
    if observe_live_token:
        # The observed outcome is the row: either the call met a refusal or the
        # still-valid credential was accepted. Never loop, and always report.
        if not revoked:
            raise Failed("the incident revocation did not tombstone a family")
        return probe
    if tool_calls != 0:
        raise Failed(f"the client made {tool_calls} tool call(s) with a revoked family")
    if not revoked:
        raise Failed("the incident revocation did not tombstone a family")
    if 401 not in statuses and "invalid_grant" not in codes:
        raise Failed(f"the revoked family produced neither a 401 nor an invalid_grant: {probe}")
    return probe


def terminal_probe(
    demo: "Demo", command: list[str], env: dict, cwd: Path, timeout: float = 90
) -> dict:
    """Observe a client after its upstream grant was revoked.

    The access token is allowed to expire first, so the client must refresh.
    The facade answers the terminal upstream rejection with a client-facing
    ``invalid_grant``; the probe asserts exactly one refresh, no loop, no tool
    call and no re-login, and records the MCP surface's status for comparison.
    """
    demo.revoke_upstream()
    time.sleep(32)
    before = demo.state()
    login = "none"
    output = ""
    try:
        result = subprocess.run(command, cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout)
        output = ((result.stdout or "") + (result.stderr or ""))[-1500:]
        if re.search(r"Waiting for the OAuth callback|authorize\?", output):
            login = "attempted"
    except subprocess.TimeoutExpired as expired:
        login = "waited"
        if expired.stdout:
            output = str(expired.stdout)[-1500:]
    time.sleep(2)
    after = demo.state()
    settle = time.time() + 4
    while time.time() < settle:
        time.sleep(1)
    final = demo.state()
    events = (after.get("refreshEvents") or [])[len(before.get("refreshEvents") or []):]
    later = (final.get("refreshEvents") or [])[len(after.get("refreshEvents") or []):]
    refusals = (after.get("refusals") or [])[len(before.get("refusals") or []):]
    refreshed = int((after.get("upstream") or {}).get("refreshed") or 0) - int(
        (before.get("upstream") or {}).get("refreshed") or 0
    )
    reused = int((after.get("upstream") or {}).get("reused") or 0)
    revoked = any(family.get("revoked") for family in after.get("families") or [])
    tool_calls = int(after.get("toolCalls") or 0) - int(before.get("toolCalls") or 0)
    codes = [event.get("errorCode") for event in events]
    # Every event that names an upstream class is one call to the upstream's
    # token endpoint; a failed refresh increments no success counter.
    upstream_attempts = sum(1 for event in events if event.get("upstream"))
    statuses = sorted({int(entry.get("status") or 0) for entry in refusals if entry.get("status")})
    probe = {
        "login": login,
        "refreshes": upstream_attempts,
        "events": len(events),
        "errorCodes": codes,
        "sequence": [
            (
                event.get("class"),
                event.get("reason"),
                event.get("outcome"),
                event.get("errorCode"),
                event.get("upstream"),
            )
            for event in events
        ],
        "mcpStatuses": statuses,
        "revoked": revoked,
        "looped": len(later) > 0,
        "toolCalls": tool_calls,
        "upstreamRefreshed": refreshed,
        "upstreamReused": reused,
        "output": output,
    }
    if login == "waited" and upstream_attempts == 0:
        raise Blocked("the client waited for a new interactive login without presenting the revoked "
                      f"handle; last output: {output}")
    if upstream_attempts != 1:
        raise Failed(
            f"the client made {upstream_attempts} upstream refresh attempt(s), want exactly one; "
            f"events {probe['sequence']}; output: {output}")
    if "invalid_grant" not in codes:
        raise Failed(
            f"the revoked upstream produced no invalid_grant answer: {probe['sequence']}; output: {output}")
    if probe["looped"]:
        raise Failed("the client kept refreshing after the terminal invalid_grant")
    if not revoked:
        raise Failed("the terminal upstream rejection did not revoke the family")
    if tool_calls != 0:
        raise Failed(f"the client made {tool_calls} tool call(s) on a revoked grant")
    if reused != 0:
        raise Failed(f"the upstream detected refresh-token reuse ({reused})")
    return probe


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


def _toml_key(key: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]+", key):
        return key
    return json.dumps(key)


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_value(item) for item in value) + "]"
    raise TypeError(f"unsupported TOML value: {type(value).__name__}")


def _toml_section(lines: list[str], path: list[str], table: dict) -> None:
    scalars = {key: value for key, value in table.items() if not isinstance(value, dict)}
    children = {key: value for key, value in table.items() if isinstance(value, dict)}
    if scalars:
        lines.append("[" + ".".join(_toml_key(part) for part in path) + "]")
        for key, value in scalars.items():
            lines.append(f"{_toml_key(key)} = {_toml_value(value)}")
        lines.append("")
    for key, value in children.items():
        _toml_section(lines, path + [key], value)


def kimi_model_config() -> str:
    """The provider, model and default-model settings of the real Kimi config.

    Nothing else is carried: no mcp_servers entry, no service or UI table. The
    model login itself may span those tables plus a credential file, so only the
    default model's provider and its model entries are written.
    """
    source = Path.home() / ".kimi-code" / "config.toml"
    if not source.is_file():
        raise Blocked("no ~/.kimi-code/config.toml model configuration to carry")
    try:
        import tomllib
    except ImportError:
        raise Blocked("this Python has no tomllib to read ~/.kimi-code/config.toml") from None
    try:
        document = tomllib.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Blocked("~/.kimi-code/config.toml is not readable TOML") from None
    default_model = document.get("default_model")
    models = document.get("models") or {}
    providers = document.get("providers") or {}
    if not isinstance(default_model, str) or default_model not in models:
        raise Blocked("~/.kimi-code/config.toml names no resolvable default_model")
    model = models[default_model]
    if not isinstance(model, dict):
        raise Blocked("the Kimi default model entry is not a table")
    provider_name = model.get("provider")
    if not isinstance(provider_name, str) or provider_name not in providers:
        raise Blocked("the Kimi default model names no provider the config defines")
    provider = providers[provider_name]
    if not isinstance(provider, dict):
        raise Blocked("the Kimi provider entry is not a table")
    lines = [f"default_model = {_toml_value(default_model)}", ""]
    _toml_section(lines, ["providers", provider_name], provider)
    _toml_section(lines, ["models", default_model], model)
    return "\n".join(lines).rstrip() + "\n"


def write_kimi_home(home: Path, mcp_name: str, mcp_url: str) -> None:
    """Write the isolated config: the model settings plus the example's MCP entry.

    Kimi keeps MCP servers in its own mcp.json, not in config.toml; the entry
    is OAuth-authenticated, which is the flow the local client exercises.
    """
    home.mkdir(parents=True, exist_ok=True)
    config = home / "config.toml"
    config.write_text(kimi_model_config(), encoding="utf-8")
    config.chmod(0o600)
    mcp = home / "mcp.json"
    mcp.write_text(
        json.dumps({"mcpServers": {mcp_name: {"url": mcp_url, "auth": "oauth"}}}, indent=2) + "\n",
        encoding="utf-8",
    )
    mcp.chmod(0o600)


def vibe_model_key() -> str | None:
    """Return Mistral's model API key, or None when it is not configured.

    Vibe resolves MISTRAL_API_KEY from the environment and then from the OS
    keyring (service ``ai.mistral.vibe``, account ``MISTRAL_API_KEY``); it keeps
    no model key in config.toml. Only the key value is used, in the child's
    environment; nothing is copied and nothing is printed.
    """
    if os.environ.get("MISTRAL_API_KEY"):
        return os.environ["MISTRAL_API_KEY"]
    config = Path.home() / ".vibe" / "config.toml"
    if config.is_file():
        try:
            import tomllib
        except ImportError:
            tomllib = None
        if tomllib is not None:
            try:
                document = tomllib.loads(config.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                document = {}
            for table in (document, document.get("api") or {}, document.get("model") or {}):
                for key, value in table.items():
                    if key.lower() in {"api_key", "apikey", "mistral_api_key"} and isinstance(value, str) and value:
                        return value
    if sys.platform == "darwin":
        # The same lookup Vibe's own keyring helper performs; the command's
        # output is the secret, so it is never included in an error.
        try:
            result = subprocess.run(
                [
                    "/usr/bin/security",
                    "find-generic-password",
                    "-s",
                    "ai.mistral.vibe",
                    "-a",
                    "MISTRAL_API_KEY",
                    "-w",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode == 0:
            key = result.stdout.strip()
            if key:
                return key
    return None


VIBE_KEYRING_SERVICE = "ai.mistral.vibe"
VIBE_KEYRING_KINDS = ("tokens", "client_info", "fingerprint")


def vibe_keychain_accounts(alias: str) -> list[str]:
    """Which of Vibe's MCP OAuth accounts for ``alias`` exist, metadata only.

    ``security find-generic-password`` without ``-w`` reads the item's
    attributes and never its secret, so this can neither prompt for nor reveal
    a credential value.
    """
    if sys.platform != "darwin":
        return []
    present: list[str] = []
    for kind in VIBE_KEYRING_KINDS:
        account = f"mcp-oauth:{alias}:{kind}"
        result = subprocess.run(
            [
                "/usr/bin/security",
                "find-generic-password",
                "-s",
                VIBE_KEYRING_SERVICE,
                "-a",
                account,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            present.append(account)
    return present


def vibe_uses_macos_security() -> bool:
    """Ask the installed client whether its keyring helper shells out to security.

    ``vibe/utils/keyring.py`` routes every read and write through
    ``/usr/bin/security`` on darwin; that module is what decides where an MCP
    OAuth token lands, not the Python ``keyring`` package a
    ``PYTHON_KEYRING_BACKEND`` would select. The probe runs the client's own
    interpreter so the answer comes from the installed source.
    """
    try:
        shebang = CLIENTS["vibe"].read_text(encoding="utf-8", errors="replace").splitlines()[0]
    except (OSError, IndexError):
        return sys.platform == "darwin"
    interpreter = shebang[2:].split()[0] if shebang.startswith("#!") else ""
    if not interpreter:
        return sys.platform == "darwin"
    result = subprocess.run(
        [
            interpreter,
            "-c",
            "from vibe.utils.keyring import _should_use_macos_security as m; print(int(m()))",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        return sys.platform == "darwin"
    return result.stdout.strip() == "1"


def vibe_keychain_delete(alias: str) -> None:
    """Delete only ``alias``'s three accounts; never any other Vibe item.

    ``delete-generic-password`` is given the exact service and account, so it
    cannot match the operator's ``mcp-oauth:theorycloud:*`` or ``MISTRAL_API_KEY``
    items. A missing item exits non-zero and is ignored.
    """
    if sys.platform != "darwin":
        return
    for kind in VIBE_KEYRING_KINDS:
        subprocess.run(
            [
                "/usr/bin/security",
                "delete-generic-password",
                "-s",
                VIBE_KEYRING_SERVICE,
                "-a",
                f"mcp-oauth:{alias}:{kind}",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )


def vibe_keychain_clear(alias: str) -> list[str]:
    """Delete the alias's accounts and return any that still exist."""
    present = vibe_keychain_accounts(alias)
    if present:
        log(f"[vibe] removing {len(present)} keychain item(s) under mcp-oauth:{alias}:")
        vibe_keychain_delete(alias)
    return vibe_keychain_accounts(alias)


def vibe_action_urls(action_log: Path) -> list[str]:
    """Every ``open_url`` the Rust TUI recorded instead of opening a browser."""
    try:
        lines = action_log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    urls: list[str] = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and record.get("kind") == "open_url" and record.get("url"):
            urls.append(str(record["url"]))
    return urls


class VibeTui:
    """The installed Vibe TUI in a PTY: the only surface with ``/mcp login``.

    ``vibe -p`` refuses to start an MCP OAuth login, so the one login runs here;
    every prompt is then a separate ``vibe -p`` process, which is what proves the
    restart row. The browser step is played by the harness: the Rust TUI records
    ``open_url`` actions in ``VIBE_E2E_ACTION_LOG`` instead of launching a
    browser, and the PATH shims the profile installs are a second guard, so no
    browser window can open on the operator's desktop.
    """

    def __init__(self, work: Path, env: dict, action_log: Path) -> None:
        self.work = work
        self.env = env
        self.action_log = action_log
        self.buffer = b""
        self.master = -1
        self.process: subprocess.Popen | None = None

    def __enter__(self) -> "VibeTui":
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
        self.master = master
        self.process = subprocess.Popen(
            [str(CLIENTS["vibe"]), "--trust", "--auto-approve"],
            cwd=str(self.work),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=self.env,
            close_fds=True,
        )
        os.close(slave)
        if not self.wait(lambda: "state=idle:app=vibe" in self.raw(), 180):
            raise Failed("the Vibe TUI did not become ready: " + self.visible()[-600:])
        return self

    def __exit__(self, *_exc) -> bool:
        if self.process is not None and self.process.poll() is None:
            self.send("/exit")
            deadline = time.time() + 15
            while time.time() < deadline and self.process.poll() is None:
                self.pump(0.5)
            if self.process.poll() is None:
                self.process.kill()
        try:
            os.close(self.master)
        except OSError:
            pass
        return False

    def raw(self) -> str:
        return self.buffer.decode("utf-8", "replace")

    def visible(self) -> str:
        return strip_ansi(self.raw())

    def pump(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.buffer += chunk

    def wait(self, predicate, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.4)
            if predicate():
                return True
            if self.process is not None and self.process.poll() is not None:
                return False
        return False

    def send(self, text: str) -> None:
        for character in text:
            os.write(self.master, character.encode())
            time.sleep(VIBE_TUI_SETTLE_SECONDS)
        time.sleep(0.4)
        os.write(self.master, b"\r")

    def login(self, alias: str, ca_file: str) -> None:
        """Send ``/mcp login <alias>`` and play the browser to Vibe's callback."""
        self.send(f"/mcp login {alias}")
        deadline = time.time() + 180
        url = ""
        while time.time() < deadline and not url:
            self.pump(0.4)
            urls = vibe_action_urls(self.action_log)
            if urls:
                url = urls[-1]
        if not url:
            raise Failed("the Vibe TUI never produced an authorization URL: " + self.visible()[-600:])
        callback = follow_authorize(url, ca_file, VIBE_CALLBACK_PREFIXES)
        status, _location = http_get(callback, ca_file)
        if status != 200:
            raise Failed(f"Vibe's loopback callback answered {status}")
        if not self.wait(lambda: "authenticated" in self.visible(), 120):
            raise Failed("Vibe never reported the MCP server authenticated: " + self.visible()[-600:])
        self.pump(1)

TERMINAL_PROMPT = (
    "Call the example MCP server's echo tool with message 'hello-after-revocation' and reply with "
    "exactly its output."
)


def client_prompt_command(client: str, name: str, prompt: str) -> list[str]:
    if client == "codex":
        return [
            str(CLIENTS["codex"]),
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            prompt,
        ]
    if client == "claude_code":
        return [
            str(CLIENTS["claude_code"]),
            "-p",
            "--allowedTools",
            f"mcp__{name}__echo",
            "--dangerously-skip-permissions",
            prompt,
        ]
    if client == "kimi_code":
        return [str(CLIENTS[client]), "-p", prompt]
    raise ValueError(f"unknown client {client!r}")


def vibe_prompt_command(prompt: str) -> list[str]:
    """One ``vibe -p`` turn, trusted and auto-approved.

    ``--trust`` accepts the isolated working directory for this invocation and
    ``--auto-approve`` (``--yolo``) runs the MCP echo tool without the TUI's
    approval prompt; headless mode has no keyboard to answer it.
    """
    return [str(CLIENTS["vibe"]), "-p", prompt, "--trust", "--auto-approve"]


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
    command = client_prompt_command("codex", name, TERMINAL_PROMPT)
    terminal = terminal_probe(demo, command, env, home.parent / "work")
    family = family_probe(
        demo,
        [str(CLIENTS["codex"]), "mcp", "login", name, "--no-browser"],
        command,
        env,
        home.parent / "work",
    )
    return observe("codex", login, before, middle, after, first, second, demo, terminal, family)


def probe_codex_mcp_401(demo: Demo, home: Path, name: str) -> dict:
    """The MCP-401 comparison for Codex: a live token after its family was revoked.

    The demo serving this probe issues a long access-token lifetime, so Codex
    presents its still-valid token instead of refreshing. What the resource
    server then does with it is the observation: the example's bearer validator
    accepts every credential the facade issued for the lifetime the token
    response stated, so the expected outcome is an accepted call rather than a
    401. The probe records it either way.
    """
    copy_codex_model_auth(home)
    (home / "config.toml").write_text(
        f'[mcp_servers.{name}]\nurl = "{demo.base}/acme/mcp"\n', encoding="utf-8"
    )
    env = os.environ.copy()
    env["CODEX_HOME"] = str(home)
    env["CODEX_CA_CERTIFICATE"] = demo.ca
    command = [
        str(CLIENTS["codex"]),
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        TERMINAL_PROMPT,
    ]
    return family_probe(
        demo,
        [str(CLIENTS["codex"]), "mcp", "login", name, "--no-browser"],
        command,
        env,
        home.parent / "work",
        observe_live_token=True,
    )


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
    terminal = terminal_probe(demo, client_prompt_command("claude_code", name, TERMINAL_PROMPT), env, home.parent / "work")
    return observe("claude_code", login, before, middle, after, first, second, demo, terminal)


def profile_kimi(demo: Demo, home: Path, name: str) -> dict:
    copy_kimi_model_auth(home)
    write_kimi_home(home, name, demo.base + "/acme/mcp")
    env = os.environ.copy()
    env["KIMI_CODE_HOME"] = str(home)
    env["NODE_EXTRA_CA_CERTS"] = demo.ca
    env["SSL_CERT_FILE"] = demo.ca
    before = demo.state()
    work = home.parent / "work"
    first = run_prompt_pty(
        [str(CLIENTS["kimi_code"]), "-p", TOOL_PROMPT],
        env,
        demo.ca,
        ("http://127.0.0.1", "http://localhost"),
        cwd=work,
    )
    middle = demo.state()
    second = run_prompt_pty(
        [str(CLIENTS["kimi_code"]), "-p", TOOL_PROMPT.replace("hello-from-client", "hello-after-restart")],
        env,
        demo.ca,
        ("http://127.0.0.1", "http://localhost"),
        cwd=work,
    )
    after = demo.state()
    if int(after.get("toolCalls") or 0) <= int(before.get("toolCalls") or 0):
        detail = " ".join((first.stdout + second.stdout).strip().splitlines()[-3:])
        raise Blocked(f"Kimi Code could not run a prompt in its isolated home: {detail}")
    terminal = terminal_probe(demo, client_prompt_command("kimi_code", name, TERMINAL_PROMPT), env, work)
    return observe("kimi_code", "", before, middle, after, first, second, demo, terminal)


def vibe_terminal_observation(output: str) -> str:
    """Classify what Vibe did after the terminal ``invalid_grant``: observed only.

    A terminal refresh rejection leaves Vibe's turn stopped: it reports
    ``mcp_authorization_required`` and tells the user the server needs
    re-authorization, but it never starts a login on its own and never loops.
    """
    text = output.lower()
    markers = (
        "/mcp login",
        "requires authentication",
        "re-authenticate",
        "re-authorize",
        "mcp_authorization_required",
    )
    if any(marker in text for marker in markers):
        return "login"
    if "waiting for the oauth callback" in text or "authorize?" in text:
        return "waited"
    return "none"


def profile_vibe(demo: Demo, home: Path, name: str) -> dict:
    """Vibe 3.0.4: one TUI login, then real sessions in separate processes.

    Rows: a tool call on the login's access token, a restarted ``vibe -p``
    process that refreshes after the token expired (MCP SDK 2.3.0 asks the
    origin-root ``/token``, which the example's own compatibility alias serves),
    and then the revoked-upstream process. Every Vibe keychain item lives under
    ``mcp-oauth:apptheory-local-clients:`` and is removed by the run's
    ``finally`` path.
    """
    if sys.platform != "darwin":
        raise Blocked(
            "Vibe's MCP OAuth login writes the OS keychain through /usr/bin/security; the "
            "dedicated-alias authorization covers the macOS Keychain and no confined login "
            "surface is proven on this platform"
        )
    if not vibe_uses_macos_security():
        raise Blocked(
            "the installed Vibe does not route its MCP OAuth store through /usr/bin/security, so "
            "the dedicated-alias keychain rules would not cover it"
        )
    alias = VIBE_ALIAS
    leftovers = vibe_keychain_clear(alias)
    if leftovers:
        raise Blocked(
            f"a prefixed Keychain item could not be removed before the run: {', '.join(leftovers)}"
        )
    key = vibe_model_key()
    if not key:
        raise Blocked("no Mistral model API key is configured for Vibe")
    work = home.parent / "work"
    work.mkdir(exist_ok=True)
    shim = home.parent / "browser-shims"
    shim.mkdir(parents=True, exist_ok=True)
    browser_calls = home.parent / "browser-calls.log"
    browser_calls.write_text("", encoding="utf-8")
    for tool in ("open", "osascript"):
        script = shim / tool
        script.write_text(
            f'#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "{browser_calls}"\nexit 0\n', encoding="utf-8"
        )
        script.chmod(0o755)
    actions = home.parent / "vibe-actions.jsonl"
    actions.write_text("", encoding="utf-8")
    env = os.environ.copy()
    env["VIBE_HOME"] = str(home)
    env["MISTRAL_API_KEY"] = key
    env["SSL_CERT_FILE"] = demo.ca
    env["REQUESTS_CA_BUNDLE"] = demo.ca
    env["VIBE_E2E_ACTION_LOG"] = str(actions)
    env["PATH"] = f"{shim}:{env.get('PATH', '')}"
    env.pop("BROWSER", None)
    added = subprocess.run(
        [
            str(CLIENTS["vibe"]),
            "mcp",
            "add",
            "--url",
            demo.base + "/acme/mcp",
            "--scope",
            "mcp:tools",
            "--no-login",
            alias,
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if added.returncode != 0:
        raise Failed(f"vibe mcp add failed: {added.stdout[-400:]} {added.stderr[-400:]}")
    before = demo.state()
    with VibeTui(work, env, actions) as tui:
        tui.login(alias, demo.ca)
    logged_in = demo.state()
    stored = vibe_keychain_accounts(alias)
    if set(stored) != {f"mcp-oauth:{alias}:{kind}" for kind in VIBE_KEYRING_KINDS}:
        raise Failed(f"Vibe stored {stored or 'no items'}, want the three accounts its source writes")
    first = subprocess.run(
        vibe_prompt_command(VIBE_PROMPTS["first"]),
        cwd=str(work),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    middle = demo.state()
    # The token expires here. A restarted `vibe -p` process must refresh; MCP SDK
    # 2.3.0 asks the origin-root /token, which the example's compatibility alias
    # re-dispatches to the facade's route token handler.
    time.sleep(demo.ttl_seconds + 6)
    second = subprocess.run(
        vibe_prompt_command(VIBE_PROMPTS["second"]),
        cwd=str(work),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    after = demo.state()
    terminal = terminal_probe(demo, vibe_prompt_command(TERMINAL_PROMPT), env, work, timeout=120)
    terminal["observed"] = vibe_terminal_observation(terminal.get("output") or "")
    if len(vibe_action_urls(actions)) != 1:
        raise Failed(
            f"Vibe started {len(vibe_action_urls(actions))} authorization flows; want exactly one login"
        )
    if browser_calls.read_text(encoding="utf-8", errors="replace").strip():
        raise Failed("a browser launcher ran; the authorization URL must only be recorded")
    issued = int((logged_in.get("upstream") or {}).get("issued") or 0) - int(
        (before.get("upstream") or {}).get("issued") or 0
    )
    if issued != 1:
        raise Failed(f"the login minted {issued} upstream grants, want exactly one")
    result = observe("vibe", "", before, middle, after, first, second, demo, terminal)
    if result["refreshes"] != 1:
        raise Failed(f"Vibe's expired-token turn produced {result['refreshes']} served refreshes, want one")
    return result


def observe(
    client: str,
    login: str,
    before: dict,
    middle: dict,
    after: dict,
    first: subprocess.CompletedProcess,
    second: subprocess.CompletedProcess | None,
    demo: Demo,
    terminal: dict | None = None,
    family: dict | None = None,
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
        "terminal": terminal or {},
        "family": family or {},
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
    parser.add_argument(
        "--verify-401",
        action="store_true",
        help="also drive the MCP-401 branch (Codex, long access-token lifetime, revoked family)",
    )
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
    keychain_clean = True
    try:
        shared = [name for name in selected if name != "vibe"]
        if shared:
            with Demo(scratch) as demo:
                log(f"example app ready at {demo.base} (CA {demo.ca})")
                for name in shared:
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
        if "vibe" in selected:
            # Vibe gets its own app so its one login and its keychain items stay
            # scoped to this leg. The items are cleaned in the finally below, on
            # success, failure, timeout and Ctrl-C alike.
            vibe_root = scratch / "vibe-app"
            vibe_root.mkdir()
            home = vibe_root / "vibe" / "home"
            home.mkdir(parents=True)
            (home.parent / "work").mkdir(exist_ok=True)
            log("[vibe] starting against its own app (30s access-token lifetime)")
            try:
                with Demo(vibe_root, port=PORT + 2, prefix="local-clients-vibe") as demo:
                    results.append(profile_vibe(demo, home, VIBE_ALIAS))
                log("[vibe] PASS")
            except Blocked as blocker:
                results.append({"client": "vibe", "status": "BLOCKED", "reason": str(blocker)})
                log(f"[vibe] BLOCKED: {blocker}")
            except (Failed, subprocess.TimeoutExpired) as failure:
                results.append({"client": "vibe", "status": "FAIL", "reason": str(failure)})
                log(f"[vibe] FAIL: {failure}")
        if args.verify_401 and "codex" in selected:
            # A second app with a long access-token lifetime: the tombstoned
            # family must be met by the resource server, not by a refresh.
            second = scratch / "mcp401"
            second.mkdir()
            home = second / "codex" / "home"
            home.mkdir(parents=True)
            (home.parent / "work").mkdir(exist_ok=True)
            log("[codex/401] starting")
            try:
                with Demo(second, port=PORT + 1, access_ttl="600s", prefix="local-clients-401") as demo:
                    probe = probe_codex_mcp_401(demo, home, "example")
                results.append({"client": "codex/401", "status": "PASS", "family": probe})
                log("[codex/401] PASS")
            except Blocked as blocker:
                results.append({"client": "codex/401", "status": "BLOCKED", "reason": str(blocker)})
                log(f"[codex/401] BLOCKED: {blocker}")
            except (Failed, subprocess.TimeoutExpired) as failure:
                results.append({"client": "codex/401", "status": "FAIL", "reason": str(failure)})
                log(f"[codex/401] FAIL: {failure}")
    finally:
        # Runs on success, failure, timeout and Ctrl-C: remove every item Vibe
        # wrote under the dedicated alias and prove none remains. A locked or
        # prompting Keychain must fail this step closed (and still let the
        # scratch be removed), never mask the run's own exception.
        if "vibe" in selected:
            try:
                remaining = vibe_keychain_clear(VIBE_ALIAS)
            except (OSError, subprocess.TimeoutExpired) as cleanup_error:
                keychain_clean = False
                log(f"[vibe] keychain cleanup could not run: {cleanup_error}")
            else:
                if remaining:
                    keychain_clean = False
                    for account in remaining:
                        log(f"[vibe] keychain cleanup FAILED: {account} still exists")
                else:
                    log(f"[vibe] keychain clean: no mcp-oauth:{VIBE_ALIAS}:* item remains")
        if args.keep:
            log(f"scratch kept at {scratch}")
        else:
            remove_scratch(scratch)

    log("")
    log("local MCP client profiles")
    for result in results:
        detail = result.get("reason") or (
            f"{result.get('tool_calls')} tool calls, {result.get('refreshes')} refreshes, "
            f"{result.get('refusals')} refusals"
        )
        if result["client"].endswith("/401"):
            family = result.get("family") or {}
            detail = (
                f"revoked family while the access token lived: MCP {family.get('mcpStatuses')}, "
                f"refresh answers {family.get('errorCodes')}, "
                f"{family.get('toolCalls')} tool call(s), re-login {family.get('login')}"
            )
        terminal = result.get("terminal") or {}
        if terminal:
            detail += (
                f"; revoked upstream: {terminal.get('refreshes')} upstream refresh, "
                f"{terminal.get('events')} event(s) {terminal.get('errorCodes')}, "
                f"MCP {terminal.get('mcpStatuses')}, family revoked {terminal.get('revoked')}, "
                f"re-login {terminal.get('login')}"
            )
            if terminal.get("observed"):
                detail += f", next {terminal['observed']}"
        family = result.get("family") or {}
        if family:
            detail += (
                f"; revoked family: MCP {family.get('mcpStatuses')}, "
                f"refresh answers {family.get('errorCodes')}, no tool call"
            )
        log(f"  {result['client']:<12} {result['status']:<8} {detail}")
    failures = [result for result in results if result["status"] == "FAIL"]
    blocked = [result for result in results if result["status"] == "BLOCKED"]
    log("")
    log(f"result: {len(results) - len(failures) - len(blocked)} passed, {len(failures)} failed, {len(blocked)} blocked")
    if not keychain_clean:
        log(f"result: FAIL the keychain still holds an mcp-oauth:{VIBE_ALIAS}:* item")
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
