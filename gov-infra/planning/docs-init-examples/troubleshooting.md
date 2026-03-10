# AppTheory Troubleshooting

This is an example target for `docs/troubleshooting.md`, organized by symptom and verified fix path.

## Quick Diagnosis

| Symptom | First check | Expected next step |
| --- | --- | --- |
| Version checks fail early | `./scripts/verify-version-alignment.sh` | Align version metadata and rerun |
| API docs differ from exports | `./scripts/verify-api-snapshots.sh` | Regenerate snapshots and verify |
| Behavior differs by language/runtime | `./scripts/verify-contract-tests.sh` | Fix parity and rerun tests |

## Common Issues

### Issue: version alignment check fails

**Symptoms**
- `./scripts/verify-version-alignment.sh` exits non-zero.

**Solution**
```bash
./scripts/verify-version-alignment.sh
make rubric
```

**Verification**
- Alignment script passes and rubric proceeds.

### Issue: API snapshot drift after code changes

**Symptoms**
- `./scripts/verify-api-snapshots.sh` fails.

**Solution**
```bash
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
```

**Verification**
- Snapshot verification passes with intentional diff only.

### Issue: route appears registered but never matches

**Symptoms**
- Requests return `404` unexpectedly.

**Solution**
- Use strict route registration and fail on invalid patterns.

**Verification**
- Route-matching tests pass and invalid patterns fail fast.

## Getting Help

- Capture failing command output, expected behavior, and actual behavior.
- Open a focused issue with reproduction steps and environment details.
