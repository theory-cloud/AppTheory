package oauth

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// mcpAuthFacadeFixtureDir is the shared acceptance fixture directory. The cases
// below drive real RSA keys, real RS256 signatures, and real local key servers;
// no static secret, and no network egress beyond loopback, is involved.
const mcpAuthFacadeFixtureDir = "../../contract-tests/fixtures/routing/mcp-auth-facade"

const (
	jwksFixtureIssuer   = "https://issuer.example.com"
	jwksFixtureAudience = "https://mcp.example.com/acme/mcp"
)

// jwksFixtureNow is the frozen clock every fixture case validates against.
var jwksFixtureNow = time.Unix(1_700_000_000, 0).UTC()

func loadMCPAuthFacadeFixture(t *testing.T, name string, target any) {
	t.Helper()
	path := filepath.Join(mcpAuthFacadeFixtureDir, name)
	body, err := os.ReadFile(path)
	require.NoErrorf(t, err, "read shared fixture %s", path)
	require.NoErrorf(t, json.Unmarshal(body, target), "decode shared fixture %s", path)
}

// jwksFailureReason maps a validator failure back onto the fixture's reason
// vocabulary so every `reason` row is asserted, not just the rejection.
func jwksFailureReason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errAlgorithmNotAllowed):
		return "algorithm_not_allowed"
	case errors.Is(err, errIssuerMismatch):
		return "issuer_mismatch"
	case errors.Is(err, errAudienceMismatch):
		return "audience_mismatch"
	case errors.Is(err, ErrBearerTokenExpired):
		return "expired"
	case errors.Is(err, errInsecureURL):
		return "non_https"
	case errors.Is(err, errCrossOriginRedirect):
		return "cross_origin_redirect"
	case errors.Is(err, errMissingJWKSURI):
		return "missing_jwks_uri"
	default:
		return ""
	}
}

// ---------------------------------------------------------------------------
// Shared fixture: jwks-validator.v1.json
// ---------------------------------------------------------------------------

