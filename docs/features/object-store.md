---
title: Object Store Helper
---

# Object Store Helper

AppTheory exposes a narrow bounded object-store helper for framework-owned byte payload storage across Go,
TypeScript, and Python. It is intentionally small: one strict object reference type, one bounded store interface, one
bounded upload-grant capability, one S3-backed implementation per runtime, and deterministic local fakes for contract
tests.

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
- The bounded upload grant is a separate capability interface (`UploadGranter`,
  `ObjectStoreUploadGranter`), deliberately not a fourth store method, so no existing store implementation changes
  shape and a store opts in to minting upload links.
- Local fakes provide call recording, failure injection, a deterministic clock, and copy-on-write safety:
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

Each runtime keeps the cloud-client seam private to AppTheory tests and exposes only the bounded `ObjectStore` contract
plus the bounded upload grant.

### Dependency posture

The runtime dependency posture is deliberately asymmetric but explicit:

- **TypeScript:** `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are hard package dependencies because
  `ts/src/objectstore.ts` imports the S3 client and the presigner at module load. GitHub Release consumers get the S3
  implementation with the package, but the public surface still exposes only bounded `put`/`get`/`delete` operations
  plus the bounded upload grant.
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

## Bounded upload grant

The one authorized presigning exception is a single-object upload link. It exists so a caller can PUT bytes directly to
the bucket instead of proxying a payload through the framework, and it is bounded so the resulting link can only ever
upload the bytes that were declared.

The grant is reachable only through the upload-grant capability:

```go
granter, ok := store.(objectstore.UploadGranter)
if !ok {
  return objectstore.ErrInvalidStoreConfig
}
grant, err := granter.PresignPut(ctx, objectstore.PresignPutInput{
  Ref:            ref,                       // exact, unversioned s3://bucket/key
  ContentLength:  17,                        // required, > 0, <= MaxBytes
  ChecksumSHA256: checksum,                  // required: base64 of the 32-byte SHA-256 digest
  ContentType:    "text/plain; charset=utf-8",
  MaxBytes:       1 << 20,                   // caller-supplied ceiling
  ExpiresIn:      10 * time.Minute,          // required, > 0, <= objectstore.MaxPresignPutExpiresIn
})
```

```ts
const grant = await (store as ObjectStoreUploadGranter).presignPut({
  ref, contentLength: 17, checksumSha256: checksum,
  contentType: "text/plain; charset=utf-8", maxBytes: 1 << 20, expiresIn: 600,
});
```

```python
grant = cast(ObjectStoreUploadGranter, store).presign_put(
    ObjectStorePresignPutInput(
        ref=ref,
        content_length=17,
        checksum_sha256=checksum,
        content_type="text/plain; charset=utf-8",
        max_bytes=1 << 20,
        expires_in=600,
    )
)
```

The result carries the URL, the method (`PUT`), the exact headers the client must send
(`content-length`, `content-type`, `x-amz-checksum-sha256`), the expiry, and the reference.

Guarantees enforced by every runtime:

- **The constraint headers are signed request headers.** `content-length`, `content-type`, and
  `x-amz-checksum-sha256` are part of the presigned `X-Amz-SignedHeaders`, so S3 rejects any upload whose bytes,
  length, or content type differ from the declared ones.
- **They are never hoisted into unsigned query parameters.** A signature that only constrained the query string would
  be a weaker grant; every S3 implementation verifies the presigned URL after signing and fails closed with
  `objectstore.invalid_store_config` if the constraints are not signed headers.
- **The expiry is capped.** `ExpiresIn` must be positive and at most `MaxPresignPutExpiresIn` (fifteen minutes,
  `MAX_PRESIGN_PUT_EXPIRES_IN` / `MAX_PRESIGN_PUT_EXPIRES_IN` in TypeScript and Python). Anything above the cap fails
  closed before a URL is minted.
- **The reference is exact and unversioned.** Versioned, prefixed, wildcarded, and malformed references are refused
  with `objectstore.invalid_ref`.
- **Everything else about the request is required.** A missing content length, content type, checksum, or `MaxBytes`,
  a non-positive or over-ceiling content length, a non-canonical checksum, and a content type carrying control
  characters (including CR/LF header injection) all fail closed with `objectstore.invalid_presign_put`.

The fake stores mint a deterministic link that encodes the signed fields, so a consumer can test the whole upload
journey without AWS:

```go
fake := objectstoretest.NewStore()
grant, err := fake.PresignPut(ctx, input) // https://objectstore.fake/<bucket>/<key>?X-Amz-SignedHeaders=...
```

The fake clock defaults to the fixed instant `2026-01-01T00:00:00Z` and is injectable (`SetClock` / `setClock` /
`set_clock`), so grants are reproducible across runs and across runtimes.

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

There is no silent fallback from KMS to bucket-default or S3-managed encryption. Upload grants never attach a
server-side encryption header: the upload is the client's own request against a bucket that owns its encryption
policy.

## Non-goals

The helper deliberately does **not** provide:

- listing
- presigned GET (or any read link)
- presigning without a signed checksum, length, and content type
- public URLs
- multipart upload
- copy or head operations
- raw S3 client injection or exposure
- client-side encryption
- product-specific schemas such as TheoryMCP records

The bounded upload grant is the only presigning surface and it is deliberately narrow: generic presigning and presigned
GET remain forbidden, as do list, multipart, copy, head, public URLs, and raw clients. The contract fixtures assert
both halves of that boundary.

If an AppTheory-owned code path needs a new object-store behavior, grow this contract with fixtures and all three
runtime implementations instead of bypassing it with package-local S3 calls.
