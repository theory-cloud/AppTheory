# AppTheory Planning (Migration + Multi-language Buildout)

This folder is the project plan for creating **AppTheory** as a **TableTheory-style multi-language monorepo**:

- Go at repo root
- TypeScript in `ts/`
- Python in `py/`
- Shared, fixture-driven contract tests in `contract-tests/`
- Distribution via **GitHub Releases only** (no npm/PyPI publishing)

Primary goals:

- First-class user experience in Go/TypeScript/Python (not “ports” or wrappers).
- Strong drift prevention via a versioned **runtime contract** + **contract tests**.
- A pragmatic, low-friction migration path for existing Lift users (easy, not drop-in).
- Preserve/extend Lift’s CDK and AWS mock tooling (with a clear cross-language strategy).

## Start here

- `docs/development/planning/apptheory/apptheory-multilang-roadmap.md` (primary roadmap + acceptance criteria)
- `docs/development/planning/apptheory/apptheory-full-alignment-roadmap.md` (union-of-capabilities parity plan + acceptance criteria)
- `docs/development/planning/apptheory/apptheory-facetheory-support-roadmap.md` (FaceTheory enablement: Lambda URL + streaming SSR)
- `docs/development/planning/apptheory/apptheory-gap-analysis.md` (current gaps + remediation roadmap)
- `docs/development/planning/apptheory/apptheory-gap-analysis-lift-parity.md` (Lift parity gaps for Pay Theory: Autheory + K3, plus Lesser)
- `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md` (Lift parity gaps derived from `equaltoai/lesser`)

## Sub-roadmaps (deep workstreams)

- `docs/development/planning/apptheory/subroadmaps/SR-CONTRACT.md` (runtime contract + contract tests)
- `docs/development/planning/apptheory/subroadmaps/SR-RELEASE.md` (GitHub Releases only, supply-chain, version alignment)
- `docs/development/planning/apptheory/subroadmaps/SR-CDK.md` (CDK strategy: examples → constructs via jsii)
- `docs/development/planning/apptheory/subroadmaps/SR-CDK-LIFT-SUNSET.md` (CDK gaps blocking full Lift CDK sunset; Lesser)
- `docs/development/planning/apptheory/subroadmaps/SR-MOCKS.md` (AWS mocks + local testkits per language)
- `docs/development/planning/apptheory/subroadmaps/SR-PROD-FEATURES.md` (multi-tenant/auth/observability/rate limits)
- `docs/development/planning/apptheory/subroadmaps/SR-MIDDLEWARE.md` (middleware pipeline + `ctx.Set/Get` parity)
- `docs/development/planning/apptheory/subroadmaps/SR-SERVICES.md` (Lift `pkg/services` parity; start: EventBus)
- `docs/development/planning/apptheory/subroadmaps/SR-SANITIZATION.md` (safe logging + redaction utilities)
- `docs/development/planning/apptheory/subroadmaps/SR-NAMING.md` (deterministic naming helpers)
- `docs/development/planning/apptheory/subroadmaps/SR-MIGRATION.md` (Lift → AppTheory migration plan)
- `docs/development/planning/apptheory/subroadmaps/SR-EVENTSOURCES.md` (SQS/EventBridge/DynamoDB Streams parity)
- `docs/development/planning/apptheory/subroadmaps/SR-WEBSOCKETS.md` (WebSocket runtime + `streamer` parity)
- `docs/development/planning/apptheory/subroadmaps/SR-SSE.md` (API Gateway REST v1 + SSE streaming parity)
- `docs/development/planning/apptheory/subroadmaps/SR-STREAMING.md` (response streaming contract + Lambda URL streaming handler + streaming testkit)
- `docs/development/planning/apptheory/subroadmaps/SR-SSR-INFRA.md` (CloudFront + S3 + Lambda URL deployment pattern)
- `docs/development/planning/apptheory/subroadmaps/SR-LINT.md` (lint parity across Go/TS/Py)

## Supporting docs (living references)

- `docs/development/planning/apptheory/supporting/apptheory-repo-layout.md`
- `docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md`
- `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`
- `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md`
- `docs/development/planning/apptheory/supporting/apptheory-full-alignment-parity-target.md`
- `docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`
- `docs/development/planning/apptheory/supporting/apptheory-governance-note.md`