type jwksValidatorFixture struct {
	Contract struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"contract"`
	Algorithm struct {
		Allowed  []string `json:"allowed"`
		Rejected []string `json:"rejected"`
	} `json:"algorithm"`
	Defaults struct {
		UnknownKidRefresh string `json:"unknown_kid_refresh"`
		MaxRefreshPerKid  int    `json:"max_refresh_per_kid"`
		Cache             string `json:"cache"`
		IssuerCheck       string `json:"issuer_check"`
		AudienceCheck     string `json:"audience_check"`
		AZPCheck          string `json:"azp_check"`
	} `json:"defaults"`
	Cases []jwksValidatorFixtureCase `json:"cases"`
}

type jwksValidatorFixtureCase struct {
	Name           string `json:"name"`
	Scenario       string `json:"scenario"`
	Expect         string `json:"expect"`
	Reason         string `json:"reason"`
	JWKSFetches    int    `json:"jwks_fetches"`
	BoundedRefresh bool   `json:"bounded_refresh"`
}

// jwksValidatorCaseRunners maps every fixture case name to its scenario. The
// case list itself is taken from the fixture, so adding a row without a runner
// fails the test instead of silently shrinking coverage.
func jwksValidatorCaseRunners() map[string]func(*testing.T, jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	return map[string]func(*testing.T, jwksValidatorFixtureCase) (*BearerTokenClaims, error){
		"alg-none-rejected":                runFixtureAlgNoneRejected,
		"hs256-rejected":                   runFixtureHS256Rejected,
		"unknown-kid-triggers-one-refresh": runFixtureUnknownKidTriggersOneRefresh,
		"unknown-kid-refresh-is-bounded":   runFixtureUnknownKidRefreshIsBounded,
		"expired-key-refresh":              runFixtureExpiredKeyRefresh,
		"issuer-mismatch-rejected":         runFixtureIssuerMismatchRejected,
		"audience-mismatch-rejected":       runFixtureAudienceMismatchRejected,
		"expired-token-rejected":           runFixtureExpiredTokenRejected,
	}
}

func TestJWKSValidatorFixture(t *testing.T) {
	var fixture jwksValidatorFixture
	loadMCPAuthFacadeFixture(t, "jwks-validator.v1.json", &fixture)

	require.NotEmpty(t, fixture.Cases, "the shared fixture must pin at least one case")
	require.Equal(t, []string{"RS256"}, fixture.Algorithm.Allowed,
		"the shared fixture pins exactly one allowed algorithm")
	require.Equal(t, defaultMaxRefreshPerKid, fixture.Defaults.MaxRefreshPerKid,
		"the validator default must equal the fixture's defaults.max_refresh_per_kid")

	runners := jwksValidatorCaseRunners()
	require.Len(t, runners, len(fixture.Cases),
		"every fixture case needs exactly one runner and no runner may be unused")

	for _, fixtureCase := range fixture.Cases {
		t.Run(fixtureCase.Name, func(t *testing.T) {
			runner, ok := runners[fixtureCase.Name]
			require.Truef(t, ok, "fixture case %q has no runner", fixtureCase.Name)

			_, err := runner(t, fixtureCase)
			switch fixtureCase.Expect {
			case "accepted":
				require.NoErrorf(t, err, "case %q: %s", fixtureCase.Name, fixtureCase.Scenario)
			case "rejected":
				require.Errorf(t, err, "case %q: %s", fixtureCase.Name, fixtureCase.Scenario)
				if fixtureCase.Reason != "" {
					require.Equalf(t, fixtureCase.Reason, jwksFailureReason(err),
						"case %q must fail for the pinned reason", fixtureCase.Name)
				}
			default:
				t.Fatalf("fixture case %q has an unknown expect %q", fixtureCase.Name, fixtureCase.Expect)
			}
		})
	}
}

func runFixtureAlgNoneRejected(t *testing.T, _ jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	key := newTestRSAKey(t)
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:  jwksFixtureIssuer,
		JWKSURI: "https://issuer.example.com/jwks.json",
		Now:     frozenJWKSClock(jwksFixtureNow),
	})
	// alg=none with an empty signature: the algorithm is refused before any
	// signature or key work happens at all.
	return validateTestToken(validator, unsupportedAlgorithmToken(t, "none", "key-1", key, testJWKSClaims(nil)))
}

func runFixtureHS256Rejected(t *testing.T, _ jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	key := newTestRSAKey(t)
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:  jwksFixtureIssuer,
		JWKSURI: "https://issuer.example.com/jwks.json",
		Now:     frozenJWKSClock(jwksFixtureNow),
	})
	// HS256 signed with the RSA public key bytes as the HMAC secret: the classic
	// algorithm-confusion attempt, refused because only RS256 is allowed.
	return validateTestToken(validator, unsupportedAlgorithmToken(t, "HS256", "key-1", key, testJWKSClaims(nil)))
}

func runFixtureUnknownKidTriggersOneRefresh(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	keyA, keyB := newTestRSAKey(t), newTestRSAKey(t)
	jwkA, jwkB := testJWK(t, "key-a", keyA), testJWK(t, "key-b", keyB)
	server := newJWKSTestServer(t, jwkA)
	// The kid the token names is published only after the first key-set fetch,
	// so exactly one bounded refresh can find it.
	server.configure(func(s *jwksTestServer) {
		s.onFetch = func(s *jwksTestServer, fetch int) {
			if fetch == 1 {
				s.keys = []map[string]string{jwkA, jwkB}
			}
		}
	})

	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
	})
	require.True(t, fixtureCase.BoundedRefresh, "the fixture pins this case as a bounded refresh")
	claims, err := validateTestToken(validator, signTestRS256Token(t, "key-b", keyB, testJWKSClaims(nil)))
	require.Equal(t, fixtureCase.JWKSFetches, server.fetchCount(), "fixture jwks_fetches")
	return claims, err
}

func runFixtureUnknownKidRefreshIsBounded(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	keyA, keyUnknown := newTestRSAKey(t), newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-a", keyA))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
	})

	// The first token exhausts the bounded refresh for its kid; the server never
	// publishes that kid.
	_, firstErr := validateTestToken(validator, signTestRS256Token(t, "key-still-unknown", keyUnknown, testJWKSClaims(nil)))
	require.ErrorIs(t, firstErr, ErrInvalidBearerToken)

	// A second token naming the same still-unknown kid arrives inside the
	// refresh cooldown, so it is refused without another key-set fetch. This
	// pins the bound to the kid being resolved, not to a per-token allowance.
	_, secondErr := validateTestToken(validator, signTestRS256Token(t, "key-still-unknown", keyUnknown, testJWKSClaims(map[string]any{
		"exp": jwksFixtureNow.Add(2 * time.Hour).Unix(),
	})))
	require.Error(t, secondErr)
	require.Equal(t, fixtureCase.JWKSFetches, server.fetchCount(), "fixture jwks_fetches")
	return nil, secondErr
}

func runFixtureExpiredKeyRefresh(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	keyRotatedFrom, keyRotatedTo := newTestRSAKey(t), newTestRSAKey(t)
	jwkBefore, jwkAfter := testJWK(t, "key-k", keyRotatedFrom), testJWK(t, "key-k", keyRotatedTo)
	server := newJWKSTestServer(t, jwkBefore)
	// The server rotates the key for the same kid after the first fetch, so only
	// an expired cache entry can pick the new key up.
	server.configure(func(s *jwksTestServer) {
		s.onFetch = func(s *jwksTestServer, fetch int) {
			if fetch == 1 {
				s.keys = []map[string]string{jwkAfter}
			}
		}
	})

	now := jwksFixtureNow
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:          jwksFixtureIssuer,
		JWKSURI:         server.jwksURL(),
		HTTPClient:      server.client(),
		Now:             func() time.Time { return now },
		CacheTTL:        time.Minute,
		RefreshCooldown: 10 * time.Second,
	})

	_, err := validateTestToken(validator, signTestRS256Token(t, "key-k", keyRotatedFrom, testJWKSClaims(nil)))
	require.NoError(t, err)
	require.Equal(t, 1, server.fetchCount(), "the first validation populates the cache")

	// Expire the cached entry and the refresh-cooldown window at once.
	now = jwksFixtureNow.Add(2 * time.Minute)
	claims, err := validateTestToken(validator, signTestRS256Token(t, "key-k", keyRotatedTo, testJWKSClaims(map[string]any{
		"exp": now.Add(time.Hour).Unix(),
	})))
	require.Equal(t, fixtureCase.JWKSFetches, server.fetchCount(), "fixture jwks_fetches")
	return claims, err
}

func runFixtureIssuerMismatchRejected(t *testing.T, _ jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:           jwksFixtureIssuer,
		JWKSURI:          server.jwksURL(),
		HTTPClient:       server.client(),
		Now:              frozenJWKSClock(jwksFixtureNow),
		RequiredAudience: fixedRequiredAudience(jwksFixtureAudience),
	})

	// The issuer is checked before the key lookup, so a token for another issuer
	// must be refused without touching the key set.
	_, mismatchErr := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"iss": "https://other.example.com",
	})))
	require.ErrorIs(t, mismatchErr, ErrInvalidBearerToken)
	require.Zero(t, server.fetchCount(), "the issuer must be verified before the key lookup")

	// Positive control: the same validator still accepts a correctly issued
	// token, so the rejection above is not "always reject".
	_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.NoError(t, err)
	return nil, mismatchErr
}

func runFixtureAudienceMismatchRejected(t *testing.T, _ jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:           jwksFixtureIssuer,
		JWKSURI:          server.jwksURL(),
		HTTPClient:       server.client(),
		Now:              frozenJWKSClock(jwksFixtureNow),
		RequiredAudience: fixedRequiredAudience(jwksFixtureAudience),
	})

	_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.NoError(t, err)

	// Audience matching is exact: an audience that merely extends the required
	// resource URL is refused. A prefix, subclass, or wildcard match would let
	// this token through.
	_, mismatchErr := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"aud": jwksFixtureAudience + "/extra",
	})))
	require.ErrorIs(t, mismatchErr, ErrBearerTokenInvalidAudience)
	return nil, mismatchErr
}

func runFixtureExpiredTokenRejected(t *testing.T, _ jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
	})

	_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.NoError(t, err)

	_, expiredErr := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"exp": jwksFixtureNow.Add(-time.Minute).Unix(),
	})))
	require.ErrorIs(t, expiredErr, ErrBearerTokenExpired)
	return nil, expiredErr
}

// ---------------------------------------------------------------------------
// Shared fixture: discovery-bootstrap.v1.json
// ---------------------------------------------------------------------------

type discoveryFixture struct {
	Contract struct {
		ID string `json:"id"`
	} `json:"contract"`
	Security struct {
		HTTPSOnly           bool   `json:"https_only"`
		IssuerMustMatch     bool   `json:"issuer_must_match_discovery_document"`
		CrossOriginRedirect string `json:"cross_origin_redirect"`
	} `json:"security"`
	Cases []struct {
		Name     string `json:"name"`
		Scenario string `json:"scenario"`
		Expect   string `json:"expect"`
		Reason   string `json:"reason"`
	} `json:"cases"`
}

func TestOIDCDiscoveryBootstrapFixture(t *testing.T) {
	var fixture discoveryFixture
	loadMCPAuthFacadeFixture(t, "discovery-bootstrap.v1.json", &fixture)

	require.True(t, fixture.Security.HTTPSOnly, "the fixture pins https-only discovery")
	require.True(t, fixture.Security.IssuerMustMatch, "the fixture pins issuer verification before jwks_uri")
	require.Equal(t, "rejected", fixture.Security.CrossOriginRedirect)
	require.NotEmpty(t, fixture.Cases, "the shared fixture must pin at least one case")

	runners := discoveryCaseRunners()
	require.Len(t, runners, len(fixture.Cases),
		"every fixture case needs exactly one runner and no runner may be unused")

	for _, fixtureCase := range fixture.Cases {
		t.Run(fixtureCase.Name, func(t *testing.T) {
			runner, ok := runners[fixtureCase.Name]
			require.Truef(t, ok, "fixture case %q has no runner", fixtureCase.Name)

			jwksURI, err := runner(t)
			switch fixtureCase.Expect {
			case "accepted":
				require.NoErrorf(t, err, "case %q: %s", fixtureCase.Name, fixtureCase.Scenario)
				require.NotEmpty(t, jwksURI, "an accepted bootstrap must return the key-set URL")
			case "rejected":
				require.Errorf(t, err, "case %q: %s", fixtureCase.Name, fixtureCase.Scenario)
				require.Empty(t, jwksURI, "a rejected bootstrap must not return a key-set URL")
				if fixtureCase.Reason != "" {
					require.Equalf(t, fixtureCase.Reason, jwksFailureReason(err),
						"case %q must fail for the pinned reason", fixtureCase.Name)
				}
			default:
				t.Fatalf("fixture case %q has an unknown expect %q", fixtureCase.Name, fixtureCase.Expect)
			}
		})
	}
}

func discoveryCaseRunners() map[string]func(*testing.T) (string, error) {
	return map[string]func(*testing.T) (string, error){
		"same-origin-https-accepted":     runDiscoverySameOriginHTTPSAccepted,
		"issuer-mismatch-rejected":       runDiscoveryIssuerMismatchRejected,
		"non-https-rejected":             runDiscoveryNonHTTPSRejected,
		"cross-origin-redirect-rejected": runDiscoveryCrossOriginRedirectRejected,
		"missing-jwks-uri-rejected":      runDiscoveryMissingJWKSURIRejected,
	}
}

func runDiscoverySameOriginHTTPSAccepted(t *testing.T) (string, error) {
	t.Helper()
	server := newDiscoveryTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeJWKSJSON(w, map[string]string{
			"issuer":   jwksFixtureIssuer,
			"jwks_uri": "https://" + r.Host + "/jwks.json",
		})
	})
	jwksURI, err := BootstrapOIDCDiscovery(context.Background(), server.discoveryURL(), jwksFixtureIssuer, server.client())
	require.NoError(t, err)
	require.Equal(t, server.url()+"/jwks.json", jwksURI)
	require.Equal(t, int64(1), server.fetches.Load())
	return jwksURI, nil
}

func runDiscoveryIssuerMismatchRejected(t *testing.T) (string, error) {
	t.Helper()
	server := newDiscoveryTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Everything else about the document is valid and the jwks_uri really
		// resolves: only the issuer mismatch may reject it, which pins "verify
		// the issuer before trusting jwks_uri".
		writeJWKSJSON(w, map[string]string{
			"issuer":   "https://other.example.com",
			"jwks_uri": "https://" + r.Host + "/jwks.json",
		})
	})
	return BootstrapOIDCDiscovery(context.Background(), server.discoveryURL(), jwksFixtureIssuer, server.client())
}

func runDiscoveryNonHTTPSRejected(t *testing.T) (string, error) {
	t.Helper()
	return BootstrapOIDCDiscovery(context.Background(), "http://127.0.0.1:8080/.well-known/openid-configuration", jwksFixtureIssuer, nil)
}

func runDiscoveryCrossOriginRedirectRejected(t *testing.T) (string, error) {
	t.Helper()
	server := newDiscoveryTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("location", "https://other.example.com/.well-known/openid-configuration")
		w.WriteHeader(http.StatusFound)
	})
	return BootstrapOIDCDiscovery(context.Background(), server.discoveryURL(), jwksFixtureIssuer, server.client())
}

func runDiscoveryMissingJWKSURIRejected(t *testing.T) (string, error) {
	t.Helper()
	server := newDiscoveryTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJWKSJSON(w, map[string]string{"issuer": jwksFixtureIssuer})
	})
	return BootstrapOIDCDiscovery(context.Background(), server.discoveryURL(), jwksFixtureIssuer, server.client())
}

// ---------------------------------------------------------------------------
// Shared fixture: route-challenge.v1.json (resource_indicator rows)
// ---------------------------------------------------------------------------

func TestCanonicalResourceURLMatchesRouteChallengeFixture(t *testing.T) {
	var fixture struct {
		ResourceIndicator struct {
			Rule   string `json:"rule"`
			Accept []struct {
				RouteResource string `json:"route_resource"`
				Requested     string `json:"requested"`
				Match         bool   `json:"match"`
			} `json:"accept"`
			Reject []struct {
				RouteResource string `json:"route_resource"`
				Requested     string `json:"requested"`
			} `json:"reject"`
		} `json:"resource_indicator"`
	}
	loadMCPAuthFacadeFixture(t, "route-challenge.v1.json", &fixture)

	require.NotEmpty(t, fixture.ResourceIndicator.Accept, "the fixture must pin accepted resource indicators")
	require.NotEmpty(t, fixture.ResourceIndicator.Reject, "the fixture must pin refused resource indicators")

	for _, row := range fixture.ResourceIndicator.Accept {
		require.True(t, row.Match, "an accept row must pin match=true")
		require.Equalf(t, CanonicalResourceURL(row.RouteResource), CanonicalResourceURL(row.Requested),
			"requested resource %q must canonicalize onto route resource %q", row.Requested, row.RouteResource)
	}
	for _, row := range fixture.ResourceIndicator.Reject {
		require.NotEqualf(t, CanonicalResourceURL(row.RouteResource), CanonicalResourceURL(row.Requested),
			"requested resource %q must not canonicalize onto route resource %q", row.Requested, row.RouteResource)
	}
}

// ---------------------------------------------------------------------------
// Controls that keep the fixture assertions non-vacuous
// ---------------------------------------------------------------------------

func TestJWKSValidatorRejectsEveryAlgorithmTheFixtureRefuses(t *testing.T) {
	var fixture jwksValidatorFixture
	loadMCPAuthFacadeFixture(t, "jwks-validator.v1.json", &fixture)
	require.NotEmpty(t, fixture.Algorithm.Rejected)

	key := newTestRSAKey(t)
	for _, algorithm := range fixture.Algorithm.Rejected {
		t.Run(algorithm, func(t *testing.T) {
			validator := newTestJWKSValidator(t, JWKSValidatorOptions{
				Issuer:  jwksFixtureIssuer,
				JWKSURI: "https://issuer.example.com/jwks.json",
				Now:     frozenJWKSClock(jwksFixtureNow),
			})
			_, err := validateTestToken(validator, unsupportedAlgorithmToken(t, algorithm, "key-1", key, testJWKSClaims(nil)))
			require.ErrorIs(t, err, ErrInvalidBearerToken)
			require.Equal(t, "algorithm_not_allowed", jwksFailureReason(err))
		})
	}
}

func TestJWKSValidatorAcceptsAWellFormedRS256Token(t *testing.T) {
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:           jwksFixtureIssuer,
		JWKSURI:          server.jwksURL(),
		HTTPClient:       server.client(),
		Now:              frozenJWKSClock(jwksFixtureNow),
		RequiredAudience: fixedRequiredAudience(jwksFixtureAudience),
		RequiredScopes:   fixedRequiredScopes("namespace:use", "agent:use"),
		AllowedAZP:       []string{"client-1"},
	})

	claims, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"azp":   "client-1",
		"scope": "namespace:use agent:use",
		"aud":   []string{"https://other.example.com", jwksFixtureAudience},
	})))
	require.NoError(t, err)
	require.Equal(t, "acme", claims.Subject)
	require.Equal(t, jwksFixtureAudience, claims.Audience)
	require.Equal(t, []string{"namespace:use", "agent:use"}, claims.Scopes)
	require.Equal(t, jwksFixtureNow.Add(time.Hour), claims.ExpiresAt)
	require.Equal(t, 1, server.fetchCount(), "one well-formed token needs exactly one key-set fetch")
}

func TestJWKSValidatorFailsClosedOnSignatureAndKeyDoubts(t *testing.T) {
	keyTrusted, keyOther := newTestRSAKey(t), newTestRSAKey(t)

	cases := []struct {
		name string
		run  func(t *testing.T) error
		want error
	}{
		{
			name: "signature-signed-by-another-key",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow),
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyOther, testJWKSClaims(nil)))
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "missing-kid",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow),
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "", keyTrusted, testJWKSClaims(nil)))
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "malformed-compact-jws",
			run: func(t *testing.T) error {
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: "https://issuer.example.com/jwks.json",
					Now: frozenJWKSClock(jwksFixtureNow),
				})
				_, err := validateTestToken(validator, "not-a-jws")
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "missing-expiry",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow),
				})
				claims := testJWKSClaims(nil)
				delete(claims, "exp")
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, claims))
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "not-yet-valid",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow),
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, testJWKSClaims(map[string]any{
					"nbf": jwksFixtureNow.Add(time.Minute).Unix(),
				})))
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "audience-absent",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow), RequiredAudience: fixedRequiredAudience(jwksFixtureAudience),
				})
				claims := testJWKSClaims(nil)
				delete(claims, "aud")
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, claims))
				return err
			},
			want: ErrBearerTokenInvalidAudience,
		},
		{
			name: "missing-scope",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow), RequiredScopes: fixedRequiredScopes("namespace:use", "agent:use"),
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, testJWKSClaims(map[string]any{
					"scope": "namespace:use",
				})))
				return err
			},
			want: ErrBearerTokenInsufficientScope,
		},
		{
			name: "azp-not-allowlisted",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow), AllowedAZP: []string{"client-1"},
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, testJWKSClaims(map[string]any{
					"azp": "client-2",
				})))
				return err
			},
			want: ErrInvalidBearerToken,
		},
		{
			name: "azp-absent-with-allowlist",
			run: func(t *testing.T) error {
				server := newJWKSTestServer(t, testJWK(t, "key-1", keyTrusted))
				validator := newTestJWKSValidator(t, JWKSValidatorOptions{
					Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
					Now: frozenJWKSClock(jwksFixtureNow), AllowedAZP: []string{"client-1"},
				})
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", keyTrusted, testJWKSClaims(nil)))
				return err
			},
			want: ErrInvalidBearerToken,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			require.ErrorIs(t, testCase.run(t), testCase.want)
		})
	}
}

func TestJWKSValidatorRefusesInconsistentKeys(t *testing.T) {
	key := newTestRSAKey(t)
	consistent := testJWK(t, "key-1", key)

	cases := []struct {
		name   string
		mutate func(jwk map[string]string)
		reason string
	}{
		{name: "jwk-alg-not-rs256", mutate: func(jwk map[string]string) { jwk["alg"] = "ES256" }, reason: "the JWK declares another algorithm"},
		{name: "jwk-use-not-signature", mutate: func(jwk map[string]string) { jwk["use"] = "enc" }, reason: "the JWK is not a signature key"},
		{name: "jwk-kty-not-rsa", mutate: func(jwk map[string]string) { jwk["kty"] = "EC" }, reason: "the JWK is not an RSA key"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			jwk := map[string]string{}
			for name, value := range consistent {
				jwk[name] = value
			}
			testCase.mutate(jwk)

			server := newJWKSTestServer(t, jwk)
			validator := newTestJWKSValidator(t, JWKSValidatorOptions{
				Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
				Now: frozenJWKSClock(jwksFixtureNow),
			})
			// The RSA material still matches the token, so only the JWK
			// inconsistency can refuse it.
			_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
			require.ErrorIsf(t, err, ErrInvalidBearerToken, "%s", testCase.reason)
		})
	}
}

func TestJWKSValidatorBoundsTheKeySetResponse(t *testing.T) {
	key := newTestRSAKey(t)
	jwk := testJWK(t, "key-1", key)

	t.Run("oversized-document", func(t *testing.T) {
		document, err := json.Marshal(map[string]any{
			"keys":    []map[string]string{jwk},
			"padding": strings.Repeat("a", jwksMaxDocumentBytes+16),
		})
		require.NoError(t, err)
		require.Greater(t, len(document), jwksMaxDocumentBytes)

		server := newJWKSTestServer(t)
		server.configure(func(s *jwksTestServer) { s.body = string(document) })
		validator := newTestJWKSValidator(t, JWKSValidatorOptions{
			Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
			Now: frozenJWKSClock(jwksFixtureNow),
		})
		_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
		require.ErrorIs(t, err, ErrInvalidBearerToken)
		require.ErrorIs(t, err, errResponseTooLarge)
	})

	t.Run("too-many-keys", func(t *testing.T) {
		keys := []map[string]string{jwk}
		for index := 0; index < jwksMaxKeys; index++ {
			keys = append(keys, map[string]string{
				"kty": "RSA",
				"kid": fmt.Sprintf("filler-%d", index),
				"n":   base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3, 4}),
				"e":   "AQAB",
			})
		}
		require.Greater(t, len(keys), jwksMaxKeys)

		server := newJWKSTestServer(t, keys...)
		validator := newTestJWKSValidator(t, JWKSValidatorOptions{
			Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
			Now: frozenJWKSClock(jwksFixtureNow),
		})
		_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
		require.ErrorIs(t, err, ErrInvalidBearerToken)
		require.ErrorIs(t, err, errTooManyKeys)
	})
}

func TestJWKSValidatorRefusesInsecureAndCrossOriginKeySources(t *testing.T) {
	key := newTestRSAKey(t)

	t.Run("plain-http-jwks-uri", func(t *testing.T) {
		_, err := NewJWKSValidator(JWKSValidatorOptions{
			Issuer:  jwksFixtureIssuer,
			JWKSURI: "http://issuer.example.com/jwks.json",
		})
		require.ErrorIs(t, err, ErrInvalidURL)
		require.ErrorIs(t, err, errInsecureURL)
	})

	t.Run("plain-http-discovery-url", func(t *testing.T) {
		_, err := NewJWKSValidator(JWKSValidatorOptions{
			Issuer:       jwksFixtureIssuer,
			DiscoveryURL: "http://issuer.example.com/.well-known/openid-configuration",
		})
		require.ErrorIs(t, err, ErrInvalidURL)
		require.ErrorIs(t, err, errInsecureURL)
	})

	t.Run("no-key-source", func(t *testing.T) {
		_, err := NewJWKSValidator(JWKSValidatorOptions{Issuer: jwksFixtureIssuer})
		require.ErrorIs(t, err, ErrInvalidURL)
	})

	t.Run("cross-origin-key-set-redirect", func(t *testing.T) {
		server := newJWKSTestServer(t, testJWK(t, "key-1", key))
		server.configure(func(s *jwksTestServer) {
			s.location = "https://other.example.com/jwks.json"
		})
		validator := newTestJWKSValidator(t, JWKSValidatorOptions{
			Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
			Now: frozenJWKSClock(jwksFixtureNow),
		})
		_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
		require.ErrorIs(t, err, ErrInvalidBearerToken)
		require.ErrorIs(t, err, errCrossOriginRedirect)
	})
}

func TestJWKSValidatorPropagatesRouteDerivationFailures(t *testing.T) {
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	derivationFailure := errors.New("route derivation failed")

	audienceValidator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
		Now: frozenJWKSClock(jwksFixtureNow),
		RequiredAudience: func(*apptheory.Context) (string, error) {
			return "", derivationFailure
		},
	})
	_, err := validateTestToken(audienceValidator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.ErrorIs(t, err, derivationFailure)

	scopeValidator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer: jwksFixtureIssuer, JWKSURI: server.jwksURL(), HTTPClient: server.client(),
		Now: frozenJWKSClock(jwksFixtureNow),
		RequiredScopes: func(*apptheory.Context) ([]string, error) {
			return nil, derivationFailure
		},
	})
	_, err = validateTestToken(scopeValidator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.ErrorIs(t, err, derivationFailure)
}

func TestNewJWKSValidatorBootstrapsKeysFromDiscovery(t *testing.T) {
	key := newTestRSAKey(t)
	jwk := testJWK(t, "key-1", key)
	var discoveryFetches, jwksFetches atomic.Int64

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		discoveryFetches.Add(1)
		writeJWKSJSON(w, map[string]string{
			"issuer":   jwksFixtureIssuer,
			"jwks_uri": "https://" + r.Host + "/jwks.json",
		})
	})
	mux.HandleFunc("/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		jwksFetches.Add(1)
		writeJWKSJSON(w, map[string]any{"keys": []map[string]string{jwk}})
	})
	server := httptest.NewTLSServer(mux)
	t.Cleanup(server.Close)

	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:       jwksFixtureIssuer,
		DiscoveryURL: server.URL + "/.well-known/openid-configuration",
		HTTPClient:   server.Client(),
		Now:          frozenJWKSClock(jwksFixtureNow),
	})
	require.Equal(t, int64(1), discoveryFetches.Load(), "the discovery document is fetched once, at construction")
	require.Zero(t, jwksFetches.Load(), "no key set is fetched before a token is presented")

	claims, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.NoError(t, err)
	require.Equal(t, "acme", claims.Subject)
	require.Equal(t, int64(1), jwksFetches.Load())

	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"iss": "https://other.example.com",
	})))
	require.ErrorIs(t, err, ErrInvalidBearerToken)
}

func TestRequireBearerTokenMiddlewareMapsJWKSValidatorFailures(t *testing.T) {
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:           jwksFixtureIssuer,
		JWKSURI:          server.jwksURL(),
		HTTPClient:       server.client(),
		Now:              frozenJWKSClock(jwksFixtureNow),
		RequiredAudience: fixedRequiredAudience(jwksFixtureAudience),
		RequiredScopes:   fixedRequiredScopes("namespace:use"),
	})

	middleware := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp",
		ClaimsValidator:     validator,
		RequiredScopesFunc:  fixedRequiredScopes("namespace:use"),
	})
	handler := middleware(func(c *apptheory.Context) (*apptheory.Response, error) {
		claims, ok := BearerTokenClaimsFromContext(c)
		require.True(t, ok)
		require.Equal(t, "acme", claims.Subject)
		return &apptheory.Response{Status: 200}, nil
	})

	serve := func(t *testing.T, token string) *apptheory.Response {
		t.Helper()
		response, err := handler(&apptheory.Context{
			Request: apptheory.Request{Headers: map[string][]string{"authorization": {"Bearer " + token}}},
		})
		require.NoError(t, err)
		return response
	}

	require.Equal(t, 200, serve(t, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil))).Status)

	expired := serve(t, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"exp": jwksFixtureNow.Add(-time.Minute).Unix(),
	})))
	require.Equal(t, 401, expired.Status)

	wrongAudience := serve(t, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"aud": "https://other.example.com/acme/mcp",
	})))
	require.Equal(t, 403, wrongAudience.Status)
	require.NotContains(t, wrongAudience.Headers, "www-authenticate")

	missingScope := serve(t, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{
		"scope": "agent:use",
	})))
	require.Equal(t, 403, missingScope.Status)
	require.Equal(t, []string{
		`Bearer error="insufficient_scope", scope="namespace:use", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"`,
	}, missingScope.Headers["www-authenticate"])

	require.Equal(t, 401, serve(t, "not-a-token").Status)
}

