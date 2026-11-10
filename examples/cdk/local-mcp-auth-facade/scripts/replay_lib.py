#!/usr/bin/env python3
"""Replay the real-client refresh sequences against the local example app.

The example (``examples/cdk/local-mcp-auth-facade``) mounts AppTheory's MCP auth
facade with its brokered route refresh and a real local authorization server.
This script drives it over real HTTP, exactly as a client does — discovery,
dynamic registration, authorize with PKCE, server-side code exchange, refresh —
and asserts the app's own state document after each sequence: family status, the
live head, and the chain generation of every member. A status code alone never
passes a sequence.

Usage (the app must already be running, for example under ``apptheory-local``):

    python3 scripts/replay_lib.py rotation-chain \
        --base-url https://mcp.localhost:8240 \
        --ca "$HOME/.cache/apptheory-local/runs/<run>/tls/ca.pem"

The seven sequences are the ones the LOCAL-W3-X5 rows run in CI. They are kept
here, next to the example, so a developer can replay one against a running app
without the examples harness.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qsl, urlencode, urlsplit

MCP_PATH = "/acme/mcp"
TOKEN_PATH = "/.well-known/oauth-authorization-server/acme/mcp/token"
REGISTER_PATH = "/.well-known/oauth-authorization-server/acme/mcp/register"
AUTHORIZE_PATH = "/.well-known/oauth-authorization-server/acme/mcp/authorize"
REDIRECT_URI = "http://127.0.0.1:39471/cb"
SCOPE = "mcp:tools"
# The example's grace window is one second; a sequence that needs a
# beyond-grace presentation waits past it rather than changing the policy.
GRACE_WINDOW_WAIT_SECONDS = 1.4


class ReplayError(RuntimeError):
    """A sequence assertion failed."""


def require(condition: object, message: str) -> None:
    if not condition:
        raise ReplayError(message)


def short_hash(value: str) -> str:
    """The short handle/family hash the example's state document reports."""
    digest = hashlib.sha256(value.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()[:12]


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):  # noqa: D401 - urllib protocol method
        return None


