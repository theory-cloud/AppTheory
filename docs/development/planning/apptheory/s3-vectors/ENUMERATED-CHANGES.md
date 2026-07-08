# Enumerated Changes: S3 Vectors and Bedrock Embedding Helpers

### 1. Add the scoped-need, change list, and roadmap artifacts

- **Paths**: `docs/development/planning/apptheory/s3-vectors/*`, `docs/development/planning/apptheory/README.md`
- **Runtime scope**: none
- **Contract impact**: doc-only
- **Acceptance**: The approved scope, flat change list, and roadmap are checked in and linked from the AppTheory planning index.
- **Validation**: `git diff --check`
- **Conventional Commit subject**: `docs(planning): scope S3 Vectors integration`

### 2. Add vector-store and embedding fixtures

- **Paths**: `contract-tests/fixtures/vectorstore/*`, `contract-tests/fixtures/fixture.schema.json`, `contract-tests/fixtures/README.md`
- **Runtime scope**: all
- **Contract impact**: fixture-first
- **Acceptance**: Shared fixtures define fake vector-store operations, validation errors, metadata filters, semantic indexing, and Bedrock Titan request/response behavior without contacting AWS.
- **Validation**: `./scripts/verify-fixture-schema.sh`
- **Conventional Commit subject**: `feat(vectorstore): add semantic vector fixtures`

### 3. Implement Go vector-store and embedding primitives

- **Paths**: `pkg/vectorstore/*`, `contract-tests/runners/go/*`, `go.mod`, `go.sum`, `api-snapshots/go.txt`
- **Runtime scope**: go
- **Contract impact**: fixture-first + api-snapshot-update
- **Acceptance**: Go exposes a fake vector store, S3 Vectors adapter, Titan embedder, and semantic index helper that satisfy the shared fixtures.
- **Validation**: `go test ./... && ./scripts/verify-contract-tests.sh && ./scripts/update-api-snapshots.sh`
- **Conventional Commit subject**: `feat(vectorstore): add Go semantic vector primitives`

### 4. Implement TypeScript vector-store and embedding primitives

- **Paths**: `ts/src/vectorstore.ts`, `ts/src/index.ts`, `ts/dist/*`, `contract-tests/runners/ts/*`, `ts/package.json`, `ts/package-lock.json`, `api-snapshots/ts.txt`
- **Runtime scope**: ts
- **Contract impact**: fixture-first + api-snapshot-update
- **Acceptance**: TypeScript exposes equivalent fake vector store, S3 Vectors adapter, Titan embedder, and semantic index helper, with regenerated checked-in `ts/dist` output.
- **Validation**: `npm --prefix ts run build && npm --prefix ts run check && ./scripts/verify-contract-tests.sh && ./scripts/update-api-snapshots.sh`
- **Conventional Commit subject**: `feat(vectorstore): add TypeScript semantic vector primitives`

### 5. Implement Python vector-store and embedding primitives

- **Paths**: `py/src/apptheory/vectorstore.py`, `py/src/apptheory/__init__.py`, `py/tests/test_vectorstore.py`, `contract-tests/runners/py/*`, `api-snapshots/py.txt`
- **Runtime scope**: py
- **Contract impact**: fixture-first + api-snapshot-update
- **Acceptance**: Python exposes equivalent fake vector store, S3 Vectors adapter, Titan embedder, and semantic index helper while keeping AWS SDK imports lazy.
- **Validation**: `python -m pytest py/tests || python -m unittest discover -s py/tests && ./scripts/verify-contract-tests.sh && ./scripts/update-api-snapshots.sh`
- **Conventional Commit subject**: `feat(vectorstore): add Python semantic vector primitives`

### 6. Add the `AppTheoryVectorIndex` CDK construct

- **Paths**: `cdk/lib/vector-index.ts`, `cdk/lib/index.ts`, `cdk/lib/*.js`, `cdk/lib/*.d.ts`, `cdk/test/constructs.test.cjs`, `cdk/test/snapshots/*`, `cdk-go/*`, `api-snapshots/cdk*.txt` if present
- **Runtime scope**: none
- **Contract impact**: api-snapshot-update
- **Acceptance**: CDK can create an S3 Vectors bucket/index, bind canonical env vars, and grant query/read/write/manage permissions with synthesized snapshot coverage; generated jsii and Go bindings are refreshed.
- **Validation**: `npm --prefix cdk run build && npm --prefix cdk test && bash scripts/verify-cdk-go.sh && ./scripts/update-api-snapshots.sh`
- **Conventional Commit subject**: `feat(cdk): add S3 vector index construct`

### 7. Document semantic-index usage and boundaries

- **Paths**: `docs/features/s3-vectors.md`, `docs/cdk/vector-index.md`, `docs/cdk/README.md`, `docs/cdk/api-reference.md`, `docs/api-reference.md`, `cdk/docs/*`, `README.md` if needed
- **Runtime scope**: all
- **Contract impact**: doc-only
- **Acceptance**: Docs describe the single AppTheory path, Bedrock helper defaults, TableTheory/S3 Vectors boundary, MCP usage pattern, and GitHub Releases-only installation context.
- **Validation**: `git diff --check`
- **Conventional Commit subject**: `docs(vectorstore): document S3 Vectors integration`

### 8. Add a deployable semantic-search example

- **Paths**: `examples/s3-vectors-semantic-search/*`, `examples/README.md`, example lockfiles/build outputs as needed
- **Runtime scope**: go + cdk
- **Contract impact**: example-only
- **Acceptance**: The example deploys an AppTheory Lambda and `AppTheoryVectorIndex`, writes sample chunks with Bedrock embeddings, queries S3 Vectors, and exposes a minimal HTTP API for live validation.
- **Validation**: `make test-unit` plus example-specific build/synth commands
- **Conventional Commit subject**: `feat(examples): add S3 Vectors semantic search app`

### 9. Validate the example live with the TheoryCloud AWS profile

- **Paths**: `examples/s3-vectors-semantic-search/README.md`, optional validation transcript under `docs/development/planning/apptheory/s3-vectors/`
- **Runtime scope**: go + cdk
- **Contract impact**: doc-only/example evidence
- **Acceptance**: The example is deployed with profile `TheoryCloud`, seeded, queried, and documented with exact commands and observed outputs.
- **Validation**: `AWS_PROFILE=TheoryCloud <example deploy/seed/query commands>` and `make rubric` or the strongest feasible local gate
- **Conventional Commit subject**: `docs(examples): record S3 Vectors live validation`
