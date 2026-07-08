# Live Validation: S3 Vectors Semantic Search Example

Date: 2026-07-08
AWS profile: `TheoryCloud`
Account: `497086312543`
Region: `us-east-1`
Validated stack: `AppTheoryS3VectorsSemanticSearchLive2`

## Preflight

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 aws sts get-caller-identity
```

Observed caller:

```json
{
  "UserId": "AROAXHPFHGBP4ERBD54T2:aron@paytheory.com",
  "Account": "497086312543",
  "Arn": "arn:aws:sts::497086312543:assumed-role/AWSReservedSSO_AWSAdministratorAccess_400f35d5829b219a/aron@paytheory.com"
}
```

Bedrock Titan Text Embeddings V2 access was verified before deployment:

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 aws bedrock-runtime invoke-model \
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

No teardown was run for the failed stack. It remains `ROLLBACK_COMPLETE` with retained resources from the failed attempt.
The validated retry used an isolated stack name:

```bash
cd examples/cdk/s3-vectors-semantic-search
npm ci
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 \
  npx cdk deploy -c stackName=AppTheoryS3VectorsSemanticSearchLive2 \
  AppTheoryS3VectorsSemanticSearchLive2 \
  --require-approval never \
  --outputs-file cdk.outputs.json
```

Observed deploy outputs:

```text
ApiUrl = https://z16ndw9yg8.execute-api.us-east-1.amazonaws.com
VectorBucketName = apptheorys3vectorssemanticsearchlive2-vectors-4a361780
VectorIndexName = semantic
```

## Runtime validation

Health:

```bash
curl -sS "https://z16ndw9yg8.execute-api.us-east-1.amazonaws.com/health"
```

Observed:

```json
{
  "configured": true,
  "dimension": 1024,
  "embedding_model_id": "amazon.titan-embed-text-v2:0",
  "embedding_normalize": true,
  "ok": true,
  "vector_bucket_name": "apptheorys3vectorssemanticsearchlive2-vectors-4a361780",
  "vector_index_name": "semantic"
}
```

Seed:

```bash
curl -sS -X POST "https://z16ndw9yg8.execute-api.us-east-1.amazonaws.com/seed"
```

Observed:

```json
{
  "seeded": 4,
  "tenant": "demo",
  "namespace": "apptheory",
  "vector_bucket_name": "apptheorys3vectorssemanticsearchlive2-vectors-4a361780",
  "vector_index_name": "semantic",
  "keys": [
    "demo/apptheory/01-runtime-contract",
    "demo/apptheory/02-middleware-ordering",
    "demo/apptheory/03-semantic-recall",
    "demo/apptheory/04-bedrock-embedding"
  ]
}
```

Search:

```bash
curl -sS "https://z16ndw9yg8.execute-api.us-east-1.amazonaws.com/search?q=middleware%20ordering"
```

Observed top hit:

```json
{
  "query": "middleware ordering",
  "tenant": "demo",
  "namespace": "apptheory",
  "top_k": 3,
  "count": 3,
  "hits": [
    {
      "key": "demo/apptheory/02-middleware-ordering",
      "distance": 0.2219429,
      "title": "Middleware ordering is part of the contract"
    }
  ]
}
```

## Result

Live validation passed: AppTheory CDK created S3 Vectors infrastructure, the Go AppTheory Lambda used the shared
`pkg/vectorstore` Bedrock/S3 Vectors helpers, `/seed` wrote embeddings, and `/search` returned the expected semantic
candidate with metadata from S3 Vectors.
