# AppTheory — Multi-language Serverless Application Framework (Go, TypeScript, Python)

AppTheory is a TableTheory-style multi-language monorepo for building serverless applications with a **shared runtime
contract** and **cross-language drift prevention**.

Distribution: **GitHub Releases only** (no npm/PyPI publishing).

## Charter (M0)

AppTheory exists to provide a **portable runtime core** (and contract tests) for AWS serverless applications that must be
first-class in **Go, TypeScript, and Python**.

Target audiences and use cases:

- Platform and application teams building HTTP APIs on AWS Lambda (Lambda Function URL, API Gateway v2).
- Event-driven workloads (SQS, EventBridge, etc.) once fixture-backed by contract tests.
- Internal tooling and shared libraries that need consistent request/response semantics across languages.

Non-goals (near-term):

- Not a general-purpose web framework; contract-first serverless runtime only.
- Not registry-published packages (no npm or PyPI); releases ship via GitHub assets.

## Public Names (M0)

- Go module path: `github.com/theory-cloud/apptheory`
- npm package: `@theory-cloud/apptheory`
- Python distribution name: `apptheory`
- Python import name: `apptheory`

## Supported Runtimes (M0)

- Go toolchain: `1.25.6`
- Node.js: `24`
- Python: `3.14`

Start here:

- Planning index: `docs/development/planning/apptheory/README.md`
- Main roadmap: `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`
