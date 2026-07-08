# Scoped Need: S3 Vectors and Bedrock Embedding Helpers

## Background

Amazon S3 Vectors is now a managed AWS vector storage and query surface. KnowledgeTheory already uses S3 Vectors with
Bedrock Titan Text Embeddings V2 for its live semantic retrieval path, alongside DynamoDB/TableTheory for canonical
content. AppTheory should extract the AppTheory-relevant pieces from that live pattern: repeatable CDK infrastructure,
canonical environment and IAM wiring, cross-language embedding helpers, and a narrow vector-store facade that prevents
Go, TypeScript, and Python applications from drifting.

## Problem

AppTheory applications that need semantic ingest, semantic retrieval, MCP memory, or RAG currently have to hand-roll the
same failure-prone pieces: vector bucket and index CDK, grants, environment variables, Bedrock `InvokeModel` request
shape, embedding dimension validation, S3 Vectors request batching, metadata filter serialization, and canonical error
handling. That encourages raw SDK usage and product-local conventions instead of the single AppTheory path.

## Users and beneficiaries

- Framework users building import pipelines that transform S3 objects or job records into semantic indexes.
- AppTheory MCP servers that need explicit semantic retrieval or memory tools.
- KnowledgeTheory-like services that keep canonical records in TableTheory/DynamoDB and use S3 Vectors only for recall.
- Operators who need one deployment surface for S3 Vectors resources and Bedrock embedding permissions.

## Success criteria

- AppTheory exports an additive cross-language vector-store contract in Go, TypeScript, and Python with deterministic fake
  behavior for tests.
- AppTheory exports a Bedrock Titan embedding helper in Go, TypeScript, and Python with fixed defaults for Titan Text
  Embeddings V2, dimension validation, and fail-closed malformed-response handling.
- Shared contract fixtures prove vector-store validation, batching, metadata filtering, embedding request shape, and
  semantic-index composition parity across all three runtimes.
- AppTheory CDK exports an `AppTheoryVectorIndex` construct that creates or references an S3 vector bucket/index, binds
  canonical environment variables, and grants least-privilege query/read/write/manage permissions.
- Documentation explains the single path: TableTheory remains canonical persistence; S3 Vectors is the semantic recall
  plane; Bedrock helpers are explicit runtime primitives, not implicit middleware.
- A deployable example application proves the CDK + runtime path against the `TheoryCloud` AWS profile.

## Contract impact

Additive growth. This introduces a new service/helper contract and a new CDK construct, but it does not change existing
runtime routing, middleware tiers, error envelopes, or deployment behavior. The contract must grow through new fixtures
and API snapshots because the vector-store and embedding helpers are exported cross-language surfaces.

## Nearest existing surface

- `AppTheoryS3Ingest`, `AppTheoryJobsTable`, `AppTheoryQueueConsumer`, and import-pipeline docs already define the
  surrounding pipeline primitives.
- `pkg/objectstore`, `ts/src/objectstore.ts`, and `py/src/apptheory/objectstore.py` provide the closest precedent: a
  deliberately narrow AWS facade with deterministic fake behavior and contract fixtures.
- `AppTheoryMcpServer` is the nearest retrieval consumer, but semantic lookup must remain explicit app/tool logic rather
  than hidden middleware.

## Out of scope

- A generic multi-vector-database abstraction.
- Bedrock Knowledge Bases orchestration.
- OpenSearch Serverless migration or activation.
- App-specific chunking strategies, KnowledgeTheory metadata fields, or KnowledgeTheory query classification logic.
- Automatic retrieval middleware or a new runtime tier.
- Using S3 Vectors as canonical persistence; canonical records stay in TableTheory/DynamoDB or app-owned stores.

## Open questions

- Whether later milestones should add optional chunking helpers after multiple consumers converge on a portable chunk
  contract.
- Whether non-Titan embedding providers deserve AppTheory helpers. The initial answer is no until there is an AppTheory
  use case with a repeatable contract.
