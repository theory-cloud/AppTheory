# Unknown / unverified (M0, item 10)

Status: honest unknowns for review (M0).
Last updated: 2026-10-12
Owner: AppTheory

This document lists what the M0 design **does not** establish, separated from what it does. Claims are only as
strong as their evidence; nothing here is asserted as fact.

## 1. Verified from local sources (for contrast)

These were checked directly during M0 and are safe to treat as fact:

| Claim | Evidence |
| --- | --- |
| CDK transport authorizer is a closed `IAM | JWT` enum; `IAM` is the default | `cdk/lib/mcp-server.ts:20-25`, `858` |
| The public transport posture throws with `rootAuthorizationServerDiscovery` and with legacy issuer/jwks props. M0 recorded this as the `unauthenticatedMcp` opt-out; M1 removed that prop and moved the guard to `transportPosture: none-public` | `cdk/lib/mcp-server.ts:1044-1075` (`validatePostureGuards`) |
| JWT authorizer requires a static issuer + non-empty audience | `cdk/lib/mcp-server.ts:869-900` |
| Route inventory derives no `/register` and no callback route | `cdk/lib/mcp-server.ts:649-675`; `runtime/mcproutes` |
| Go bearer validator receives `context.Context`; TS/Py validators receive the app context | `runtime/oauth/bearer.go:23,27`; `ts/src/oauth/index.ts:96,101`; `py/src/apptheory/oauth/__init__.py:163,164` |
| Go challenge is single-header and metadata-URL derives from `MCP_ENDPOINT` | `runtime/oauth/bearer.go:194-222` |
| ↳ **As-built note (2026-10-14, M3c-2): stale.** The challenge now derives only from `ResourceMetadataURL` / `ResourceMetadataURLFunc`; the runtime never reads `MCP_ENDPOINT`, and no construct injects it. | `runtime/oauth/bearer.go` (`RequireBearerTokenMiddleware`); `cdk/lib/remote-mcp-server.ts` (`protectedResourceMetadataUrl`) |
| Only Go ships in-memory authorization-code/refresh stores | `runtime/oauth/tokens.go:35-167` |
| M2 shipped as `fix(security)` (#1124, `b3ef924`) and is absent from the 6.0.0 BREAKING CHANGES list | `CHANGELOG.md:6-12,62` |
| `UPGRADING.md` documents the MCP transport default flip | `UPGRADING.md` "MCP transport routes require credentials by default" |
| Release Please default changelog path is `CHANGELOG.md`; config is `release-type: go`, `draft: true` | `release-please-config.json` |
| The `streamjoin` test synchronizes with `time.Sleep` (the call is at `streamjoin_test.go:194`; `TestCloseEndsStreamEarlyForReader` begins at `:182`), and `Close` cancels before closing the pipe | `runtime/internal/streamjoin/streamjoin_test.go:182,194`; `streamjoin.go` `Close` |
| Autheory publishes RFC 8414 metadata with `authorization_endpoint = issuer + /oauth/authorize`, `jwks_uri = /.well-known/jwks.json`, `registration_endpoint = /register`, RFC 9207 and RFC 8707 support flags true, DCR issues `mcp_` clients, refresh bound to the issuing client | Autheory `origin/staging` `2390dd00` (per the M0 ground-truth read) |
| No AWS documentation is vendored in this repo (only a `third_party/` npm tarball) | `third_party/`, `docs/` |

## 2. Unverified — must be confirmed before implementation relies on them

### AWS platform behavior (no vendored docs; verify against AWS public documentation and a lab synth)

| # | Unknown | Why it matters | Where it will be checked |
| --- | --- | --- | --- |
| U1 | What an **API Gateway HTTP API JWT authorizer 401** response actually contains (status/body, whether any `WWW-Authenticate` is emitted). `UPGRADING.md` asserts 401 for JWT and 403 for IAM; the header content is unverified. | Determines whether the `jwt` posture can carry an RFC 9728 challenge at all, and what clients observe. | M2 implementation spike + M6 lab. |
| U2 | Whether HTTP API **Lambda authorizers** can influence 401/403 response headers, and whether HTTP APIs support gateway-response customization. Believed not, unverified. | Rules out a Lambda-authorizer alternative for challenge emission. | M2 spike. |
| U3 | Whether an **IAM-authorizer 403** includes any challenge header. Presumed none. | Confirms `iam` cannot serve OAuth-bearer clients (the TMS blocker). | M6 lab. |
| U4 | CloudFront **viewer-request function** behavior for synthesizing a 401 with custom headers at the edge (DD-4 mechanics). | Optional edge gate viability. | M4/M6. |
| U5 | Exact REST v1 vs HTTP API v2 remapping of `WWW-Authenticate` (the TMS edge restoration exists because REST v1 remaps; the v2 no-op is asserted in TMS code, not verified against AWS docs). | Justifies the framework edge-restoration construct (G9). | M4. |
| U6 | Whether `disableExecuteApiEndpoint` is available and behaves as expected on the HTTP API used by the MCP transport. | DD-2 "disable" option. | M4 synth + lab. |

### Release automation behavior

| # | Unknown | Why it matters | Where it will be checked |
| --- | --- | --- | --- |
| U7 | Exactly which Conventional Commit types Release Please renders into the generated section for this `release-type: go` config (i.e., whether a given typed commit is release-visible). | Item 8's "next release carries the correction" depends on the correction commit being rendered. | M4, by observing the generated RC changelog. |
| U8 | Whether Release Please can be made to accept a correction to a **past** section without hand-editing (assumed no). | Confirms the mechanism must live outside the generated file. | M4. |

### Cross-repo facts read at a branch head, not staging

| # | Unknown / caveat | Detail |
| --- | --- | --- |
| U9 | TMS facts were read at `origin/staging` (`6537a053`); TMS facts read at the held branch head (`d4569e7d`) may differ. | The M0 design reads staging truth; the adoption branch is withheld. |
| U10 | Autheory facts were read at `origin/staging` (`2390dd00`); the Autheory working tree was on its adoption branch (`2c4a2efd`) during the audits. | Recorded as a grounding caveat, not a design input. |

### Product decisions that are not AppTheory's to make

| # | Unknown | Owner |
| --- | --- | --- |
| U11 | Whether Autheory could mint **per-route issuers**, obviating the facade's route-as-issuer model. | Autheory steward (operator decision); recorded as an open question, not a change. |
| U12 | Why TMS broker retention is exactly 30 days, and why DCR rate limiting is per-route anonymous with no source-IP keying (stated as deliberate, rationale unrecorded). | TMS steward. |
| U13 | Whether Autheory's published `authorization_endpoint` path (`/oauth/authorize`) versus its internal path constant (`/auth/authorize`) matters for discovery-driven clients. | Autheory steward. |

### Evidence-quality gaps inherited from the plan gate

| # | Gap | Detail |
| --- | --- | --- |
| U14 | G12's flake (one fail, one pass) rests on CI evidence (PR #1133 run 38284927184) not independently verifiable offline. The test exists; the flake occurrence is plausible, unconfirmed. | Factory owns CI evidence at PR gates. |
| U15 | The plan-gate reviews' **first-request provider/model receipts** were not independently attested by either reviewer run (recorded gap in Factory docs/110). | Not a design input. |
| U16 | The "v6.0.0 tag/assets immutable" and "no consumers" statements were accepted as operator rulings, not verified from the repo. | Operator ruling. |

## 3. Toolchain caveat (recorded so M1–M4 do not repeat it)

Scoped memory records that `tc-toolchain exec AppTheory` currently mispins the Go floor (it forces an older
Go than `go.mod` requires), which makes Go commands fail under the wrapper. This is a Factory toolchain state
issue, not an AppTheory defect. M1–M4 must use the repo's own documented commands (`make ...`) when the wrapper
cannot run, and must not weaken gates to work around it. (Factory docs/094 is the toolchain reference.)

## 4. How this list is used

- M1–M4 must not claim completion of any item that depends on a row above until that row is resolved.
- Each resolved row should update this document with the evidence (source, lab observation, or AWS doc URL).
- The M6 lab proof receipt must name which rows it resolves (per ADV-P110-6 observation channels).
