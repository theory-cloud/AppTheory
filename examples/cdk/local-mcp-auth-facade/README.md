# Local MCP auth-facade example

One Go Lambda app that mounts AppTheory's MCP auth facade with its **brokered
route refresh**, an MCP tool surface behind the runtime-bearer transport
posture, and a real local authorization server as the upstream. It runs on the
local runner (`apptheory-local`) and is driven over real HTTP by
`scripts/local/run_examples_local.py`.

The example exists because the refresh policy cannot be proven by unit tests
alone. The sequences that broke real clients are replayed here as real HTTP
requests, and every assertion reads the app's own state document — family
status, live head, chain generation — not just a status code.

## What it mounts

| Surface | Path |
| --- | --- |
| MCP transport | `POST/GET/DELETE /acme/mcp` |
| Protected-resource metadata | `/.well-known/oauth-protected-resource/acme/mcp` |
| Authorization-server metadata | `/.well-known/oauth-authorization-server/acme/mcp` |
| Authorize / token / register | `/.well-known/oauth-authorization-server/acme/mcp/{authorize,token,register}` |
| Refresh compatibility alias | `POST /token` (refresh grant only) |
| Upstream callback | `/_oauth/mcp/callback` |

The facade is registered in **route issuer mode**, so each MCP route is its own
authorization server and its RFC 8414 metadata lives at the route's own
well-known path — the one a client derives from the advertised issuer.

`POST /token` is a compatibility alias, not a second authorization server. MCP
SDK 2.3.0's OAuth provider refreshes at `<origin>/token` whenever the process
did not cache authorization-server metadata first — every restart with stored
tokens — while route-issuer mode serves the token endpoint under the route.
Without the alias, a real Vibe 3.0.4 session reports `mcp_invalid_result` after
its access token expires and stops calling the tool. The alias resolves the
presented handle's broker record, rebuilds that route's token path, and
re-dispatches the unchanged request through the app, so the facade's own token
handler performs every binding check, grace and rotation decision, refusal and
telemetry event. It serves only `grant_type=refresh_token`; an unknown or
unrouteable handle gets the same uniform `invalid_grant` the route endpoint
gives. `handlers/go/main_test.go` pins both halves.

The upstream is this example's own OAuth 2.1 authorization server
(`handlers/go/upstream.go`): RS256 access tokens with a published JWKS,
single-use authorization codes, S256 PKCE, rotating refresh tokens with reuse
detection, and one HTTP authorize endpoint the client's browser visits. The
authorize endpoint auto-approves, because a local run has no human at the
keyboard; the consent decision is the example's own seam.

No local OIDC provider path ships with the local runner, so the framework
example carries its own. TMS proves the same facade against a real local
Autheory provider; this example proves the facade's own policy locally.

## Run it

```bash
# The runner binary the examples harness builds on demand:
go build -o "$HOME/.cache/apptheory-examples-local/bin/apptheory-local" ./cmd/apptheory-local

"$HOME/.cache/apptheory-examples-local/bin/apptheory-local" run \
  --app examples/cdk/local-mcp-auth-facade \
  --profile scripts/local/examples-local.json \
  --port-base 8240 --tls --tls-host mcp.localhost \
  -c publicBaseUrl=https://mcp.localhost:8240
```

The log prints the run's CA (`.../tls/ca.pem`). Replay one sequence against the
running app:

```bash
python3 examples/cdk/local-mcp-auth-facade/scripts/rotation-chain.py \
  --base-url https://mcp.localhost:8240 --ca <run>/tls/ca.pem
```

The sequences are `rotation-chain`, `stale-predecessor`, `concurrent-refresh`,
`restart-mid-chain`, `retry-storm`, `genuine-replay` and `legacy-continuity`.
`make examples-local` runs all seven as classified rows.

## The state document

`GET /_state` returns the example-only inspection surface the rows read:

- `families`: every broker record grouped by family, with its handle hash, chain
  generation, status, whether it carries a grace deadline, and whether it is the
  live head; `revoked` is the family tombstone.
- `upstream`: how many access tokens and refresh rotations the upstream minted,
  and how many times it detected reuse (it must stay zero for real client
  behaviour).
- `refreshEvents` and `refusals`: the redacted telemetry the facade emitted.
- `toolCalls`: how many times the echo tool ran, which is how the real-client
  target observes a successful MCP call.

The document carries hashes only, never a handle, a token, or a credential.

`POST /_state/legacy` seeds a family-less v6.4.0-era broker record with live
upstream material, so the legacy-continuity row starts from the record an older
deployment left behind. `POST /_state/revoke-upstream-grant` makes every
upstream grant terminally dead, the local stand-in for a person withdrawing
their authorization. Both are example-only seams for local proof.

## Configuration

The CDK stack sets the app's configuration; the framework reads no environment
variable of its own.

| Variable | Meaning |
| --- | --- |
| `MCP_EXAMPLE_PUBLIC_BASE_URL` | the app's HTTPS origin; every advertised URL derives from it |
| `MCP_EXAMPLE_HANDLE_TTL` | the route handle's local lifetime (default `24h`) |
| `MCP_EXAMPLE_GRACE_WINDOW` | the lost-response replay window (default `1s`; the rows wait past it) |
| `MCP_EXAMPLE_ACCESS_TTL` | the upstream access-token lifetime (default `900s`; `make local-clients` uses `30s`) |
| `MCP_EXAMPLE_UPSTREAM_CLIENT_ID` | the facade's own registration at the upstream |
| `MCP_EXAMPLE_SUBJECT` | the person the local upstream authenticates |

The reference stores are in-memory and do not encrypt: this is a local example,
not a deployment. A durable deployment supplies encrypting stores.

## Tests

`handlers/go/main_test.go` runs the whole authorization-code + PKCE + refresh
dance against the composed app in process, so a wiring mistake fails `go test`
before any container starts.
