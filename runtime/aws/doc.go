// Package runtimeaws provides fail-closed AWS runtime hardening helpers for Go Lambdas.
//
// The package deliberately exposes narrow STS and S3 operation interfaces rather
// than raw service clients. AssumeFirst eagerly assumes one role and proves its
// account identity before returning an ephemeral credentials provider.
// VerifyVersionedArtifact accepts only an S3 version-pinned object whose returned
// version and archive-derived aggregate digest match the caller's pins.
package runtimeaws
