# Import Pipeline Example (Support Pack)

This example is the end-to-end reference stack for the “Import Pipeline Support Pack” (Issue `#169`).

It demonstrates the baseline wiring for an import pipeline:

1) S3 ingest (bucket → EventBridge)
2) Ingest handler creates a job + enqueues per-record work
3) SQS worker processes records with:
   - job ledger record status updates
   - idempotency records (exactly-once-ish)
   - safe logging (sanitized error envelopes)
4) Optional batch primitive (CodeBuild project) for non-Lambda steps

## Commands

```bash
npm ci
npx cdk synth
```

## Notes

- This stack is designed to be deterministic for CI `cdk synth` snapshot verification.

