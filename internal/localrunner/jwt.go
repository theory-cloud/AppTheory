package localrunner

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// JWT validation for API Gateway authorizers.
//
// An HTTP API JWT authorizer validates the token's signature against the
// issuer's JWKS and checks the issuer, the audience, the expiry and the
// not-before instant:
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
//
// A Cognito user-pool authorizer validates the same token against the pool's
// JWKS; a Cognito token's issuer is the pool's canonical URL and an access
// token carries its scopes in the scope claim:
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html
//
// The runner serves the pool at a loopback issuer, so it accepts both the local
// issuer and the canonical Cognito issuer the token names.

// jwtIssuer is the issuer configuration one route validates against.
type jwtIssuer struct {
	// Accepted lists every issuer value a token may name.
	Accepted []string
	// JWKSURL is where the signing keys are read.
	JWKSURL string
	// Audience is empty when the authorizer does not restrict it.
	Audience []string
}

// jwtVerifier validates one issuer's tokens and caches its keys.
type jwtVerifier struct {
	clock  Clock
	issuer jwtIssuer
	// client fetches the JWKS; it never uses a proxy and never leaves loopback.
	client *http.Client

	mu        sync.Mutex
	cached    []jwtKey
	fetchedAt time.Time
}

type jwtKey struct {
	kid string
	alg string
	rsa *rsa.PublicKey
	ec  *ecdsa.PublicKey
}

func newJWTVerifier(clock Clock, issuer jwtIssuer) *jwtVerifier {
	if clock == nil {
		clock = RealClock{}
	}
	return &jwtVerifier{
		clock:  clock,
		issuer: issuer,
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				Proxy:             nil,
				DisableKeepAlives: true,
			},
		},
	}
}

// verifyToken validates the compact JWT against one issuer and returns its
// claims.
func (v *jwtVerifier) verifyToken(ctx context.Context, token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("the token is not a compact JWT")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("decode the token header: %w", err)
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if unmarshalErr := json.Unmarshal(headerBytes, &header); unmarshalErr != nil {
		return nil, fmt.Errorf("parse the token header: %w", unmarshalErr)
	}
	if strings.TrimSpace(header.Alg) == "" || strings.EqualFold(header.Alg, "none") {
		return nil, fmt.Errorf("token algorithm %q is not accepted", header.Alg)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode the token claims: %w", err)
	}
	var claims map[string]any
	if unmarshalErr := json.Unmarshal(payloadBytes, &claims); unmarshalErr != nil {
		return nil, fmt.Errorf("parse the token claims: %w", unmarshalErr)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("decode the token signature: %w", err)
	}

	if err := v.checkClaims(claims); err != nil {
		return nil, err
	}
	if err := v.checkSignature(ctx, header.Alg, header.Kid, parts[0]+"."+parts[1], signature); err != nil {
		return nil, err
	}
	return claims, nil
}

// checkClaims validates the issuer, audience, expiry and not-before values
// against the run clock.
func (v *jwtVerifier) checkClaims(claims map[string]any) error {
	now := v.clock.Now()
	tokenIssuer := stringClaim(claims, "iss")
	if tokenIssuer == "" {
		return errors.New("the token has no iss claim")
	}
	if !containsStringList(v.issuer.Accepted, tokenIssuer) {
		return fmt.Errorf("token issuer %q is not the configured issuer", tokenIssuer)
	}
	if len(v.issuer.Audience) > 0 {
		if !audienceMatches(claims, v.issuer.Audience) {
			return errors.New("the token audience does not match the configured audience")
		}
	}
	if exp, ok := numericClaim(claims, "exp"); ok {
		if !now.Before(time.Unix(exp, 0)) {
			return fmt.Errorf("the token expired at %s", time.Unix(exp, 0).UTC().Format(time.RFC3339))
		}
	} else {
		return errors.New("the token has no exp claim")
	}
	if nbf, ok := numericClaim(claims, "nbf"); ok && now.Before(time.Unix(nbf, 0)) {
		return fmt.Errorf("the token is not valid before %s", time.Unix(nbf, 0).UTC().Format(time.RFC3339))
	}
	return nil
}

