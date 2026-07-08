---
title: S3 Vector Index
---

# S3 Vector Index

`AppTheoryVectorIndex` is the canonical CDK construct for AppTheory semantic-recall workloads on Amazon S3 Vectors. It
creates or attaches to one vector bucket, creates one vector index, binds AppTheory runtime environment variables, and
provides least-privilege grant helpers.

```ts
import { AppTheoryVectorIndex } from "@theory-cloud/apptheory-cdk";

const vectors = new AppTheoryVectorIndex(stack, "Vectors", {
  vectorBucketName: "my-app-vectors-lab",
  indexName: "semantic",
  dimension: 1024,
  nonFilterableMetadataKeys: ["content"],
});

vectors.bindEnvironment(worker, { includeEmbedding: true });
vectors.grantWriteVectors(worker);
vectors.grantQuery(api);
vectors.grantBedrockInvokeModel(worker);
vectors.grantBedrockInvokeModel(api);
```

## Defaults

- vector bucket is created unless `createVectorBucket: false` and `existingVectorBucketName` are provided
- removal policy is `RETAIN`
- vector data type is `float32`
- distance metric is `cosine`
- encryption defaults to S3-managed `AES256`; pass `encryptionKey` for KMS
- embedding env defaults target Bedrock Titan Text Embeddings V2

## Grants

- `grantQuery`: `GetVectorBucket`, `GetIndex`, `QueryVectors`
- `grantReadVectors`: `GetVectorBucket`, `GetIndex`, `GetVectors`, `ListVectors`
- `grantWriteVectors`: `GetVectorBucket`, `GetIndex`, `PutVectors`, `DeleteVectors`
- `grantManage`: read/query/write plus index and bucket management actions
- `grantBedrockInvokeModel`: explicit `bedrock:InvokeModel` for embedding helpers

## Contract boundary

Use S3 Vectors for semantic candidates. Keep canonical content, job ledgers, and relation graphs in TableTheory-backed or
app-owned stores. AppTheory does not hide retrieval inside middleware and does not provide a raw S3 Vectors SDK escape
hatch.
