# Roadmap: AppTheory Strengthening Program (2026-07)

**Descends from:** `ENUMERATED-CHANGES-improvement-program.md` (106 items) ← `SCOPED-NEED-improvement-program.md` (approved 2026-07-02) ← `IMPROVEMENTS.md`
**Milestone sizing:** user preference 5–9 issues per milestone → **17 milestones, 5 phases**.
Milestones are prefixed **SP** (Strengthening Program) to avoid colliding with the repo's
historical `M1`–`M16` milestone vocabulary (which names fixture directories and past Linear work).

## Goal

Deliver the full strengthening program: make the contract covenant actually cover the marketed
surface (MCP, OAuth, objectstore in all three runtimes), close the one-path violations inside
the runtime (errors, registration, binding, validation, OpenAPI), make P2 observability real
(duration, EMF, trace propagation), complete the CDK production deployment story on a runtime
module that no longer drags the CDK with it, and build the adoption on-ramp (deployed
hello-world, scaffold, honest install commands, lowered Python floor) — all additively, with
every release a minor, and every contract-visible behavior pinned fixture-first.

## Sequencing logic

- **Phase 1 lands all gates before the work they guard.** The dist-drift gate, fixture schema,
  tier glob, `--id` runner, cdk-go drift gate, pyright gate, and the lowered-Python-floor CI
  matrix all exist *before* the program starts producing the volume of TS/Python/fixture/jsii
  changes those gates protect. Paying this first makes the other 16 milestones cheaper and safer.
- **Fixture-first elevates to phase order.** Every capability milestone opens with its fixture
  items; no runtime implementation milestone precedes its fixture milestone.
- **Phases 2–4 are internally sequential but partially parallelizable across phases** (noted
  per milestone): parity work (Phase 4) does not depend on validation/OpenAPI (Phase 2), so
  SP09+ can start once Phase 1 lands if capacity allows. The one hard cross-phase edge is
  SP07 (EMF) → SP14 (dashboard construct consumes the blessed metric names).
- **Each milestone is one staging PR riding the normal `staging → premain → main` train.** A
  fixture tier and the runtime legs that turn it green ship inside the same milestone/PR, so
  no protected branch ever sees a red covenant.

## Phases

### Phase 1: Foundation — gates, hygiene, floors (SP01–SP03, items 1–17 + 94)

No user-visible framework behavior changes; everything after gets cheaper and safer.

**Milestone candidates:**

- **SP01 Credibility Sweep** — every user-facing claim (fixture counts, release status, install
  commands, example dependencies, dependency integrity) becomes true.
  - Items: 1, 2, 3, 4, 5
  - Dependencies: none — can start immediately.
  - Risks: none.

- **SP02 Type Truth & Drift Gates** — consumers see the Python types that already exist, and
  the TS build output can no longer silently drift from source.
  - Items: 6, 7, 8, 9, 10, 11
  - Dependencies: none (parallel with SP01).
  - Risks: pyright's first pass over `py/src` may surface more annotation debt than expected —
    mitigated by basic-mode start; item 7 absorbs the fixes.

- **SP03 Release & Fixture Machinery** — the covenant's own enforcement machinery stops having
  blind spots, and the Python + Node floors drop with continuous CI proof.
  - Items: 12, 13, 14, 15, 16, 17, 94
  - Dependencies: 17 (tier rename) needs 10 (glob) from SP02; 15 pairs with the existing
    `update-cdk-generated.sh`.
  - Risks: **platform floors are bounded by TableTheory** — `tabletheory-py` must support
    the Python target and `tabletheory-ts` must be consumable on Node 20. The TableTheory
    2026-07 plan now includes `Support Node 20 LTS and CommonJS consumers`; AppTheory
    verifies the aligned Node 20 floor in CI before metadata changes merge.

### Phase 2: One-Path Runtime Convergence (SP04–SP06, items 18–38)

The runtime stops offering competing shapes; the canonical path is pinned and the legacy
surfaces are deprecated in place.

**Milestone candidates:**

