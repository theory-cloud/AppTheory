# Enumerated Changes: AppTheory Strengthening Program (2026-07)

**Descends from:** `SCOPED-NEED-improvement-program.md` (approved 2026-07-02) ← `IMPROVEMENTS.md`
**Decisions in force:** full MCP+OAuth+objectstore parity · Python and Node floors lowered (target Python 3.12, Node 20 LTS) · nested `cdk-go` module included · additive + deprecate (no breaks this program)

Flat, ordered list. Each item is one commit: one intent, gates green at the end, no item
depends on a later item. Contract-visible changes follow the parity order (fixture → Go →
TS → Py → snapshots-in-same-commit → docs/examples). Fixture items land with runner plumbing
so the suite executes them; per-runtime items immediately following bring them green — a
fixture tier and its runtime items ship in the same PR so no protected branch sees red.
`VERSION`/manifests are never touched here; the program is minor-version additive throughout
(release-please will cut minors from the `feat`/`fix` subjects).

---

## Hygiene and credibility

### 1. Correct stale fixture-count and release-status claims

- **Paths**: `README.md`, `docs/_data/site-meta.yml`, `docs/features/http-runtime.md`, `docs/runtimes/go.md`, `docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md`, `docs/development/migration/lift-deprecation.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: no "128"-fixture or "Pre-1.0"/"0.x" claim remains in user-facing docs; all counts read 145 (until item 2 makes them generated).
- **Validation**: `grep -rn '128-fixture\|Pre-1.0' README.md docs/` returns nothing
- **Conventional Commit subject**: `docs: correct fixture-count and release-status claims`

### 2. Gate fixture-count claims on the actual corpus

- **Paths**: `scripts/verify-fixture-count.sh` (new), rubric wiring in `scripts/verify-rubric.sh`/`gov-infra`, count markers in `README.md` + docs pages
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: a rubric step fails if any documented fixture count differs from `find contract-tests/fixtures -name '*.json' | wc -l`.
- **Validation**: `./scripts/verify-fixture-count.sh`
- **Conventional Commit subject**: `chore(docs): gate documented fixture counts on the fixture corpus`

### 3. Fix broken example CDK dependencies

- **Paths**: `examples/cdk/sqs-queue/package.json` (+lock), `examples/cdk/lambda-role/package.json` (+lock)
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: `file:../../..` → `file:../../../cdk`; `npm ci` succeeds in both examples.
- **Validation**: `cd examples/cdk/sqs-queue && npm ci` (and lambda-role)
- **Conventional Commit subject**: `fix(examples): point sqs-queue and lambda-role at the cdk package`

### 4. Pin the TS TableTheory dependency with an integrity hash

- **Paths**: `ts/package.json:25`, `ts/package-lock.json`
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: the GitHub-release URL dependency carries a verifiable integrity value (npm `integrity` in lockfile confirmed pinned), matching the Python wheel's `#sha256=` posture.
- **Validation**: `cd ts && npm ci && npm test`
- **Conventional Commit subject**: `fix(ts): pin the tabletheory release dependency with an integrity hash`

### 5. Replace placeholder installs with resolvable commands

