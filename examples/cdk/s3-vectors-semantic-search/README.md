# AppTheory CDK S3 Vectors semantic search

This example deploys the AppTheory S3 Vectors path end to end:

- `AppTheoryVectorIndex` creates one vector bucket and one `semantic` vector index.
- A Go AppTheory Lambda uses `pkg/vectorstore.SemanticIndex` with Bedrock Titan Text Embeddings V2.
- `POST /seed` embeds a small AppTheory documentation corpus and writes vectors to S3 Vectors.
- `GET /search?q=...` embeds the query and returns S3 Vectors candidates.
- `POST /seed` and `GET /search` require a bearer token held in a stack-created Secrets Manager secret.

The example intentionally keeps source content in code for the demo. Production apps should keep canonical content,
publish ledgers, and relationships in TableTheory-backed or app-owned stores, then store keyed vectors and retrieval
metadata in S3 Vectors.

## Prerequisites

- Node.js `>=24` and `npm`
- Go `1.27.2`
- AWS CDK CLI through the local `npx cdk` dependency
- AWS credentials in a region where S3 Vectors and Bedrock Titan Text Embeddings V2 are available
- Bedrock model access for `amazon.titan-embed-text-v2:0`

## Install dependencies

```bash
cd examples/cdk/s3-vectors-semantic-search
npm ci
```

## Synthesize

```bash
npx cdk synth AppTheoryS3VectorsSemanticSearch
```

## Deploy

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 \
  npx cdk deploy AppTheoryS3VectorsSemanticSearch --require-approval never
```

For isolated live-validation retries, pass a CloudFormation-safe stack name and deploy that stack:

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 \
  npx cdk deploy -c stackName=AppTheoryS3VectorsSemanticSearchLive2 \
  AppTheoryS3VectorsSemanticSearchLive2 --require-approval never
```

The deployment prints `ApiUrl`, `SeedCommand`, `SearchCommand`, and `ApiTokenSecretArn` outputs.

## Authenticate

`POST /seed` and `GET /search` require a bearer token. The stack creates the token in a Secrets Manager secret and
injects it into the Lambda; fetch it after deployment and export it for the commands below:

```bash
SECRET_ID="<copy from the ApiTokenSecretArn output>"
API_TOKEN="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ID}" \
  --query SecretString --output text | jq -r .token)"
```

A request without a valid `Authorization: Bearer <token>` header is rejected with HTTP `401` before the handler runs.

## Seed and query

```bash
API_URL="https://..." # copy from the ApiUrl output
curl -s -X POST -H "Authorization: Bearer ${API_TOKEN}" "${API_URL}/seed" | jq .
curl -s -H "Authorization: Bearer ${API_TOKEN}" "${API_URL}/search?q=middleware%20ordering" | jq .
```

`top_k` defaults to `3` and is bounded at `25`; a larger value returns HTTP `400`.

Expected shape:

```json
{
  "query": "middleware ordering",
  "tenant": "demo",
  "namespace": "apptheory",
  "count": 3,
  "hits": [
    {
      "key": "demo/apptheory/02-middleware-ordering",
      "title": "Middleware ordering is part of the contract",
      "content": "Runtime tiers define the only valid middleware order..."
    }
  ]
}
```

If Titan model access is not enabled, `/seed` or `/search` returns a fail-closed JSON error with the Bedrock cause. Enable
model access in the target account/region, then retry the same command.

## Cost and abuse bounds

- `top_k` is bounded at `25`, so a search cannot request an unbounded result set.
- `/seed` embeds a fixed four-record corpus; re-seeding rewrites the same keys instead of growing the corpus.
- Bedrock Titan Text Embeddings V2 is billed per invocation and S3 Vectors is billed per query and per vector write. The
  HTTP API stage is throttled (`throttlingRateLimit: 5`, `throttlingBurstLimit: 10`), and the Lambda runs with a
  45-second timeout at 512 MB, so the demo keeps a small blast radius.
- The vector bucket and index use `RemovalPolicy.RETAIN` by default; delete the example stack when you are done.

## Destroy

Destroy only stacks you deployed. The vector bucket and index use `RemovalPolicy.RETAIN` by default, so review retained
resources before deleting data.

```bash
AWS_PROFILE=TheoryCloud AWS_REGION=us-east-1 \
  npx cdk destroy AppTheoryS3VectorsSemanticSearch
```

## No-AWS validation

```bash
go test ./examples/cdk/s3-vectors-semantic-search/handler
cd examples/cdk/s3-vectors-semantic-search && npm run build && npx cdk synth AppTheoryS3VectorsSemanticSearch
```
