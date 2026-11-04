package localrunner

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// jwtTestKey mints tokens the verifier accepts.
type jwtTestKey struct {
	private *rsa.PrivateKey
	kid     string
}

func newJWTTestKey(t *testing.T) *jwtTestKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return &jwtTestKey{private: key, kid: "test-key"}
}

func (k *jwtTestKey) jwks(t *testing.T) []byte {
	t.Helper()
	document := map[string]any{"keys": []any{map[string]any{
		"kty": "RSA",
		"kid": k.kid,
		"alg": "RS256",
		"n":   base64.RawURLEncoding.EncodeToString(k.private.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.private.E)).Bytes()),
	}}}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("jwks: %v", err)
	}
	return encoded
}

func (k *jwtTestKey) token(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]any{"alg": "RS256", "kid": k.kid, "typ": "JWT"})
	require.NoError(t, err)
	payload, err := json.Marshal(claims)
	require.NoError(t, err)
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, k.private, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func jwtTestIssuer(t *testing.T, key *jwtTestKey) (jwtIssuer, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/.well-known/jwks.json" {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, err := writer.Write(key.jwks(t))
		require.NoError(t, err)
	}))
	return jwtIssuer{
		Accepted: []string{server.URL},
		JWKSURL:  server.URL + "/.well-known/jwks.json",
		Audience: []string{"client-a"},
	}, server.Close
}

func TestJWTVerifierAcceptsAValidToken(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	verifier := newJWTVerifier(clock, issuer)
	token := key.token(t, map[string]any{
		"iss": issuer.Accepted[0],
		"aud": "client-a",
		"sub": "user-1",
		"exp": clock.Now().Add(time.Hour).Unix(),
		"iat": clock.Now().Unix(),
	})
	claims, err := verifier.verifyToken(context.Background(), token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims["sub"] != "user-1" {
		t.Fatalf("claims = %v", claims)
	}
}

func TestJWTVerifierRefusals(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := NewTestClock(now)
	base := func() map[string]any {
		return map[string]any{
			"iss": issuer.Accepted[0],
			"aud": "client-a",
			"sub": "user-1",
			"exp": now.Add(time.Hour).Unix(),
			"iat": now.Unix(),
		}
	}
	cases := map[string]func() (string, jwtIssuer){
		"expired": func() (string, jwtIssuer) {
			claims := base()
			claims["exp"] = now.Add(-time.Minute).Unix()
			return key.token(t, claims), issuer
		},
		"not-before": func() (string, jwtIssuer) {
			claims := base()
			claims["nbf"] = now.Add(time.Hour).Unix()
			return key.token(t, claims), issuer
		},
		"wrong issuer": func() (string, jwtIssuer) {
			claims := base()
			claims["iss"] = "https://issuer.invalid"
			return key.token(t, claims), issuer
		},
		"wrong audience": func() (string, jwtIssuer) {
			return key.token(t, base()), issuer
		},
		"bad signature": func() (string, jwtIssuer) {
			token := key.token(t, base())
			return token[:len(token)-4] + "AAAA", issuer
		},
		"missing exp": func() (string, jwtIssuer) {
			claims := base()
			delete(claims, "exp")
			return key.token(t, claims), issuer
		},
		"alg none": func() (string, jwtIssuer) {
			header, err := json.Marshal(map[string]any{"alg": "none"})
			require.NoError(t, err)
			payload, err := json.Marshal(base())
			require.NoError(t, err)
			return base64.RawURLEncoding.EncodeToString(header) + "." +
				base64.RawURLEncoding.EncodeToString(payload) + ".", issuer
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			token, configured := build()
			if name == "wrong audience" {
				configured.Audience = []string{"client-b"}
			}
			verifier := newJWTVerifier(clock, configured)
			if _, err := verifier.verifyToken(context.Background(), token); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

func TestJWTVerifierAcceptsACognitoAccessTokenClientID(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	verifier := newJWTVerifier(clock, issuer)
	// A Cognito access token carries client_id and no aud.
	token := key.token(t, map[string]any{
		"iss":       issuer.Accepted[0],
		"client_id": "client-a",
		"token_use": "access",
		"scope":     "aws.cognito.signin.user.admin",
		"exp":       clock.Now().Add(time.Hour).Unix(),
	})
	claims, err := verifier.verifyToken(context.Background(), token)
	if err != nil {
		t.Fatalf("an access token's client_id must satisfy the audience: %v", err)
	}
	if missingScope(claims, []string{"aws.cognito.signin.user.admin"}) != "" {
		t.Fatalf("scope should match: %v", claims)
	}
	if missingScope(claims, []string{"api/admin"}) != "api/admin" {
		t.Fatalf("missing scope was not reported: %v", claims)
	}
}

func TestBearerTokenParsing(t *testing.T) {
	if token, err := bearerToken("Bearer abc"); err != nil || token != "abc" {
		t.Fatalf("Bearer: %q %v", token, err)
	}
	if token, err := bearerToken("bearer abc"); err != nil || token != "abc" {
		t.Fatalf("lower-case scheme: %q %v", token, err)
	}
	for _, value := range []string{"", "Basic abc", "Bearer", "abc"} {
		if _, err := bearerToken(value); err == nil {
			t.Fatalf("%q must be refused", value)
		}
	}
}

func TestCognitoIssuerParsing(t *testing.T) {
	region, pool, ok := cognitoIssuerPoolID("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc")
	if !ok || region != "us-east-1" || pool != "us-east-1_abc" {
		t.Fatalf("issuer parse = %q %q %t", region, pool, ok)
	}
	if _, _, ok := cognitoIssuerPoolID("https://example.com/pool"); ok {
		t.Fatal("a non-Cognito issuer must not parse as one")
	}
	if pool, ok := cognitoPoolIDFromARN("arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc"); !ok || pool != "us-east-1_abc" {
		t.Fatalf("arn parse = %q %t", pool, ok)
	}
}

func TestAuthorizerPolicyWildcards(t *testing.T) {
	cases := map[string]bool{
		"arn:aws:execute-api:us-east-1:123456789012:api/dev/$connect": true,
		"arn:aws:execute-api:*:*:*/dev/*":                             true,
		"arn:aws:execute-api:*:*:*:*/dev/*":                           false,
		"arn:aws:execute-api:us-east-1:123456789012:api/*":            true,
		"arn:aws:execute-api:us-east-1:123456789012:other/dev/*":      false,
	}
	arn := "arn:aws:execute-api:us-east-1:123456789012:api/dev/$connect"
	for pattern, want := range cases {
		if got := wildcardMatch(pattern, arn); got != want {
			t.Fatalf("%s = %t, want %t", pattern, got, want)
		}
	}
}
