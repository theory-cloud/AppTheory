---
title: AWS Runtime Hardening Helpers
description: Fail-closed Go helpers for assumed-account identity and version-pinned release artifacts.
---

# AWS Runtime Hardening Helpers

`github.com/theory-cloud/apptheory/v4/runtime/aws` provides two Go-only platform-service helpers for Lambda control
planes. They centralize invariants that should not be reimplemented differently by every service:

1. assume a role before doing work, resolve its STS caller identity, and require the expected account; and
2. fetch an exact S3 object version, require S3 to return that version, and derive the parsed tar members' aggregate
   digest for comparison with its pin.

These helpers are Go-only because their consumers are Go platform Lambdas. They do not alter AppTheory's portable
request/response contract and do not create a TypeScript- or Python-specific behavior fork.

## Assume first, then assert the account

`AssumeFirst` accepts only the narrow `AssumeRoleAPI` operation and a `CallerIdentityFactory`. The factory receives the
ephemeral assumed `aws.CredentialsProvider`; it must create the `CallerIdentityAPI` used for the proof from those
credentials. The provider is returned only after `AssertAccount` reaches `AccountAssertionVerified`.

The returned provider holds the one credential set obtained by the eager `AssumeRole` call; it does not perform another
role assumption. Its cached credentials therefore report `CanExpire: false` even when STS supplied expiration metadata,
rather than claiming a refresh capability the fixed provider does not have. A lifecycle owner that needs renewed
credentials must run the full assume-then-assert flow again.

```go
baseConfig, err := config.LoadDefaultConfig(ctx)
if err != nil {
	return err
}

result, err := runtimeaws.AssumeFirst(
	ctx,
	sts.NewFromConfig(baseConfig),
	func(credentials aws.CredentialsProvider) runtimeaws.CallerIdentityAPI {
		assumedConfig := baseConfig
		assumedConfig.Credentials = credentials
		return sts.NewFromConfig(assumedConfig)
	},
	runtimeaws.AssumeRoleRequest{
		RoleARN:           deployRoleARN,
		RoleSessionName:   "namespace-deploy",
		ExpectedAccountID: targetAccountID,
	},
)
if err != nil {
	return err
}

// Only the verified path exposes credentials for subsequent scoped AWS clients.
assumedConfig := baseConfig
assumedConfig.Credentials = result.Credentials
```

Do not infer success from the absence of an SDK error alone. Inspect or record `result.Assertion.State` when an
operational receipt needs the explicit outcome:

| State | Meaning | Stable error |
|---|---|---|
| `not_configured` | Expected account ID was empty. | `ErrExpectedAccountNotConfigured` |
| `assume_failed` | STS did not establish usable assumed credentials. | `ErrAssumeRoleFailed` |
| `unavailable` | `GetCallerIdentity` did not establish an account ID. | `ErrCallerIdentityUnavailable` |
| `mismatch` | Identity was established in a different account. | `ErrAccountMismatch` |
| `verified` | Actual and expected account IDs matched exactly. | none |

When an SDK or context error causes a stable failure, the returned error preserves both the stable package sentinel and
the underlying cause for `errors.Is` checks.

`AssertAccount` is the standalone identity check for a client that is already bound to the intended authority. Empty
expected account IDs never broaden to the current/default account.

## Verify a version-pinned artifact

`VerifyVersionedArtifact` accepts AppTheory's existing `objectstore.Store` seam and a `VersionedArtifactRequest`. It has
no unversioned fallback or second path to S3. The request must provide a non-empty, non-`null` `VersionID` and a
lower-case `sha256:<hex>` aggregate digest.

```go
artifactStore, err := objectstore.NewS3Store(ctx, objectstore.S3StoreConfig{})
if err != nil {
	return err
}

artifact, err := runtimeaws.VerifyVersionedArtifact(ctx, artifactStore, runtimeaws.VersionedArtifactRequest{
	Bucket:         artifactBucket,
	Key:            artifactKey,
	VersionID:      artifactVersionID,
	ExpectedDigest: aggregateDigest,
})
if err != nil {
	return err
}

for _, entry := range artifact.Entries() {
	// Select the already-verified regular file needed by this operation.
	_ = entry.Bytes()
}
```

Verification always performs the F6 triple in order:

1. `objectstore.Store.Get` is sent with the exact requested `VersionID` and `MaxVersionedArtifactBytes` bound;
2. the returned `GetOutput.Ref.VersionID` must equal the request exactly; and
3. AppTheory reads a bounded uncompressed tar, hashes each regular-file member, derives the sorted
   `path<two spaces>four-digit-octal-mode<two spaces>sha256` aggregate digest, and requires it to match
   `ExpectedDigest`. The mode is normalized to its permission-relevant `07777` bits, including execute, setuid,
   setgid, and sticky bits.

Permission mode is part of the aggregate-digest wire format. Pins made with the earlier path-and-content-only
derivation are not compatible and must be regenerated with the current derivation before verification.

Archive member paths reject absolute and drive-letter paths, backslashes, parent (`..`) and residual current-directory
(`.`) segments, surrounding whitespace, control characters, and delimiter-ambiguous doubled spaces before aggregate
hashing. A single leading `./` is normalized away; another current-directory segment is rejected rather than collapsed.
Duplicate normalized regular-file paths are rejected, so archive order never defines member precedence.

The returned `VersionedArtifact.State` distinguishes `version_required`, `invalid_request`, `unavailable`,
`version_mismatch`, `archive_invalid`, `digest_mismatch`, and `verified`. `ArchiveBytes`, `Entries`, and
`ArtifactEntry.Bytes` return defensive copies. `ArchiveBytes` retains the fetched tar only after successful member
verification, but the raw tar container is not wholly digest-attested: digest entries attest parsed member paths,
permission modes, and content bytes (and therefore content sizes), not unused tar-header regions or intra-member and
trailing padding.
Consumers that require fully content-digest-attested bytes must select them through `Entries` and
`ArtifactEntry.Bytes`. Failed verification retains evidence fields but never exposes archive bytes. The object ceiling
is `MaxVersionedArtifactBytes`; the member ceiling is `MaxVersionedArtifactEntries`; trailing tar padding is limited
to 10,240 zero bytes (one GNU tar blocking-factor-20 record: 20 512-byte blocks), a conservative fail-closed cap
that accepts GNU tar 1.35's maximum 9,728-byte post-EOF run and rejects anything larger or nonzero.

Artifact fetch and archive-parse failures likewise preserve both the stable package sentinel and their wrapped cause for
`errors.Is` checks.

There is no unversioned mode, digest bypass, compressed-archive mode, or raw-client accessor. If a future release
artifact contract needs another archive shape, grow this verifier and its tests rather than adding a caller-local
fallback.