class FacadeClient:
    """One client of the example facade, over real HTTP with a verified CA."""

    def __init__(self, base_url: str, ca_file: str | None) -> None:
        self.base = base_url.rstrip("/")
        self.context = ssl.create_default_context(cafile=ca_file)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.context), NoRedirect()
        )
        self.client_id: str | None = None
        self.redirect_uri = REDIRECT_URI

    def call(
        self,
        method: str,
        target: str,
        *,
        headers: dict | None = None,
        body: bytes | None = None,
        timeout: float = 60,
    ) -> tuple[int, str, dict]:
        url = target if target.startswith("http") else self.base + target
        request = urllib.request.Request(url, data=body, method=method)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return response.status, response.read().decode("utf-8", "replace"), {
                    key.lower(): value for key, value in response.headers.items()
                }
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), {
                key.lower(): value for key, value in exc.headers.items()
            }

    def json_call(self, method: str, target: str, payload: dict | None = None) -> tuple[int, dict]:
        status, document, _ = self.call(
            method,
            target,
            headers={"content-type": "application/json"},
            body=None if payload is None else json.dumps(payload).encode(),
        )
        try:
            return status, json.loads(document)
        except json.JSONDecodeError:
            return status, {"raw": document}

    def register(self) -> str:
        status, document = self.json_call(
            "POST",
            REGISTER_PATH,
            {
                "client_name": "apptheory-refresh-replay",
                "redirect_uris": [self.redirect_uri],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
            },
        )
        require(status == 201, f"dynamic client registration answered {status}: {document}")
        client_id = document.get("client_id")
        require(bool(client_id), f"registration returned no client_id: {document}")
        self.client_id = str(client_id)
        return self.client_id

    def authorize_code(self) -> tuple[str, str]:
        require(self.client_id is not None, "authorize_code needs a registered client")
        verifier = "apptheory-replay-pkce-verifier-0123456789-0123456789"
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "state": "replay-state",
                "code_challenge": pkce_challenge(verifier),
                "code_challenge_method": "S256",
                "scope": SCOPE,
                "resource": self.base + MCP_PATH,
            }
        )
        target = self.base + AUTHORIZE_PATH + "?" + query
        for step in ("facade authorize", "upstream authorize", "facade callback"):
            status, document, headers = self.call("GET", target)
            require(status in (302, 303, 307), f"{step} answered {status}, want a redirect: {document}")
            target = headers.get("location") or ""
            require(bool(target), f"{step} redirected without a Location header")
            if target.startswith(self.redirect_uri.rsplit("/cb", 1)[0]):
                break
        else:
            raise ReplayError("the authorize chain never reached the client redirect")
        parameters = dict(parse_qsl(urlsplit(target).query))
        code = parameters.get("code", "")
        require(bool(code), f"the client redirect carries no code: {target}")
        require(parameters.get("state") == "replay-state", f"the client redirect lost the state: {target}")
        return code, verifier

    def exchange_code(self, code: str, verifier: str) -> tuple[int, dict]:
        status, document, _ = self.call(
            "POST",
            TOKEN_PATH,
            headers={"content-type": "application/x-www-form-urlencoded"},
            body=urlencode(
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": self.redirect_uri,
                    "client_id": self.client_id,
                    "code_verifier": verifier,
                }
            ).encode(),
        )
        try:
            return status, json.loads(document)
        except json.JSONDecodeError:
            return status, {"raw": document}

    def login(self) -> dict:
        if self.client_id is None:
            self.register()
        code, verifier = self.authorize_code()
        status, tokens = self.exchange_code(code, verifier)
        require(status == 200, f"code exchange answered {status}: {tokens}")
        require(bool(tokens.get("access_token")), f"code exchange returned no access token: {tokens}")
        require(bool(tokens.get("refresh_token")), f"code exchange returned no route handle: {tokens}")
        return tokens

    def refresh(self, handle: str) -> tuple[int, dict]:
        status, document, _ = self.call(
            "POST",
            TOKEN_PATH,
            headers={"content-type": "application/x-www-form-urlencoded"},
            body=urlencode(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": handle,
                    "client_id": self.client_id,
                }
            ).encode(),
        )
        try:
            return status, json.loads(document)
        except json.JSONDecodeError:
            return status, {"raw": document}

    def state(self) -> dict:
        status, document = self.json_call("GET", "/_state")
        require(status == 200, f"the state route answered {status}: {document}")
        return document

    def seed_legacy(self) -> str:
        status, document = self.json_call("POST", "/_state/legacy", {"client_id": self.client_id})
        require(status == 200, f"the legacy record was not seeded: {status} {document}")
        return str(document["refresh_token"])

    def revoke_upstream(self) -> None:
        status, document = self.json_call("POST", "/_state/revoke-upstream-grant", {})
        require(status == 200, f"the upstream revocation answered {status}: {document}")

    def initialize(self, access_token: str) -> tuple[int, str]:
        status, document, _ = self.call(
            "POST",
            MCP_PATH,
            headers={
                "accept": "application/json, text/event-stream",
                "content-type": "application/json",
                "authorization": "Bearer " + access_token,
            },
            body=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "apptheory-refresh-replay", "version": "1"},
                    },
                }
            ).encode(),
        )
        return status, document


def family(state: dict, family_hash: str) -> dict:
    for candidate in state.get("families") or []:
        if candidate.get("family") == family_hash:
            return candidate
    raise ReplayError(f"the state document has no family {family_hash}: {state.get('families')}")


def member(family_document: dict, handle_hash: str) -> dict:
    for candidate in family_document.get("members") or []:
        if candidate.get("handle") == handle_hash:
            return candidate
    raise ReplayError(
        f"family {family_document.get('family')} has no member {handle_hash}: "
        f"{family_document.get('members')}"
    )


def live_head(family_document: dict) -> dict:
    for candidate in family_document.get("members") or []:
        if candidate.get("liveHead"):
            return candidate
    raise ReplayError(f"family {family_document.get('family')} has no live head")


def refresh_calls(state: dict) -> int:
    return int((state.get("upstream") or {}).get("refreshed") or 0)


def rotation_chain(client: FacadeClient) -> str:
    client.register()
    tokens = client.login()
    handles = [tokens["refresh_token"]]
    access_tokens = [tokens["access_token"]]
    for index in range(3):
        status, rotated = client.refresh(handles[-1])
        require(status == 200, f"rotation {index + 1} answered {status}: {rotated}")
        require(rotated.get("refresh_token") not in handles, f"rotation {index + 1} reused a handle")
        handles.append(str(rotated["refresh_token"]))
        access_tokens.append(str(rotated["access_token"]))
    require(len(set(access_tokens)) == len(access_tokens), "a rotation reissued an access token")
    state = client.state()
    document = family(state, short_hash(tokens["refresh_token"]))
    generations = sorted(int(entry.get("generation")) for entry in document["members"])
    require(generations == [1, 2, 3, 4], f"the family generations are {generations}, want 1..4: {document}")
    head = live_head(document)
    require(int(head.get("generation")) == 4, f"the live head is not generation 4: {document}")
    require(head.get("handle") == short_hash(handles[-1]), f"the head is not the last successor: {document}")
    require(not document.get("revoked"), f"ordinary rotations revoked the family: {document}")
    require(refresh_calls(state) == 3, f"the upstream served {refresh_calls(state)} refreshes, want 3")
    status, body = client.initialize(access_tokens[-1])
    require(status == 200, f"the resource refused the last issued access token: {status} {body}")
    return (
        "rotation-chain: three rotations produced generations 1-4 of one live family, three upstream "
        "refresh calls, and the last access token initialized the MCP transport"
    )


