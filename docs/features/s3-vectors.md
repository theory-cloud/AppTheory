---
title: S3 Vectors and Bedrock Embeddings
---

# S3 Vectors and Bedrock Embeddings

AppTheory treats S3 Vectors as a semantic recall plane, not as canonical persistence. Keep source records, publish state,
relationships, and audit data in TableTheory-backed stores or app-owned ledgers. Store only keyed vectors and retrieval
metadata in S3 Vectors.

The AppTheory path has three pieces:

1. `AppTheoryVectorIndex` deploys the vector bucket/index and binds canonical env vars.
2. Runtime `vectorstore` helpers validate dimensions, metadata, query limits, and embedding responses across Go,
   TypeScript, and Python.
3. `SemanticIndex` composes an explicit embedder with already-chunked text. Chunking remains app-owned until a portable
   chunk contract exists.

## Runtime defaults

The Bedrock helper defaults are intentionally fixed:

- provider: `bedrock`
- model: `amazon.titan-embed-text-v2:0`
- dimensions: `1024` unless configured otherwise
- normalize: `true`

The helper fails closed for empty input, missing embeddings, non-finite vector values, and dimension mismatches.

## Canonical environment variables

`AppTheoryVectorIndex.bindEnvironment(fn, { includeEmbedding: true })` sets:

- `APPTHEORY_VECTOR_BUCKET_NAME`
- `APPTHEORY_VECTOR_INDEX_NAME`
- `APPTHEORY_VECTOR_INDEX_ARN`
- `APPTHEORY_VECTOR_DIMENSION`
- `APPTHEORY_EMBEDDING_PROVIDER`
- `APPTHEORY_EMBEDDING_MODEL_ID`
- `APPTHEORY_EMBEDDING_DIMENSIONS`
- `APPTHEORY_EMBEDDING_NORMALIZE`

## Go sketch

```go
embedder, err := vectorstore.NewTitanEmbedder(ctx)
if err != nil {
    return err
}
store, err := vectorstore.NewS3VectorStore(ctx, bucketName, indexName, 1024)
if err != nil {
    return err
}
semantic := &vectorstore.SemanticIndex{Store: store, Embedder: embedder, Dimension: 1024}

err = semantic.PutText(ctx, []vectorstore.SemanticRecord{{
    Key: "doc-1#0001",
    Text: "already chunked text",
    Metadata: map[string]any{"tenant": "t1", "namespace": "docs", "generation": "v1"},
}})
```

## Boundary

Do not add route middleware that automatically retrieves semantic context. Retrieval is explicit handler or MCP tool logic
so request behavior remains visible and fixture-backed.
