# API Snapshots (Parity Gate)

This folder contains **generated, versioned snapshots** of the **public API surface** for:

- Go: exported surfaces across `runtime/`, `pkg/`, `testkit/`
- TypeScript: `ts/dist/index.d.ts`
- Python: `py/src/apptheory/__init__.py` (`__all__`)

These snapshots are used by CI to fail closed on **API drift**.

## Update snapshots

Run:

`./scripts/update-api-snapshots.sh`

Then commit the resulting changes in `api-snapshots/`.

