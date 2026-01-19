# Contract Tests

Shared, fixture-driven contract tests that validate runtime behavior across Go/TypeScript/Python.

Fixtures live in `contract-tests/fixtures/` and are executed by per-language runners:

- Go: `go run ./contract-tests/runners/go`
- TypeScript/Node: `node contract-tests/runners/ts/run.cjs`
- Python: `python3 contract-tests/runners/py/run.py`
