# Scoped Need: AppTheory Strengthening Program (2026-07)

**Source analysis:** `IMPROVEMENTS.md` (repo root, 2026-07-02, staging @ `552b84ed`, v1.14.0)
**Status:** Approved. The four program-shaping decisions were confirmed by the user on
2026-07-02: (1) **full parity all three** — MCP, OAuth, and objectstore get fixtures +
TS/Python implementations; (2) **lower the Python and Node floors** — target Python 3.12 and Node 20 LTS, aligned with TableTheory's 2026-07 plan;
(3) **include** the nested `cdk-go` module split; (4) **additive + deprecate** break budget.

## Background

A full-surface analysis of the framework (Go/TS/Python runtimes, CDK, contract machinery,
docs) found that AppTheory's core is healthy but there are gaps between what the product
claims and what the contract enforces, plus adoption friction that prevents the strong core
from being experienced. The user asked for a comprehensive program covering **all** findings
so it can be enumerated into commit-sized changes.

## Problem

Seven problem clusters, in priority order:

1. **Covenant coverage gap:** MCP/OAuth/objectstore are Go-only with zero contract fixtures,
   contradicting the "first-class part of the contract" claim; rate-limit, WebSocket, and SSE
   fixture coverage is thin.
2. **No adoption on-ramp:** no deployed hello-world path, no scaffold, placeholder install
   commands, two broken example dependencies, missing `py.typed`, arbitrary-looking
   Python 3.14/Node 24 floors.
3. **Observability oversold:** P2 metric/span hooks have no shipped sink, no request duration
   measured, no trace propagation.
4. **Runtime consumers inherit the CDK:** root `go.mod` directly requires awscdk/jsii because
   `cdk-go/` shares the module.
5. **One-path violations in the runtime:** dual error types, divergent typed-handler error
   envelopes, three JSON-body paths, silent (fail-open) route registration, no canonical
   validation vocabulary.
6. **Verification machinery gaps:** no fixture JSON Schema, tier list hardcoded ×3, TS gates
   validate committed `ts/dist` with no drift check, no single-fixture runner, rubric runs
   contract tests twice, version-alignment misses release-please `extra-files`, cdk-go has no
   regeneration drift gate.
7. **Doc contradictions and gaps:** stale fixture counts (128 vs 145) and "Pre-1.0" status,
   referenced-but-missing doc surfaces, no operator docs / UPGRADING / llms.txt, no Python
   docstrings, hand-written API maps with no drift gate, CDK README omits ~15 constructs.

## Users and beneficiaries

- **Framework adopters** (new Theory Cloud users) — on-ramp, floors, typed handlers, docs.
- **Operators of deployed apps** (incl. Pay Theory production) — observability, CDK
  production props (log retention, VPC, alias/canary, WAF, dashboards), operator docs.
- **TS/Python application authors** — MCP/OAuth parity, `py.typed`, docstrings, typed APIs.
- **Contributors & the steward** — fixture schema, single-fixture runner, drift gates,
  rubric de-dup, mega-file splits, script documentation.

## Success criteria (observable)

1. `contract-tests/fixtures/` contains MCP, OAuth, and objectstore fixture tiers, and all
   three runners pass them; a TS and a Python MCP example server exist under `examples/mcp/`
   and pass the same fixtures the Go one does.
2. A new user can go from clean machine to a deployed, `curl`-able hello-world in each language
   by following one doc page, with copy-pasteable commands (no `X.Y.Z` placeholders); the two
   broken examples `npm install` cleanly.
3. CI matrix proves the lowered **Python** floor (target 3.12, or wherever
   TableTheory/toolchain constraints actually bind) and **Node** floor (target 20 LTS, matching
   TableTheory's 2026-07 `Support Node 20 LTS` plan) green on unit + contract tests.
4. P2 emits request duration; a first-party CloudWatch EMF metrics sink ships; `traceparent`/
   `X-Amzn-Trace-Id` are extracted and `TraceID` populates in the error envelope — all
   fixture-pinned across three runtimes.
5. `go mod graph` for a runtime-only consumer shows no awscdk/jsii/constructs; `cdk-go` is a
   nested module with its own `go.mod`, covered by version alignment and a regeneration drift
   gate.
6. One canonical error type + envelope and one canonical typed-handler/validation path are
   fixture-pinned (incl. a 422 field-error envelope); legacy surfaces are formally deprecated
   but unbroken (additive + deprecate; envelope-moving breaks deferred to a planned major).
   Fluent route registration fails closed.
7. `fixture.schema.json` exists and every runner validates fixtures against it; tier
   directories are globbed, not hardcoded; each runner accepts `--id`; TS contract/snapshot
   gates build from `ts/src` or fail on dist drift; `verify-version-alignment.sh` covers
   `cdk/.jsii` + example lockfiles; rubric runs contract tests once.
8. `make rubric` passes with: fixture counts generated (not hand-written), status/version
   claims corrected, `py.typed` shipped + pyright in the lint gate, `llms.txt` present,
   `cdk/README.md` complete, operator + UPGRADING docs in nav.

## Contract impact

**Yes — additive growth** (no breaking changes in this program):

- New fixture tiers: MCP, OAuth, objectstore, validation/422 envelope, observability
  (duration/EMF/trace), fail-closed registration, backfill for rate-limit/WebSocket/SSE.
- New construct surface: domain/CORS on `AppTheoryHttpApi`, `CfnWebACLAssociation`,
  `logRetention`, VPC props, alias/provisioned-concurrency/canary, observability construct.
- New runtime surface in TS/Py: MCP + OAuth + objectstore implementations; generic typed
  handlers.
- Structural (consumer-visible, non-breaking at the API level): nested `cdk-go` module —
  ships with migration note.
- Explicitly **not** breaking: legacy error codes/`JSONHandler`/lenient registration remain
  functional behind deprecation notices; envelope convergence completes in a future major.

## Nearest existing surface

Most growth composes what already exists: `AppTheoryCertificate`/`ApiDomain` (compose into
HttpApi), `pkg/observability` ProfileLogger (extend with EMF sink), `BindHandler`
(host for validation vocabulary), Go `runtime/mcp` + `runtime/oauth` (behavioral source for
fixtures — but fixtures arbitrate, not Go), api-snapshot gate pattern (template for dist/cdk-go
drift gates), testkit builders (template for MCP/OAuth test doubles in TS/Py).

## Out of scope

- **Registry publishing (npm/PyPI)** — GitHub-Releases-only invariant stands; friction is
  reduced within it (download commands, integrity hash, Renovate datasource docs).
- **Full OTel SDK integration** — only trace-context propagation ships now.
- **Escape hatches, new tiers (no P1.5), second entry points, per-route middleware ordering.**
- **Release-train loosening** — release bash consolidation is opportunistic docs/dedup only.
- **FaceTheory/TableTheory changes** — anything cross-layer goes through their stewards.

## Open questions

1. Exact Python/Node floor support is verified empirically by the CI-matrix change, not
   assumed; targets are Python 3.12 and Node 20 LTS, aligned with TableTheory's 2026-07
   floors-and-install roadmap.
2. Whether the planned major (envelope convergence completion) is scheduled now or after this
   program ships — deferred to roadmap planning.
3. Whether the scaffold/init generator ultimately belongs in AppTheory or in `theory-cli` —
   this program ships AppTheory-owned templates + generator; theory-cli integration is a
   cross-steward conversation.