// checkSignature verifies the JWS signature with the issuer's keys.
func (v *jwtVerifier) checkSignature(ctx context.Context, alg, kid, signingInput string, signature []byte) error {
	keys, err := v.keys(ctx)
	if err != nil {
		return err
	}
	candidates := keys
	if kid != "" {
		candidates = nil
		for _, key := range keys {
			if key.kid == kid {
				candidates = append(candidates, key)
			}
		}
	}
	if len(candidates) == 0 {
		// The key may have rotated since the cache was filled.
		keys, err = v.refresh(ctx)
		if err != nil {
			return err
		}
		for _, key := range keys {
			if kid == "" || key.kid == kid {
				candidates = append(candidates, key)
			}
		}
	}
	if len(candidates) == 0 {
		return fmt.Errorf("no signing key matches kid %q", kid)
	}
	lastErr := errors.New("no key verified the signature")
	for _, key := range candidates {
		if err := key.verify(alg, signingInput, signature); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func (k jwtKey) verify(alg, signingInput string, signature []byte) error {
	switch strings.ToUpper(alg) {
	case "RS256":
		return verifyRSA(k, crypto.SHA256, signingInput, signature)
	case "RS384":
		return verifyRSA(k, crypto.SHA384, signingInput, signature)
	case "RS512":
		return verifyRSA(k, crypto.SHA512, signingInput, signature)
	case "ES256":
		return verifyECDSA(k, crypto.SHA256, elliptic.P256(), signingInput, signature)
	case "ES384":
		return verifyECDSA(k, crypto.SHA384, elliptic.P384(), signingInput, signature)
	default:
		return fmt.Errorf("algorithm %q is not supported", alg)
	}
}

func verifyRSA(key jwtKey, hash crypto.Hash, signingInput string, signature []byte) error {
	if key.rsa == nil {
		return errors.New("the token algorithm is RSA but the key is not an RSA key")
	}
	digest := hashInput(hash, signingInput)
	return rsa.VerifyPKCS1v15(key.rsa, hash, digest, signature)
}

func verifyECDSA(key jwtKey, hash crypto.Hash, curve elliptic.Curve, signingInput string, signature []byte) error {
	if key.ec == nil || key.ec.Curve != curve {
		return errors.New("the token algorithm does not match the key curve")
	}
	size := (curve.Params().BitSize + 7) / 8
	if len(signature) != 2*size {
		return errors.New("the ECDSA signature has the wrong length")
	}
	digest := hashInput(hash, signingInput)
	r := new(big.Int).SetBytes(signature[:size])
	s := new(big.Int).SetBytes(signature[size:])
	if !ecdsa.Verify(key.ec, digest, r, s) {
		return errors.New("the ECDSA signature is invalid")
	}
	return nil
}

func hashInput(hash crypto.Hash, signingInput string) []byte {
	switch hash {
	case crypto.SHA256:
		sum := sha256.Sum256([]byte(signingInput))
		return sum[:]
	case crypto.SHA384:
		sum := sha512.Sum384([]byte(signingInput))
		return sum[:]
	case crypto.SHA512:
		sum := sha512.Sum512([]byte(signingInput))
		return sum[:]
	default:
		return nil
	}
}

// keys returns the cached key set, fetching it once.
func (v *jwtVerifier) keys(ctx context.Context) ([]jwtKey, error) {
	v.mu.Lock()
	cached := v.cached
	fetchedAt := v.fetchedAt
	v.mu.Unlock()
	if cached != nil && time.Since(fetchedAt) < 10*time.Minute {
		return cached, nil
	}
	return v.refresh(ctx)
}

func (v *jwtVerifier) refresh(ctx context.Context) ([]jwtKey, error) {
	if v.issuer.JWKSURL == "" {
		return nil, errors.New("the authorizer has no JWKS endpoint")
	}
	//nolint:gosec // the URL is the configured issuer, never caller input.
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, v.issuer.JWKSURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := v.client.Do(request) //nolint:gosec // the URL is the configured issuer, never caller input.
	if err != nil {
		return nil, fmt.Errorf("read the issuer JWKS: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // the body is decoded below
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the issuer JWKS answered %s", response.Status)
	}
	var document struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Alg string `json:"alg"`
			N   string `json:"n"`
			E   string `json:"e"`
			Crv string `json:"crv"`
			X   string `json:"x"`
			Y   string `json:"y"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		return nil, fmt.Errorf("parse the issuer JWKS: %w", err)
	}
	keys := make([]jwtKey, 0, len(document.Keys))
	for _, key := range document.Keys {
		parsed, err := parseJWK(key.Kty, key.Kid, key.Alg, key.N, key.E, key.Crv, key.X, key.Y)
		if err != nil {
			continue
		}
		keys = append(keys, parsed)
	}
	if len(keys) == 0 {
		return nil, errors.New("the issuer JWKS has no usable key")
	}
	v.mu.Lock()
	v.cached = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return keys, nil
}

func parseJWK(kty, kid, alg, n, e, crv, x, y string) (jwtKey, error) {
	switch strings.ToUpper(kty) {
	case "RSA":
		modulus, err := base64.RawURLEncoding.DecodeString(n)
		if err != nil {
			return jwtKey{}, err
		}
		exponent, err := base64.RawURLEncoding.DecodeString(e)
		if err != nil {
			return jwtKey{}, err
		}
		return jwtKey{
			kid: kid,
			alg: alg,
			rsa: &rsa.PublicKey{
				N: new(big.Int).SetBytes(modulus),
				E: int(new(big.Int).SetBytes(exponent).Int64()),
			},
		}, nil
	case "EC":
		curve, err := curveForName(crv)
		if err != nil {
			return jwtKey{}, err
		}
		xBytes, err := base64.RawURLEncoding.DecodeString(x)
		if err != nil {
			return jwtKey{}, err
		}
		yBytes, err := base64.RawURLEncoding.DecodeString(y)
		if err != nil {
			return jwtKey{}, err
		}
		size := (curve.Params().BitSize + 7) / 8
		if len(xBytes) > size || len(yBytes) > size {
			return jwtKey{}, errors.New("the EC key coordinates are too large for the curve")
		}
		point := make([]byte, 1+2*size)
		point[0] = 0x04
		copy(point[1+size-len(xBytes):1+size], xBytes)
		copy(point[1+2*size-len(yBytes):], yBytes)
		publicKey, err := ecdsa.ParseUncompressedPublicKey(curve, point)
		if err != nil {
			return jwtKey{}, err
		}
		return jwtKey{kid: kid, alg: alg, ec: publicKey}, nil
	default:
		return jwtKey{}, fmt.Errorf("key type %q is not supported", kty)
	}
}

func curveForName(name string) (elliptic.Curve, error) {
	switch name {
	case "P-256":
		return elliptic.P256(), nil
	case "P-384":
		return elliptic.P384(), nil
	case "P-521":
		return elliptic.P521(), nil
	default:
		return nil, fmt.Errorf("curve %q is not supported", name)
	}
}

// audienceMatches checks the aud claim, or the client_id claim a Cognito access
// token carries instead.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
func audienceMatches(claims map[string]any, audience []string) bool {
	for _, candidate := range audienceValues(claims) {
		if containsStringList(audience, candidate) {
			return true
		}
	}
	return false
}

func audienceValues(claims map[string]any) []string {
	var values []string
	switch typed := claims["aud"].(type) {
	case string:
		values = append(values, typed)
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok {
				values = append(values, text)
			}
		}
	}
	if clientID := stringClaim(claims, "client_id"); clientID != "" {
		values = append(values, clientID)
	}
	return values
}

// tokenScopes returns the scopes an access token carries.
func tokenScopes(claims map[string]any) []string {
	var scopes []string
	if raw := stringClaim(claims, "scope"); raw != "" {
		scopes = append(scopes, strings.Fields(raw)...)
	}
	if typed, ok := claims["scp"].([]any); ok {
		for _, item := range typed {
			if text, ok := item.(string); ok {
				scopes = append(scopes, text)
			}
		}
	}
	return scopes
}

// missingScope names the first required scope the token does not carry.
func missingScope(claims map[string]any, required []string) string {
	if len(required) == 0 {
		return ""
	}
	scopes := tokenScopes(claims)
	for _, scope := range required {
		if !containsStringList(scopes, scope) {
			return scope
		}
	}
	return ""
}

func stringClaim(claims map[string]any, name string) string {
	value, ok := claims[name].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func numericClaim(claims map[string]any, name string) (int64, bool) {
	switch typed := claims[name].(type) {
	case float64:
		return int64(typed), true
	case json.Number:
		value, err := typed.Int64()
		return value, err == nil
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	default:
		return 0, false
	}
}

// bearerToken extracts the token from an Authorization header value.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
func bearerToken(header string) (string, error) {
	value := strings.TrimSpace(header)
	if value == "" {
		return "", errors.New("no Authorization header")
	}
	parts := strings.SplitN(value, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", errors.New("the Authorization header is not a Bearer token")
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return "", errors.New("the Bearer token is empty")
	}
	return token, nil
}
