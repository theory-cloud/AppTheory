package oauth

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPKCE_S256_RoundTrip(t *testing.T) {
	verifier, err := NewPKCECodeVerifier()
	require.NoError(t, err)

	challenge, err := PKCEChallengeS256(verifier)
	require.NoError(t, err)
	require.NotEmpty(t, challenge)

	ok, err := PKCEVerifyS256(verifier, challenge)
	require.NoError(t, err)
	require.True(t, ok)
}
