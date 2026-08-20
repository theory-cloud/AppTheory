// Package runtimeaws provides fail-closed AWS runtime hardening helpers for Go Lambdas.
//
// The package deliberately uses narrow STS interfaces and AppTheory's object-store
// contract rather than raw service clients. AssumeFirst eagerly assumes one role
// and proves its account identity before returning an ephemeral credentials provider.
// VerifyVersionedArtifact accepts only a version-pinned object whose returned version
// and archive-derived aggregate digest match the caller's pins.
package runtimeaws
