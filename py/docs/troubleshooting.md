# Python Troubleshooting

## Issue: header casing surprises

**Symptoms:**
- You set `X-Thing` but observe `x-thing` in output.

**Cause:**
- Response header keys are canonicalized to lowercase for parity.

**Solution:**
✅ CORRECT: treat header names as case-insensitive; write lowercase keys in tests and examples.

## Issue: build fails in CI but passes locally

**Symptoms:**
- `./scripts/verify-python-build.sh` fails in CI.

**Cause:**
- Local env differs (missing isolated build tooling, stale virtualenv).

**Solution:**
✅ CORRECT: use the repo’s build verifier from a clean environment.

**Verification:**
```bash
./scripts/verify-python-build.sh
```

