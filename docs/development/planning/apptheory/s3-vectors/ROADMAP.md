# Roadmap: S3 Vectors and Bedrock Embedding Helpers

## Goal

Deliver S3 Vectors as AppTheory's blessed semantic recall plane for Lambda applications: contract-tested cross-language
vector and embedding primitives, a CDK deployment construct, explicit documentation, and a live deployable example that
uses Bedrock Titan embeddings and S3 Vectors without introducing raw SDK escape hatches or a second data path.

## Phases

### Phase 1: Planning foundation

**Milestone candidates:**
- **SV-M0 Planning** — Preserve the scoped need, flat change list, and roadmap before implementation starts.
  - Items: 1
  - Dependencies: approved scoped need
  - Risks: none

### Phase 2: Runtime contract and parity

**Milestone candidates:**
- **SV-M1 Contract + parity primitives** — Add the vector-store fixtures and converge Go, TypeScript, and Python on the same deterministic vector, embedding, and semantic-index behavior.
  - Items: 2, 3, 4, 5
  - Dependencies: SV-M0 Planning
  - Risks:
    - AWS SDKs expose S3 Vectors and Bedrock request shapes differently by language; fixtures must pin AppTheory's shape rather than mirror a single SDK.
    - Python must keep AWS SDK imports lazy so local tests do not require boto3.
    - TypeScript `ts/dist` must be regenerated in the same commit as `ts/src` changes.

### Phase 3: Deployment surface and documentation

**Milestone candidates:**
- **SV-M2 CDK + docs** — Make S3 Vectors deployable through AppTheory CDK and document the TableTheory/S3 Vectors/Bedrock boundary.
  - Items: 6, 7
  - Dependencies: SV-M1 Contract + parity primitives
  - Risks:
    - `aws-cdk-lib/aws-s3vectors` is L1-only, so grant helpers and env binding must be AppTheory-owned.
    - jsii prop shapes must remain Go-bindings friendly; `cdk-go/` is generated, not hand-edited.

### Phase 4: Example and live validation

**Milestone candidates:**
- **SV-M3 Live example** — Ship and validate a deployable semantic-search example against the TheoryCloud AWS profile.
  - Items: 8, 9
  - Dependencies: SV-M2 CDK + docs
  - Risks:
    - Bedrock model access can be region/account dependent; the example must fail closed with a clear diagnostic if Titan embedding access is not enabled.
    - Live deployment mutates AWS resources; use an AppTheory-owned example stack with explicit names and retain/destroy behavior documented.

## Cross-phase risks

- Release train discipline: all work stays on a dedicated branch from current `origin/staging`; no direct pushes to
  protected branches and no version bumps outside release automation.
- API snapshots must move with exported surfaces in the same milestone commit.
- Contract fixtures are the specification; any divergence between Go, TypeScript, and Python is a framework bug.
- S3 Vectors service limits and query result limits have changed since launch, so hard-coded limits must either reflect
  current AWS limits or be AppTheory-configurable with safe validation.

## Cross-repo dependencies

- No required TableTheory or FaceTheory changes. TableTheory remains the canonical record store when an app needs
  durable structured state.
- KnowledgeTheory may later consume these helpers, but this roadmap does not require changing KnowledgeTheory.

## Deprecation and migration plan

No deprecation is required. This is an additive AppTheory surface. Existing applications using raw S3 Vectors SDK calls
can migrate by replacing infrastructure with `AppTheoryVectorIndex`, replacing product-local embedding clients with the
AppTheory Titan helper, and replacing direct vector operations with `VectorStore`/`SemanticIndex` primitives.

## Open questions

- Should a future milestone add a portable chunking helper after more than one AppTheory consumer converges on chunking
  semantics?
- Should AppTheory eventually support non-Titan embedding providers, or should those remain app-owned until a second live
  Theory Cloud use case proves a shared contract?
