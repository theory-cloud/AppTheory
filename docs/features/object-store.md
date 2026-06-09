---
title: Object Store Helper
---

# Object Store Helper

AppTheory exposes a narrow Go object-store helper in `pkg/objectstore` for framework-owned byte payload storage. It is
intentionally small: one strict object reference type, one bounded `Store` interface, one S3-backed implementation, and a
deterministic testkit fake.

This helper exists so AppTheory-owned code paths can share one fail-closed S3 access pattern instead of reimplementing
S3 get/put/delete, URL parsing, encryption headers, and bounded reads in each package. It is **not** a general storage
SDK.

## Surface

- `ObjectRef{Bucket, Key, VersionID}` identifies exactly one object.
- `ParseObjectRef("s3://bucket/key")` accepts only strict `s3://bucket/key` references.
  - Bucket and key are required.
  - No default bucket or default key is inferred.
  - Query strings and fragments are rejected.
  - Valid bucket and key values are preserved exactly; the parser does not normalize or URL-decode them.
- `Store` supports only:
  - `Put(ctx, PutInput) (ObjectRef, error)`
  - `Get(ctx, GetInput) (*GetOutput, error)` with a required positive `MaxBytes`
  - `Delete(ctx, DeleteInput) error`
- `testkit/objectstore.NewStore()` provides an in-memory fake with call recording, failure injection, and copy-on-write
  safety.

## S3 implementation

Create the S3 implementation through AppTheory, not by injecting an AWS client:

```go
store, err := objectstore.NewS3Store(ctx, objectstore.S3StoreConfig{
  Encryption: objectstore.S3EncryptionConfig{Mode: objectstore.S3EncryptionS3Managed},
})
if err != nil {
  return err
}
```

`NewS3Store` loads AWS SDK v2 configuration and keeps the S3 client seam private to AppTheory tests. Public callers get
only the `Store` contract.

## Bounded reads

Every `Get` call must provide a positive byte cap:

```go
out, err := store.Get(ctx, objectstore.GetInput{
  Ref:      ref,
  MaxBytes: 1 << 20,
})
```

If the object body would exceed `MaxBytes`, the helper returns `objectstore.ErrObjectTooLarge`. There is no unbounded
read method.

## Fail-closed encryption

S3 encryption configuration is validated before any S3 operation can be built:

- `S3EncryptionBucketDefault` emits no SSE header and relies on the bucket's default encryption policy.
- `S3EncryptionS3Managed` emits the S3-managed AES256 SSE header.
- `S3EncryptionKMS` emits the AWS KMS SSE header and requires `KMSKeyID`.

Invalid combinations fail closed with `objectstore.ErrInvalidEncryptionConfig`:

- KMS mode without a key.
- A blank or whitespace-padded KMS key.
- A KMS key supplied for bucket-default or S3-managed mode.
- Any unknown encryption mode.

There is no silent fallback from KMS to bucket-default or S3-managed encryption.

## Non-goals

The helper deliberately does **not** provide:

- listing
- presigning
- public URLs
- multipart upload
- copy or head operations
- raw `*s3.Client` injection or exposure
- client-side encryption
- TypeScript or Python SDKs
- product-specific schemas such as TheoryMCP records

If an AppTheory-owned code path needs a new object-store behavior, grow this contract with tests instead of bypassing it
with package-local S3 calls.
