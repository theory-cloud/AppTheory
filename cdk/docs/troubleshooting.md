# CDK Troubleshooting

## Issue: synth fails in CI

**Symptoms:**
- `./scripts/verify-cdk-synth.sh` fails.

**Cause:**
- Breaking change in a construct, missing dependency, or example drift.

**Solution:**
✅ CORRECT:
1. Run the synth verifier locally.
2. Fix the construct/example so synth is deterministic again.

**Verification:**
```bash
./scripts/verify-cdk-synth.sh
make rubric
```