// ---------------------------------------------------------------------------
// Test doubles: real RSA keys, real signatures, loopback HTTP(S) servers
// ---------------------------------------------------------------------------

func frozenJWKSClock(instant time.Time) func() time.Time {
	return func() time.Time { return instant }
}

func fixedRequiredAudience(audience string) func(*apptheory.Context) (string, error) {
	return func(*apptheory.Context) (string, error) { return audience, nil }
}

func fixedRequiredScopes(scopes ...string) func(*apptheory.Context) ([]string, error) {
	return func(*apptheory.Context) ([]string, error) { return scopes, nil }
}

func newTestJWKSValidator(t *testing.T, options JWKSValidatorOptions) BearerTokenClaimsValidator {
	t.Helper()
	validator, err := NewJWKSValidator(options)
	require.NoError(t, err)
	return validator
}

func validateTestToken(validator BearerTokenClaimsValidator, token string) (*BearerTokenClaims, error) {
	return validator(&apptheory.Context{}, token)
}

func newTestRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return key
}

func testJWK(t *testing.T, kid string, key *rsa.PrivateKey) map[string]string {
	t.Helper()
	return map[string]string{
		"kty": "RSA",
		"kid": kid,
		"use": "sig",
		"alg": "RS256",
		"n":   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}
}

