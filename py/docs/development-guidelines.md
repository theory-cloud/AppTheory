# Python Development Guidelines

## Project layout

- Source: `py/src/apptheory/`
- Tests: `py/tests/`

## Commands

Lint (ruff) from repo root:
```bash
./scripts/verify-python-lint.sh
```

Build (wheel + sdist) from repo root:
```bash
./scripts/verify-python-build.sh
```

## API snapshots

If you change exports, update snapshots and commit the results:

```bash
./scripts/update-api-snapshots.sh
```