- **SP04 Canonical Errors & Fail-Closed Registration** — one error envelope for every
  framework-emitted error, and invalid route registration can no longer fail silently.
  - Items: 18, 19, 20, 21, 22, 23, 24, 25
  - Dependencies: Phase 1 gates (schema gate validates the new fixture tiers; dist gate guards
    the TS legs).
  - Risks: fail-closed registration changes behavior for *misconfigured* apps — an app with a
    silently-dead route today will panic at startup tomorrow. Additive by intent (it surfaces
    an existing bug) but needs a Pay Theory shakedown note in the milestone PR and an
    UPGRADING entry (SP16). Envelope convergence must preserve legacy codes behind
    `WithHTTPErrorFormat` — fixtures in item 18 pin both sides.

- **SP05 Canonical Typed Handlers & Validation** — one generic typed-handler shape and one
  declarative validation vocabulary with a canonical 422, identical in all three runtimes.
  - Items: 26, 27, 28, 29, 30, 31, 32, 33
  - Dependencies: SP04 (validation errors ride the canonical envelope).
  - Risks: expressing Go's reflection-driven `BindConfig` semantics in Python annotations and
    TS generics is the design-heavy step — known unknown on edge-case conversion parity
    (durations, slices); mitigated by pinning conversions exhaustively in item 26 before any
    implementation.

- **SP06 OpenAPI from the Contract** — the wire contract is generated from typed handlers,
  byte-identical across runtimes; plus the tier-encoding cleanup.
  - Items: 34, 35, 36, 37, 38
  - Dependencies: SP05 (generation reads typed handlers + validation rules).
  - Risks: byte-pinned OpenAPI output requires canonical JSON ordering rules across three
    serializers — known unknown; mitigated by specifying ordering in the fixture design (item
    34) rather than trusting library defaults.

### Phase 3: Observability & Coverage Backfill (SP07–SP08, items 39–54)

P2 becomes real: measured, emitted, propagated — and the thin fixture areas get pinned.

**Milestone candidates:**

- **SP07 Duration & EMF Metrics** — requests are timed and a first-party CloudWatch EMF sink
  ships; "P2 observability" stops being batteries-not-included.
  - Items: 39, 40, 41, 42, 43, 44, 45, 46
  - Dependencies: Phase 1 gates. Parallelizable with Phase 2.
  - Risks: EMF requires a `Timestamp` per record — determinism handled by the injected clock,
    but fixture design must pin the EMF envelope precisely enough to catch drift without
    over-pinning AWS-side flexibility.

- **SP08 Trace Propagation & Fixture Backfill** — trace context flows into requests and error
  envelopes, and rate-limit/WebSocket/SSE edge behavior is pinned.
  - Items: 47, 48, 49, 50, 51, 52, 53, 54
  - Dependencies: SP07 (docs item 51 describes the full shipped surface); backfill items are
    independent siblings.
  - Risks: backfill fixtures may expose real cross-runtime divergence in today's rate-limit /
    WebSocket / SSE behavior — that is the point; budget for convergence fixes inside the
    milestone rather than treating divergence as scope creep.

### Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)

The covenant expands to cover every marketed surface, in every runtime. Fixture milestones
lead; each language leg turns them green.

**Milestone candidates:**

- **SP09 MCP Contract Truth** — the MCP method surface is specified by fixtures and Go
  converges on them; the fixtures arbitrate, not the Go code.
  - Items: 55, 56, 57, 58, 59
  - Dependencies: Phase 1 gates. Parallelizable with Phases 2–3.
  - Risks: **theory-mcp-server runs on the Go MCP runtime** — any convergence change in item
    59 must be validated against it before release (cross-repo coordination below). MCP spec
    version (`2025-11-25`) may advance mid-program; pin fixtures to the implemented protocol
    version explicitly.

