package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"regexp"
)

// pkceVerifierRE matches the allowed PKCE code verifier charset (RFC7636).
// Allowed: ALPHA / DIGIT / "-" / "." / "_" / "~" (43..128 chars).
var pkceVerifierRE = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

// NewPKCECodeVerifier generates a random PKCE code verifier (length ~43).
func NewPKCECodeVerifier() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("pkce: rand: %w", err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(b[:])
	// RawURLEncoding uses [A-Za-z0-9_-] and produces length 43 for 32 bytes.
	return verifier, nil
}

// ValidatePKCECodeVerifier validates a verifier against RFC7636 constraints.
func ValidatePKCECodeVerifier(verifier string) error {
	if !pkceVerifierRE.MatchString(verifier) {
		return fmt.Errorf("pkce: invalid code verifier")
	}
	return nil
}

// PKCEChallengeS256 computes the S256 code challenge for a verifier.
func PKCEChallengeS256(verifier string) (string, error) {
	if err := ValidatePKCECodeVerifier(verifier); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// PKCEVerifyS256 verifies a verifier matches an expected S256 challenge.
func PKCEVerifyS256(verifier, expectedChallenge string) (bool, error) {
	got, err := PKCEChallengeS256(verifier)
	if err != nil {
		return false, err
	}
	return got == expectedChallenge, nil
}
