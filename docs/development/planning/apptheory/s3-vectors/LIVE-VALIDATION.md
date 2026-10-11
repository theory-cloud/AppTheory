# Live Validation: S3 Vectors Semantic Search Example

Date: 2026-07-08
AWS profile: `<aws-profile>`
Account: `<aws-account-id>`
Region: `us-east-1`
Validated stack: `AppTheoryS3VectorsSemanticSearchLive2`

> **Retention note.** This is a historical validation record only. The validation stack referenced here is **not part
> of the current system**: it is not maintained, monitored, or reachable, and no live verification of it is expected.
> The endpoint URL, the AWS account and role identifiers, and the concrete vector bucket and index names have been
> removed from this record, and its request recipes are no longer published here. Do not attempt to call any endpoint
> or resource described below.

## Preflight

Caller identity and Bedrock model access were verified with the operator's SSO profile before deployment. The observed
caller's account and assumed-role identifiers are removed from this record; a valid caller resolved to the target
account in `us-east-1`.

```bash
AWS_PROFILE=<aws-profile> AWS_REGION=us-east-1 aws sts get-caller-identity
```

Bedrock Titan Text Embeddings V2 access was verified before deployment:

```bash
AWS_PROFILE=<aws-profile> AWS_REGION=us-east-1 aws bedrock-runtime invoke-model \
  --model-id amazon.titan-embed-text-v2:0 \
  --content-type application/json \
  --accept application/json \
  --body '{"inputText":"AppTheory S3 Vectors live validation","dimensions":1024,"normalize":true}' \
  --cli-binary-format raw-in-base64-out /tmp/titan.json
```

Observed embedding length: `1024`.

## Deployment

The first deploy of `AppTheoryS3VectorsSemanticSearch` failed before handler creation because `AWS::S3Vectors::Index`
requires `VectorBucketName` to be the bucket name, while the L1 `CfnVectorBucket.ref` resolved to a 111-character value.
That live failure produced the follow-up AppTheory fix: created vector buckets now receive a stable generated lowercase
name and the index uses that name directly.

The validated retry used an isolated stack name:

```bash
cd examples/cdk/s3-vectors-semantic-search
npm ci
AWS_PROFILE=<aws-profile> AWS_REGION=us-east-1 \
  npx cdk deploy -c stackName=AppTheoryS3VectorsSemanticSearchLive2 \
  AppTheoryS3VectorsSemanticSearchLive2 \
  --require-approval never \
  --outputs-file cdk.outputs.json
```

Observed deploy outputs (identifiers removed):

```text
ApiUrl = https://<api-id>.<region>.amazonaws.com
VectorBucketName = <vector-bucket-name>
VectorIndexName = semantic
```

## Runtime validation

The deployed endpoint was exercised for health, seed, and search. The endpoint URL and the request/response recipes are
removed from this record; the observed shapes were:

- **Health** reported `configured: true`, dimension `1024`, the Titan embedding model id, normalized embeddings, and
  the created vector bucket and index.
- **Seed** embedded the four AppTheory sample records and wrote their vectors, reporting `seeded: 4` for the
  `demo`/`apptheory` tenant and namespace.
- **Search** for `middleware ordering` returned the expected top hit
  (`demo/apptheory/02-middleware-ordering`, title `Middleware ordering is part of the contract`) with an S3 Vectors
  distance score.

## Result

Live validation passed: AppTheory CDK created S3 Vectors infrastructure, the Go AppTheory Lambda used the shared
`pkg/vectorstore` Bedrock/S3 Vectors helpers, `/seed` wrote embeddings, and `/search` returned the expected semantic
candidate with metadata from S3 Vectors.