- **Paths**: `README.md`, `docs/runtimes/typescript.md`, `docs/runtimes/python.md`, `docs/cdk/getting-started.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: every install block is copy-pasteable (`gh release download` with pattern + checksum verification step); no literal `X.Y.Z` remains.
- **Validation**: follow the TS instructions verbatim on a clean directory
- **Conventional Commit subject**: `docs: replace placeholder installs with release-download commands`

### 6. Ship `py.typed`

- **Paths**: `py/src/apptheory/py.typed` (new), `py/pyproject.toml` package-data
- **Runtime scope**: py
- **Contract impact**: internal-only (no exported symbol change; wheel contents change)
- **Acceptance**: built wheel contains `apptheory/py.typed`; a consumer pyright run resolves AppTheory types.
- **Validation**: `./scripts/verify-python-build.sh` and inspect wheel
- **Conventional Commit subject**: `feat(py): ship py.typed so consumers see the type hints`

### 7. Add pyright to the Python lint gate

- **Paths**: `py/pyproject.toml`, `scripts/verify-python-lint.sh`, `Makefile`, annotation fixes across `py/src/**` (e.g. `context.py:103,174,255` missing return types)
- **Runtime scope**: py
- **Contract impact**: internal-only
- **Acceptance**: `make lint` runs pyright (basic mode) green over `py/src`.
- **Validation**: `make lint`
- **Conventional Commit subject**: `chore(py): add pyright to the lint gate and repair surfaced annotations`

### 8. Ship TS source maps and gate `ts/dist` against drift

- **Paths**: `ts/tsconfig.json` (`sourceMap`/`declarationMap` on), `ts/dist/**` (regenerated), `scripts/verify-ts-dist-drift.sh` (new), rubric/CI wiring (`.github/workflows/ci.yml`)
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: dist rebuilt from src produces zero `git diff`; the gate fails CI when it doesn't; published dist carries `.map` files. Closes the stale-dist gate-correctness hole (contract runner + snapshot generator consume dist).
- **Validation**: `./scripts/verify-ts-dist-drift.sh`
- **Conventional Commit subject**: `fix(ts): ship source maps and gate ts/dist against drift`

## Verification machinery

### 9. Add a fixture JSON Schema and schema gate

- **Paths**: `contract-tests/fixtures/fixture.schema.json` (new), `scripts/verify-fixture-schema.sh` (new), rubric wiring, `contract-tests/fixtures/README.md`
- **Runtime scope**: none
- **Contract impact**: internal-only (pins the *meta*-contract)
- **Acceptance**: all 145 fixtures validate; a deliberately malformed fixture fails the gate.
- **Validation**: `./scripts/verify-fixture-schema.sh`
- **Conventional Commit subject**: `test(contract): add a fixture JSON Schema and schema gate`

### 10. Discover fixture tiers by glob in all runners

- **Paths**: `contract-tests/runners/go/fixture.go`, `contract-tests/runners/py/run.py:61`, `contract-tests/runners/ts/run.cjs:146`
- **Runtime scope**: all (runner code)
- **Contract impact**: internal-only
- **Acceptance**: no hardcoded tier list remains; a new fixture directory is picked up by all three runners without runner edits.
- **Validation**: `./scripts/verify-contract-tests.sh` (count of executed fixtures unchanged)
- **Conventional Commit subject**: `fix(contract): discover fixture tiers by directory glob in all runners`

### 11. Run a single fixture by id across all runners

- **Paths**: three runners (add `--id`/`--filter`), `Makefile` (`contract-one ID=...`), `CONTRIBUTING.md`
- **Runtime scope**: all (runner code)
- **Contract impact**: internal-only
- **Acceptance**: `make contract-one ID=<fixture-id>` runs exactly that fixture in Go, TS, and Python.
- **Validation**: `make contract-one ID=p0-routing-basic` (or equivalent existing id)
- **Conventional Commit subject**: `test(contract): run a single fixture by id across all runners`

### 12. De-duplicate contract-test execution in the rubric

- **Paths**: `gov-infra/verifiers/gov-verify-rubric.sh`, `scripts/verify-rubric.sh`
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: one rubric invocation runs each language's contract suite exactly once; `npm ci` count reduced; rubric wall-clock measurably drops.
- **Validation**: `make rubric` (inspect log for single contract pass)
- **Conventional Commit subject**: `chore(rubric): run contract suites once per rubric invocation`

### 13. Cache dependencies in CI

- **Paths**: `.github/workflows/ci.yml` (setup-go/setup-node/uv cache config for go, ts, py, contract-tests jobs)
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: warm-cache CI runs skip cold `npm ci`/module downloads; PR CI time drops.
- **Validation**: green CI run showing cache hits
- **Conventional Commit subject**: `chore(ci): cache go, npm, and uv dependencies`

### 14. Align the version gate with release-please extra-files

- **Paths**: `scripts/verify-version-alignment.sh` (add `cdk/.jsii` `$.version` + `examples/cdk/*/package-lock.json` cdk pins), cross-check that both `release-please-config*.json` extra-files lists match one source
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: every file release-please rewrites is covered by the alignment gate; a deliberate `cdk/.jsii` version skew fails it.
- **Validation**: `./scripts/verify-version-alignment.sh`
- **Conventional Commit subject**: `fix(release): align the version gate with release-please extra-files`

### 15. Fail on stale generated `cdk-go` bindings

- **Paths**: `scripts/verify-cdk-go-drift.sh` (new, wraps `update-cdk-generated.sh` + `git diff --exit-code cdk-go/`), rubric/CI wiring
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: a TS construct change without regenerated Go bindings fails the gate.
- **Validation**: `./scripts/verify-cdk-go-drift.sh`
- **Conventional Commit subject**: `chore(ci): fail on stale generated cdk-go bindings`

### 16. Add purpose headers to repo scripts

- **Paths**: `scripts/*.sh` (the 59 headerless files)
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: every script opens with a 1–3 line purpose/invocation comment; no behavior change (release consolidation stays opportunistic per scope).
- **Validation**: `make rubric`
- **Conventional Commit subject**: `docs(scripts): add purpose headers to repo scripts`

### 17. Reorganize fixtures by behavior domain

- **Paths**: `contract-tests/fixtures/**` (rename `m1..m16`,`p0..p2` → behavior-named dirs; milestone retained as fixture metadata), fixtures README, `docs/reference/contract-fixtures.md`; runners unaffected (item 10's glob)
- **Runtime scope**: none
- **Contract impact**: internal-only (no fixture behavior changes)
- **Acceptance**: directory names describe behavior (routing, middleware, event-sources, websockets, streaming, logging, microvm, ...); fixture count and pass results identical before/after.
- **Validation**: `./scripts/verify-contract-tests.sh` + `./scripts/verify-fixture-schema.sh`
- **Conventional Commit subject**: `test(contract): reorganize fixtures by behavior domain`

## One-path runtime convergence (additive + deprecate)

### 18. Pin the canonical error envelope for framework-emitted errors

- **Paths**: `contract-tests/fixtures/errors/` (new): binding failure, empty body, invalid JSON, panic recovery, 404, method-not-allowed — all asserting the canonical `app.*` envelope; legacy `EMPTY_BODY`/`INVALID_JSON` codes pinned only behind the Lift-compat `HTTPErrorFormat` option
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: fixtures schema-validate and fail for the right reason where runtimes diverge today.
- **Validation**: `./scripts/verify-fixture-schema.sh`; suite green after items 19–21
- **Conventional Commit subject**: `test(contract): pin the canonical error envelope for framework errors`

### 19. Converge Go on the canonical error path

- **Paths**: `runtime/errors.go`, `runtime/portable_error.go`, `runtime/json_handler.go` (deprecation notice, codes preserved behind compat format), `runtime/bind_handler.go`, `api-snapshots/go.txt` (same commit), Go error docs
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: `AppTheoryError` is the documented canonical type; `AppError`/`JSONHandler` carry Deprecated markers but behave unchanged; error fixtures pass in Go.
- **Validation**: `go run ./contract-tests/runners/go --fixtures contract-tests/fixtures` + `./scripts/update-api-snapshots.sh`
- **Conventional Commit subject**: `feat(runtime): converge on the canonical error path and deprecate legacy codes`

### 20. Converge TypeScript on the canonical error path

- **Paths**: `ts/src/errors*.ts`, deprecation JSDoc on legacy helpers, `ts/dist/**` (regenerated, same commit), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: error fixtures pass in TS; legacy surfaces deprecated, unbroken.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `feat(ts): converge on the canonical error path`

### 21. Converge Python on the canonical error path

- **Paths**: `py/src/apptheory/errors.py`, `__init__.py` exports, `api-snapshots/py.txt` (same commit), `py/tests/`
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: error fixtures pass in Python; legacy surfaces deprecated, unbroken.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `feat(py): converge on the canonical error path`

### 22. Pin fail-closed route registration

- **Paths**: `contract-tests/fixtures/routing/` additions: invalid pattern (`/x/{}`), duplicate route, nil/undefined handler → app construction error, canonical error surface
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: fixtures express registration-time failure via `setup` and fail against today's lenient fluent path.
- **Validation**: `./scripts/verify-fixture-schema.sh`; suite green after items 23–25
- **Conventional Commit subject**: `test(contract): pin fail-closed route registration`

### 23. Fail closed on invalid route registration (Go)

- **Paths**: `runtime/serve.go:24` area, `runtime/router.go:92-96` (surface `router.add` errors — panic on fluent path), Deprecated markers on now-redundant `*Strict` variants, `api-snapshots/go.txt` (same commit)
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: a typo'd pattern can no longer register silently; registration fixtures pass.
- **Validation**: `make test-unit` + contract runner
- **Conventional Commit subject**: `feat(runtime): fail closed on invalid route registration`

### 24. Fail closed on invalid route registration (TS)

- **Paths**: `ts/src/app.ts` registration path, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: registration fixtures pass in TS.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `feat(ts): fail closed on invalid route registration`

### 25. Fail closed on invalid route registration (Python)

- **Paths**: `py/src/apptheory/app.py`/`router.py`, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: registration fixtures pass in Python.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `feat(py): fail closed on invalid route registration`

### 26. Pin canonical typed-handler binding semantics

- **Paths**: `contract-tests/fixtures/binding/` (new): body + query + path + header binding, typed conversions (int/bool/float/duration/slices), strict unknown-fields mode, canonical binding-error envelope
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: Go `BindHandler` semantics (`runtime/bind_handler.go`) are the behavioral source, expressed as fixtures that TS/Py currently fail.
- **Validation**: schema gate; suite green after items 27–29
- **Conventional Commit subject**: `test(contract): pin canonical typed-handler binding semantics`

### 27. Align Go binding with the pinned fixtures

- **Paths**: `runtime/bind_handler.go` (converge any divergence; document as the one canonical typed path; steer `JSONValue()` docs toward it), `api-snapshots/go.txt` if surface moves
- **Runtime scope**: go
- **Contract impact**: fixture-first (implementation leg)
- **Acceptance**: binding fixtures pass in Go.
- **Validation**: contract runner (Go)
- **Conventional Commit subject**: `fix(runtime): align BindHandler with the pinned binding fixtures`

### 28. Add the canonical generic typed handler (TS)

- **Paths**: `ts/src/bind-handler.ts` (new: `bindHandler<Req,Resp>`), `ts/src/context.ts` (`jsonValue<T>()` generic overload), `ts/src/index.ts`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: binding fixtures pass in TS; handler/body/params are typed end-to-end.
- **Validation**: `cd ts && npm run check && npm test` + contract runner
- **Conventional Commit subject**: `feat(ts): add the canonical generic typed handler`

### 29. Add the canonical typed handler (Python)

- **Paths**: `py/src/apptheory/bind_handler.py` (new), `__init__.py`, `api-snapshots/py.txt` (same commit), `py/tests/`
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: binding fixtures pass in Python with typed dataclass/annotation-driven binding.
- **Validation**: contract runner + `uv --directory py run pytest -q`
- **Conventional Commit subject**: `feat(py): add the canonical typed handler`

### 30. Pin the validation vocabulary and 422 envelope

- **Paths**: `contract-tests/fixtures/validation/` (new): declarative rules (required, min/max, length, pattern, enum), canonical 422 field-error envelope, multi-error aggregation, interaction with binding errors
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: one validation vocabulary and one 422 shape are pinned; all apps will emit identical validation errors.
- **Validation**: schema gate; suite green after items 31–33
- **Conventional Commit subject**: `test(contract): pin the validation vocabulary and 422 field-error envelope`

### 31. Declarative validation with the canonical 422 (Go)

- **Paths**: `runtime/bind_handler.go` (+ validation tag engine, new file `runtime/validate.go`), `api-snapshots/go.txt` (same commit), docs
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: validation fixtures pass in Go; user `Validate` func remains as an escape-free additive hook after declarative rules.
- **Validation**: contract runner + `make test-unit`
- **Conventional Commit subject**: `feat(runtime): declarative validation with the canonical 422 envelope`

### 32. Declarative validation with the canonical 422 (TS)

- **Paths**: `ts/src/validate.ts` (new), `bind-handler.ts`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: validation fixtures pass in TS.
- **Validation**: contract runner + `npm test`
- **Conventional Commit subject**: `feat(ts): declarative validation with the canonical 422 envelope`

### 33. Declarative validation with the canonical 422 (Python)

- **Paths**: `py/src/apptheory/validate.py` (new), `bind_handler.py`, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: validation fixtures pass in Python.
- **Validation**: contract runner + pytest
- **Conventional Commit subject**: `feat(py): declarative validation with the canonical 422 envelope`

### 34. Pin OpenAPI generation output from typed handlers

- **Paths**: `contract-tests/fixtures/openapi/` (new): given a route table of typed handlers + validation rules, the emitted OpenAPI document is byte-pinned (deterministic ordering)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: one generated wire-contract format, identical across runtimes.
- **Validation**: schema gate; suite green after items 35–37
- **Conventional Commit subject**: `test(contract): pin OpenAPI generation from typed handlers`

### 35. Generate OpenAPI from typed handlers (Go)

- **Paths**: `runtime/openapi.go` (new), `api-snapshots/go.txt` (same commit), docs
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: OpenAPI fixtures pass in Go.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(runtime): generate OpenAPI from typed handlers`

### 36. Generate OpenAPI from typed handlers (TS)

- **Paths**: `ts/src/openapi.ts` (new), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: OpenAPI fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): generate OpenAPI from typed handlers`

### 37. Generate OpenAPI from typed handlers (Python)

- **Paths**: `py/src/apptheory/openapi.py` (new), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: OpenAPI fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): generate OpenAPI from typed handlers`

### 38. Thread `Tier` through the portable serve path

- **Paths**: `runtime/serve.go:236,257,320` (replace `enableP2 bool` with the `Tier` type)
- **Runtime scope**: go
- **Contract impact**: internal-only
- **Acceptance**: no behavior change; fixtures and unit tests unchanged-green; P2-only branches read as tier checks.
- **Validation**: `make test-unit` + contract runner
- **Conventional Commit subject**: `refactor(runtime): thread Tier through the portable serve path`

## Observability (make P2 real)

### 39. Pin request duration in P2 observability records

- **Paths**: `contract-tests/fixtures/observability/` additions (deterministic testkit clock → exact duration values in log/metric records)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: duration field pinned in the observability record shape.
- **Validation**: schema gate; suite green after items 40–42
- **Conventional Commit subject**: `test(contract): pin request duration in observability records`

### 40. Record request duration (Go)

- **Paths**: `runtime/observability.go:48-100` (+duration via injected clock), `api-snapshots/go.txt` (same commit)
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: duration fixtures pass in Go.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(runtime): record request duration in observability records`

### 41. Record request duration (TS)

- **Paths**: `ts/src/` observability path, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: duration fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): record request duration in observability records`

### 42. Record request duration (Python)

- **Paths**: `py/src/apptheory/` observability path, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: duration fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): record request duration in observability records`

### 43. Pin the CloudWatch EMF metric output format

- **Paths**: `contract-tests/fixtures/observability/` EMF additions (exact EMF JSON log lines for request count/duration/error metrics, deterministic values)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: one blessed metric sink format pinned; no plugin system.
- **Validation**: schema gate; suite green after items 44–46
- **Conventional Commit subject**: `test(contract): pin the CloudWatch EMF metric output format`

### 44. First-party EMF metrics sink (Go)

- **Paths**: `pkg/observability/emf.go` (new), `pkg/observability/hooks_apptheory.go` (bridges wire `Metric`), `api-snapshots/go.txt` (same commit)
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: EMF fixtures pass in Go; `HooksFromLogger`-style bridge now populates Metric.
- **Validation**: contract runner + `make test-unit`
- **Conventional Commit subject**: `feat(observability): first-party CloudWatch EMF metrics sink`

### 45. First-party EMF metrics sink (TS)

- **Paths**: `ts/src/emf.ts` (new), hook bridge, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: EMF fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): first-party CloudWatch EMF metrics sink`

### 46. First-party EMF metrics sink (Python)

- **Paths**: `py/src/apptheory/emf.py` (new), hook bridge, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: EMF fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): first-party CloudWatch EMF metrics sink`

### 47. Pin trace-context extraction and error TraceID

- **Paths**: `contract-tests/fixtures/observability/` trace additions (`traceparent` + `X-Amzn-Trace-Id` extraction precedence, TraceID in span/log records and in the error envelope)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: propagation semantics pinned (extraction only; no OTel SDK).
- **Validation**: schema gate; suite green after items 48–50
- **Conventional Commit subject**: `test(contract): pin trace-context extraction and error TraceID`

### 48. Propagate trace context (Go)

- **Paths**: `runtime/request.go`/`context.go` (extract), `runtime/observability.go`, `runtime/portable_error.go` (populate `TraceID`), `api-snapshots/go.txt` (same commit)
- **Runtime scope**: go
- **Contract impact**: api-snapshot-update
- **Acceptance**: trace fixtures pass in Go.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(runtime): propagate trace context into requests and error envelopes`

### 49. Propagate trace context (TS)

- **Paths**: `ts/src/` request/observability/error paths, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: trace fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): propagate trace context into requests and error envelopes`

### 50. Propagate trace context (Python)

- **Paths**: `py/src/apptheory/` request/observability/error paths, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: trace fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): propagate trace context into requests and error envelopes`

### 51. Rewrite the observability feature docs to match the shipped surface

- **Paths**: `docs/features/` observability/logging pages, `README.md` tier table
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: docs describe duration + EMF sink + trace propagation as shipped, and name what remains bring-your-own (full OTel SDK).
- **Validation**: docs build (`pages` job) green
- **Conventional Commit subject**: `docs: describe the shipped P2 observability surface accurately`

## Fixture-coverage backfill

### 52. Backfill rate-limit strategy and window fixtures

- **Paths**: `contract-tests/fixtures/` rate-limit additions (multi-window strategies, limiter-store failure → fail-closed, content-type override edge cases); per-runtime convergence fixes in the same commit if trivial, else immediate follow-ups per parity order
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: `pkg/limited` behavior (3 fixtures today) is pinned across its strategy surface, green in all runtimes.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `test(contract): backfill rate-limit strategy and window fixtures`

### 53. Backfill WebSocket auth and failure fixtures

- **Paths**: `contract-tests/fixtures/` websocket additions (auth-on-connect deny, management-client failure envelope, large frame)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: WebSocket coverage extends beyond the 5 happy-path fixtures, green in all runtimes.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `test(contract): backfill WebSocket auth and failure fixtures`

### 54. Backfill SSE disconnect and heartbeat fixtures

- **Paths**: `contract-tests/fixtures/` streaming additions (client-disconnect mid-stream, heartbeat/keep-alive framing, late-error after first byte)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: SSE edge behavior pinned, green in all runtimes.
- **Validation**: `./scripts/verify-contract-tests.sh`
- **Conventional Commit subject**: `test(contract): backfill SSE disconnect and heartbeat fixtures`

## MCP parity (fixtures → Go convergence → TS → Python)

### 55. Pin the MCP core protocol surface

- **Paths**: `contract-tests/fixtures/mcp/` (new tier): initialize handshake (protocol `2025-11-25`), tools list/call, JSON-RPC error envelopes, malformed-request handling
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: the MCP method surface is specified by fixtures, not by the Go implementation.
- **Validation**: schema gate; Go green after item 59, TS after 60, Py after 64
- **Conventional Commit subject**: `test(contract): pin the MCP core protocol surface`

### 56. Pin MCP resources and prompts

- **Paths**: `contract-tests/fixtures/mcp/` resources/prompts fixtures (list/read/templates, prompt get/render)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: registry behavior pinned.
- **Validation**: schema gate; green per-runtime as implementations land
- **Conventional Commit subject**: `test(contract): pin MCP resources and prompts`

### 57. Pin MCP sessions and streamable HTTP transport

- **Paths**: `contract-tests/fixtures/mcp/` session lifecycle (create/expire/reject), streamable HTTP request/response framing, reserved-path behavior
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: transport + session semantics pinned.
- **Validation**: schema gate; green per-runtime as implementations land
- **Conventional Commit subject**: `test(contract): pin MCP sessions and streamable HTTP transport`

### 58. Pin MCP resumable SSE and task stores

- **Paths**: `contract-tests/fixtures/mcp/` resumable SSE (event ids, replay-from-last-id), task lifecycle against deterministic store fakes
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: resumption + task semantics pinned store-agnostically (DynamoDB specifics stay unit-tested per runtime).
- **Validation**: schema gate; green per-runtime as implementations land
- **Conventional Commit subject**: `test(contract): pin MCP resumable SSE and task semantics`

### 59. Converge Go MCP on the pinned fixtures

- **Paths**: `runtime/mcp/**` (fix any divergence fixtures reveal), Go contract-runner MCP dispatch, `api-snapshots/go.txt` if surface moves
- **Runtime scope**: go
- **Contract impact**: fixture-first (implementation leg)
- **Acceptance**: all `mcp/` fixtures pass in Go — the fixtures arbitrate, not the existing Go code.
- **Validation**: contract runner (Go)
- **Conventional Commit subject**: `fix(runtime): converge Go MCP on the pinned protocol fixtures`

### 60. MCP core server runtime (TS)

- **Paths**: `ts/src/mcp/` (new: JSON-RPC, initialize, tool registry/dispatch), TS runner MCP dispatch, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-55 fixtures pass in TS.
- **Validation**: contract runner + `npm test`
- **Conventional Commit subject**: `feat(ts): MCP core server runtime`

### 61. MCP resources and prompts (TS)

- **Paths**: `ts/src/mcp/` registries, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-56 fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): MCP resources and prompts`

### 62. MCP sessions and streamable HTTP transport (TS)

- **Paths**: `ts/src/mcp/` session + transport (behind the reserved paths in `ts/src/internal/aws-http.ts:126-129`), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-57 fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): MCP sessions and streamable HTTP transport`

### 63. MCP resumable SSE and task/stream stores (TS)

- **Paths**: `ts/src/mcp/` resumable SSE + store interfaces with in-memory + DynamoDB implementations, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-58 fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): MCP resumable SSE and task stores`

### 64. MCP core server runtime (Python)

- **Paths**: `py/src/apptheory/mcp/` (new), Python runner MCP dispatch, `__init__.py` re-exports, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-55 fixtures pass in Python.
- **Validation**: contract runner + pytest
- **Conventional Commit subject**: `feat(py): MCP core server runtime`

### 65. MCP resources and prompts (Python)

- **Paths**: `py/src/apptheory/mcp/`, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-56 fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): MCP resources and prompts`

### 66. MCP sessions and streamable HTTP transport (Python)

- **Paths**: `py/src/apptheory/mcp/` (behind reserved paths in `aws_http.py:16-19`), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-57 fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): MCP sessions and streamable HTTP transport`

### 67. MCP resumable SSE and task/stream stores (Python)

- **Paths**: `py/src/apptheory/mcp/` stores (memory + DynamoDB), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-58 fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): MCP resumable SSE and task stores`

### 68. MCP test doubles in the TS testkit

- **Paths**: `ts/src/testkit.ts` (or `ts/src/testkit/mcp.ts`), mirroring `testkit/mcp/`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: a TS app author can test an MCP server deterministically without AWS.
- **Validation**: `npm test`
- **Conventional Commit subject**: `feat(ts): MCP test doubles in the testkit`

### 69. MCP test doubles in the Python testkit

- **Paths**: `py/src/apptheory/testkit.py` (or `testkit/mcp.py`), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: a Python app author can test an MCP server deterministically without AWS.
- **Validation**: pytest
- **Conventional Commit subject**: `feat(py): MCP test doubles in the testkit`

### 70. TypeScript MCP example server

- **Paths**: `examples/mcp/tools-only-ts/` (new, mirroring the Go example), `examples/README.md`
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: example builds and its testkit-driven test passes in `verify-testkit-examples.sh` scope.
- **Validation**: `./scripts/verify-testkit-examples.sh`
- **Conventional Commit subject**: `docs(examples): TypeScript MCP server example`

### 71. Python MCP example server

- **Paths**: `examples/mcp/tools-only-py/` (new), `examples/README.md`
- **Runtime scope**: py
- **Contract impact**: internal-only
- **Acceptance**: example runs its deterministic test green.
- **Validation**: `./scripts/verify-testkit-examples.sh`
- **Conventional Commit subject**: `docs(examples): Python MCP server example`

## OAuth parity

### 72. Pin OAuth protected-resource metadata and bearer validation

- **Paths**: `contract-tests/fixtures/oauth/` (new tier): RFC 9728 `/.well-known/oauth-protected-resource` responses, bearer accept/reject (expiry, audience, scope), canonical 401/403 envelopes
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: the OAuth surface MCP protection depends on is fixture-specified.
- **Validation**: schema gate; green per-runtime as items 74–78 land
- **Conventional Commit subject**: `test(contract): pin OAuth protected-resource metadata and bearer validation`

### 73. Pin OAuth dynamic client registration and PKCE

- **Paths**: `contract-tests/fixtures/oauth/` DCR + PKCE fixtures (registration flow, code-challenge verification, failure envelopes)
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: DCR/PKCE semantics pinned.
- **Validation**: schema gate; green per-runtime as implementations land
- **Conventional Commit subject**: `test(contract): pin OAuth dynamic client registration and PKCE`

### 74. Converge Go OAuth on the pinned fixtures

- **Paths**: `runtime/oauth/**`, Go runner OAuth dispatch, `api-snapshots/go.txt` if surface moves
- **Runtime scope**: go
- **Contract impact**: fixture-first (implementation leg)
- **Acceptance**: all `oauth/` fixtures pass in Go.
- **Validation**: contract runner (Go)
- **Conventional Commit subject**: `fix(runtime): converge Go OAuth on the pinned fixtures`

### 75. OAuth protected resource and bearer validation (TS)

- **Paths**: `ts/src/oauth/` (new; includes testkit doubles), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-72 fixtures pass in TS.
- **Validation**: contract runner + `npm test`
- **Conventional Commit subject**: `feat(ts): OAuth protected resource and bearer validation`

### 76. OAuth DCR and PKCE (TS)

- **Paths**: `ts/src/oauth/`, `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-73 fixtures pass in TS.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(ts): OAuth dynamic client registration and PKCE`

### 77. OAuth protected resource and bearer validation (Python)

- **Paths**: `py/src/apptheory/oauth/` (new; includes testkit doubles), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-72 fixtures pass in Python.
- **Validation**: contract runner + pytest
- **Conventional Commit subject**: `feat(py): OAuth protected resource and bearer validation`

### 78. OAuth DCR and PKCE (Python)

- **Paths**: `py/src/apptheory/oauth/`, `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: item-73 fixtures pass in Python.
- **Validation**: contract runner
- **Conventional Commit subject**: `feat(py): OAuth dynamic client registration and PKCE`

## Object store parity

### 79. Pin the bounded object-store contract

- **Paths**: `contract-tests/fixtures/objectstore/` (new tier): Put / bounded-Get / Delete semantics against deterministic fakes; forbidden operations (list/presign/multipart) pinned as errors — the narrowness *is* the contract
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: `pkg/objectstore`'s deliberately narrow surface is fixture-specified.
- **Validation**: schema gate; green per-runtime as items 80–82 land
- **Conventional Commit subject**: `test(contract): pin the bounded object-store contract`

### 80. Converge Go objectstore on the pinned fixtures

- **Paths**: `pkg/objectstore/**`, Go runner dispatch, `api-snapshots/go.txt` if surface moves
- **Runtime scope**: go
- **Contract impact**: fixture-first (implementation leg)
- **Acceptance**: objectstore fixtures pass in Go.
- **Validation**: contract runner (Go)
- **Conventional Commit subject**: `fix(runtime): converge Go objectstore on the pinned fixtures`

### 81. Bounded S3 object-store client (TS)

- **Paths**: `ts/src/objectstore.ts` (new, incl. testkit fake), `ts/dist/**` (regen), `api-snapshots/ts.txt` (same commit)
- **Runtime scope**: ts
- **Contract impact**: api-snapshot-update
- **Acceptance**: objectstore fixtures pass in TS.
- **Validation**: contract runner + `npm test`
- **Conventional Commit subject**: `feat(ts): bounded S3 object-store client`

### 82. Bounded S3 object-store client (Python)

- **Paths**: `py/src/apptheory/objectstore.py` (new, incl. testkit fake), `api-snapshots/py.txt` (same commit)
- **Runtime scope**: py
- **Contract impact**: api-snapshot-update
- **Acceptance**: objectstore fixtures pass in Python.
- **Validation**: contract runner + pytest
- **Conventional Commit subject**: `feat(py): bounded S3 object-store client`

## Deployment surface

### 83. Split `cdk-go` into a nested Go module

- **Paths**: `cdk-go/go.mod` + `go.sum` (new), root `go.mod` (drop awscdk/jsii/constructs), `scripts/verify-version-alignment.sh` + `update-cdk-generated.sh` (second module awareness), `release-please-config*.json` extra-files if needed, migration note in `docs/` + `cdk-go` README
- **Runtime scope**: go
- **Contract impact**: internal-only (import paths unchanged; consumer-visible packaging)
- **Acceptance**: `go mod graph` on a runtime-only consumer shows no awscdk/jsii/constructs; `go test ./cdk-go/...` still green from the nested module; migration note published.
- **Validation**: `make test` + `./scripts/verify-cdk-go-drift.sh` + `./scripts/verify-version-alignment.sh`
- **Conventional Commit subject**: `feat(cdk): split cdk-go into a nested Go module`

### 84. Custom domain, certificate, and CORS on the flagship HTTP constructs

- **Paths**: `cdk/lib/http-api.ts`, `cdk/lib/app.ts` (compose `AppTheoryCertificate`/`AppTheoryApiDomain`; CORS props), `cdk/test/`, `cdk-go/**` (regenerated, same commit), `cdk/README.md` entry
- **Runtime scope**: none (deployment)
- **Contract impact**: api-snapshot-update (`cdk/.jsii` surface)
- **Acceptance**: `AppTheoryHttpApi`/`AppTheoryApp` accept domain + auto-validated cert + CORS without dropping to raw CDK.
- **Validation**: `cd cdk && npm test` + `./scripts/verify-cdk-synth.sh` + drift gate
- **Conventional Commit subject**: `feat(cdk): custom domain, certificate, and CORS on AppTheoryHttpApi and AppTheoryApp`

### 85. Attach regional WAF to API stages

- **Paths**: `cdk/lib/enhanced-security.ts` (+`CfnWebACLAssociation` wiring/prop), `cdk/test/`, `cdk-go/**` (regen, same commit)
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii)
- **Acceptance**: the REGIONAL WebACL the package builds can attach to HTTP/REST API stages through props.
- **Validation**: `cd cdk && npm test` + drift gate
- **Conventional Commit subject**: `feat(cdk): attach regional WAF to API stages`

### 86. Log retention on functions and apps

- **Paths**: `cdk/lib/function.ts`, `cdk/lib/app.ts` (explicit log group + retention prop, finite default), `cdk/test/`, `cdk-go/**` (regen, same commit)
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii)
- **Acceptance**: no AppTheory-deployed function defaults to never-expire logs.
- **Validation**: `cd cdk && npm test` + drift gate
- **Conventional Commit subject**: `feat(cdk): log retention on functions and apps`

### 87. First-class VPC props on functions and apps

- **Paths**: `cdk/lib/function.ts`, `cdk/lib/app.ts` (`vpc`/`vpcSubnets`/`securityGroups`), `cdk/test/`, `cdk-go/**` (regen, same commit)
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii)
- **Acceptance**: VPC placement no longer requires the all-or-nothing EnhancedSecurity bundle or raw props spread.
- **Validation**: `cd cdk && npm test` + drift gate
- **Conventional Commit subject**: `feat(cdk): first-class VPC props on functions and apps`

### 88. Alias, provisioned concurrency, and canary deploys

- **Paths**: `cdk/lib/function.ts` (+version/alias/provisioned props), new `cdk/lib/function-deployment.ts` (CodeDeploy canary/linear traffic shifting), `cdk/test/`, `cdk-go/**` (regen, same commit), docs page
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii)
- **Acceptance**: a construct-only path exists for alias-based provisioned concurrency and canary deployment.
- **Validation**: `cd cdk && npm test` + `./scripts/verify-cdk-synth.sh` + drift gate
- **Conventional Commit subject**: `feat(cdk): alias, provisioned concurrency, and canary deployments`

### 89. Observability dashboard and alarm construct

- **Paths**: `cdk/lib/observability.ts` (new: dashboard, latency/duration/error alarms consuming the EMF metrics from items 43–46, SNS alarm actions), `cdk/test/`, `cdk-go/**` (regen, same commit)
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update (jsii)
- **Acceptance**: one construct gives an AppTheory app a dashboard + actionable alarms wired to the runtime's blessed metric names.
- **Validation**: `cd cdk && npm test` + drift gate
- **Conventional Commit subject**: `feat(cdk): observability dashboard and alarm construct`

### 90. Generate the construct inventory in the CDK README

- **Paths**: `cdk/README.md` (complete the ~15 missing constructs), small generator/check script reading `cdk/lib/index.ts` exports, rubric wiring
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: every exported construct appears in the README; the check fails when one is added without a README entry.
- **Validation**: new verify script + `make rubric`
- **Conventional Commit subject**: `docs(cdk): generate the construct inventory in the package README`

## Onboarding

### 91. Deployable hello-world example in three languages

- **Paths**: `examples/cdk/hello-world/` (new: one function + `AppTheoryHttpApi`, Go/TS/Py variants, testkit test each, README with bootstrap→deploy→curl→destroy), `examples/README.md`
- **Runtime scope**: all
- **Contract impact**: internal-only
- **Acceptance**: from a clean clone, README steps produce a `curl`-able endpoint in each language; testkit tests keep it deterministic in CI.
- **Validation**: `./scripts/verify-testkit-examples.sh` + one manual deploy per language
- **Conventional Commit subject**: `docs(examples): deployable hello-world in Go, TypeScript, and Python`

### 92. Carry getting-started through bootstrap and deploy

- **Paths**: `docs/getting-started.md`, `docs/cdk/getting-started.md` (add `cdk bootstrap`, `cdk deploy`, verification, teardown; link hello-world)
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: one doc path goes clean-machine → deployed service; synth is a step, not the destination.
- **Validation**: follow the page verbatim on a fresh environment
- **Conventional Commit subject**: `docs: carry getting-started through bootstrap and deploy`

### 93. Project scaffold generator

- **Paths**: `cmd/apptheory-init/` (new CLI) + `templates/` (per-language app + stack + test, pinned release-asset install), `docs/getting-started.md` entry, `api-snapshots` untouched (CLI not a library surface)
- **Runtime scope**: all
- **Contract impact**: internal-only (new tool; emits the one blessed shape by construction)
- **Acceptance**: `apptheory-init --lang=ts my-app` produces a building, testing, deployable project; generated projects verified in CI like examples. theory-cli integration recorded as a cross-steward follow-up, not blocked on.
- **Validation**: CI job scaffolds all three languages and runs their tests
- **Conventional Commit subject**: `feat(cmd): project scaffold generator`

### 94. Lower the Python and Node floors with CI-matrix proof

- **Paths**: `py/pyproject.toml` (`requires-python`, ruff `target-version`), `ts/package.json` + lockfile (`engines.node`), `cdk/package.json` + lockfile (`engines.node`), `.github/workflows/ci.yml` (Python matrix incl. 3.14, Node matrix incl. 20 and 24), `docs/` compatibility policy note; floors set where TableTheory/toolchain actually bind (targets: Python 3.12, Node 20 LTS)
- **Runtime scope**: py, ts
- **Contract impact**: internal-only
- **Acceptance**: unit + contract tests green on every Python and Node matrix version; TypeScript runtime + CDK package metadata both advertise Node `>=20`; the floor claims are enforced, not asserted.
- **Validation**: CI matrix green + `./scripts/verify-contract-tests.sh` + `cd ts && npm run check` + `cd cdk && npm test`
- **Conventional Commit subject**: `feat(platform): support Python 3.12+ and Node 20+`

### 95. Consumer dependency-automation guide

- **Paths**: `docs/` new page (Renovate github-releases datasource config for AppTheory + TableTheory lockstep bumps; Dependabot notes), linked from install docs
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: a consumer can wire automated bump PRs for release-pinned installs without a registry.
- **Validation**: docs build green; config validated against Renovate schema
- **Conventional Commit subject**: `docs: consumer dependency-automation guide for release-pinned installs`

## Documentation program

### 96. Add `llms.txt` and the reserved llm-faq surface

- **Paths**: `llms.txt` (new, root), `docs/llm-faq/` (create minimal canonical entries or remove the dangling references in `docs/README.md:63` + maintainer guide), Pages config if needed
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: no referenced-but-missing doc surface remains; coding agents get a canonical entry map.
- **Validation**: docs build green; links resolve
- **Conventional Commit subject**: `docs: add llms.txt and resolve the reserved llm-faq surface`

### 97. Operator guide for deployed applications

- **Paths**: `docs/guides/operations.md` (new: debugging deployed apps — cold starts, IAM, event-shape mismatch, CORS, 500-envelope reading; cost; alarming with item 89's construct), nav entry
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: troubleshooting exists for app operators, not just repo contributors.
- **Validation**: docs build green
- **Conventional Commit subject**: `docs: operator guide for deployed applications`

### 98. UPGRADING policy and per-line notes

- **Paths**: `UPGRADING.md` (new, root), release-process doc note on maintaining it per minor line
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: consumers have a v1.x→v1.y upgrade path distinct from the generated CHANGELOG; deprecations from items 19–25 are listed with their replacement.
- **Validation**: docs build green
- **Conventional Commit subject**: `docs: add UPGRADING policy and per-line upgrade notes`

### 99. Exclude the planning corpus from the published site

- **Paths**: `docs/_config.yml` (or move `docs/development/planning/**` + `docs/planning/**` out of the published tree), verify subtree-publish path filters still hold, remove duplicate migration entry point (`docs/migration-guide.md` vs `docs/migration/`)
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: published site contains only canonical pages; planning docs remain in-repo but unpublished; no duplicate entry points.
- **Validation**: Pages build green; spot-check published tree
- **Conventional Commit subject**: `chore(docs): exclude the planning corpus from the published site`

### 100. Docstrings for Python core modules

- **Paths**: `py/src/apptheory/{context,app,router,response,request}.py`
- **Runtime scope**: py
- **Contract impact**: internal-only
- **Acceptance**: every public symbol in the five core modules has a docstring; hover/IDE help is populated.
- **Validation**: `make lint` (pyright/ruff green)
- **Conventional Commit subject**: `docs(py): docstrings for core modules`

### 101. JSDoc for TypeScript core modules

- **Paths**: `ts/src/{context,app,router,response,types}.ts`, `ts/dist/**` (regenerated — JSDoc lands in `.d.ts`, same commit)
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: public symbols in core modules carry JSDoc visible in consumer IDEs.
- **Validation**: `cd ts && npm run check` + dist drift gate
- **Conventional Commit subject**: `docs(ts): JSDoc for core modules`

### 102. Cross-check hand-written API maps against snapshots

- **Paths**: new `scripts/verify-api-docs.sh` (checks `docs/api-reference.md`, `ts/docs/README.md`, `py/docs/README.md`, `cdk/docs/README.md` mention every snapshot-exported top-level symbol), rubric wiring
- **Runtime scope**: none
- **Contract impact**: internal-only
- **Acceptance**: an exported-surface change that skips the hand-written maps fails the gate (same posture as snapshots themselves).
- **Validation**: `./scripts/verify-api-docs.sh`
- **Conventional Commit subject**: `chore(docs): cross-check hand-written API maps against snapshots`

## Maintainability

### 103. Split TS microvm into a module directory

- **Paths**: `ts/src/microvm.ts` (7,368 lines) → `ts/src/microvm/` mirroring `runtime/microvm/`'s file shape; `ts/src/index.ts` re-exports unchanged; `ts/dist/**` (regen); `api-snapshots/ts.txt` must be byte-identical (proves no surface change)
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: no exported-surface or fixture change; file sizes drop below review-tractable thresholds.
- **Validation**: `./scripts/verify-api-snapshots.sh` (unchanged) + contract runner
- **Conventional Commit subject**: `refactor(ts): split microvm into a module directory`

### 104. Split Python microvm into a package

- **Paths**: `py/src/apptheory/microvm.py` (5,525 lines) → `py/src/apptheory/microvm/` package; re-exports preserved; `api-snapshots/py.txt` byte-identical
- **Runtime scope**: py
- **Contract impact**: internal-only
- **Acceptance**: no surface or fixture change.
- **Validation**: `./scripts/verify-api-snapshots.sh` + contract runner
- **Conventional Commit subject**: `refactor(py): split microvm into a package`

### 105. Split Go event-source adapters by source

- **Paths**: `runtime/aws_eventsources.go` (929 lines) → per-source files (`aws_sqs.go`, `aws_kinesis.go`, ...) with the dispatch sniffer isolated; `api-snapshots/go.txt` byte-identical
- **Runtime scope**: go
- **Contract impact**: internal-only
- **Acceptance**: no surface or fixture change.
- **Validation**: `./scripts/verify-api-snapshots.sh` + contract runner
- **Conventional Commit subject**: `refactor(runtime): split event-source adapters by source`

### 106. Re-evaluate TS transitive dependency overrides

- **Paths**: `ts/package.json:27-47` overrides block, `ts/package-lock.json`, `ts/dist/**` if build output shifts
- **Runtime scope**: ts
- **Contract impact**: internal-only
- **Acceptance**: each override is either dropped (upstream fixed) or documented with the CVE/reason it pins; consumers inherit no stale pins.
- **Validation**: `cd ts && npm ci && npm test && npm audit`
- **Conventional Commit subject**: `chore(ts): re-evaluate transitive dependency overrides`

---

## Self-check

- ✅ Every contract-visible change has its fixture item ordered first (18→19-21, 22→23-25, 26→27-29, 30→31-33, 34→35-37, 39→40-42, 43→44-46, 47→48-50, 55-58→59-67, 72-73→74-78, 79→80-82).
- ✅ Every exported-surface change carries its api-snapshot update in the same commit (noted per item); pure refactors pin snapshots byte-identical (103-105).
- ✅ Every TS source change notes `ts/dist` regeneration in the same commit (guarded globally by item 8 thereafter).
- ✅ Every jsii construct change notes `cdk-go` regeneration in the same commit (guarded globally by item 15 thereafter).
- ✅ No item needs a later item to compile or pass: machinery gates (8-15) precede everything they guard; typed handlers (26-29) precede validation (30-33) precede OpenAPI (34-37); EMF (43-46) precedes the dashboard construct (89); glob (10) precedes the tier rename (17); the cdk-go split (83) precedes the construct-growth items (84-89) so regeneration lands once per shape.
- ✅ Taken together the list satisfies all eight success criteria in the scoped need (criterion 1: 55-82 + 70-71; 2: 3, 5, 91-92; 3: 94; 4: 39-50; 5: 83 + 14-15; 6: 18-33 + 22-25; 7: 8-15 + 9-11; 8: 1-2, 6-7, 90, 96-98).

**Not enumerated by rule:** `VERSION`, the two release-please manifests, and lockfile version stamps — release-time artifacts only. The program is additive: every release it produces is a minor.