func testJWKSClaims(overrides map[string]any) map[string]any {
	claims := map[string]any{
		"iss":   jwksFixtureIssuer,
		"sub":   "acme",
		"aud":   jwksFixtureAudience,
		"exp":   jwksFixtureNow.Add(time.Hour).Unix(),
		"scope": "namespace:use",
	}
	for name, value := range overrides {
		claims[name] = value
	}
	return claims
}

func encodeJWSSegment(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(body)
}

func signTestRS256Token(t *testing.T, kid string, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	header := encodeJWSSegment(t, map[string]string{"alg": jwksAlgorithmRS256, "kid": kid, "typ": "JWT"})
	payload := encodeJWSSegment(t, claims)
	signingInput := header + "." + payload
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	require.NoError(t, err)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// unsupportedAlgorithmToken builds a token whose header declares an algorithm
// the validator must refuse. HS* is signed for real (using the RSA public key
// bytes as the HMAC secret, the classic confusion attempt); every other
// algorithm is rejected on the algorithm alone before the signature is read.
func unsupportedAlgorithmToken(t *testing.T, algorithm, kid string, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	header := encodeJWSSegment(t, map[string]string{"alg": algorithm, "kid": kid, "typ": "JWT"})
	payload := encodeJWSSegment(t, claims)
	signingInput := header + "." + payload

	switch {
	case algorithm == "none":
		return signingInput + "."
	case strings.HasPrefix(algorithm, "HS"):
		var newHash func() hash.Hash
		switch algorithm {
		case "HS256":
			newHash = sha256.New
		case "HS384":
			newHash = sha512.New384
		case "HS512":
			newHash = sha512.New
		default:
			t.Fatalf("unsupported hmac algorithm %q", algorithm)
		}
		mac := hmac.New(newHash, x509.MarshalPKCS1PublicKey(&key.PublicKey))
		_, _ = mac.Write([]byte(signingInput))
		return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	default:
		return signingInput + "." + base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("x", 64)))
	}
}

