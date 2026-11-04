package localrunner

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// signRS mints an RS384 or RS512 token for the verifier's other algorithms.
func signRS(t *testing.T, key *jwtTestKey, alg string, hash crypto.Hash, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]any{"alg": alg, "kid": key.kid})
	require.NoError(t, err)
	payload, err := json.Marshal(claims)
	require.NoError(t, err)
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	var digest []byte
	switch hash {
	case crypto.SHA384:
		sum := sha512.Sum384([]byte(signingInput))
		digest = sum[:]
	case crypto.SHA512:
		sum := sha512.Sum512([]byte(signingInput))
		digest = sum[:]
	default:
		sum := sha256.Sum256([]byte(signingInput))
		digest = sum[:]
	}
	signature, err := rsa.SignPKCS1v15(rand.Reader, key.private, hash, digest)
	require.NoError(t, err)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func TestJWTVerifierOtherAlgorithms(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	claims := map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a",
		"exp": clock.Now().Add(time.Hour).Unix(),
	}
	for _, testCase := range []struct {
		alg  string
		hash crypto.Hash
	}{
		{"RS384", crypto.SHA384},
		{"RS512", crypto.SHA512},
	} {
		verifier := newJWTVerifier(clock, issuer)
		token := signRS(t, key, testCase.alg, testCase.hash, claims)
		_, err := verifier.verifyToken(context.Background(), token)
		require.NoError(t, err, testCase.alg)
	}

	// An unknown kid refreshes the key set and then fails.
	verifier := newJWTVerifier(clock, issuer)
	unknown := signRS(t, key, "RS256", crypto.SHA256, claims)
	// Replace the kid in the header so the first lookup misses.
	parts := splitToken(t, unknown)
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"other"}`))
	_, err := verifier.verifyToken(context.Background(), header+"."+parts[1]+"."+parts[2])
	require.Error(t, err)
}

func splitToken(t *testing.T, token string) []string {
	t.Helper()
	var parts []string
	start := 0
	for index := 0; index < len(token); index++ {
		if token[index] == '.' {
			parts = append(parts, token[start:index])
			start = index + 1
		}
	}
	parts = append(parts, token[start:])
	require.Len(t, parts, 3)
	return parts
}

func TestWebSocketLifetimeTimerCloses(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	invoker := &recordingWebSocketInvoker{}
	server := &WebSocketServer{API: testWebSocketAPI(), Invokers: map[string]Invoker{"Fn": invoker}, Clock: clock}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	conn, reader := dialTestWebSocket(t, httpServer.URL, nil, "")
	defer func() { _ = conn.Close() }() //nolint:errcheck // test cleanup
	_, err := clock.Advance(webSocketIdleTimeout - time.Minute)
	require.NoError(t, err)
	_, err = clock.Advance(2 * time.Minute)
	require.NoError(t, err)
	opcode, payload := readServerFrame(t, reader)
	require.Equal(t, byte(wsOpcodeClose), opcode)
	require.Equal(t, wsCloseGoingAway, closeCodeOf(payload))
}