- **SP10 MCP TypeScript Runtime** — a TS author can build, test, and ship an MCP server on
  AppTheory, verified by the same fixtures as Go.
  - Items: 60, 61, 62, 63, 68, 70
  - Dependencies: SP09 (fixtures exist and are Go-green).
  - Risks: resumable SSE within Node's Lambda response-streaming model is the biggest known
    unknown of the program; the existing `ts/src/internal/aws-lambda-streaming.ts` is the
    starting surface. DynamoDB store parity should reuse the TableTheory-ts dependency rather
    than raw SDK — fail-closed, no escape hatch.

- **SP11 MCP Python Runtime** — a Python author gets the same, fixture-verified.
  - Items: 64, 65, 66, 67, 69, 71
  - Dependencies: SP09. Parallelizable with SP10 (different runtimes, same fixtures).
  - Risks: Python Lambda streaming for resumable SSE (mirror of SP10's unknown); Python's
    sync-first runtime shape (matching the existing `sse.py` model) must express session +
    stream semantics without inventing a second concurrency model.

- **SP12 OAuth Parity** — protected-resource metadata, bearer validation, DCR, and PKCE are
  fixture-pinned and identical in all three runtimes; TS/Py MCP servers can be protected
  resources.
  - Items: 72, 73, 74, 75, 76, 77, 78
  - Dependencies: SP09–SP11 recommended first (OAuth's consumer is the MCP surface), hard
    dependency only on Phase 1.
  - Risks: token-validation crypto differences across language stacks (JWKS handling, clock
    skew) — pinned by fixtures with deterministic keys/clocks from the testkit.

- **SP13 Object Store Parity** — the deliberately-narrow object store is contract-covered in
  all three runtimes, forbidden operations pinned as errors.
  - Items: 79, 80, 81, 82
  - Dependencies: Phase 1 only; fully parallelizable within Phase 4.
  - Risks: none beyond ordinary implementation effort. (4 items — deliberately under the 5–9
    preference; folding it into SP12 would blur two unrelated capabilities.)

### Phase 5: Deployment Surface & Adoption (SP14–SP17, items 83–93, 95–106)

The framework becomes production-deployable and adoptable end-to-end, and the codebase is
left cleaner than the program found it.

**Milestone candidates:**

- **SP14 Production Deployment Surface** — the runtime module sheds the CDK tree, and the
  flagship constructs gain the production knobs (domain/CORS, WAF, log retention, VPC,
  canary, dashboard) that currently force raw-CDK bypasses.
  - Items: 83, 84, 85, 86, 87, 88, 89, 90
  - Dependencies: item 89 needs SP07 (EMF metric names); item 83 lands first inside the
    milestone so construct regeneration happens once per shape; cdk-go drift gate (SP03) active.
  - Risks: **nested Go module release mechanics** — a nested `cdk-go` module needs its own
    `cdk-go/vX.Y.Z` tag for `go get` to resolve it; release-please (`release-type: go`, two
    configs) and `verify-version-alignment.sh` must produce and check the dual tags. This is
    the roadmap's highest release-machinery risk; it is mitigated by proving the tag flow on a
    premain RC before the stable cut, and it must NOT land mid-release-cycle (see release
    timing below).

- **SP15 On-Ramp** — a new adopter goes from clean machine to deployed, curl-able service in
  one documented path, and can scaffold a correct project in one command.
  - Items: 91, 92, 93, 95, 96
  - Dependencies: SP01 (real install commands); hello-world (91) needs nothing new, so this
    milestone can start any time after Phase 1 — scheduled here so the scaffold templates
    (93) emit the program's canonical typed-handler/validation shapes from SP05.
  - Risks: scaffold ownership (AppTheory vs theory-cli) is an open cross-steward question —
    program ships AppTheory-owned `cmd/apptheory-init`; integration follow-up recorded, not
    blocked on.

- **SP16 Operator & Upgrade Docs** — operators of deployed apps get real guidance, and
  consumers get a maintained upgrade path listing every deprecation this program introduced.
  - Items: 97, 98, 99, 100, 101, 102
  - Dependencies: 98 (UPGRADING) lists deprecations from SP04; 97 (operator guide) references
    SP07/SP14 observability; 99 must verify subtree-publish path filters.
  - Risks: none.

- **SP17 Codebase Decomposition** — the mega-files are split with byte-identical public
  surfaces and the transitive-override debt is retired.
  - Items: 103, 104, 105, 106
  - Dependencies: scheduled last so it never conflicts with the program's feature branches in
    the same files (microvm, event sources). Snapshot-byte-identical acceptance makes it
    mechanically safe. (4 items — under preference; kept separate because mixing pure
    refactors into feature milestones muddies release notes and review.)
  - Risks: none beyond merge timing — do not start while any Phase 4 branch is open.

## Cross-phase risks

- **Program length vs. release cadence.** 106 commits across 17 milestones means many minor
  releases. Each milestone must fully ride `staging → premain → main` and back-merge before
  the next promotion; the strict-train rules in `AGENTS.md` (premain manifest reset after
  each stable, no stale RC PRs) become the program's operating rhythm, not an occasional
  ceremony.
- **SP14's nested-module cut is release-machinery-sensitive.** Land it at the *start* of a
  cycle, immediately after a stable release + back-merge, never while an RC is open.
- **Fixture-count churn.** The corpus will grow well past 145; item 2 (generated counts) must
  land in SP01 precisely so no doc claim ever hand-tracks the number again.
- **Deprecation accumulation.** SP04 introduces deprecations whose removal is out of program
  scope; the future-major decision (scoped-need open question 2) should be made before the
  program ends so UPGRADING (SP16) can state a horizon.
- **Steward self-dependency.** The Go MCP runtime under change in SP09 serves my own agent
  endpoint via theory-mcp-server. Convergence changes get validated against a staging
  deployment of theory-mcp-server before any stable release.

## Cross-repo dependencies

- **TableTheory (data-layer steward):** item 94 (SP03) is bounded by TableTheory's own
  platform floors: `tabletheory-py` must support the Python target and `tabletheory-ts`
  must be consumable on Node 20. Verified against TableTheory's 2026-07 M3
  `floors-and-install` plan, which includes item 17 `Support Node 20 LTS and CommonJS
  consumers` and R1 validation by AppTheory or a sandbox app. TS MCP/limiter DynamoDB
  stores should consume `tabletheory-ts` rather than raw SDK — confirm its API suffices
  before SP10.
- **theory-mcp-server (platform):** consumes the Go MCP runtime; must be regression-validated
  against SP09's convergence and SP12's OAuth changes before stable cuts.
- **theory-cli (deploy path):** scaffold integration (`theory app init`) is a follow-up
  conversation; AppTheory ships its own generator in SP15 regardless.
- **FaceTheory:** no changes expected (m14 streaming fixtures are untouched by this program).

These are surfaced per the steward protocol: none blocks Phase 1; TableTheory floor
verification (Python 3.12 + Node 20) is needed before SP03 merges item 94; the rest bind at
Phases 4–5.

## Deprecation and migration plan

Additive + deprecate throughout: `AppError`, `JSONHandler`'s Lift-compat codes (preserved
behind `WithHTTPErrorFormat`), the `*Strict` registration variants, and lenient fluent
registration are deprecated in place during Phase 2, documented in UPGRADING (SP16), and
removed only in a future major outside this program. The `cdk-go` nested module ships with a
migration note (one-time `go get` addition for CDK-in-Go consumers); runtime-only consumers
see their dependency tree shrink with no action.

## Open questions

1. **Platform floor final values** — resolved empirically by SP03's CI matrix against
   TableTheory's artifacts; targets are Python 3.12 and Node 20 LTS.
2. **Future-major horizon** for completing envelope convergence — decide before SP16 writes
   UPGRADING.
3. **Scaffold ownership** (AppTheory `cmd/apptheory-init` vs theory-cli `theory app init`) —
   cross-steward; program proceeds with AppTheory-owned.
4. **release-please dual-tag support for the nested module** — verify against the current
   release-please version during SP14 planning, before the milestone branch opens.
