# Linear Project: AppTheory Strengthening Program (2026-07)

## Project description
Deliver the full strengthening program: make the contract covenant actually cover the marketed surface (MCP, OAuth, objectstore in all three runtimes), close the one-path violations inside the runtime (errors, registration, binding, validation, OpenAPI), make P2 observability real (duration, EMF, trace propagation), complete the CDK production deployment story on a runtime module that no longer drags the CDK with it, and build the adoption on-ramp (deployed hello-world, scaffold, honest install commands, lowered Python floor) — all additively, with every release a minor, and every contract-visible behavior pinned fixture-first.

## Creation mode
- Linear MCP tools are available; no Linear CLI is installed.
- Target team: `Theorycloud` (`THE`).
- External Linear mutation completed on 2026-07-02 after user confirmation.
- Source branch: `project/improvement-program`.

## Created Linear state
- Project: [`AppTheory Strengthening Program (2026-07)`](https://linear.app/theorycloud/project/apptheory-strengthening-program-2026-07-34b95819ec60)
- Project ID: `4b7d0ee0-7be5-4bb5-aa27-c471c88d3b5c`
- Team: `Theorycloud` (`THE`, `3bc3ab6d-82c3-4aca-a8e2-c769eb4060a7`)
- Created shape: 17 milestones, 106 issues, labels applied, and roadmap dependency blockers linked in Linear.
- Milestone IDs:
  - `SP01 Credibility Sweep`: `19ba41b4-732b-469f-8d8d-96a6fcda11b7`
  - `SP02 Type Truth & Drift Gates`: `47f98d5b-f9d3-4163-8f5b-f23aa82ffb8c`
  - `SP03 Release & Fixture Machinery`: `301cd1c4-267c-45d4-8312-eea6b00686de`
  - `SP04 Canonical Errors & Fail-Closed Registration`: `262360e1-88c8-4083-bb96-1981f6e1ebeb`
  - `SP05 Canonical Typed Handlers & Validation`: `81d1acbc-ca80-466c-863a-1491863e4676`
  - `SP06 OpenAPI from the Contract`: `9f6ae890-f599-4978-8939-de9e8c66e92c`
  - `SP07 Duration & EMF Metrics`: `2b86ea58-5262-482a-b7e5-732be92e149f`
  - `SP08 Trace Propagation & Fixture Backfill`: `51fc1adf-726e-46b3-bd03-d8571c35db8b`
  - `SP09 MCP Contract Truth`: `f84a6658-4a3a-4a3a-819f-eb102a84b0b8`
  - `SP10 MCP TypeScript Runtime`: `0e905e03-0190-485a-8391-3b9f195d3116`
  - `SP11 MCP Python Runtime`: `3108654d-7ccc-43ef-9276-3a1476531c7b`
  - `SP12 OAuth Parity`: `bb170e3e-c695-4db4-aa4e-30bb78b16c21`
  - `SP13 Object Store Parity`: `bfc3d312-84e3-410f-aded-5f45895a10a9`
  - `SP14 Production Deployment Surface`: `33470ff2-b3b2-4fae-a9a4-ef0bfd799413`
  - `SP15 On-Ramp`: `d5fddee0-e17e-49e2-9f03-c4d3b74fd5fe`
  - `SP16 Operator & Upgrade Docs`: `3c89a3df-02e2-4dcc-870d-14bd990adda5`
  - `SP17 Codebase Decomposition`: `a7bda547-a985-42eb-9d88-3cf788549b17`

## Milestones

### Milestone: SP01 Credibility Sweep
**Goal**: every user-facing claim (fixture counts, release status, install commands, example dependencies, dependency integrity) becomes true.
**Phase**: Phase 1: Foundation — gates, hygiene, floors (SP01–SP03, items 1–17 + 94)
**Depends on**: none — can start immediately.

**Issues** (in order):
1. **Correct stale fixture-count and release-status claims** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP01 Credibility Sweep
   - Enumerated item: #1 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `README.md`, `docs/_data/site-meta.yml`, `docs/features/http-runtime.md`, `docs/runtimes/go.md`, `docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md`, `docs/development/migration/lift-deprecation.md`
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: no "128"-fixture or "Pre-1.0"/"0.x" claim remains in user-facing docs; all counts read 145 (until item 2 makes them generated).
   - Validation: `grep -rn '128-fixture\|Pre-1.0' README.md docs/` returns nothing
   - Commit subject: `docs: correct fixture-count and release-status claims`
2. **Gate fixture-count claims on the actual corpus** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP01 Credibility Sweep
   - Enumerated item: #2 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `scripts/verify-fixture-count.sh` (new), rubric wiring in `scripts/verify-rubric.sh`/`gov-infra`, count markers in `README.md` + docs pages
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: a rubric step fails if any documented fixture count differs from `find contract-tests/fixtures -name '*.json' | wc -l`.
   - Validation: `./scripts/verify-fixture-count.sh`
   - Commit subject: `chore(docs): gate documented fixture counts on the fixture corpus`
3. **Fix broken example CDK dependencies** — [`apptheory`, `example`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP01 Credibility Sweep
   - Enumerated item: #3 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `examples/cdk/sqs-queue/package.json` (+lock), `examples/cdk/lambda-role/package.json` (+lock)
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: `file:../../..` → `file:../../../cdk`; `npm ci` succeeds in both examples.
   - Validation: `cd examples/cdk/sqs-queue && npm ci` (and lambda-role)
   - Commit subject: `fix(examples): point sqs-queue and lambda-role at the cdk package`
4. **Pin the TS TableTheory dependency with an integrity hash** — [`apptheory`, `runtime:ts`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP01 Credibility Sweep
   - Enumerated item: #4 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/package.json:25`, `ts/package-lock.json`
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: the GitHub-release URL dependency carries a verifiable integrity value (npm `integrity` in lockfile confirmed pinned), matching the Python wheel's `#sha256=` posture.
   - Validation: `cd ts && npm ci && npm test`
   - Commit subject: `fix(ts): pin the tabletheory release dependency with an integrity hash`
5. **Replace placeholder installs with resolvable commands** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP01 Credibility Sweep
   - Enumerated item: #5 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `README.md`, `docs/runtimes/typescript.md`, `docs/runtimes/python.md`, `docs/cdk/getting-started.md`
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: every install block is copy-pasteable (`gh release download` with pattern + checksum verification step); no literal `X.Y.Z` remains.
   - Validation: follow the TS instructions verbatim on a clean directory
   - Commit subject: `docs: replace placeholder installs with release-download commands`

### Milestone: SP02 Type Truth & Drift Gates
**Goal**: consumers see the Python types that already exist, and the TS build output can no longer silently drift from source.
**Phase**: Phase 1: Foundation — gates, hygiene, floors (SP01–SP03, items 1–17 + 94)
**Depends on**: none (parallel with SP01).

**Issues** (in order):
1. **Ship `py.typed`** — [`apptheory`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #6 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/py.typed` (new), `py/pyproject.toml` package-data
   - Runtime scope: py
   - Contract impact: internal-only (no exported symbol change; wheel contents change)
   - Acceptance: built wheel contains `apptheory/py.typed`; a consumer pyright run resolves AppTheory types.
   - Validation: `./scripts/verify-python-build.sh` and inspect wheel
   - Commit subject: `feat(py): ship py.typed so consumers see the type hints`
2. **Add pyright to the Python lint gate** — [`apptheory`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #7 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/pyproject.toml`, `scripts/verify-python-lint.sh`, `Makefile`, annotation fixes across `py/src/**` (e.g. `context.py:103,174,255` missing return types)
   - Runtime scope: py
   - Contract impact: internal-only
   - Acceptance: `make lint` runs pyright (basic mode) green over `py/src`.
   - Validation: `make lint`
   - Commit subject: `chore(py): add pyright to the lint gate and repair surfaced annotations`
3. **Ship TS source maps and gate `ts/dist` against drift** — [`apptheory`, `runtime:ts`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #8 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/tsconfig.json` (`sourceMap`/`declarationMap` on), `ts/dist/**` (regenerated), `scripts/verify-ts-dist-drift.sh` (new), rubric/CI wiring (`.github/workflows/ci.yml`)
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: dist rebuilt from src produces zero `git diff`; the gate fails CI when it doesn't; published dist carries `.map` files. Closes the stale-dist gate-correctness hole (contract runner + snapshot generator consume dist).
   - Validation: `./scripts/verify-ts-dist-drift.sh`
   - Commit subject: `fix(ts): ship source maps and gate ts/dist against drift`
4. **Add a fixture JSON Schema and schema gate** — [`apptheory`, `contract-change`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #9 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/fixture.schema.json` (new), `scripts/verify-fixture-schema.sh` (new), rubric wiring, `contract-tests/fixtures/README.md`
   - Runtime scope: none
   - Contract impact: internal-only (pins the *meta*-contract)
   - Acceptance: all 145 fixtures validate; a deliberately malformed fixture fails the gate.
   - Validation: `./scripts/verify-fixture-schema.sh`
   - Commit subject: `test(contract): add a fixture JSON Schema and schema gate`
5. **Discover fixture tiers by glob in all runners** — [`apptheory`, `contract-change`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #10 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/runners/go/fixture.go`, `contract-tests/runners/py/run.py:61`, `contract-tests/runners/ts/run.cjs:146`
   - Runtime scope: all (runner code)
   - Contract impact: internal-only
   - Acceptance: no hardcoded tier list remains; a new fixture directory is picked up by all three runners without runner edits.
   - Validation: `./scripts/verify-contract-tests.sh` (count of executed fixtures unchanged)
   - Commit subject: `fix(contract): discover fixture tiers by directory glob in all runners`
6. **Run a single fixture by id across all runners** — [`apptheory`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP02 Type Truth & Drift Gates
   - Enumerated item: #11 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: three runners (add `--id`/`--filter`), `Makefile` (`contract-one ID=...`), `CONTRIBUTING.md`
   - Runtime scope: all (runner code)
   - Contract impact: internal-only
   - Acceptance: `make contract-one ID=<fixture-id>` runs exactly that fixture in Go, TS, and Python.
   - Validation: `make contract-one ID=p0-routing-basic` (or equivalent existing id)
   - Commit subject: `test(contract): run a single fixture by id across all runners`

### Milestone: SP03 Release & Fixture Machinery
**Goal**: the covenant's own enforcement machinery stops having blind spots, and the Python floor drops with continuous CI proof.
**Phase**: Phase 1: Foundation — gates, hygiene, floors (SP01–SP03, items 1–17 + 94)
**Depends on**: 17 (tier rename) needs 10 (glob) from SP02; 15 pairs with the existing `update-cdk-generated.sh`.

**Issues** (in order):
1. **De-duplicate contract-test execution in the rubric** — [`apptheory`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #12 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `gov-infra/verifiers/gov-verify-rubric.sh`, `scripts/verify-rubric.sh`
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: one rubric invocation runs each language's contract suite exactly once; `npm ci` count reduced; rubric wall-clock measurably drops.
   - Validation: `make rubric` (inspect log for single contract pass)
   - Commit subject: `chore(rubric): run contract suites once per rubric invocation`
2. **Cache dependencies in CI** — [`apptheory`, `contract-change`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #13 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `.github/workflows/ci.yml` (setup-go/setup-node/uv cache config for go, ts, py, contract-tests jobs)
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: warm-cache CI runs skip cold `npm ci`/module downloads; PR CI time drops.
   - Validation: green CI run showing cache hits
   - Commit subject: `chore(ci): cache go, npm, and uv dependencies`
3. **Align the version gate with release-please extra-files** — [`apptheory`, `cdk`, `example`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #14 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `scripts/verify-version-alignment.sh` (add `cdk/.jsii` `$.version` + `examples/cdk/*/package-lock.json` cdk pins), cross-check that both `release-please-config*.json` extra-files lists match one source
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: every file release-please rewrites is covered by the alignment gate; a deliberate `cdk/.jsii` version skew fails it.
   - Validation: `./scripts/verify-version-alignment.sh`
   - Commit subject: `fix(release): align the version gate with release-please extra-files`
4. **Fail on stale generated `cdk-go` bindings** — [`apptheory`, `cdk`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #15 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `scripts/verify-cdk-go-drift.sh` (new, wraps `update-cdk-generated.sh` + `git diff --exit-code cdk-go/`), rubric/CI wiring
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: a TS construct change without regenerated Go bindings fails the gate.
   - Validation: `./scripts/verify-cdk-go-drift.sh`
   - Commit subject: `chore(ci): fail on stale generated cdk-go bindings`
5. **Add purpose headers to repo scripts** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #16 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `scripts/*.sh` (the 59 headerless files)
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: every script opens with a 1–3 line purpose/invocation comment; no behavior change (release consolidation stays opportunistic per scope).
   - Validation: `make rubric`
   - Commit subject: `docs(scripts): add purpose headers to repo scripts`
6. **Reorganize fixtures by behavior domain** — [`apptheory`, `contract-change`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #17 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/**` (rename `m1..m16`,`p0..p2` → behavior-named dirs; milestone retained as fixture metadata), fixtures README, `docs/reference/contract-fixtures.md`; runners unaffected (item 10's glob)
   - Runtime scope: none
   - Contract impact: internal-only (no fixture behavior changes)
   - Acceptance: directory names describe behavior (routing, middleware, event-sources, websockets, streaming, logging, microvm, ...); fixture count and pass results identical before/after.
   - Validation: `./scripts/verify-contract-tests.sh` + `./scripts/verify-fixture-schema.sh`
   - Commit subject: `test(contract): reorganize fixtures by behavior domain`
7. **Lower the Python and Node floors with CI-matrix proof** — [`apptheory`, `runtime:py`, `runtime:ts`, `cdk`, `docs`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP03 Release & Fixture Machinery
   - Enumerated item: #94 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/pyproject.toml` (`requires-python`, ruff `target-version`), `ts/package.json` + lockfile (`engines.node`), `cdk/package.json` + lockfile (`engines.node`), `.github/workflows/ci.yml` (Python matrix incl. 3.14, Node matrix incl. 20 and 24), `docs/` compatibility policy note; floors set where TableTheory/toolchain actually bind (targets: Python 3.12, Node 20 LTS)
   - Runtime scope: py, ts
   - Contract impact: internal-only
   - Acceptance: unit + contract tests green on every Python and Node matrix version; TypeScript runtime + CDK package metadata both advertise Node `>=20`; the floor claims are enforced, not asserted.
   - Validation: CI matrix green + `./scripts/verify-contract-tests.sh` + `cd ts && npm run check` + `cd cdk && npm test`
   - Commit subject: `feat(platform): support Python 3.12+ and Node 20+`

### Milestone: SP04 Canonical Errors & Fail-Closed Registration
**Goal**: one error envelope for every framework-emitted error, and invalid route registration can no longer fail silently.
**Phase**: Phase 2: One-Path Runtime Convergence (SP04–SP06, items 18–38)
**Depends on**: Phase 1 gates (schema gate validates the new fixture tiers; dist gate guards the TS legs).

**Issues** (in order):
1. **Pin the canonical error envelope for framework-emitted errors** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #18 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/errors/` (new): binding failure, empty body, invalid JSON, panic recovery, 404, method-not-allowed — all asserting the canonical `app.*` envelope; legacy `EMPTY_BODY`/`INVALID_JSON` codes pinned only behind the Lift-compat `HTTPErrorFormat` option
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: fixtures schema-validate and fail for the right reason where runtimes diverge today.
   - Validation: `./scripts/verify-fixture-schema.sh`; suite green after items 19–21
   - Commit subject: `test(contract): pin the canonical error envelope for framework errors`
2. **Converge Go on the canonical error path** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #19 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/errors.go`, `runtime/portable_error.go`, `runtime/json_handler.go` (deprecation notice, codes preserved behind compat format), `runtime/bind_handler.go`, `api-snapshots/go.txt` (same commit), Go error docs
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: `AppTheoryError` is the documented canonical type; `AppError`/`JSONHandler` carry Deprecated markers but behave unchanged; error fixtures pass in Go.
   - Validation: `go run ./contract-tests/runners/go --fixtures contract-tests/fixtures` + `./scripts/update-api-snapshots.sh`
   - Commit subject: `feat(runtime): converge on the canonical error path and deprecate legacy codes`
3. **Converge TypeScript on the canonical error path** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #20 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/errors*.ts`, deprecation JSDoc on legacy helpers, `ts/dist/**` (regenerated, same commit), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: error fixtures pass in TS; legacy surfaces deprecated, unbroken.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `feat(ts): converge on the canonical error path`
4. **Converge Python on the canonical error path** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #21 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/errors.py`, `__init__.py` exports, `api-snapshots/py.txt` (same commit), `py/tests/`
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: error fixtures pass in Python; legacy surfaces deprecated, unbroken.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `feat(py): converge on the canonical error path`
5. **Pin fail-closed route registration** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #22 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/routing/` additions: invalid pattern (`/x/{}`), duplicate route, nil/undefined handler → app construction error, canonical error surface
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: fixtures express registration-time failure via `setup` and fail against today's lenient fluent path.
   - Validation: `./scripts/verify-fixture-schema.sh`; suite green after items 23–25
   - Commit subject: `test(contract): pin fail-closed route registration`
6. **Fail closed on invalid route registration (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #23 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/serve.go:24` area, `runtime/router.go:92-96` (surface `router.add` errors — panic on fluent path), Deprecated markers on now-redundant `*Strict` variants, `api-snapshots/go.txt` (same commit)
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: a typo'd pattern can no longer register silently; registration fixtures pass.
   - Validation: `make test-unit` + contract runner
   - Commit subject: `feat(runtime): fail closed on invalid route registration`
7. **Fail closed on invalid route registration (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #24 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/app.ts` registration path, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: registration fixtures pass in TS.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `feat(ts): fail closed on invalid route registration`
8. **Fail closed on invalid route registration (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP04 Canonical Errors & Fail-Closed Registration
   - Enumerated item: #25 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/app.py`/`router.py`, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: registration fixtures pass in Python.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `feat(py): fail closed on invalid route registration`

### Milestone: SP05 Canonical Typed Handlers & Validation
**Goal**: one generic typed-handler shape and one declarative validation vocabulary with a canonical 422, identical in all three runtimes.
**Phase**: Phase 2: One-Path Runtime Convergence (SP04–SP06, items 18–38)
**Depends on**: SP04 (validation errors ride the canonical envelope).

**Issues** (in order):
1. **Pin canonical typed-handler binding semantics** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #26 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/binding/` (new): body + query + path + header binding, typed conversions (int/bool/float/duration/slices), strict unknown-fields mode, canonical binding-error envelope
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: Go `BindHandler` semantics (`runtime/bind_handler.go`) are the behavioral source, expressed as fixtures that TS/Py currently fail.
   - Validation: schema gate; suite green after items 27–29
   - Commit subject: `test(contract): pin canonical typed-handler binding semantics`
2. **Align Go binding with the pinned fixtures** — [`apptheory`, `contract-change`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #27 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/bind_handler.go` (converge any divergence; document as the one canonical typed path; steer `JSONValue()` docs toward it), `api-snapshots/go.txt` if surface moves
   - Runtime scope: go
   - Contract impact: fixture-first (implementation leg)
   - Acceptance: binding fixtures pass in Go.
   - Validation: contract runner (Go)
   - Commit subject: `fix(runtime): align BindHandler with the pinned binding fixtures`
3. **Add the canonical generic typed handler (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #28 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/bind-handler.ts` (new: `bindHandler<Req,Resp>`), `ts/src/context.ts` (`jsonValue<T>()` generic overload), `ts/src/index.ts`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: binding fixtures pass in TS; handler/body/params are typed end-to-end.
   - Validation: `cd ts && npm run check && npm test` + contract runner
   - Commit subject: `feat(ts): add the canonical generic typed handler`
4. **Add the canonical typed handler (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #29 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/bind_handler.py` (new), `__init__.py`, `api-snapshots/py.txt` (same commit), `py/tests/`
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: binding fixtures pass in Python with typed dataclass/annotation-driven binding.
   - Validation: contract runner + `uv --directory py run pytest -q`
   - Commit subject: `feat(py): add the canonical typed handler`
5. **Pin the validation vocabulary and 422 envelope** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #30 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/validation/` (new): declarative rules (required, min/max, length, pattern, enum), canonical 422 field-error envelope, multi-error aggregation, interaction with binding errors
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: one validation vocabulary and one 422 shape are pinned; all apps will emit identical validation errors.
   - Validation: schema gate; suite green after items 31–33
   - Commit subject: `test(contract): pin the validation vocabulary and 422 field-error envelope`
6. **Declarative validation with the canonical 422 (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #31 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/bind_handler.go` (+ validation tag engine, new file `runtime/validate.go`), `api-snapshots/go.txt` (same commit), docs
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: validation fixtures pass in Go; user `Validate` func remains as an escape-free additive hook after declarative rules.
   - Validation: contract runner + `make test-unit`
   - Commit subject: `feat(runtime): declarative validation with the canonical 422 envelope`
7. **Declarative validation with the canonical 422 (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #32 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/validate.ts` (new), `bind-handler.ts`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: validation fixtures pass in TS.
   - Validation: contract runner + `npm test`
   - Commit subject: `feat(ts): declarative validation with the canonical 422 envelope`
8. **Declarative validation with the canonical 422 (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP05 Canonical Typed Handlers & Validation
   - Enumerated item: #33 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/validate.py` (new), `bind_handler.py`, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: validation fixtures pass in Python.
   - Validation: contract runner + pytest
   - Commit subject: `feat(py): declarative validation with the canonical 422 envelope`

### Milestone: SP06 OpenAPI from the Contract
**Goal**: the wire contract is generated from typed handlers, byte-identical across runtimes; plus the tier-encoding cleanup.
**Phase**: Phase 2: One-Path Runtime Convergence (SP04–SP06, items 18–38)
**Depends on**: SP05 (generation reads typed handlers + validation rules).

**Issues** (in order):
1. **Pin OpenAPI generation output from typed handlers** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP06 OpenAPI from the Contract
   - Enumerated item: #34 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/openapi/` (new): given a route table of typed handlers + validation rules, the emitted OpenAPI document is byte-pinned (deterministic ordering)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: one generated wire-contract format, identical across runtimes.
   - Validation: schema gate; suite green after items 35–37
   - Commit subject: `test(contract): pin OpenAPI generation from typed handlers`
2. **Generate OpenAPI from typed handlers (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP06 OpenAPI from the Contract
   - Enumerated item: #35 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/openapi.go` (new), `api-snapshots/go.txt` (same commit), docs
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: OpenAPI fixtures pass in Go.
   - Validation: contract runner
   - Commit subject: `feat(runtime): generate OpenAPI from typed handlers`
3. **Generate OpenAPI from typed handlers (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP06 OpenAPI from the Contract
   - Enumerated item: #36 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/openapi.ts` (new), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: OpenAPI fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): generate OpenAPI from typed handlers`
4. **Generate OpenAPI from typed handlers (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP06 OpenAPI from the Contract
   - Enumerated item: #37 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/openapi.py` (new), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: OpenAPI fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): generate OpenAPI from typed handlers`
5. **Thread `Tier` through the portable serve path** — [`apptheory`, `runtime:go`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP06 OpenAPI from the Contract
   - Enumerated item: #38 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/serve.go:236,257,320` (replace `enableP2 bool` with the `Tier` type)
   - Runtime scope: go
   - Contract impact: internal-only
   - Acceptance: no behavior change; fixtures and unit tests unchanged-green; P2-only branches read as tier checks.
   - Validation: `make test-unit` + contract runner
   - Commit subject: `refactor(runtime): thread Tier through the portable serve path`

### Milestone: SP07 Duration & EMF Metrics
**Goal**: requests are timed and a first-party CloudWatch EMF sink ships; "P2 observability" stops being batteries-not-included.
**Phase**: Phase 3: Observability & Coverage Backfill (SP07–SP08, items 39–54)
**Depends on**: Phase 1 gates. Parallelizable with Phase 2.

**Issues** (in order):
1. **Pin request duration in P2 observability records** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #39 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/observability/` additions (deterministic testkit clock → exact duration values in log/metric records)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: duration field pinned in the observability record shape.
   - Validation: schema gate; suite green after items 40–42
   - Commit subject: `test(contract): pin request duration in observability records`
2. **Record request duration (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #40 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/observability.go:48-100` (+duration via injected clock), `api-snapshots/go.txt` (same commit)
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: duration fixtures pass in Go.
   - Validation: contract runner
   - Commit subject: `feat(runtime): record request duration in observability records`
3. **Record request duration (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #41 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/` observability path, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: duration fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): record request duration in observability records`
4. **Record request duration (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #42 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/` observability path, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: duration fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): record request duration in observability records`
5. **Pin the CloudWatch EMF metric output format** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #43 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/observability/` EMF additions (exact EMF JSON log lines for request count/duration/error metrics, deterministic values)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: one blessed metric sink format pinned; no plugin system.
   - Validation: schema gate; suite green after items 44–46
   - Commit subject: `test(contract): pin the CloudWatch EMF metric output format`
6. **First-party EMF metrics sink (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #44 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `pkg/observability/emf.go` (new), `pkg/observability/hooks_apptheory.go` (bridges wire `Metric`), `api-snapshots/go.txt` (same commit)
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: EMF fixtures pass in Go; `HooksFromLogger`-style bridge now populates Metric.
   - Validation: contract runner + `make test-unit`
   - Commit subject: `feat(observability): first-party CloudWatch EMF metrics sink`
7. **First-party EMF metrics sink (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #45 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/emf.ts` (new), hook bridge, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: EMF fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): first-party CloudWatch EMF metrics sink`
8. **First-party EMF metrics sink (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP07 Duration & EMF Metrics
   - Enumerated item: #46 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/emf.py` (new), hook bridge, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: EMF fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): first-party CloudWatch EMF metrics sink`

### Milestone: SP08 Trace Propagation & Fixture Backfill
**Goal**: trace context flows into requests and error envelopes, and rate-limit/WebSocket/SSE edge behavior is pinned.
**Phase**: Phase 3: Observability & Coverage Backfill (SP07–SP08, items 39–54)
**Depends on**: SP07 (docs item 51 describes the full shipped surface); backfill items are independent siblings.

**Issues** (in order):
1. **Pin trace-context extraction and error TraceID** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #47 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/observability/` trace additions (`traceparent` + `X-Amzn-Trace-Id` extraction precedence, TraceID in span/log records and in the error envelope)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: propagation semantics pinned (extraction only; no OTel SDK).
   - Validation: schema gate; suite green after items 48–50
   - Commit subject: `test(contract): pin trace-context extraction and error TraceID`
2. **Propagate trace context (Go)** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #48 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/request.go`/`context.go` (extract), `runtime/observability.go`, `runtime/portable_error.go` (populate `TraceID`), `api-snapshots/go.txt` (same commit)
   - Runtime scope: go
   - Contract impact: api-snapshot-update
   - Acceptance: trace fixtures pass in Go.
   - Validation: contract runner
   - Commit subject: `feat(runtime): propagate trace context into requests and error envelopes`
3. **Propagate trace context (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #49 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/` request/observability/error paths, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: trace fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): propagate trace context into requests and error envelopes`
4. **Propagate trace context (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #50 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/` request/observability/error paths, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: trace fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): propagate trace context into requests and error envelopes`
5. **Rewrite the observability feature docs to match the shipped surface** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #51 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `docs/features/` observability/logging pages, `README.md` tier table
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: docs describe duration + EMF sink + trace propagation as shipped, and name what remains bring-your-own (full OTel SDK).
   - Validation: docs build (`pages` job) green
   - Commit subject: `docs: describe the shipped P2 observability surface accurately`
6. **Backfill rate-limit strategy and window fixtures** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #52 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/` rate-limit additions (multi-window strategies, limiter-store failure → fail-closed, content-type override edge cases); per-runtime convergence fixes in the same commit if trivial, else immediate follow-ups per parity order
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: `pkg/limited` behavior (3 fixtures today) is pinned across its strategy surface, green in all runtimes.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `test(contract): backfill rate-limit strategy and window fixtures`
7. **Backfill WebSocket auth and failure fixtures** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #53 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/` websocket additions (auth-on-connect deny, management-client failure envelope, large frame)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: WebSocket coverage extends beyond the 5 happy-path fixtures, green in all runtimes.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `test(contract): backfill WebSocket auth and failure fixtures`
8. **Backfill SSE disconnect and heartbeat fixtures** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP08 Trace Propagation & Fixture Backfill
   - Enumerated item: #54 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/` streaming additions (client-disconnect mid-stream, heartbeat/keep-alive framing, late-error after first byte)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: SSE edge behavior pinned, green in all runtimes.
   - Validation: `./scripts/verify-contract-tests.sh`
   - Commit subject: `test(contract): backfill SSE disconnect and heartbeat fixtures`

### Milestone: SP09 MCP Contract Truth
**Goal**: the MCP method surface is specified by fixtures and Go converges on them; the fixtures arbitrate, not the Go code.
**Phase**: Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)
**Depends on**: Phase 1 gates. Parallelizable with Phases 2–3.

**Issues** (in order):
1. **Pin the MCP core protocol surface** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP09 MCP Contract Truth
   - Enumerated item: #55 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/mcp/` (new tier): initialize handshake (protocol `2025-11-25`), tools list/call, JSON-RPC error envelopes, malformed-request handling
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: the MCP method surface is specified by fixtures, not by the Go implementation.
   - Validation: schema gate; Go green after item 59, TS after 60, Py after 64
   - Commit subject: `test(contract): pin the MCP core protocol surface`
2. **Pin MCP resources and prompts** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP09 MCP Contract Truth
   - Enumerated item: #56 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/mcp/` resources/prompts fixtures (list/read/templates, prompt get/render)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: registry behavior pinned.
   - Validation: schema gate; green per-runtime as implementations land
   - Commit subject: `test(contract): pin MCP resources and prompts`
3. **Pin MCP sessions and streamable HTTP transport** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP09 MCP Contract Truth
   - Enumerated item: #57 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/mcp/` session lifecycle (create/expire/reject), streamable HTTP request/response framing, reserved-path behavior
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: transport + session semantics pinned.
   - Validation: schema gate; green per-runtime as implementations land
   - Commit subject: `test(contract): pin MCP sessions and streamable HTTP transport`
4. **Pin MCP resumable SSE and task stores** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP09 MCP Contract Truth
   - Enumerated item: #58 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/mcp/` resumable SSE (event ids, replay-from-last-id), task lifecycle against deterministic store fakes
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: resumption + task semantics pinned store-agnostically (DynamoDB specifics stay unit-tested per runtime).
   - Validation: schema gate; green per-runtime as implementations land
   - Commit subject: `test(contract): pin MCP resumable SSE and task semantics`
5. **Converge Go MCP on the pinned fixtures** — [`apptheory`, `contract-change`, `runtime:go`, `api-snapshot`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP09 MCP Contract Truth
   - Enumerated item: #59 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/mcp/**` (fix any divergence fixtures reveal), Go contract-runner MCP dispatch, `api-snapshots/go.txt` if surface moves
   - Runtime scope: go
   - Contract impact: fixture-first (implementation leg)
   - Acceptance: all `mcp/` fixtures pass in Go — the fixtures arbitrate, not the existing Go code.
   - Validation: contract runner (Go)
   - Commit subject: `fix(runtime): converge Go MCP on the pinned protocol fixtures`

### Milestone: SP10 MCP TypeScript Runtime
**Goal**: a TS author can build, test, and ship an MCP server on AppTheory, verified by the same fixtures as Go.
**Phase**: Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)
**Depends on**: SP09 (fixtures exist and are Go-green).

**Issues** (in order):
1. **MCP core server runtime (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #60 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/mcp/` (new: JSON-RPC, initialize, tool registry/dispatch), TS runner MCP dispatch, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-55 fixtures pass in TS.
   - Validation: contract runner + `npm test`
   - Commit subject: `feat(ts): MCP core server runtime`
2. **MCP resources and prompts (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #61 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/mcp/` registries, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-56 fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): MCP resources and prompts`
3. **MCP sessions and streamable HTTP transport (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #62 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/mcp/` session + transport (behind the reserved paths in `ts/src/internal/aws-http.ts:126-129`), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-57 fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): MCP sessions and streamable HTTP transport`
4. **MCP resumable SSE and task/stream stores (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #63 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/mcp/` resumable SSE + store interfaces with in-memory + DynamoDB implementations, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-58 fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): MCP resumable SSE and task stores`
5. **MCP test doubles in the TS testkit** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #68 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/testkit.ts` (or `ts/src/testkit/mcp.ts`), mirroring `testkit/mcp/`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: a TS app author can test an MCP server deterministically without AWS.
   - Validation: `npm test`
   - Commit subject: `feat(ts): MCP test doubles in the testkit`
6. **TypeScript MCP example server** — [`apptheory`, `runtime:ts`, `docs`, `example`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP10 MCP TypeScript Runtime
   - Enumerated item: #70 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `examples/mcp/tools-only-ts/` (new, mirroring the Go example), `examples/README.md`
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: example builds and its testkit-driven test passes in `verify-testkit-examples.sh` scope.
   - Validation: `./scripts/verify-testkit-examples.sh`
   - Commit subject: `docs(examples): TypeScript MCP server example`

### Milestone: SP11 MCP Python Runtime
**Goal**: a Python author gets the same, fixture-verified.
**Phase**: Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)
**Depends on**: SP09. Parallelizable with SP10 (different runtimes, same fixtures).

**Issues** (in order):
1. **MCP core server runtime (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #64 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/mcp/` (new), Python runner MCP dispatch, `__init__.py` re-exports, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-55 fixtures pass in Python.
   - Validation: contract runner + pytest
   - Commit subject: `feat(py): MCP core server runtime`
2. **MCP resources and prompts (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #65 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/mcp/`, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-56 fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): MCP resources and prompts`
3. **MCP sessions and streamable HTTP transport (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #66 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/mcp/` (behind reserved paths in `aws_http.py:16-19`), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-57 fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): MCP sessions and streamable HTTP transport`
4. **MCP resumable SSE and task/stream stores (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #67 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/mcp/` stores (memory + DynamoDB), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-58 fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): MCP resumable SSE and task stores`
5. **MCP test doubles in the Python testkit** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #69 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/testkit.py` (or `testkit/mcp.py`), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: a Python app author can test an MCP server deterministically without AWS.
   - Validation: pytest
   - Commit subject: `feat(py): MCP test doubles in the testkit`
6. **Python MCP example server** — [`apptheory`, `runtime:py`, `docs`, `example`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP11 MCP Python Runtime
   - Enumerated item: #71 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `examples/mcp/tools-only-py/` (new), `examples/README.md`
   - Runtime scope: py
   - Contract impact: internal-only
   - Acceptance: example runs its deterministic test green.
   - Validation: `./scripts/verify-testkit-examples.sh`
   - Commit subject: `docs(examples): Python MCP server example`

### Milestone: SP12 OAuth Parity
**Goal**: protected-resource metadata, bearer validation, DCR, and PKCE are fixture-pinned and identical in all three runtimes; TS/Py MCP servers can be protected resources.
**Phase**: Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)
**Depends on**: SP09–SP11 recommended first (OAuth's consumer is the MCP surface), hard dependency only on Phase 1.

**Issues** (in order):
1. **Pin OAuth protected-resource metadata and bearer validation** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #72 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/oauth/` (new tier): RFC 9728 `/.well-known/oauth-protected-resource` responses, bearer accept/reject (expiry, audience, scope), canonical 401/403 envelopes
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: the OAuth surface MCP protection depends on is fixture-specified.
   - Validation: schema gate; green per-runtime as items 74–78 land
   - Commit subject: `test(contract): pin OAuth protected-resource metadata and bearer validation`
2. **Pin OAuth dynamic client registration and PKCE** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #73 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/oauth/` DCR + PKCE fixtures (registration flow, code-challenge verification, failure envelopes)
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: DCR/PKCE semantics pinned.
   - Validation: schema gate; green per-runtime as implementations land
   - Commit subject: `test(contract): pin OAuth dynamic client registration and PKCE`
3. **Converge Go OAuth on the pinned fixtures** — [`apptheory`, `contract-change`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #74 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/oauth/**`, Go runner OAuth dispatch, `api-snapshots/go.txt` if surface moves
   - Runtime scope: go
   - Contract impact: fixture-first (implementation leg)
   - Acceptance: all `oauth/` fixtures pass in Go.
   - Validation: contract runner (Go)
   - Commit subject: `fix(runtime): converge Go OAuth on the pinned fixtures`
4. **OAuth protected resource and bearer validation (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #75 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/oauth/` (new; includes testkit doubles), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-72 fixtures pass in TS.
   - Validation: contract runner + `npm test`
   - Commit subject: `feat(ts): OAuth protected resource and bearer validation`
5. **OAuth DCR and PKCE (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #76 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/oauth/`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: item-73 fixtures pass in TS.
   - Validation: contract runner
   - Commit subject: `feat(ts): OAuth dynamic client registration and PKCE`
6. **OAuth protected resource and bearer validation (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #77 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/oauth/` (new; includes testkit doubles), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-72 fixtures pass in Python.
   - Validation: contract runner + pytest
   - Commit subject: `feat(py): OAuth protected resource and bearer validation`
7. **OAuth DCR and PKCE (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP12 OAuth Parity
   - Enumerated item: #78 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/oauth/`, `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: item-73 fixtures pass in Python.
   - Validation: contract runner
   - Commit subject: `feat(py): OAuth dynamic client registration and PKCE`

### Milestone: SP13 Object Store Parity
**Goal**: the deliberately-narrow object store is contract-covered in all three runtimes, forbidden operations pinned as errors.
**Phase**: Phase 4: Full Parity — MCP, OAuth, Object Store (SP09–SP13, items 55–82)
**Depends on**: Phase 1 only; fully parallelizable within Phase 4.

**Issues** (in order):
1. **Pin the bounded object-store contract** — [`apptheory`, `contract-change`, `fixture-first`, `runtime:go`, `runtime:ts`, `runtime:py`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP13 Object Store Parity
   - Enumerated item: #79 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `contract-tests/fixtures/objectstore/` (new tier): Put / bounded-Get / Delete semantics against deterministic fakes; forbidden operations (list/presign/multipart) pinned as errors — the narrowness *is* the contract
   - Runtime scope: all
   - Contract impact: fixture-first
   - Acceptance: `pkg/objectstore`'s deliberately narrow surface is fixture-specified.
   - Validation: schema gate; green per-runtime as items 80–82 land
   - Commit subject: `test(contract): pin the bounded object-store contract`
2. **Converge Go objectstore on the pinned fixtures** — [`apptheory`, `contract-change`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP13 Object Store Parity
   - Enumerated item: #80 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `pkg/objectstore/**`, Go runner dispatch, `api-snapshots/go.txt` if surface moves
   - Runtime scope: go
   - Contract impact: fixture-first (implementation leg)
   - Acceptance: objectstore fixtures pass in Go.
   - Validation: contract runner (Go)
   - Commit subject: `fix(runtime): converge Go objectstore on the pinned fixtures`
3. **Bounded S3 object-store client (TS)** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP13 Object Store Parity
   - Enumerated item: #81 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/objectstore.ts` (new, incl. testkit fake), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
   - Runtime scope: ts
   - Contract impact: api-snapshot-update
   - Acceptance: objectstore fixtures pass in TS.
   - Validation: contract runner + `npm test`
   - Commit subject: `feat(ts): bounded S3 object-store client`
4. **Bounded S3 object-store client (Python)** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP13 Object Store Parity
   - Enumerated item: #82 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/objectstore.py` (new, incl. testkit fake), `api-snapshots/py.txt` (same commit)
   - Runtime scope: py
   - Contract impact: api-snapshot-update
   - Acceptance: objectstore fixtures pass in Python.
   - Validation: contract runner + pytest
   - Commit subject: `feat(py): bounded S3 object-store client`

### Milestone: SP14 Production Deployment Surface
**Goal**: the runtime module sheds the CDK tree, and the flagship constructs gain the production knobs (domain/CORS, WAF, log retention, VPC, canary, dashboard) that currently force raw-CDK bypasses.
**Phase**: Phase 5: Deployment Surface & Adoption (SP14–SP17, items 83–93, 95–106)
**Depends on**: item 89 needs SP07 (EMF metric names); item 83 lands first inside the milestone so construct regeneration happens once per shape; cdk-go drift gate (SP03) active.

**Issues** (in order):
1. **Split `cdk-go` into a nested Go module** — [`apptheory`, `runtime:go`, `cdk`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #83 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk-go/go.mod` + `go.sum` (new), root `go.mod` (drop awscdk/jsii/constructs), `scripts/verify-version-alignment.sh` + `update-cdk-generated.sh` (second module awareness), `release-please-config*.json` extra-files if needed, migration note in `docs/` + `cdk-go` README
   - Runtime scope: go
   - Contract impact: internal-only (import paths unchanged; consumer-visible packaging)
   - Acceptance: `go mod graph` on a runtime-only consumer shows no awscdk/jsii/constructs; `go test ./cdk-go/...` still green from the nested module; migration note published.
   - Validation: `make test` + `./scripts/verify-cdk-go-drift.sh` + `./scripts/verify-version-alignment.sh`
   - Commit subject: `feat(cdk): split cdk-go into a nested Go module`
2. **Custom domain, certificate, and CORS on the flagship HTTP constructs** — [`apptheory`, `cdk`, `api-snapshot`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #84 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/http-api.ts`, `cdk/lib/app.ts` (compose `AppTheoryCertificate`/`AppTheoryApiDomain`; CORS props), `cdk/test/`, `cdk-go/**` (regenerated, same commit), `cdk/README.md` entry
   - Runtime scope: none (deployment)
   - Contract impact: api-snapshot-update (`cdk/.jsii` surface)
   - Acceptance: `AppTheoryHttpApi`/`AppTheoryApp` accept domain + auto-validated cert + CORS without dropping to raw CDK.
   - Validation: `cd cdk && npm test` + `./scripts/verify-cdk-synth.sh` + drift gate
   - Commit subject: `feat(cdk): custom domain, certificate, and CORS on AppTheoryHttpApi and AppTheoryApp`
3. **Attach regional WAF to API stages** — [`apptheory`, `cdk`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #85 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/enhanced-security.ts` (+`CfnWebACLAssociation` wiring/prop), `cdk/test/`, `cdk-go/**` (regen, same commit)
   - Runtime scope: none
   - Contract impact: api-snapshot-update (jsii)
   - Acceptance: the REGIONAL WebACL the package builds can attach to HTTP/REST API stages through props.
   - Validation: `cd cdk && npm test` + drift gate
   - Commit subject: `feat(cdk): attach regional WAF to API stages`
4. **Log retention on functions and apps** — [`apptheory`, `cdk`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #86 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/function.ts`, `cdk/lib/app.ts` (explicit log group + retention prop, finite default), `cdk/test/`, `cdk-go/**` (regen, same commit)
   - Runtime scope: none
   - Contract impact: api-snapshot-update (jsii)
   - Acceptance: no AppTheory-deployed function defaults to never-expire logs.
   - Validation: `cd cdk && npm test` + drift gate
   - Commit subject: `feat(cdk): log retention on functions and apps`
5. **First-class VPC props on functions and apps** — [`apptheory`, `cdk`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #87 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/function.ts`, `cdk/lib/app.ts` (`vpc`/`vpcSubnets`/`securityGroups`), `cdk/test/`, `cdk-go/**` (regen, same commit)
   - Runtime scope: none
   - Contract impact: api-snapshot-update (jsii)
   - Acceptance: VPC placement no longer requires the all-or-nothing EnhancedSecurity bundle or raw props spread.
   - Validation: `cd cdk && npm test` + drift gate
   - Commit subject: `feat(cdk): first-class VPC props on functions and apps`
6. **Alias, provisioned concurrency, and canary deploys** — [`apptheory`, `cdk`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #88 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/function.ts` (+version/alias/provisioned props), new `cdk/lib/function-deployment.ts` (CodeDeploy canary/linear traffic shifting), `cdk/test/`, `cdk-go/**` (regen, same commit), docs page
   - Runtime scope: none
   - Contract impact: api-snapshot-update (jsii)
   - Acceptance: a construct-only path exists for alias-based provisioned concurrency and canary deployment.
   - Validation: `cd cdk && npm test` + `./scripts/verify-cdk-synth.sh` + drift gate
   - Commit subject: `feat(cdk): alias, provisioned concurrency, and canary deployments`
7. **Observability dashboard and alarm construct** — [`apptheory`, `cdk`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #89 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/lib/observability.ts` (new: dashboard, latency/duration/error alarms consuming the EMF metrics from items 43–46, SNS alarm actions), `cdk/test/`, `cdk-go/**` (regen, same commit)
   - Runtime scope: none
   - Contract impact: api-snapshot-update (jsii)
   - Acceptance: one construct gives an AppTheory app a dashboard + actionable alarms wired to the runtime's blessed metric names.
   - Validation: `cd cdk && npm test` + drift gate
   - Commit subject: `feat(cdk): observability dashboard and alarm construct`
8. **Generate the construct inventory in the CDK README** — [`apptheory`, `cdk`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP14 Production Deployment Surface
   - Enumerated item: #90 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cdk/README.md` (complete the ~15 missing constructs), small generator/check script reading `cdk/lib/index.ts` exports, rubric wiring
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: every exported construct appears in the README; the check fails when one is added without a README entry.
   - Validation: new verify script + `make rubric`
   - Commit subject: `docs(cdk): generate the construct inventory in the package README`

### Milestone: SP15 On-Ramp
**Goal**: a new adopter goes from clean machine to deployed, curl-able service in one documented path, and can scaffold a correct project in one command.
**Phase**: Phase 5: Deployment Surface & Adoption (SP14–SP17, items 83–93, 95–106)
**Depends on**: SP01 (real install commands); hello-world (91) needs nothing new, so this milestone can start any time after Phase 1 — scheduled here so the scaffold templates (93) emit the program's canonical typed-handler/validation shapes from SP05.

**Issues** (in order):
1. **Deployable hello-world example in three languages** — [`apptheory`, `runtime:go`, `runtime:ts`, `runtime:py`, `docs`, `example`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP15 On-Ramp
   - Enumerated item: #91 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `examples/cdk/hello-world/` (new: one function + `AppTheoryHttpApi`, Go/TS/Py variants, testkit test each, README with bootstrap→deploy→curl→destroy), `examples/README.md`
   - Runtime scope: all
   - Contract impact: internal-only
   - Acceptance: from a clean clone, README steps produce a `curl`-able endpoint in each language; testkit tests keep it deterministic in CI.
   - Validation: `./scripts/verify-testkit-examples.sh` + one manual deploy per language
   - Commit subject: `docs(examples): deployable hello-world in Go, TypeScript, and Python`
2. **Carry getting-started through bootstrap and deploy** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP15 On-Ramp
   - Enumerated item: #92 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `docs/getting-started.md`, `docs/cdk/getting-started.md` (add `cdk bootstrap`, `cdk deploy`, verification, teardown; link hello-world)
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: one doc path goes clean-machine → deployed service; synth is a step, not the destination.
   - Validation: follow the page verbatim on a fresh environment
   - Commit subject: `docs: carry getting-started through bootstrap and deploy`
3. **Project scaffold generator** — [`apptheory`, `runtime:go`, `runtime:ts`, `runtime:py`, `api-snapshot`, `docs`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP15 On-Ramp
   - Enumerated item: #93 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `cmd/apptheory-init/` (new CLI) + `templates/` (per-language app + stack + test, pinned release-asset install), `docs/getting-started.md` entry, `api-snapshots` untouched (CLI not a library surface)
   - Runtime scope: all
   - Contract impact: internal-only (new tool; emits the one blessed shape by construction)
   - Acceptance: `apptheory-init --lang=ts my-app` produces a building, testing, deployable project; generated projects verified in CI like examples. theory-cli integration recorded as a cross-steward follow-up, not blocked on.
   - Validation: CI job scaffolds all three languages and runs their tests
   - Commit subject: `feat(cmd): project scaffold generator`
4. **Consumer dependency-automation guide** — [`apptheory`, `docs`, `cross-repo`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP15 On-Ramp
   - Enumerated item: #95 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `docs/` new page (Renovate github-releases datasource config for AppTheory + TableTheory lockstep bumps; Dependabot notes), linked from install docs
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: a consumer can wire automated bump PRs for release-pinned installs without a registry.
   - Validation: docs build green; config validated against Renovate schema
   - Commit subject: `docs: consumer dependency-automation guide for release-pinned installs`
5. **Add `llms.txt` and the reserved llm-faq surface** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP15 On-Ramp
   - Enumerated item: #96 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `llms.txt` (new, root), `docs/llm-faq/` (create minimal canonical entries or remove the dangling references in `docs/README.md:63` + maintainer guide), Pages config if needed
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: no referenced-but-missing doc surface remains; coding agents get a canonical entry map.
   - Validation: docs build green; links resolve
   - Commit subject: `docs: add llms.txt and resolve the reserved llm-faq surface`

### Milestone: SP16 Operator & Upgrade Docs
**Goal**: operators of deployed apps get real guidance, and consumers get a maintained upgrade path listing every deprecation this program introduced.
**Phase**: Phase 5: Deployment Surface & Adoption (SP14–SP17, items 83–93, 95–106)
**Depends on**: 98 (UPGRADING) lists deprecations from SP04; 97 (operator guide) references SP07/SP14 observability; 99 must verify subtree-publish path filters.

**Issues** (in order):
1. **Operator guide for deployed applications** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #97 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `docs/guides/operations.md` (new: debugging deployed apps — cold starts, IAM, event-shape mismatch, CORS, 500-envelope reading; cost; alarming with item 89's construct), nav entry
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: troubleshooting exists for app operators, not just repo contributors.
   - Validation: docs build green
   - Commit subject: `docs: operator guide for deployed applications`
2. **UPGRADING policy and per-line notes** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #98 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `UPGRADING.md` (new, root), release-process doc note on maintaining it per minor line
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: consumers have a v1.x→v1.y upgrade path distinct from the generated CHANGELOG; deprecations from items 19–25 are listed with their replacement.
   - Validation: docs build green
   - Commit subject: `docs: add UPGRADING policy and per-line upgrade notes`
3. **Exclude the planning corpus from the published site** — [`apptheory`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #99 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `docs/_config.yml` (or move `docs/development/planning/**` + `docs/planning/**` out of the published tree), verify subtree-publish path filters still hold, remove duplicate migration entry point (`docs/migration-guide.md` vs `docs/migration/`)
   - Runtime scope: none
   - Contract impact: doc-only
   - Acceptance: published site contains only canonical pages; planning docs remain in-repo but unpublished; no duplicate entry points.
   - Validation: Pages build green; spot-check published tree
   - Commit subject: `chore(docs): exclude the planning corpus from the published site`
4. **Docstrings for Python core modules** — [`apptheory`, `runtime:py`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #100 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/{context,app,router,response,request}.py`
   - Runtime scope: py
   - Contract impact: internal-only
   - Acceptance: every public symbol in the five core modules has a docstring; hover/IDE help is populated.
   - Validation: `make lint` (pyright/ruff green)
   - Commit subject: `docs(py): docstrings for core modules`
5. **JSDoc for TypeScript core modules** — [`apptheory`, `runtime:ts`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #101 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/{context,app,router,response,types}.ts`, `ts/dist/**` (regenerated — JSDoc lands in `.d.ts`, same commit)
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: public symbols in core modules carry JSDoc visible in consumer IDEs.
   - Validation: `cd ts && npm run check` + dist drift gate
   - Commit subject: `docs(ts): JSDoc for core modules`
6. **Cross-check hand-written API maps against snapshots** — [`apptheory`, `cdk`, `api-snapshot`, `docs`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP16 Operator & Upgrade Docs
   - Enumerated item: #102 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: new `scripts/verify-api-docs.sh` (checks `docs/api-reference.md`, `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md` mention every snapshot-exported top-level symbol), rubric wiring
   - Runtime scope: none
   - Contract impact: internal-only
   - Acceptance: an exported-surface change that skips the hand-written maps fails the gate (same posture as snapshots themselves).
   - Validation: `./scripts/verify-api-docs.sh`
   - Commit subject: `chore(docs): cross-check hand-written API maps against snapshots`

### Milestone: SP17 Codebase Decomposition
**Goal**: the mega-files are split with byte-identical public surfaces and the transitive-override debt is retired.
**Phase**: Phase 5: Deployment Surface & Adoption (SP14–SP17, items 83–93, 95–106)
**Depends on**: scheduled last so it never conflicts with the program's feature branches in the same files (microvm, event sources). Snapshot-byte-identical acceptance makes it mechanically safe. (4 items — under preference; kept separate because mixing pure refactors into feature milestones muddies release notes and review.)

**Issues** (in order):
1. **Split TS microvm into a module directory** — [`apptheory`, `runtime:ts`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP17 Codebase Decomposition
   - Enumerated item: #103 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/src/microvm.ts` (7,368 lines) → `ts/src/microvm/` mirroring `runtime/microvm/`'s file shape; `ts/src/index.ts` re-exports unchanged; `ts/dist/**` (regen); `api-snapshots/ts.txt` must be byte-identical (proves no surface change)
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: no exported-surface or fixture change; file sizes drop below review-tractable thresholds.
   - Validation: `./scripts/verify-api-snapshots.sh` (unchanged) + contract runner
   - Commit subject: `refactor(ts): split microvm into a module directory`
2. **Split Python microvm into a package** — [`apptheory`, `runtime:py`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP17 Codebase Decomposition
   - Enumerated item: #104 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `py/src/apptheory/microvm.py` (5,525 lines) → `py/src/apptheory/microvm/` package; re-exports preserved; `api-snapshots/py.txt` byte-identical
   - Runtime scope: py
   - Contract impact: internal-only
   - Acceptance: no surface or fixture change.
   - Validation: `./scripts/verify-api-snapshots.sh` + contract runner
   - Commit subject: `refactor(py): split microvm into a package`
3. **Split Go event-source adapters by source** — [`apptheory`, `runtime:go`, `api-snapshot`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP17 Codebase Decomposition
   - Enumerated item: #105 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `runtime/aws_eventsources.go` (929 lines) → per-source files (`aws_sqs.go`, `aws_kinesis.go`, ...) with the dispatch sniffer isolated; `api-snapshots/go.txt` byte-identical
   - Runtime scope: go
   - Contract impact: internal-only
   - Acceptance: no surface or fixture change.
   - Validation: `./scripts/verify-api-snapshots.sh` + contract runner
   - Commit subject: `refactor(runtime): split event-source adapters by source`
4. **Re-evaluate TS transitive dependency overrides** — [`apptheory`, `runtime:ts`]
   - Source: Roadmap AppTheory Strengthening Program (2026-07), Milestone SP17 Codebase Decomposition
   - Enumerated item: #106 from `ENUMERATED-CHANGES-improvement-program.md`
   - Paths: `ts/package.json:27-47` overrides block, `ts/package-lock.json`, `ts/dist/**` if build output shifts
   - Runtime scope: ts
   - Contract impact: internal-only
   - Acceptance: each override is either dropped (upstream fixed) or documented with the CVE/reason it pins; consumers inherit no stale pins.
   - Validation: `cd ts && npm ci && npm test && npm audit`
   - Commit subject: `chore(ts): re-evaluate transitive dependency overrides`

## Source documents
- `IMPROVEMENTS.md`
- `SCOPED-NEED-improvement-program.md`
- `ENUMERATED-CHANGES-improvement-program.md`
- `ROADMAP-improvement-program.md`
