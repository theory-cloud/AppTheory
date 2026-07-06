---
title: Object Store Helper
---

# Object Store Helper

AppTheory exposes a narrow bounded object-store helper for framework-owned byte payload storage across Go,
TypeScript, and Python. It is intentionally small: one strict object reference type, one bounded store interface, one
S3-backed implementation per runtime, and deterministic local fakes for contract tests.

This helper exists so AppTheory-owned code paths can share one fail-closed S3 access pattern instead of reimplementing
S3 get/put/delete, URL parsing, encryption headers, and bounded reads in each package. It is **not** a general storage
SDK.

## Surface

- `ObjectRef` identifies exactly one object (`bucket`, `key`, optional version ID).
- `ParseObjectRef` / `parseObjectRef` / `parse_object_ref` accepts only strict `s3://bucket/key` references.
  - Bucket and key are required.
  - No default bucket or default key is inferred.
  - Query strings and fragments are rejected.
  - Valid bucket and key values are preserved exactly; the parser does not normalize or URL-decode them.
- The store supports only:
  - Put
  - bounded Get with a required positive byte cap
  - Delete
- Local fakes provide call recording, failure injection, and copy-on-write safety:
  - Go: `testkit/objectstore.NewStore()`
  - TypeScript: `createFakeObjectStore()` / `FakeObjectStore`
  - Python: `create_fake_object_store()` / `FakeObjectStore`

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

```ts
const store = await createS3ObjectStore({
  encryption: { mode: S3Encryption.S3Managed },
});
```

```python
store = create_s3_object_store(
    S3ObjectStoreConfig(encryption=S3EncryptionConfig(mode=S3_ENCRYPTION_S3_MANAGED))
)
```

Each runtime keeps the cloud-client seam private to AppTheory tests and exposes only the bounded `ObjectStore` contract.

### Dependency posture

The runtime dependency posture is deliberately asymmetric but explicit:

- **TypeScript:** `@aws-sdk/client-s3` is a hard package dependency because `ts/src/objectstore.ts` imports the S3 client
  at module load. GitHub Release consumers get the S3 implementation with the package, but the public surface still
  exposes only bounded `put`/`get`/`delete` operations.
- **Python:** `boto3` is optional and lazy. Importing `apptheory`, parsing object refs, and using the fake store do not
  require boto3. `create_s3_object_store` fails closed with `ObjectStoreError(objectstore.invalid_store_config)` when
  boto3 or the required `put_object` / `get_object` / `delete_object` methods are unavailable.
- **Go:** AWS SDK dependencies are compiled into the Go helper through the normal module dependency graph.

This asymmetry is a distribution policy choice only. It does not add a second object-store contract and it does not
permit raw S3 client injection or exposure.

## Bounded reads

Every Get call must provide a positive byte cap:

```go
out, err := store.Get(ctx, objectstore.GetInput{
  Ref:      ref,
  MaxBytes: 1 << 20,
})
```

If the object body would exceed the cap, the helper returns the runtime's stable `objectstore.object_too_large` error.
There is no unbounded read method.

## Fail-closed encryption

S3 encryption configuration is validated before any S3 operation can be built:

- Bucket-default mode emits no SSE header and relies on the bucket's default encryption policy.
- S3-managed mode emits the S3-managed AES256 SSE header.
- KMS mode emits the AWS KMS SSE header and requires a KMS key ID.

Invalid combinations fail closed with the runtime's stable `objectstore.invalid_encryption_config` error:

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
- raw S3 client injection or exposure
- client-side encryption
- product-specific schemas such as TheoryMCP records

If an AppTheory-owned code path needs a new object-store behavior, grow this contract with fixtures and all three
runtime implementations instead of bypassing it with package-local S3 calls.
