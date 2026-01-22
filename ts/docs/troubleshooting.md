# TypeScript Troubleshooting

## Issue: `ts/dist` drift

**Symptoms:**
- CI fails on API snapshots or contract tests after a TypeScript change.

**Cause:**
- `ts/src/**` changed but `ts/dist/**` wasn’t regenerated and committed.

**Solution:**
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

## Issue: header casing surprises

**Symptoms:**
- You set `X-Thing` but observe `x-thing` in output.

**Cause:**
- Response header keys are canonicalized to lowercase for parity.

**Solution:**
✅ CORRECT: treat header names as case-insensitive; write lowercase keys in tests and examples.

