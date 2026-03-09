# AppTheory Troubleshooting (Example)

This file is an example for `docs/troubleshooting.md`.

## Quick Diagnosis

| Symptom | Likely Cause | First Check |
|---|---|---|
| Version alignment script fails | Manifest/version drift | `./scripts/verify-version-alignment.sh` |
| API docs drift detected | Snapshots not refreshed | `./scripts/update-api-snapshots.sh` |
| Header assertion case mismatch | Expected mixed-case output keys | Header normalization assumptions |

## Common Issues

### Issue: Version alignment failure

**Cause**
- `VERSION`, TS, Python, and/or CDK manifests are out of sync.

**Fix**

```bash
./scripts/verify-version-alignment.sh
```

**Verify**

```bash
./scripts/verify-version-alignment.sh
make rubric
```

### Issue: API reference and export mismatch

**Cause**
- Public symbol changes were not reflected in `api-snapshots/*`.

**Fix**

```bash
./scripts/update-api-snapshots.sh
```

**Verify**

```bash
./scripts/update-api-snapshots.sh
make rubric
```

## Getting Help

- Capture the exact failing command and output.
- Include affected file paths and recent change context.
- Open a maintainer issue with reproduction steps.
- No canonical issue template is defined under `.github/ISSUE_TEMPLATE/`; include reproduction steps directly in the issue or PR body.