// jwksTestServer serves a real JWKS document over HTTPS. Each request is
// counted, so a fixture row can pin the exact number of key-set fetches.
type jwksTestServer struct {
	server *httptest.Server

	mu       sync.Mutex
	fetches  int
	keys     []map[string]string
	onFetch  func(s *jwksTestServer, fetch int)
	status   int
	location string
	body     string
}

func newJWKSTestServer(t *testing.T, keys ...map[string]string) *jwksTestServer {
	t.Helper()
	server := &jwksTestServer{keys: keys}
	server.server = httptest.NewTLSServer(http.HandlerFunc(server.handle))
	t.Cleanup(server.server.Close)
	return server
}

func (s *jwksTestServer) handle(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.fetches++
	fetch := s.fetches
	location := s.location
	status := s.status
	body := s.body
	if body == "" {
		encoded, err := json.Marshal(map[string]any{"keys": s.keys})
		if err != nil {
			encoded = []byte(`{"keys":[]}`)
		}
		body = string(encoded)
	}
	// onFetch runs with the lock held and after the current response has been
	// rendered, so a callback mutates the key set for later fetches only and
	// must not call the locking helpers on this server.
	if s.onFetch != nil {
		s.onFetch(s, fetch)
	}
	s.mu.Unlock()

	if location != "" {
		w.Header().Set("location", location)
		w.WriteHeader(http.StatusFound)
		return
	}
	if status != 0 && status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(body))
}

func (s *jwksTestServer) configure(apply func(*jwksTestServer)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	apply(s)
}

func (s *jwksTestServer) jwksURL() string { return s.server.URL + "/jwks.json" }

func (s *jwksTestServer) client() *http.Client { return s.server.Client() }

func (s *jwksTestServer) fetchCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fetches
}

// discoveryTestServer serves one OIDC discovery response over HTTPS.
type discoveryTestServer struct {
	server  *httptest.Server
	fetches atomic.Int64
}

func newDiscoveryTestServer(t *testing.T, handler http.HandlerFunc) *discoveryTestServer {
	t.Helper()
	server := &discoveryTestServer{}
	server.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.fetches.Add(1)
		handler(w, r)
	}))
	t.Cleanup(server.server.Close)
	return server
}

func (s *discoveryTestServer) client() *http.Client { return s.server.Client() }

func (s *discoveryTestServer) url() string { return s.server.URL }

func (s *discoveryTestServer) discoveryURL() string {
	return s.server.URL + "/.well-known/openid-configuration"
}

func writeJWKSJSON(w http.ResponseWriter, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(body)
}
