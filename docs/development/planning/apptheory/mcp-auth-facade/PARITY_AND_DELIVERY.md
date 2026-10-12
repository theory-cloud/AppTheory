# Parity and delivery plan (M0, item 7)

Status: plan for review (M0).
Last updated: 2026-10-12
Owner: AppTheory

Atomic parity is the operator rule (Factory docs/110): every capability ships for Go, TypeScript, and Python
with jsii CDK bindings **in the same release**, proven by shared fixtures. The facade today is Go-only in
places, so this matrix is also the framework's own parity debt.

## 1. Parity matrix

Legend: **Y** = exists today; **part** = partial; **–** = absent. "Work" is what M1–M4 must add per surface.

| # | Capability (gap) | Go | TS | Py | CDK | Work needed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Route algebra v2 incl. `/register` + callback + per-route issuer/resource (G2, G3) | Y (v1) | part (metadata endpoints only) | – | Y (v1) | v2 derivations + `IssuerMode` in Go/TS/CDK; **new TS route algebra** (`ts/src` has only issuer-based metadata builders — no route/path derivation); **new Py algebra** |
| 2 | Facade registrar `RegisterMCPFacade` / `registerMcpFacade` / `register_mcp_facade` (G3) | Y | – | – | part | **M1: TS/Py registrar skeletons** (posture field + fail-closed pairing, no handlers); **M3: fill all three with facade mechanics**; extend Go for register/callback/provider/stores |
| 3 | Transport posture + CDK↔runtime pairing (G1) | part | – | – | part | posture vocabulary + pairing + fail-closed in all four (M1; TS/Py via the M1 registrar skeletons) |
| 4 | Route-aware validator context + route-derived audience/scopes (G5) | part | Y | Y | n/a | Go validator signature change; route-derived inputs in all three |
| 5 | JWKS/RS256 validator + OIDC discovery bootstrap (G4) | – | – | – | n/a | new in all three |
| 6 | Route-derived RFC 9728 challenge + 403 `insufficient_scope` (G6) | part | part | part | n/a | route-derived metadata URL, 403 scope challenge, all three |
| 7 | RFC 8707 resource indicators (G8) | – | – | – | n/a | new in all three (authorize + token + audience exact-match) |
| 8 | Front-channel termination + upstream callback (G7) | – | – | – | n/a | new in all three (seam exists in Go only) |
| 9 | Facade code store + replay → broker revoke (G7) | part | – | – | n/a | store SPI + reference stores + replay-revoke semantics, all three |
| 10 | DCR endpoint handler + derived `/register` route + rate limit (G2, G7) | part | part (metadata field only) | part (metadata field only) | – | endpoint handler + route mount + rate limit, all three; TS/Py "part" today is only the `registration_endpoint` metadata field (`ts/src/oauth/index.ts`), no handler; CDK derives route |
| 11 | Brokered refresh (lock/coalesce/grace/rotation) + hidden upstream material (G7) | – | – | – | n/a | new in all three |
| 12 | Provider SPI (+ Autheory adapter) | – | – | – | n/a | new in all three |
| 13 | Store SPI + in-memory reference stores | part | – | – | n/a | new in all three (Go has two in-memory stores today) |
| 14 | CDK posture + derived routes + defense-in-depth floor (G1, G9-adjacent) | n/a | n/a | n/a | part | posture, `/register`/callback derivation, throttling/origin/denial requirements |
| 15 | CDK edge `WWW-Authenticate` restoration for REST v1 (G9) | n/a | n/a | n/a | – | new framework front-door construct |
| 16 | Conformance kit (G10) | – | – | – | – | new (Layers A/B/C + expectation tables) |
| 17 | Release-note correction mechanism (G11) | n/a | n/a | n/a | n/a | docs mechanism (item 8) |
| 18 | Deterministic `streamjoin` close test (G12) | part | n/a | n/a | n/a | `Close` ordering fix + test rewrite (M4) |

Cross-runtime asymmetries worth stating plainly (from the audits): the route algebra and the facade registrar
are Go-only; Go's bearer validator cannot see the request; token stores are Go-only; RFC 8707 is absent
everywhere; no runtime ships a JWT/JWKS validator.

## 2. Milestones (atomic parity per milestone)

Each milestone lands as **one PR to `staging`** with all four surfaces, shared fixtures, and green CI. A
milestone that ships Go without TS/Py/CDK is not done.

### M1 — Transport posture + conformance kit (closes G1, G10)

- Posture vocabulary (`iam` | `jwt` | `runtime-bearer` | `none-public`) + default resolution (item 3) in CDK.
- **Facade registrar skeletons in Go/TS/Py** carrying the posture field and the **registration-time fail-closed
  pairing** check: a `runtime-bearer` posture without the explicit runtime-posture assertion returns an error
  before any route is registered. The skeletons contain posture + pairing only; the facade handler bodies are
  M3. This is what makes "pairing in Go/TS/Py/CDK" implementable inside M1 rather than M3.
- CDK↔runtime pairing, fail closed at synth and registration, in Go/TS/Py/CDK.
- Conformance kit Layers A/B/C and the `facade-transport-posture.v1` / `facade-route-model.v1` tables,
  registered under `contract-tests/fixtures/routing/mcp-auth-facade/` with Go + CDK-TS loaders.
- Defense-in-depth floor enforcement (DD-1/DD-2/DD-3 declaration) at synth.
- Parity: Go, TS, Py, CDK together.

