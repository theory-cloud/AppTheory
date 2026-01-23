# AppTheory Troubleshooting

This guide maps common symptoms to verified fixes.

## Issue: `verify-version-alignment` fails

**Symptoms:**
- `./scripts/verify-version-alignment.sh` exits non-zero.

**Cause:**
- One of `VERSION`, `ts/package.json`, `py/pyproject.toml`, or `cdk/package.json` drifted.

**Solution:**
✅ CORRECT: bump all versions together and keep lockfiles consistent.

**Verification:**
```bash
./scripts/verify-version-alignment.sh
make rubric
```

## Issue: TypeScript changes don’t take effect

**Symptoms:**
- CI fails with API snapshot drift or runtime behavior mismatch.

**Cause:**
- `ts/dist/**` wasn’t regenerated/committed after editing `ts/src/**`.

**Solution:**
✅ CORRECT:
```bash
cd ts
npm ci
npm run build
```

**Verification:**
```bash
./scripts/update-api-snapshots.sh
make rubric
```

## Issue: response headers appear lowercased

**Symptoms:**
- You set `X-Thing` but see `x-thing` in output.

**Cause:**
- AppTheory canonicalizes response header map keys to lowercase for cross-language parity.

**Solution:**
✅ CORRECT: always treat header names as case-insensitive; write keys in lowercase in tests and examples.

