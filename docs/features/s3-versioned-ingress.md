---
title: S3 Versioned Artifact Ingress
---

# S3 Versioned Artifact Ingress

`AppTheoryS3VersionedIngress` is the single bucket contract for Theory Cloud namespace release bundles. It creates one
S3 bucket with versioning enabled so vetting, registration, and deployment can bind to the same immutable
`(key, version ID, digest)` tuple. The object layout is fixed:

```text
ns/<namespaceSlug>/<bundleId>
```

`AppTheoryS3VersionedIngress.KEY_ROOT` and the instance `keyRoot` accessor both expose the canonical `ns/` root.
Consumers must not duplicate that literal or add another upload layout.

```ts
const ingress = new AppTheoryS3VersionedIngress(this, "ArtifactIngress", {
  bucketName: "theorycloud-artifact-ingress",
});

ingress.grantUpload(uploadRole, "acme", "rel_0123456789abcdefghijklmnop");
ingress.grantVersionedRead(vettingRole, "acme", "rel_0123456789abcdefghijklmnop");
```

The `bucketName` prop is optional and changes only the physical bucket name. `bucketName` and `bucketArn` accessors
forward the created bucket's CloudFormation tokens; they do not expose a second bucket or grant path.

## Fixed bucket posture

The construct always emits:

- S3 versioning with status `Enabled`
- all four S3 public-access-block settings
- S3-managed server-side encryption (`AES256`), matching AppTheory's existing bucket default
- bucket-owner-enforced object ownership
- a bucket policy denying non-TLS access through `aws:SecureTransport`
- CloudFormation retain semantics on deletion and replacement

The construct intentionally emits no lifecycle expiration or noncurrent-version deletion rule. Namespace deployment
requires pinned versions to remain readable, and the accepted artifact-flow contract does not define a quarantine
retention period. Retention changes require an operator-owned contract decision rather than a caller-supplied bypass.

## Exact-key grants

`grantUpload(grantee, namespaceSlug, bundleId)` returns an IAM grant containing only `s3:PutObject` on the exact bundle
object ARN. `grantVersionedRead(...)` returns a separate grant containing only `s3:GetObjectVersion` on that same exact
ARN. Neither helper grants bucket listing, unversioned reads, multipart permissions, or wildcard access to a namespace
prefix.

Literal namespace slugs must match `^[a-z0-9][a-z0-9-]{1,62}$`. Literal bundle IDs must match
`^rel_[0-9a-z]{26}$`. Invalid literals fail synthesis instead of being trimmed, lowercased, or broadened.

CloudFormation token values follow AppTheory's token-policy convention: structural inputs remain required, while
`Token.isUnresolved` skips only literal value validation. The exact object ARN remains a CloudFormation-safe join of
the bucket ARN, `ns/`, namespace token, slash, and bundle token.

## Authority boundary

This construct owns bucket shape and IAM grant scoping only. It does not mint ULIDs, define `theorycloud://` artifact
URIs, issue STS credentials or presigned requests, validate uploaded bytes, or deploy the bucket into
`platform_control`. An operator-authorized platform stack decides when to provision it; namespace application stacks
and upload tooling consume the resulting identity and least-privilege grant contract.
