# AppTheory CDK S3 Vectors semantic search

This example deploys the AppTheory S3 Vectors path end to end:

- `AppTheoryVectorIndex` creates one vector bucket and one `semantic` vector index.
- A Go AppTheory Lambda uses `pkg/vectorstore.SemanticIndex` with Bedrock Titan Text Embeddings V2.
- `POST /seed` embeds a small AppTheory documentation corpus and writes vectors to S3 Vectors.
- `GET /search?q=...` embeds the query and returns S3 Vectors candidates.

The example intentionally keeps source content in code for the demo. Production apps should keep canonical content,
publish ledgers, and relationships in TableTheory-backed or app-owned stores, then store keyed vectors and retrieval
metadata in S3 Vectors.

## Prerequisites

- Node.js `>=24` and `npm`
- Go `1.26.4`
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

The deployment prints `ApiUrl`, `SeedCommand`, and `SearchCommand` outputs.

## Seed and query

```bash
API_URL="https://..." # copy from the ApiUrl output
curl -s -X POST "${API_URL}/seed" | jq .
curl -s "${API_URL}/search?q=middleware%20ordering" | jq .
```

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
