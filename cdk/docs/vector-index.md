# S3 Vector Index

`AppTheoryVectorIndex` deploys the AppTheory S3 Vectors semantic-recall surface: vector bucket, vector index, canonical
environment variables, S3 Vectors grants, and explicit Bedrock `InvokeModel` grants for Titan embedding helpers.

When `encryptionKey` is omitted (the default), the construct emits no `EncryptionConfiguration`: S3 Vectors applies its
service default (SSE-S3 / AES256), and an already-deployed bucket or index is not replaced on upgrade. Pass
`encryptionKey` for SSE-KMS.

Canonical operator guidance lives in [`docs/cdk/vector-index.md`](../../docs/cdk/vector-index.md).