### M2 — Route model + validator + challenge (closes G2, G4, G5, G6, G8)

- Route algebra `v2`: derived `/register` + callback, `IssuerMode: route` per-route issuer/resource — Go, TS,
  **new Py**, CDK.
- Route-aware validator context (Go signature fix) + route-derived audience/scope inputs in all three.
- JWKS/RS256 validator with OIDC discovery bootstrap + alg pinning + issuer/audience/azp checks in all three.
- Route-derived RFC 9728 challenge, 403 `insufficient_scope` with the remediation scope set, RFC 8707 resource
  indicators — all three.
- Parity: Go, TS, Py, CDK together.

### M3 — Facade module + SPIs (closes G7; completes G3 for this surface)

- Front-channel termination, upstream callback, code store + replay→revoke, DCR endpoint, brokered refresh
  (lock/coalesce/grace/rotation) with hidden upstream material — **facade registrars in all three runtimes**.
- Provider SPI + Autheory adapter (first adapter) in all three.
- Store SPI + in-memory reference stores in all three.
- Parity: Go, TS, Py, CDK together.

### M4 — Hygiene (closes G9, G11, G12)

- Framework CDK edge `WWW-Authenticate` restoration construct for REST v1 origins.
- Release-note correction mechanism executed (item 8) — docs only.
- Deterministic `streamjoin` close test (§3).
- Parity: the CDK construct is jsii (all languages); the flake fix is Go-only by nature.

## 3. G12 — deterministic `TestCloseEndsStreamEarlyForReader`

**Defect (grounded):** `runtime/internal/streamjoin/streamjoin_test.go:182` synchronizes with
`time.Sleep(10 * time.Millisecond)` and then asserts a blocked `Read` returns `io.ErrClosedPipe`.
`Body.Close` (`runtime/internal/streamjoin/streamjoin.go`) currently does `b.cancel()` **then** `b.pr.Close()`.
Two paths can release the blocked read:

- `b.pr.Close()` → the blocked `b.pr.Read` returns `io.ErrClosedPipe` (the assertion's expectation);
- `b.cancel()` → the test's producer returns from `<-ctx.Done()` and its deferred `pw.Close()` → the blocked
  `b.pr.Read` returns `io.EOF`.

Whichever lands first wins, so the test is inherently timing-dependent.

**Proposed deterministic approach (M4):**

1. In `Body.Close`, close the reader pipe **before** canceling the producer context (`b.pr.Close()` then
   `b.cancel()`). This makes the error a blocked `Read` observes deterministic: the pipe reader is closed
   before the producer can observe cancellation and close the writer, so a blocked (or subsequently started)
   read always returns `io.ErrClosedPipe`. Both paths still unblock producers blocked on `Write` or on
   `ctx.Done()`, so the documented io.Closer contract is preserved.
2. Rewrite the test without `time.Sleep`: start the reader goroutine, call `Close()`, then assert the reader's
   error is `io.ErrClosedPipe`. No handshake is needed because a `Read` begun after `pr.Close()` also returns
   `ErrClosedPipe`.
3. Keep the bounded `assertNoProducerGoroutine` join (it polls to a 2 s deadline; bounded, not racy).

This is a runtime change and therefore M4 work, not M0 (M0 is design-only).

## 4. CI gates

Existing gates that must stay green (from `Makefile`, `AGENTS.md`, and `gov-infra/verifiers/`):

| Command | Gates |
| --- | --- |
| `make fmt` / `scripts/fmt-check.sh` | Go formatting |
| `make lint` | Go/TS/Py lint |
| `make test-unit` | `go test ./...` |
| `make test` | unit tests + `scripts/verify-version-alignment.sh` |
| `make build` | release artifacts (drift checks) |
| `make rubric` | `scripts/verify-rubric.sh`: fixture count + schema, invocation scope, CDK README inventory, CDK-Go drift, API docs, gov tests, then `gov-infra/verifiers/gov-verify-rubric.sh` |
| `scripts/verify-docs-standard.sh` | docs structure/planning exclusions |
| `scripts/verify-api-snapshots.sh` | public API drift |
| `scripts/verify-contract-tests.sh` | Go/TS/Py fixture parity |

New gates added by this program:

- **Conformance gate (M1):** the kit's Layer A/B/C assertions wired into `make rubric` (or an adjacent gate),
  so a posture regression fails CI. The requirement: no transport route may exist without an authorization
  assertion.
- **Parity gate (M1–M3):** the fixture corpus is the parity proof. A capability that ships in one runtime only
  fails because the shared fixture runs in all three.

The Factory toolchain note (docs/094) applies: run pinned binaries through `tc-toolchain exec` — with the
caveat recorded in memory that `tc-toolchain exec AppTheory` currently mispins the Go floor (see
`UNVERIFIED.md` §toolchain); use the repo's own documented commands when the wrapper cannot run.

## 5. Sequencing and dependencies

- M0 (this PR) → plan gate → M1 → M2 → M3 → M4 → M5 adoption → M6 lab proof (operator-run).
- M2's `IssuerMode: route` is a hard dependency for TMS adoption: without it the routed issuer cannot be
  expressed and M5 cannot delete TMS's route algebra.
- M3's provider SPI is a hard dependency for the Autheory adapter and for the single-domain proxy.
- The conformance kit (M1) is a hard dependency for docs/110 success criteria 3 and 4.
