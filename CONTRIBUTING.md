# Contributing to AppTheory

Thank you for your interest in AppTheory. This document explains how to report issues, run tests, and submit changes.

## Reporting Issues

Open a [GitHub issue](https://github.com/theory-cloud/AppTheory/issues) with:

- What you expected to happen
- What actually happened
- Runtime and language (Go, TypeScript, or Python)
- Minimal reproduction steps

## Development Setup

```bash
git clone https://github.com/theory-cloud/AppTheory.git
cd AppTheory

# Go
go mod download

# TypeScript
(cd ts && npm ci)

# Python
(cd py && python -m pip install -e .)

# CDK
(cd cdk && npm ci)
```

Prerequisites: Go 1.26+, Node.js 24+, Python 3.14+, `make`, `git`.

## Running Tests

```bash
# Go unit tests
go test ./runtime/... ./pkg/... ./testkit/...

# TypeScript tests
(cd ts && npm run check)

# Python tests
(cd py && python -m pytest)

# CDK construct tests
(cd cdk && npm test)

# Contract tests (cross-language parity)
make contract-tests
```

**Contract tests are required.** Any change that affects cross-language behavior must pass all three language runners.
The contract test fixtures in `contract-tests/fixtures/` define the expected behavior — the Go, TypeScript, and Python
runtimes are independently verified against these fixtures.

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Make your changes. Add or update tests as needed.
3. Ensure all tests pass, including contract tests if your change affects runtime behavior.
4. Open a pull request with a clear description of what changed and why.

Keep PRs focused. One logical change per PR is easier to review than a bundle of unrelated changes.

## Code of Conduct

Be respectful, constructive, and professional. We're building tools that people rely on in production.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
