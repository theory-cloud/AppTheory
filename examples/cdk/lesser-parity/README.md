# Lesser Parity Example

This example demonstrates **complete AppTheory CDK parity** with the patterns previously implemented using Lift CDK in the Lesser project. It contains **NO Lift CDK imports** and serves as the migration validation gate for sunsetting Lift CDK.

## What This Proves

This single stack successfully synthesizes all the core infrastructure patterns from Lesser:

### M1 — REST API v1 Router
- Multi-Lambda route mapping (SSE, GraphQL, catch-all)
- **Full response streaming integration** (`responseTransferMode: STREAM`, `/response-streaming-invocations`, 15-minute timeout)
- Stage controls (logging, metrics, throttling)
- CORS configuration

### M2 — SQS Queue + DLQ + Consumer
- Queue with dead letter queue
- Consumer with full event-source options (`batchSize`, `maxBatchingWindow`, `reportBatchItemFailures`, `maxConcurrency`)
- Composable pattern (separate queue and consumer)

### M3 — DynamoDB with Deletion Protection
- Table with `deletionProtection: true`
- Point-in-time recovery
- GSI support
- Stream enablement

### M4 — CloudFront Distributions
- **Path-routed frontend** with multi-SPA behind one stage domain (`/l/*`, `/auth/*`)
- API bypass paths (`/auth/wallet/*`)
- CloudFront Function for SPA viewer-request rewrite
- **Separate media CDN** distribution

### M5 — Lambda Roles via AppTheoryLambdaRole
- X-Ray tracing enablement
- Environment encryption KMS keys
- Custom IAM policy statements

## Project Structure

```
lesser-parity/
├── bin/
│   └── app.ts              # CDK app entry point
├── lib/
│   └── lesser-parity-stack.ts  # Main stack with all constructs
├── handlers/
│   ├── api.mjs             # General API handler
│   ├── graphql.mjs         # GraphQL handler
│   ├── sse.mjs             # SSE streaming handler
│   └── worker.mjs          # SQS queue worker
├── snapshots/
│   └── LesserParityExample.template.sha256  # Synth verification
├── package.json
├── tsconfig.json
└── cdk.json
```

## Usage

```bash
# Install dependencies
npm install

# Synthesize the stack
npm run synth

# Deploy (requires AWS credentials)
npm run deploy
```

## Verification

This example is included in the repository's deterministic synth verification:

```bash
./scripts/verify-cdk-synth.sh
```

The synthesized template hash is pinned in `snapshots/LesserParityExample.template.sha256`. Any changes to the construct behavior will cause the verification to fail.

## Acceptance Criteria (from M6)

✅ Example contains **NO** Lift CDK imports  
✅ REST API v1 routes: SSE → `sseFn`, `/api/graphql` → `graphqlFn`, `/{proxy+}` → `apiFn`  
✅ Streaming routes synthesize with `STREAM` + `/response-streaming-invocations` + `900000`  
✅ SQS queue with DLQ and consumer mapping  
✅ DynamoDB table with deletion protection enabled  
✅ CloudFront path-routed frontend + media CDN  
✅ Lambda roles created via `AppTheoryLambdaRole`  
✅ Synth output is pinned and verified in CI/`make rubric`

## Outputs

After deployment, the following outputs are available:

| Output | Description |
|--------|-------------|
| `ApiUrl` | REST API base URL |
| `SseUrl` | SSE streaming endpoint |
| `GraphqlUrl` | GraphQL endpoint |
| `TableName` | DynamoDB table name |
| `QueueUrl` | SQS queue URL |
| `DlqUrl` | SQS dead letter queue URL |
| `FrontendDomain` | CloudFront frontend domain |
| `MediaCdnDomain` | CloudFront media CDN domain |
| `ApiRoleArn` | API Lambda execution role ARN |
| `WorkerRoleArn` | Worker Lambda execution role ARN |
| `ClientBucketName` | Client SPA S3 bucket |
| `AuthBucketName` | Auth SPA S3 bucket |
| `MediaBucketName` | Media CDN S3 bucket |

## Migration Guide

To migrate from Lift CDK to AppTheory CDK:

1. Replace Lift CDK imports with AppTheory CDK imports
2. Use this example as a reference for construct usage
3. Run `npx cdk diff` to compare synthesized outputs
4. Verify with `./scripts/verify-cdk-synth.sh`

See [Migration Guide](../../../cdk/docs/migration-guide.md) for detailed instructions.
