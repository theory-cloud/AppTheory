# ADR 0001 — CDK Constructs via TypeScript-first jsii

Status: accepted

## Context

AppTheory needs a first-class deployment story that preserves Lift’s CDK experience while remaining **first-class for
Go/TypeScript/Python users**.

If constructs are authored in a single language without multi-language bindings, infra patterns will drift and only one
language will remain “native”.

## Decision

AppTheory will ship CDK constructs as a **TypeScript-first `jsii` library**, with generated bindings for Go and Python.

## How constructs are tested

- Constructs are verified using **snapshot tests**:
  - build a stack using the construct(s)
  - synthesize the CloudFormation template
  - compare JSON output to committed snapshots
- Each construct must be exercised by at least one example stack.

## Versioning

- The constructs package version is **aligned to the repo `VERSION`** (same policy as the runtime SDKs).
- Any breaking changes follow the repo’s versioning and release notes policy.

## Distribution

AppTheory uses **GitHub Releases only**.

- TypeScript: ship an `npm pack` tarball for the constructs package.
- Python: ship a wheel + sdist for the constructs package.
- Go: ship the generated Go bindings as source (consumable via `go get` by tag) and/or as a release artifact bundle.

No publishing to npm or PyPI.

## Alternatives considered

- **Go-only constructs**: fastest short-term, but makes TS/Py second-class and encourages drift.
- **Examples/templates only**: acceptable as a bootstrap strategy, but does not preserve Lift’s “reusable defaults”
  posture.

## References

- `docs/development/planning/apptheory/subroadmaps/SR-CDK.md`