def stale_predecessor(client: FacadeClient) -> str:
    tokens = client.login()
    root = tokens["refresh_token"]
    status, rotated = client.refresh(root)
    require(status == 200, f"the first rotation answered {status}: {rotated}")
    before = refresh_calls(client.state())
    time.sleep(GRACE_WINDOW_WAIT_SECONDS)
    status, served = client.refresh(root)
    require(status == 200, f"the stale predecessor was refused: {status} {served}")
    require(
        served.get("refresh_token") not in (root, rotated.get("refresh_token")),
        f"the stale presentation did not mint a new head: {served}",
    )
    state = client.state()
    document = family(state, short_hash(root))
    require(not document.get("revoked"), f"the stale predecessor revoked the family: {document}")
    head = live_head(document)
    require(int(head.get("generation")) == 3, f"the stale presentation did not rotate the head: {document}")
    require(head.get("handle") == short_hash(served["refresh_token"]), f"the head is not the served handle: {document}")
    require(refresh_calls(state) - before == 1, "the stale serve made %d upstream calls, want 1" % (
        refresh_calls(state) - before
    ))
    status, body = client.initialize(served["access_token"])
    require(status == 200, f"the served access token was refused: {status} {body}")
    return (
        "stale-predecessor: a predecessor presented past grace was served fresh credentials by rotating the "
        "family's live head (generation 3), the family stayed live, and one upstream rotation happened"
    )


def concurrent_refresh(client: FacadeClient) -> str:
    tokens = client.login()
    handle = tokens["refresh_token"]
    before = refresh_calls(client.state())
    results: list[tuple[int, dict]] = []
    lock = threading.Lock()

    def refresh_from_one_handle() -> None:
        outcome = client.refresh(handle)
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=refresh_from_one_handle) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    require([status for status, _ in results] == [200, 200], f"concurrent refreshers answered {results}")
    state = client.state()
    document = family(state, short_hash(handle))
    require(not document.get("revoked"), f"a concurrent refresh revoked the family: {document}")
    require(len(document["members"]) == 2, f"the family has {len(document['members'])} members, want 2: {document}")
    require(int(live_head(document).get("generation")) == 2, f"the head is not the single successor: {document}")
    require(
        refresh_calls(state) - before == 1,
        f"two concurrent refreshers made {refresh_calls(state) - before} upstream calls, want 1",
    )
    return (
        "concurrent-refresh: two processes refreshed one handle at the same time, both were served, exactly "
        "one upstream rotation happened, and the family keeps one successor and stays live"
    )


def restart_mid_chain(client: FacadeClient) -> str:
    tokens = client.login()
    root = tokens["refresh_token"]
    status, rotated = client.refresh(root)
    require(status == 200, f"the in-memory rotation answered {status}: {rotated}")
    # The restarted process kept the predecessor while another process used the
    # successor: the replay must return the same successor body.
    status, replayed = client.refresh(root)
    require(status == 200, f"the restarted client was refused: {status} {replayed}")
    require(
        replayed.get("refresh_token") == rotated.get("refresh_token"),
        f"the in-window replay minted a different successor: {replayed} vs {rotated}",
    )
    require(
        replayed.get("access_token") == rotated.get("access_token"),
        "the in-window replay returned a different access token",
    )
    status, continued = client.refresh(rotated["refresh_token"])
    require(status == 200, f"the restarted client could not continue: {status} {continued}")
    state = client.state()
    document = family(state, short_hash(root))
    generations = sorted(int(entry.get("generation")) for entry in document["members"])
    require(generations == [1, 2, 3], f"the family generations are {generations}, want 1..3: {document}")
    require(not document.get("revoked"), f"the restart revoked the family: {document}")
    return (
        "restart-mid-chain: a client that restarted holding the predecessor replayed the successor body "
        "without a second upstream call and then continued from it (generations 1-3, family live)"
    )


