# AppTheory Troubleshooting

This guide organizes common failures into symptom, cause, solution, and verification.

## Quick Diagnosis

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| `./scripts/verify-version-alignment.sh` fails | `VERSION`, `ts/package.json`, `py/pyproject.toml`, and `cdk/package.json` are out of sync | `VERSION`, package manifests, `Makefile`, existing troubleshooting docs |
| TypeScript changes do not appear in CI or snapshots | `ts/dist/**` was not regenerated after source changes | `ts/package.json`, `docs/development-guidelines.md`, `docs/troubleshooting.md` |
| Response header assertions fail because keys are lowercase | AppTheory canonicalizes output header map keys | `docs/core-patterns.md`, `docs/_patterns.yaml`, existing troubleshooting docs |

## Common Issues

### Issue: Version alignment verification fails

**Symptoms:**
- `./scripts/verify-version-alignment.sh` exits non-zero
- `make test` or `make rubric` fails after a version bump

**Cause:**
- One or more of `VERSION`, `ts/package.json`, `py/pyproject.toml`, or `cdk/package.json` were updated independently

**Solution:**

```bash
# CORRECT: align all package/version files, then re-run the verification script
./scripts/verify-version-alignment.sh
```

If the script still fails, review the four version-bearing files together and update them as a single change.

**Verification:**

```bash
./scripts/verify-version-alignment.sh
make rubric
```

### Issue: TypeScript source changes do not take effect

**Symptoms:**
- API snapshot drift appears after editing `ts/src/**`
- CI or local verification still reflects old TypeScript behavior

**Cause:**
- `ts/dist/**` was not rebuilt and committed after the source change

**Solution:**

```bash
# CORRECT
cd ts
npm ci
npm run build
```

Then refresh the snapshot evidence if exported interfaces changed.

**Verification:**

```bash
./scripts/update-api-snapshots.sh
make rubric
```

### Issue: Response headers appear lowercased

**Symptoms:**
- You set `X-Request-Id` but tests or logs show `x-request-id`

**Cause:**
- AppTheory canonicalizes response header map keys to lowercase for cross-language parity

**Solution:**

```text
CORRECT: treat headers as case-insensitive on input and assert lowercase output keys in examples and tests.
```

**Verification:**

```text
Update tests and docs to assert lowercase response header keys, then rerun the affected verification command.
```

## Getting Help

- Prefer adding verified symptom -> fix entries here rather than burying operational knowledge in ad hoc notes.
- If a recurring issue depends on undocumented behavior, add a `TODO:` in the affected docs and confirm the interface from the canonical sources before publishing new guidance.
