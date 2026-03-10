# AppTheory Development Guidelines

This is an example target for `docs/development-guidelines.md`.

## Standards

- Keep canonical docs aligned with runtime behavior and verified evidence.
- Use snapshot evidence (`api-snapshots/go.txt`, `api-snapshots/ts.txt`, `api-snapshots/py.txt`) before documenting API changes.
- Keep examples deterministic and runnable in CI.
- Record unknowns explicitly instead of guessing.

## Review Checklist

- `docs/api-reference.md` reflects current, snapshot-backed interfaces.
- `docs/core-patterns.md` contains both **CORRECT** and **INCORRECT** examples.
- `docs/testing-guide.md` lists active verification commands.
- `docs/troubleshooting.md` includes symptom, fix, and verification guidance.
- `docs/migration-guide.md` remains task-oriented for users.

## Documentation Expectations

- Update documentation in the same change that alters public behavior.
- Prefer clear headings, short procedures, and concrete command examples.
- Avoid planning-only notes in canonical docs pages.
- Keep terminology and links consistent across the docs set.