def retry_storm(client: FacadeClient) -> str:
    tokens = client.login()
    root = tokens["refresh_token"]
    status, rotated = client.refresh(root)
    require(status == 200, f"the first rotation answered {status}: {rotated}")
    before = refresh_calls(client.state())
    time.sleep(GRACE_WINDOW_WAIT_SECONDS)
    statuses = [client.refresh(root)[0] for _ in range(12)]
    require(all(status == 200 for status in statuses), f"the retry storm was refused: {statuses}")
    state = client.state()
    document = family(state, short_hash(root))
    require(not document.get("revoked"), f"the retry storm revoked the family: {document}")
    require(int(live_head(document).get("generation")) == 3, f"the storm minted extra generations: {document}")
    require(
        refresh_calls(state) - before == 1,
        f"twelve identical presentations made {refresh_calls(state) - before} upstream calls, want 1",
    )
    return (
        "retry-storm: twelve identical presentations of one dead predecessor were all served, the re-armed "
        "window cost one upstream rotation, the head is generation 3, and the family stays live"
    )


def genuine_replay(client: FacadeClient) -> str:
    client.register()
    code, verifier = client.authorize_code()
    status, tokens = client.exchange_code(code, verifier)
    require(status == 200, f"the first code exchange answered {status}: {tokens}")
    status, body = client.exchange_code(code, verifier)
    require(
        status == 400 and body.get("error") == "invalid_grant",
        f"the replayed code answered {status} {body}, want an invalid_grant",
    )
    state = client.state()
    document = family(state, short_hash(tokens["refresh_token"]))
    require(bool(document.get("revoked")), f"the replayed code did not revoke the family: {document}")
    status, refused = client.refresh(tokens["refresh_token"])
    require(
        status == 400 and refused.get("error") == "invalid_grant",
        f"the revoked family answered {status} {refused}, want invalid_grant",
    )
    require(
        not refused.get("access_token") and not refused.get("refresh_token"),
        f"a revoked handle was served credentials: {refused}",
    )
    return (
        "genuine-replay: a replayed authorization code revoked its family, and the family's handle then "
        "answered 400 invalid_grant with no credentials — the token endpoint's re-authorize signal"
    )


def legacy_continuity(client: FacadeClient) -> str:
    client.register()
    legacy_handle = client.seed_legacy()
    before = refresh_calls(client.state())
    status, adopted = client.refresh(legacy_handle)
    require(status == 200, f"the pre-policy record was refused: {status} {adopted}")
    state = client.state()
    legacy = family(state, "legacy")
    record = member(legacy, short_hash(legacy_handle))
    require(int(record.get("generation")) == 0, f"the pre-policy record claims a generation: {record}")
    adopted_family = family(state, short_hash(adopted["refresh_token"]))
    require(
        int(live_head(adopted_family).get("generation")) == 1,
        f"the adopted family root is not generation 1: {adopted_family}",
    )
    require(refresh_calls(state) - before == 1, "legacy adoption made more than one upstream call")
    status, continued = client.refresh(adopted["refresh_token"])
    require(status == 200, f"the adopted lineage could not continue: {status} {continued}")
    state = client.state()
    adopted_family = family(state, short_hash(adopted["refresh_token"]))
    require(
        int(live_head(adopted_family).get("generation")) == 2,
        f"the adopted lineage did not rotate: {adopted_family}",
    )
    return (
        "legacy-continuity: a family-less pre-policy record was adopted in code — one upstream rotation "
        "minted a generation-1 family root, and the next refresh rotated it to generation 2"
    )


SEQUENCES = {
    "rotation-chain": rotation_chain,
    "stale-predecessor": stale_predecessor,
    "concurrent-refresh": concurrent_refresh,
    "restart-mid-chain": restart_mid_chain,
    "retry-storm": retry_storm,
    "genuine-replay": genuine_replay,
    "legacy-continuity": legacy_continuity,
}


def main(argv: list[str] | None = None, sequence: str | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay one MCP auth-facade refresh sequence")
    if sequence is None:
        parser.add_argument("sequence", choices=sorted(SEQUENCES))
    parser.add_argument("--base-url", required=True, help="the running app's HTTPS origin")
    parser.add_argument("--ca", default=None, help="the run's CA bundle (the local runner's ca.pem)")
    args = parser.parse_args(argv)
    chosen = sequence or args.sequence
    try:
        client = FacadeClient(args.base_url, args.ca)
        summary = SEQUENCES[chosen](client)
    except ReplayError as failure:
        print(f"replay {chosen}: FAIL ({failure})", file=sys.stderr)
        return 1
    except urllib.error.URLError as failure:
        print(f"replay {chosen}: FAIL (transport: {failure})", file=sys.stderr)
        return 1
    print(summary)
    return 0


def main_for(sequence: str) -> int:
    """Entry point for the per-sequence scripts the examples harness executes."""
    return main(sequence=sequence)


if __name__ == "__main__":
    raise SystemExit(main())
