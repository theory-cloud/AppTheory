# AppTheory — Product Improvement Analysis

**Date:** 2026-07-02 · **Baseline:** `staging` @ `552b84ed` (v1.14.0, post-M16 corrective MicroVM release)
**Author:** AppTheory steward agent

This document is a whole-framework assessment of how AppTheory can become a stronger and more
usable product. It was produced from a full-surface analysis of the Go, TypeScript, and Python
runtimes, the CDK deployment surface, the contract-test and release machinery, and the
documentation/onboarding experience.

Every recommendation here is framed **inside** the single-path, contract-first philosophy.
"Improve" never means "add a second way." It means one of three things:

1. **Complete the single path** where it is currently unfinished (a capability the contract
   promises but a runtime or construct doesn't deliver).
2. **Harden the enforcement machinery** so the covenant actually covers what the product claims.
3. **Remove friction** for adopters and contributors without weakening any invariant.

Where a finding touches a deliberate invariant (GitHub-Releases-only distribution, tier model,
one entry point), the recommendation preserves the invariant and says so explicitly.

---

## Executive summary

AppTheory's core is genuinely strong: three peer runtimes, 145 cross-language contract fixtures
run on every commit, a deterministic testkit in all three languages, a disciplined release train,
and clean code (zero TODO/FIXME markers across ~66k lines of runtime source). The problems are
not rot — they are **gaps between what the product claims and what the contract actually
enforces**, and **adoption friction** that keeps the strong core from being experienced.

The five most consequential findings, in order:

1. **The covenant doesn't cover the headline features.** MCP, OAuth, and objectstore have
   **zero contract fixtures** and exist **only in Go** — despite the README calling MCP "a
   first-class part of the contract." This is the largest identity-level gap in the product.
2. **There is no path to a deployed hello-world.** The getting-started guide ends at an
   in-memory test invocation; the CDK guide ends at synth. No scaffold/init command exists.
   Install instructions use literal `X.Y.Z` placeholders with no download command.
3. **P2 observability is thinner than advertised.** Metric and span hooks are interfaces with
   no shipped sink, no request latency is ever measured, and there is no OTel/X-Ray/EMF bridge.
4. **Runtime consumers inherit the CDK.** The root Go module directly requires
   `aws-cdk-go/awscdk/v2`, `jsii-runtime-go`, and `constructs` — a hello-world HTTP service
   pulls the entire CDK/jsii dependency tree.
5. **The single path has internal forks.** Two exported error types, two typed-handler helpers
   emitting *different* error envelopes, three ways to read a JSON body, and silent route-
   registration failure — one-path violations inside the framework's own runtime.

---

## 1. Close the contract-coverage gap on MCP, OAuth, and objectstore

**This is the top priority.** The framework's identity is "behavioral parity enforced by shared
fixtures," and its most differentiated features sit outside that enforcement.

### Findings

- **MCP is Go-only.** `runtime/mcp/` is ~5k lines (25 files: server, JSON-RPC, tools,
  resources, prompts, sessions, resumable SSE, DynamoDB task/stream stores). TypeScript and
  Python contain **no MCP implementation at all** — they only hard-reserve the routes
  (`ts/src/internal/aws-http.ts:126-129`, `py/src/apptheory/aws_http.py:16-19`). A TS or
  Python author cannot build an MCP server on AppTheory today, and every `examples/mcp/*` is Go.
- **OAuth is Go-only.** `runtime/oauth/` (bearer, DCR, PKCE, RFC 9728 protected-resource
  metadata) has no TS/Python counterpart behind the reserved `/.well-known/...` paths.
- **Zero fixtures for all three surfaces.** Of the 145 fixtures, none exercise MCP protocol
  behavior, OAuth, or `pkg/objectstore`. The only MCP-adjacent fixtures
  (`m3/apigw-proxy-remote-mcp-*`) test trailing-slash proxy routing, not MCP. Coverage is also
  thin for rate limiting (3 fixtures), WebSockets (5, happy-path), and SSE edge behavior
  (no client-disconnect, backpressure, or heartbeat fixtures).
- Meanwhile MicroVM has 17 fixtures (m15+m16) — recent investment skewed there while the
  MCP/OAuth parity debt sat untracked.

### Recommendations

1. **Decide and document the parity stance per surface.** Either MCP/OAuth are
   contract-covered three-runtime surfaces (then fixtures come first, then TS/Python
   implementations follow, milestone-style), or they are **documented as Go-only** in the
   README, docs, and API-reference — today the README's "first-class part of the contract"
   claim is not true in the contract's own terms. Honesty is cheaper than parity; parity is
   more valuable. Do one deliberately.
2. If parity is chosen, sequence it fixture-first: pin the MCP method surface
   (initialize/tools/resources/prompts/session lifecycle/SSE resumption) and the OAuth
   discovery + bearer validation behavior as fixtures, verify they fail correctly in TS/Py,
   then implement. The Go implementation arbitrates nothing; the fixtures do.
3. **Backfill thin areas regardless:** rate-limit window/strategy fixtures, WebSocket
   auth-on-connect and management-client-failure fixtures, SSE disconnect/heartbeat fixtures.

---

## 2. Build the on-ramp: deployed hello-world, scaffold, real install commands

### Findings

- **No documented path reaches a running service.** `docs/getting-started.md` ends at a
  testkit in-memory invocation (a unit test); `docs/cdk/getting-started.md` ends at
  `verify-cdk-synth.sh`. `cdk bootstrap` is mentioned nowhere in `docs/`. The smallest
  deployable example is the multilang demo — 3 Lambdas + SQS + EventBridge + DynamoDB Streams
  + WebSockets — far too heavy for a first touch. A realistic first deploy is ~8–10 manual
  steps stitched across three documents.
- **Install instructions are placeholders.** `README.md:52-60`, both runtime pages, and the
  CDK getting-started all say `npm i ./theory-cloud-apptheory-X.Y.Z.tgz` /
  `pip install ./apptheory-X.Y.Z-*.whl` with a literal `X.Y.Z` and no `gh release download`
  or `curl` command, and no checksum-verification step.
- **No scaffold exists.** No `theory app init`, no template repo, no generator. The only
  shipped CLI is `cmd/lift-migrate`. (`docs/planning/app-integration/M0.md` anticipates a
  `theory app` integration — it is planned, not shipped.)
- **Two examples are broken at `npm install`:** `examples/cdk/sqs-queue/package.json:12` and
  `examples/cdk/lambda-role/package.json:12` declare `"@theory-cloud/apptheory-cdk": "file:../../.."`,
  which resolves to the repo root — which has no `package.json`. All examples use `file:` deps,
  so none are copy-out-and-run for an external adopter without rewriting the dependency.
- **Version floors block adoption and appear technically arbitrary.** Python `>=3.14`
  (`py/pyproject.toml:8`) and Node `>=24` (`ts/package.json:68-70`) exclude most enterprise
  environments. The Python source uses nothing newer than 3.10 syntax (`match`/`case` plus
  `from __future__ import annotations`) — the floor could plausibly drop to 3.11/3.12 with a
  CI matrix proving it, dramatically widening the addressable audience.

### Recommendations

1. **Ship a single-Lambda hello-world example** (one function, one `AppTheoryHttpApi`) with a
   README that goes clone → install → `cdk bootstrap` → `cdk deploy` → `curl` — in each of the
   three languages. Extend `docs/cdk/getting-started.md` past synth to deploy.
2. **Replace every `X.Y.Z` placeholder** with a copy-pasteable, version-resolving command
   (e.g. `gh release download --repo theory-cloud/AppTheory --pattern '*.tgz'`) plus the
   checksum-verification step. This preserves the GitHub-Releases-only invariant while
   removing most of its friction.
3. **Build the scaffold** — a `theory app init`-style generator (or template repos) producing
   a working app + stack + test per language, wired to a pinned release asset. This is the
   single highest-leverage adoption feature, and it is *more* aligned with single-path than
   docs are: a generator emits the one blessed shape by construction.
4. **Fix the two `file:../../..` example dependencies** (small, immediate).
5. **Re-evaluate the Node/Python floors** with an explicit compatibility policy. If the floors
   stay, document *why*; if they drop, add the older versions to the CI matrix so the claim
   is enforced, not asserted.

### On distribution (invariant, handled carefully)

GitHub-Releases-only distribution is a deliberate invariant — it keeps the three runtimes
version-aligned and the supply chain pinned, and this document does not recommend abandoning
it. But two of its costs deserve mitigation *within* the invariant:

- **Add an integrity hash to the TS TableTheory dependency.** `ts/package.json:25` pins
  TableTheory by GitHub-release URL **without** an integrity hash, while the Python equivalent
  carries `#sha256=…`. That is a supply-chain inconsistency on the exact axis the invariant
  exists to protect. Fix immediately.
- **Document a Renovate/Dependabot story.** URL-pinned release deps are invisible to
  dependency automation; consumers must hand-bump AppTheory and TableTheory in lockstep.
  Ship a documented Renovate custom-datasource config (GitHub releases are a supported
  datasource) so consumers get automated bump PRs without a registry.
- If registry publishing is ever revisited, it is an owner-level contract decision to be made
  explicitly — not something to smuggle in. The friction data above is the input to that
  decision, not a verdict.

---

## 3. Mend the one-path violations inside the runtime

The framework's pitch is "fewer valid shapes." These findings are places where the runtime
itself offers competing shapes or fails open.

### Findings (Go, with TS/Py analogues)

- **Two exported error types.** `AppError` (`runtime/errors.go:11`) and `AppTheoryError`
  (`runtime/portable_error.go:10`) coexist (27 vs 40 internal uses) with conversion helpers
  between them. A newcomer cannot tell which to return.
- **Two typed-handler helpers, two error envelopes.** `JSONHandler` emits Lift-compatible
  `EMPTY_BODY`/`INVALID_JSON` codes (`runtime/json_handler.go:9-12`); `BindHandler` emits
  `app.bad_request`/`app.validation_failed` (`runtime/bind_handler.go:299`). The same
  conceptual operation produces two different client-visible contracts.
- **Three ways to read a JSON body:** `ctx.JSONValue()`, `JSONHandler`, `BindHandler` — each
  with different error behavior.
- **Silent route-registration failure.** The fluent `Get/Post/...` path discards router parse
  and nil-handler errors (`runtime/router.go:92-96`, `runtime/serve.go:24`); a typo'd pattern
  silently registers nothing. Only the `*Strict` variants surface the error. A fail-closed
  framework should not fail open at registration time.
- **No declarative validation vocabulary.** The only hook is a user-supplied
  `Validate func(*Context, Req) error` (`runtime/bind_handler.go:35`), so every app invents
  its own field-error shape — precisely the drift the framework exists to prevent.
- **Tier encoding is a bool.** P1-vs-P2 threads through `servePortable` as `enableP2 bool`
  (`runtime/serve.go:236`) instead of the exported `Tier` type, obscuring where P2-only
  behavior branches.

### Recommendations

1. **Converge on one error type and one envelope**, with fixtures pinning the envelope for
   every framework-emitted error (binding failure, validation failure, panic recovery, 404,
   method-not-allowed). Deprecate the loser explicitly (docs + API snapshot note); if
   Lift-compat codes must survive, they belong behind the existing `WithHTTPErrorFormat`
   option, not a second helper.
2. **Make registration fail closed.** Fluent registration should panic (or collect errors and
   fail `HandleLambda` fast) on an invalid pattern — matching the framework's own fail-closed
   doctrine. The `*Strict` variants then become redundant and can be deprecated: one path.
3. **Design the canonical validation contract.** One declarative vocabulary (struct tags in
   Go, a schema object in TS, annotations in Python), one canonical 422 field-error envelope,
   fixtures first. This is the highest-value *contract growth* opportunity in the runtime: it
   converts today's undefined behavior into enforced sameness, and it is the feature
   generative tools benefit from most.
4. **Then generate the wire contract.** Once `Req`/`Resp` types and validation are canonical,
   OpenAPI generation from typed handlers is nearly free and is exactly what a contract-first
   framework should emit. (Fixture-pinned output format.)
5. **Typed-handler parity for TS/Python.** TS handlers today are `(ctx) => Response` with
   `jsonValue(): unknown`, `param(): string` (`ts/src/context.ts:129,182,206,229`); Python
   mirrors this (`py/src/apptheory/context.py:109-138`). Introduce the *single* generic
   handler shape per language (`jsonValue<T>()`, typed params/body) matching Go's
   `BindHandler` semantics, fixture-verified.

---

## 4. Make P2 observability real

### Findings

- `recordObservability` (`runtime/observability.go:48-100`) invokes user-supplied `Log`,
  `Metric`, `Span` hooks — but **no first-party Metric or Span sink exists anywhere in the
  module**. Both bridge helpers (`pkg/observability/hooks_apptheory.go:10-35`,
  `profile_logger.go:190-196`) wire only `Log`.
- **No request latency is ever measured** — the record carries method/path/status/error_code
  but no duration, so even a custom Metric sink cannot emit a latency metric.
- `SpanRecord` is a post-completion record, not a span: no start/stop, no `traceparent` or
  `X-Amzn-Trace-Id` extraction, no propagation. `AppTheoryError.TraceID` is never populated.
- No OTel, X-Ray, EMF, or Prometheus support anywhere. Structured logging, by contrast, is
  genuinely production-grade (`pkg/observability` ProfileLogger + zap adapter + SNS notifier).
- README markets P2 as "+observability hooks, rate limiting" — the hooks exist; the batteries
  do not. Fixture coverage is correspondingly thin (1 observability-basic fixture).

### Recommendations

1. **Add duration to the observability record** (clock is already injectable — deterministic
   fixtures can pin it). Small change, unlocks everything downstream.
2. **Ship one blessed metrics sink: CloudWatch EMF.** EMF is emit-to-stdout, zero-dependency,
   Lambda-native, and deterministic enough to fixture (JSON log lines). One sink, not a
   plugin system — single path.
3. **Extract and propagate trace context** (W3C `traceparent` + `X-Amzn-Trace-Id`) into the
   request context and populate `TraceID` in the error envelope. Full OTel SDK integration
   can be a later contract decision; trace *propagation* is table stakes now.
4. **Pin all of it with fixtures** (P2 tier), so TS/Python parity is enforced, not hoped.
5. Until then, **correct the docs** to say hooks-with-logging-batteries, metrics/tracing
   bring-your-own — the current framing oversells.

---

## 5. Unbundle the CDK from the runtime Go module

### Findings

- The **root** `go.mod` directly requires `aws-cdk-go/awscdk/v2 v2.254.0`,
  `jsii-runtime-go`, and `constructs` (go.mod:6,16-17) because `cdk-go/` lives in the same
  module. Every Go consumer of the *runtime* — a hello-world HTTP handler — transitively
  inherits the CDK/jsii tree in `go.sum`, larger builds, and CDK CVE surface in their scans.
- `cdk-go/` (206 generated files, ~1.5 MB) is regenerated **by hand** via
  `scripts/update-cdk-generated.sh`, and CI has **no drift gate**: `generated_sync_test.go`
  checks version markers and the embedded tarball name only; nothing re-runs `jsii-pacmak`
  and diffs. A TS construct change can ship with stale Go bindings.

### Recommendations

1. **Split `cdk-go` into a nested Go module** (`cdk-go/go.mod`) so runtime consumers stop
   inheriting CDK/jsii. This is a consumer-visible change (import path unchanged, but a
   separate `go get`) — it needs a migration note and a release-train entry, and the
   version-alignment machinery must learn the second module. High value: it makes the runtime
   as light as it claims to be.
2. **Add a `cdk-go` drift gate to CI:** run `update-cdk-generated.sh` and fail on
   `git diff --exit-code cdk-go/` in the rubric. Same class of gate as API snapshots — the
   machinery pattern already exists.

---

## 6. Complete the CDK deployment story (grow constructs, don't bypass)

The construct surface is broad (~40 constructs) but the flagship constructs are missing knobs
that force users toward exactly the "drop to raw CDK" move the framework forbids.

### Findings

- **`AppTheoryHttpApi` has no custom-domain, CORS, or authorizer props at all**
  (`cdk/lib/http-api.ts:6-9` — props are `handler` + `apiName`). `AppTheoryApp` accepts only a
  pre-existing `certificateArn` (`cdk/lib/app.ts:130-143`) even though `AppTheoryCertificate`
  (auto DNS-validated ACM) exists in the same package. The primitives exist; the flagships
  don't compose them.
- **Regional WAF cannot attach.** `AppTheoryEnhancedSecurity` builds a REGIONAL `CfnWebACL`
  (`cdk/lib/enhanced-security.ts:512-513`) but no `CfnWebACLAssociation` exists anywhere —
  the ACL can't be bound to an API stage through the blessed surface.
- **No Lambda log-retention control** on `AppTheoryFunction`/`AppTheoryApp` (log groups
  default to never-expire — a real cost/compliance issue), **no first-class VPC props**
  (only via the all-or-nothing EnhancedSecurity bundle or raw `FunctionProps` passthrough),
  **no alias/version/provisioned-concurrency, hence no canary/blue-green path**
  (no CodeDeploy anywhere), **no SNS or Step Functions constructs**, no dashboard construct,
  and alarms stop at Errors+Throttles with no alarm-action wiring.
- **`cdk/README.md` omits ~15 shipped constructs** (entire MCP family, all MicroVM constructs,
  S3Ingest, JobsTable, EnhancedSecurity, cert/zone/domain, CWL constructs).
- jsii builds Python bindings (`apptheory-cdk` wheel, release-asset only) — fine — but the
  reproducibility scripts around it (`verify-cdk-python-build.sh`) are heavy hand-rolled bash
  worth consolidating over time.

### Recommendations (all construct growth, no bypasses)

1. Compose **domain + auto-cert + CORS** into `AppTheoryHttpApi`/`AppTheoryApp` props.
2. Add the **`CfnWebACLAssociation` path** so the regional WAF the package already builds can
   attach to API stages.
3. Add **`logRetention`** (default it to a sane finite value) and **first-class `vpc` props**
   on `AppTheoryFunction`/`AppTheoryApp`.
4. Add **alias + provisioned concurrency + CodeDeploy canary** as construct props — this is
   the standard production-Lambda deployment pattern and its absence is the biggest gap
   between AppTheory and "production-grade deployment surface."
5. Add an **observability construct** (dashboard + latency/duration alarms + SNS alarm
   actions) pairing with the P2 runtime work in §4.
6. Regenerate `cdk/README.md` from the export list (or from `.jsii`) so it cannot drift.

---

## 7. Harden the verification machinery itself

The covenant's enforcement tooling has gaps that undercut the guarantees it exists to provide.

### Findings

- **No JSON Schema for fixtures.** The fixture format is defined by prose
  (`contract-tests/fixtures/README.md`) plus three hand-maintained parsers (Go structs,
  `run.py` dicts, `run.cjs` objects). A malformed fixture is caught only if a runner happens
  to choke on it.
- **The tier list is hardcoded in three places** (`contract-tests/runners/go/fixture.go`,
  `run.py:61`, `run.cjs:146`). A new tier directory added without editing all three runners
  **silently doesn't run** — the worst possible failure mode for a covenant.
- **TS gates validate a committed build artifact.** The TS contract runner and
  `generate-api-snapshots.sh:21` consume `ts/dist/*` — which is committed, never rebuilt in
  the contract-tests CI job, and has **no drift check** (`git diff --exit-code` appears in no
  verify script for `ts/dist`). Stale dist = green gates on stale code. Also: dist ships with
  `sourceMap`/`declarationMap` disabled, so consumers debug compiled JS blind.
- **No single-fixture runner, no watch mode.** All three runners accept only a fixtures root —
  no `--id` filter. TDD on one fixture across three runtimes requires hand-building a
  throwaway directory tree.
- **`make rubric` runs contract tests effectively twice** (once in `gov_cmd_unit`, again via
  `verify-contract-tests.sh`) with multiple cold `npm ci` runs; CI jobs have no dependency
  caching.
- **`verify-version-alignment.sh` doesn't check everything release-please rewrites:**
  `cdk/.jsii` and three example lockfiles are in both release-please configs' `extra-files`
  but not in the alignment gate. The 13-entry `extra-files` list is also duplicated across the
  stable and premain configs — a drift hazard.
- **Fixture directories are named by milestone** (`m1`…`m16`), not behavior. `m14` means
  nothing to an adopter reading the covenant; "streaming/", "websockets/", "microvm/" would.
- 59 of 62 `scripts/*.sh` have no header comment; the release-verification cluster is ~5,000
  lines of overlapping bash across ~15 scripts (`verify-release-state` vs
  `diagnose-release-state`, two postcondition scripts, etc.).

### Recommendations

1. **Author `contract-tests/fixtures/fixture.schema.json`** and validate every fixture in all
   three runners (and in a standalone `verify-fixture-schema.sh` rubric step). The schema
   *is* the covenant's covenant.
2. **Glob tier directories** instead of hardcoding the list — removes a three-way silent-drop
   drift surface with a trivial change.
3. **Rebuild `ts/src` before the TS contract and snapshot gates**, or add an explicit
   dist-drift check (`npm run build && git diff --exit-code ts/dist`). Enable declaration/source
   maps in the published dist.
4. **Add `--id`/`--filter` to all three runners** plus a `make contract-one ID=...` target;
   optional watch mode after. Small change, large TDD payoff — and it lowers the cost of the
   fixture-first discipline this document keeps prescribing.
5. **De-duplicate rubric contract runs and add CI dependency caching** (Go modules, npm, uv).
6. **Extend `verify-version-alignment.sh`** to cover `cdk/.jsii` and the example lockfiles;
   generate or cross-check the two release-please `extra-files` lists from one source.
7. **Rename fixture directories by behavior domain** (keep milestone in fixture metadata).
   Mechanical, improves the covenant's legibility to adopters and to generative tools.
8. **One header comment per script**, and consolidate the release-bash cluster opportunistically
   (don't rewrite it for its own sake; it works and is release-critical).

---

## 8. Documentation: fix the contradictions, then fill the operator-facing gaps

### Findings

- **Fixture-count drift:** actual count 145; "128" survives in `README.md:66,118,147`,
  `docs/_data/site-meta.yml:28`, `docs/features/http-runtime.md:161`, `docs/runtimes/go.md:171`
  — including body-says-145/footer-says-128 contradictions on single pages.
- **Status drift:** `README.md:72` says "Pre-1.0" while the repo is on a v1.x release train
  and ships a "v1.0 Security Migration Guide"; two planning docs still say "0.x".
- **Referenced-but-nonexistent surfaces:** `docs/llm-faq/**`, `docs/internal/**`,
  `docs/archive/**` are referenced from `docs/README.md` but do not exist. No `llms.txt`
  exists despite "generative-coding friendly" positioning and `AI Training` annotations.
- **Troubleshooting is contributor-facing only** — it maps repo-gate failures to verify
  scripts; there is nothing for *operators of deployed apps* (cold starts, IAM failures,
  event-shape mismatches, CORS debugging, 500-envelope interpretation). No cost/alarming/
  runbook guidance despite "used in production by Pay Theory."
- **No version-to-version upgrade guides** — migration docs cover only Lift→AppTheory and the
  one-time v1.0 security cutover; the 666KB generated CHANGELOG is not a substitute.
- **Four hand-written API maps** (`docs/api-reference.md` + per-package `ts|py|cdk/docs/README.md`)
  have no drift gate, unlike the snapshots they mirror.
- ~60 planning/roadmap docs ship inside the published `docs/` tree as declared "non-canonical"
  content; Python core modules have essentially zero docstrings (~9 docstrings across ~932
  defs), so IDE hover is empty; `py.typed` is missing entirely, so consumers' type checkers
  ignore all shipped Python hints (PEP 561), and no mypy/pyright runs in CI to verify them.

### Recommendations

1. **Generate the fixture count** into README/docs from `find contract-tests/fixtures -name '*.json' | wc -l`
   (docs build step or a verify script) — the number has now drifted twice; stop hand-writing it.
2. Sweep the six stale "128" spots and the three "pre-1.0/0.x" claims now (one small PR).
3. **Ship `py.typed` + wire pyright/mypy into the Python lint gate.** The hints exist; today
   they are invisible downstream and unverified internally. Cheapest high-value fix in the repo.
4. Add docstrings to the Python core modules (context/app/router/response/request) and JSDoc
   to the TS equivalents — this is the hover/IntelliSense surface adopters actually touch.
5. Create `llms.txt` (+ the referenced `docs/llm-faq/` or remove the references). For a
   framework whose pitch is generative-coding consistency, being legible to coding agents is
   product surface, not garnish.
6. Add an **operator guide** (debugging deployed apps, cost, alarms — paired with §4/§6
   observability work) and an **UPGRADING.md** maintained per release line.
7. Move the planning corpus out of the published docs tree (or into an excluded directory).

---

## 9. Maintainability hotspots (contributor experience)

- **Mega-files:** `ts/src/microvm.ts` (7,368 lines), `py/src/apptheory/microvm.py` (5,525),
  `runtime/mcp/server.go` (1,640), `ts/src/app.ts` (2,123), `runtime/aws_eventsources.go`
  (929, all event sources + dispatch in one file). Split along the module boundaries the Go
  runtime already uses (`runtime/microvm/` is 14 files; TS/Py should mirror that shape).
  Mechanical, no contract impact, big review/onboarding payoff.
- **`ts/package.json` carries a six-package `overrides` block** hand-pinning transitive deps —
  worth revisiting each dependency-refresh cycle so consumers don't inherit stale pins.
- The `enableP2 bool` threading (§3) and dual error types (§3) are also maintainability debt,
  already covered above.

---

## Prioritized roadmap

| # | Improvement | Impact | Effort | Type |
|---|---|---|---|---|
| 1 | Fix doc contradictions (fixture count, pre-1.0, broken example deps, TS dep integrity hash) | High (credibility) | Hours | Fix |
| 2 | `py.typed` + pyright in CI; TS dist drift gate + source maps | High | Days | Fix |
| 3 | Deployed hello-world example + real install commands + `cdk bootstrap` docs | Very high (adoption) | Days | DX |
| 4 | Fixture JSON Schema + glob tiers + `--id` runner filter | High (covenant integrity) | Days | Harden |
| 5 | Decide MCP/OAuth parity stance; if parity → fixture-first milestone | Very high (identity) | Weeks | Contract growth |
| 6 | Error-type/envelope convergence + fail-closed route registration | High (one-path) | ~1 week | Contract growth |
| 7 | Observability: duration + EMF sink + trace propagation, fixture-pinned | High | ~2 weeks | Contract growth |
| 8 | Canonical validation vocabulary + 422 envelope (then OpenAPI generation) | Very high (DX) | Weeks | Contract growth |
| 9 | Split `cdk-go` into nested module + cdk-go drift gate | High (consumer weight) | ~1 week | Structural |
| 10 | Flagship CDK props: domain/CORS on HttpApi, WAF association, logRetention, VPC, alias/canary | High (production readiness) | Weeks (incremental) | Contract growth |
| 11 | Scaffold / `theory app init` generator | Very high (adoption) | Weeks | DX |
| 12 | Version-floor re-evaluation with CI matrix | High (adoption) | Days–weeks | Policy |
| 13 | Rubric de-dup + CI caching; version-alignment covers `extra-files` | Medium | Days | Harden |
| 14 | Behavior-named fixture directories; script headers; mega-file splits | Medium | Incremental | Maintainability |
| 15 | Operator docs, UPGRADING.md, llms.txt, Python docstrings | Medium–high | Incremental | Docs |

## What this document deliberately does not recommend

- **No registry publishing by default.** GitHub-Releases-only is an invariant; §2 reduces its
  friction without breaking it. Revisiting it is an explicit owner decision.
- **No escape hatches, no P1.5, no second entry point, no per-route middleware reordering.**
  Every runtime gap above is closed by growing the single path (fixtures first), never by
  adding a parallel one.
- **No weakening of the release train, signing, hooks, or immutability rules.** The release
  machinery should be consolidated and documented, not loosened.

---

*Verification basis: five parallel full-surface explorations (Go runtime; TS/Python runtimes;
CDK; contract/CI machinery; docs) with headline claims independently re-verified against the
tree (go.mod direct CDK requires; absence of MCP/OAuth in `ts/src` and `py/src/apptheory`;
`file:../../..` example deps; missing `py.typed`; 145 fixtures vs README's three "128" cites).*
