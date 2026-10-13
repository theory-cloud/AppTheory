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
	"net"
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
	body, err := os.ReadFile(path) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
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
	case errors.Is(err, errAZPNotAllowed):
		return "azp_not_allowed"
	case errors.Is(err, errUnknownKey):
		return "unknown_kid"
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
		UnknownKidRefresh            string `json:"unknown_kid_refresh"`
		MaxRefreshPerKid             int    `json:"max_refresh_per_kid"`
		FetchTimeoutSeconds          int    `json:"fetch_timeout_seconds"`
		MaxKidLength                 int    `json:"max_kid_length"`
		MaxWindowEntries             int    `json:"max_window_entries"`
		MaxKeyEntries                int    `json:"max_key_entries"`
		MaxUnknownKidFetches         int    `json:"max_unknown_kid_fetches"`
		UnknownKidFetchWindowSeconds int    `json:"unknown_kid_fetch_window_seconds"`
		Cache                        string `json:"cache"`
		IssuerCheck                  string `json:"issuer_check"`
		AudienceCheck                string `json:"audience_check"`
		AZPCheck                     string `json:"azp_check"`
	} `json:"defaults"`
	Cases []jwksValidatorFixtureCase `json:"cases"`
}

type jwksValidatorFixtureCase struct {
	Name                     string `json:"name"`
	Scenario                 string `json:"scenario"`
	Expect                   string `json:"expect"`
	Reason                   string `json:"reason"`
	JWKSFetches              int    `json:"jwks_fetches"`
	BoundedRefresh           bool   `json:"bounded_refresh"`
	DistinctKids             int    `json:"distinct_kids"`
	MaxWindowEntries         int    `json:"max_window_entries"`
	BoundedGlobalFetchBudget bool   `json:"bounded_global_fetch_budget"`
	BoundedWindowMap         bool   `json:"bounded_window_map"`
}

// jwksValidatorCaseRunners maps every fixture case name to its scenario. The
// case list itself is taken from the fixture, so adding a row without a runner
// fails the test instead of silently shrinking coverage.
func jwksValidatorCaseRunners() map[string]func(*testing.T, jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	return map[string]func(*testing.T, jwksValidatorFixtureCase) (*BearerTokenClaims, error){
		"alg-none-rejected":                           runFixtureAlgNoneRejected,
		"hs256-rejected":                              runFixtureHS256Rejected,
		"unknown-kid-triggers-one-refresh":            runFixtureUnknownKidTriggersOneRefresh,
		"unknown-kid-refresh-is-bounded":              runFixtureUnknownKidRefreshIsBounded,
		"expired-key-refresh":                         runFixtureExpiredKeyRefresh,
		"issuer-mismatch-rejected":                    runFixtureIssuerMismatchRejected,
		"audience-mismatch-rejected":                  runFixtureAudienceMismatchRejected,
		"expired-token-rejected":                      runFixtureExpiredTokenRejected,
		"oversized-kid-refused-without-a-fetch":       runFixtureOversizedKidRefusedWithoutAFetch,
		"distinct-attacker-kids-are-globally-bounded": runFixtureDistinctAttackerKidsAreGloballyBounded,
		"evicted-kid-window-allows-one-refetch":       runFixtureEvictedKidWindowAllowsOneRefetch,
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
	require.Equal(t, int(defaultJWKSFetchTimeout/time.Second), fixture.Defaults.FetchTimeoutSeconds,
		"the validator fetch bound must equal the fixture's defaults.fetch_timeout_seconds")
	require.Equal(t, defaultJWKSMaxKidLength, fixture.Defaults.MaxKidLength,
		"the kid-length cap must equal the fixture's defaults.max_kid_length")
	require.Equal(t, defaultJWKSMaxWindowEntries, fixture.Defaults.MaxWindowEntries,
		"the kid-window bound must equal the fixture's defaults.max_window_entries")
	require.Equal(t, defaultJWKSMaxKeyEntries, fixture.Defaults.MaxKeyEntries,
		"the key-cache bound must equal the fixture's defaults.max_key_entries")
	require.Equal(t, defaultJWKSMaxUnknownKidFetches, fixture.Defaults.MaxUnknownKidFetches,
		"the global fetch budget must equal the fixture's defaults.max_unknown_kid_fetches")
	require.Equal(t, int(defaultJWKSUnknownKidFetchWindow/time.Second), fixture.Defaults.UnknownKidFetchWindowSeconds,
		"the budget window must equal the fixture's defaults.unknown_kid_fetch_window_seconds")

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

// runFixtureOversizedKidRefusedWithoutAFetch pins the kid-length cap: an
// oversized kid is refused without entering any map and without a fetch.
func runFixtureOversizedKidRefusedWithoutAFetch(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	require.Equal(t, 0, fixtureCase.JWKSFetches, "the fixture pins this case as fetch-free")
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
	})

	oversized := strings.Repeat("k", defaultJWKSMaxKidLength+1)
	claims, err := validateTestToken(validator, signTestRS256Token(t, oversized, key, testJWKSClaims(nil)))
	require.Equal(t, 0, server.fetchCount(), "an oversized kid must not trigger a key-set fetch")
	return claims, err
}

// runFixtureDistinctAttackerKidsAreGloballyBounded pins the global unknown-kid
// fetch budget: many distinct attacker kids cannot multiply key-set fetches.
func runFixtureDistinctAttackerKidsAreGloballyBounded(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	require.True(t, fixtureCase.BoundedGlobalFetchBudget, "the fixture pins this case as globally bounded")
	require.Greater(t, fixtureCase.DistinctKids, defaultJWKSMaxUnknownKidFetches,
		"the case must present more kids than the budget allows")

	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
	})

	var lastErr error
	for index := 0; index < fixtureCase.DistinctKids; index++ {
		kid := fmt.Sprintf("attacker-%d", index)
		_, lastErr = validateTestToken(validator, signTestRS256Token(t, kid, key, testJWKSClaims(nil)))
		require.Error(t, lastErr, "an unpublished kid must be refused")
	}
	require.Equal(t, defaultJWKSMaxUnknownKidFetches, server.fetchCount(),
		"the global budget caps the key-set fetches no matter how many kids arrive")
	return nil, lastErr
}

// runFixtureEvictedKidWindowAllowsOneRefetch pins the kid-window map bound: at
// capacity the oldest window is evicted, so a kid whose window was evicted is
// fetched once more instead of being refused by its cooldown.
func runFixtureEvictedKidWindowAllowsOneRefetch(t *testing.T, fixtureCase jwksValidatorFixtureCase) (*BearerTokenClaims, error) {
	t.Helper()
	require.True(t, fixtureCase.BoundedWindowMap, "the fixture pins this case as a bounded window map")
	require.Positive(t, fixtureCase.MaxWindowEntries, "the case pins the window-map capacity")

	keyA, keyB := newTestRSAKey(t), newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", keyA))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:           jwksFixtureIssuer,
		JWKSURI:          server.jwksURL(),
		HTTPClient:       server.client(),
		Now:              frozenJWKSClock(jwksFixtureNow),
		MaxWindowEntries: fixtureCase.MaxWindowEntries,
	})

	resolve := func(kid string, key *rsa.PrivateKey) error {
		t.Helper()
		_, err := validateTestToken(validator, signTestRS256Token(t, kid, key, testJWKSClaims(nil)))
		require.Error(t, err, "an unpublished kid is refused")
		return err
	}

	require.Error(t, resolve("kid-a", keyA))
	require.Equal(t, 2, server.fetchCount(), "the first kid spends its own bounded refresh")
	require.Error(t, resolve("kid-b", keyB))
	require.Equal(t, 4, server.fetchCount(), "the second kid is resolved independently")
	lastErr := resolve("kid-a", keyA)
	require.Equal(t, fixtureCase.JWKSFetches, server.fetchCount(),
		"the evicted kid window allows exactly one more bounded refresh")
	return nil, lastErr
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
	HostGuard struct {
		Default   string   `json:"default"`
		Override  string   `json:"override"`
		Classes   []string `json:"classes"`
		Addresses []struct {
			Address string `json:"address"`
			Class   string `json:"class"`
			Public  bool   `json:"public"`
		} `json:"addresses"`
	} `json:"host_guard"`
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

func TestJWKSValidatorEnforcesTheAZPAllowList(t *testing.T) {
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:     jwksFixtureIssuer,
		JWKSURI:    server.jwksURL(),
		HTTPClient: server.client(),
		Now:        frozenJWKSClock(jwksFixtureNow),
		AllowedAZP: []string{"client-1"},
	})

	// An azp outside the allow-list is refused (no wildcard behavior).
	_, err := validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"azp": "attacker"})))
	require.ErrorIs(t, err, ErrInvalidBearerToken)
	require.Equal(t, "azp_not_allowed", jwksFailureReason(err))

	// A missing azp falls back to client_id.
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"client_id": "attacker"})))
	require.ErrorIs(t, err, ErrInvalidBearerToken)

	// Both an allow-listed azp and a missing-azp-but-allow-listed client_id pass.
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"client_id": "client-1"})))
	require.NoError(t, err)
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"azp": "client-1", "client_id": "attacker"})))
	require.NoError(t, err, "azp takes precedence over client_id when present")

	// A present but blank azp is refused rather than falling back to an
	// allow-listed client_id: only an absent azp falls back.
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"azp": " ", "client_id": "client-1"})))
	require.ErrorIs(t, err, ErrInvalidBearerToken)
	require.Equal(t, "azp_not_allowed", jwksFailureReason(err))

	// Surrounding whitespace is not an allow-list value either, but a padded
	// allow-listed azp still normalizes to its allow-list entry.
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(map[string]any{"azp": " client-1 "})))
	require.NoError(t, err, "an azp is compared after trimming, as the allow-list is built")

	// A token that carries neither azp nor client_id is refused under a configured
	// allow-list.
	_, err = validateTestToken(validator, signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
	require.ErrorIs(t, err, ErrInvalidBearerToken)
	require.Equal(t, "azp_not_allowed", jwksFailureReason(err))
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

// TestJWKSValidatorFetchBound pins the framework fetch bound shared with the
// TypeScript and Python validators, and that an explicit override wins.
func TestJWKSValidatorFetchBound(t *testing.T) {
	require.Equal(t, 10*time.Second, defaultJWKSFetchTimeout,
		"the shared framework fetch bound is 10 seconds")
	require.Equal(t, defaultJWKSFetchTimeout, jwksHTTPClient(nil, 0, false).Timeout,
		"the framework client carries the default fetch bound")
	require.Equal(t, 3*time.Second, resolvedFetchTimeout(nil, 3*time.Second),
		"an explicit override wins")
	require.Equal(t, 2*time.Second, resolvedFetchTimeout(&http.Client{Timeout: 2 * time.Second}, 0),
		"a caller-supplied client timeout is respected")
}

// TestJWKSValidatorFailsClosedWhenTheUpstreamHangs proves the fetch bound: a
// JWKS endpoint that accepts the connection and never answers must not stall a
// validation, and must not be fetched again.
func TestJWKSValidatorFailsClosedWhenTheUpstreamHangs(t *testing.T) {
	key := newTestRSAKey(t)
	server := newHungJWKSTestServer(t, 0, testJWK(t, "key-hung", key))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:       jwksFixtureIssuer,
		JWKSURI:      server.jwksURL(),
		HTTPClient:   server.client(),
		Now:          frozenJWKSClock(jwksFixtureNow),
		FetchTimeout: 250 * time.Millisecond,
	})

	started := time.Now()
	_, err := validateTestToken(validator, signTestRS256Token(t, "key-hung", key, testJWKSClaims(nil)))
	elapsed := time.Since(started)

	require.ErrorIs(t, err, ErrInvalidBearerToken, "a hung fetch fails closed")
	require.Less(t, elapsed, 3*time.Second, "the validation is bounded by the fetch timeout")
	require.EqualValues(t, 1, server.fetchCount(), "a hung fetch is not retried for the same token")

	select {
	case <-server.started:
	case <-time.After(2 * time.Second):
		t.Fatal("the hung upstream was never reached")
	}
}

// TestJWKSValidatorHungFetchDoesNotStallOtherValidations proves that one hung
// key-set fetch neither holds the validator's lock nor multiplies fetches: a
// cached key keeps validating, and a validation that has to wait on the hung
// fetch is bounded and fails closed.
func TestJWKSValidatorHungFetchDoesNotStallOtherValidations(t *testing.T) {
	keyA, keyB, keyC := newTestRSAKey(t), newTestRSAKey(t), newTestRSAKey(t)
	server := newHungJWKSTestServer(t, 1, testJWK(t, "key-a", keyA))
	validator := newTestJWKSValidator(t, JWKSValidatorOptions{
		Issuer:       jwksFixtureIssuer,
		JWKSURI:      server.jwksURL(),
		HTTPClient:   server.client(),
		Now:          frozenJWKSClock(jwksFixtureNow),
		FetchTimeout: 250 * time.Millisecond,
	})

	// The first validation populates the cache from a healthy response.
	require.NoError(t, validateTestTokenKey(t, validator, "key-a", keyA))
	require.EqualValues(t, 1, server.fetchCount())

	hung := make(chan error, 1)
	go func() {
		_, err := validateTestToken(validator, signTestRS256Token(t, "key-b", keyB, testJWKSClaims(nil)))
		hung <- err
	}()
	select {
	case <-server.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the hung upstream was never reached")
	}

	cachedStart := time.Now()
	require.NoError(t, validateTestTokenKey(t, validator, "key-a", keyA),
		"a cached key still validates while the upstream hangs")
	require.Less(t, time.Since(cachedStart), 500*time.Millisecond,
		"the hung fetch holds no lock that blocks other validations")

	unknownStart := time.Now()
	_, unknownErr := validateTestToken(validator, signTestRS256Token(t, "key-c", keyC, testJWKSClaims(nil)))
	require.Error(t, unknownErr, "an unknown kid fails closed while the upstream hangs")
	require.Less(t, time.Since(unknownStart), 3*time.Second,
		"a validation that waits on a hung fetch is bounded")

	select {
	case err := <-hung:
		require.Error(t, err, "the validation that started the hung fetch fails closed")
	case <-time.After(5 * time.Second):
		t.Fatal("the validation that started the hung fetch never returned")
	}
	require.EqualValues(t, 2, server.fetchCount(),
		"a hung fetch is shared, not multiplied, by other validations")
}

// TestJWKSValidatorBoundsAStalledOrTricklingResponseBody proves the fetch bound
// covers the whole response, not only its headers: an upstream that delivers
// headers and then goes quiet — or dribbles one byte at a time — must fail
// closed within the bound, must not stall a validation of a different token,
// and must not be fetched again for the tokens that joined it.
func TestJWKSValidatorBoundsAStalledOrTricklingResponseBody(t *testing.T) {
	for _, mode := range []string{jwksSlowBodyStalled, jwksSlowBodyTrickled} {
		t.Run(mode, func(t *testing.T) {
			keyA, keyB, keyC := newTestRSAKey(t), newTestRSAKey(t), newTestRSAKey(t)
			server := newSlowBodyJWKSTestServer(t, mode, 1, testJWK(t, "key-a", keyA))
			validator := newTestJWKSValidator(t, JWKSValidatorOptions{
				Issuer:       jwksFixtureIssuer,
				JWKSURI:      server.jwksURL(),
				HTTPClient:   server.client(),
				Now:          frozenJWKSClock(jwksFixtureNow),
				FetchTimeout: 500 * time.Millisecond,
			})

			// The first validation populates the cache from a healthy response, so a
			// cached key stays available once the upstream stops making progress.
			require.NoError(t, validateTestTokenKey(t, validator, "key-a", keyA))
			require.EqualValues(t, 1, server.fetchCount())

			hung := make(chan error, 1)
			go func() {
				_, err := validateTestToken(validator, signTestRS256Token(t, "key-b", keyB, testJWKSClaims(nil)))
				hung <- err
			}()
			select {
			case <-server.started:
			case <-time.After(5 * time.Second):
				t.Fatal("the slow upstream was never reached")
			}

			cachedStart := time.Now()
			require.NoError(t, validateTestTokenKey(t, validator, "key-a", keyA),
				"a cached key still validates while the upstream delivers no further body")
			require.Less(t, time.Since(cachedStart), 500*time.Millisecond,
				"the slow body holds no lock that blocks other validations")

			unknownStart := time.Now()
			_, unknownErr := validateTestToken(validator, signTestRS256Token(t, "key-c", keyC, testJWKSClaims(nil)))
			require.Error(t, unknownErr, "an unknown kid fails closed while the body is stalled")
			require.Less(t, time.Since(unknownStart), 3*time.Second,
				"a validation that waits on the slow fetch is bounded")

			select {
			case err := <-hung:
				require.Error(t, err, "the validation that started the slow fetch fails closed")
			case <-time.After(5 * time.Second):
				t.Fatal("the validation that started the slow fetch never returned")
			}
			require.EqualValues(t, 2, server.fetchCount(),
				"a slow fetch is shared, not multiplied, by other validations")
		})
	}
}

// TestJWKSValidatorStateIsBounded proves the per-validator state stays inside
// its bounds however many distinct attacker kids arrive.
func TestJWKSValidatorStateIsBounded(t *testing.T) {
	key := newTestRSAKey(t)
	server := newJWKSTestServer(t, testJWK(t, "key-1", key))
	state := newTestJWKSValidatorState(t, JWKSValidatorOptions{
		Issuer:               jwksFixtureIssuer,
		JWKSURI:              server.jwksURL(),
		HTTPClient:           server.client(),
		Now:                  frozenJWKSClock(jwksFixtureNow),
		MaxWindowEntries:     8,
		MaxUnknownKidFetches: 4,
	})

	for index := 0; index < 200; index++ {
		kid := fmt.Sprintf("attacker-%d", index)
		_, err := state.validate(nil, signTestRS256Token(t, kid, key, testJWKSClaims(nil)))
		require.Error(t, err, "an unpublished kid is refused")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	require.LessOrEqual(t, len(state.windows), 8, "the kid-window map stays inside its bound")
	require.LessOrEqual(t, len(state.keys), defaultJWKSMaxKeyEntries, "the key cache stays inside its bound")
}

// TestJWKSValidatorKeyCacheEvictsTheEarliestInsertedKey proves the key cache is
// bounded and evicts in document order, so its behavior is identical in every
// runtime.
func TestJWKSValidatorKeyCacheEvictsTheEarliestInsertedKey(t *testing.T) {
	keyA, keyB, keyC := newTestRSAKey(t), newTestRSAKey(t), newTestRSAKey(t)
	server := newJWKSTestServer(t,
		testJWK(t, "key-a", keyA), testJWK(t, "key-b", keyB), testJWK(t, "key-c", keyC))
	state := newTestJWKSValidatorState(t, JWKSValidatorOptions{
		Issuer:        jwksFixtureIssuer,
		JWKSURI:       server.jwksURL(),
		HTTPClient:    server.client(),
		Now:           frozenJWKSClock(jwksFixtureNow),
		MaxKeyEntries: 2,
	})

	// Only MaxKeyEntries keys survive one fetch, so the validator is exercised
	// through a key that is still cached; evicting a key fails closed rather
	// than serving a stale one.
	require.NoError(t, validateTestTokenKey(t, state.validate, "key-c", keyC))

	state.mu.Lock()
	defer state.mu.Unlock()
	require.Len(t, state.keys, 2, "the key cache never exceeds MaxKeyEntries")
	_, keptB := state.keys["key-b"]
	_, keptC := state.keys["key-c"]
	require.True(t, keptB && keptC, "the last two document keys survive")
	_, keptA := state.keys["key-a"]
	require.False(t, keptA, "the earliest-inserted key is evicted first")
}

func newTestJWKSValidatorState(t *testing.T, options JWKSValidatorOptions) *jwksValidator {
	t.Helper()
	state, err := newJWKSValidatorState(options)
	require.NoError(t, err)
	return state
}

// TestHostGuardMatchesTheSharedClassificationTable pins the SSRF guard against
// the address table all three runtimes execute.
func TestHostGuardMatchesTheSharedClassificationTable(t *testing.T) {
	var fixture discoveryFixture
	loadMCPAuthFacadeFixture(t, "discovery-bootstrap.v1.json", &fixture)

	guard := fixture.HostGuard
	require.Contains(t, guard.Default, "not a public address", "the guard is on by default")
	require.Contains(t, guard.Override, "off by default", "the override is documented")
	require.ElementsMatch(t,
		[]string{"loopback", "link_local", "private", "unspecified", "multicast", "public"},
		guard.Classes)
	require.NotEmpty(t, guard.Addresses, "the shared table must pin addresses")

	exercised := make(map[string]bool, len(guard.Classes))
	for _, row := range guard.Addresses {
		t.Run(row.Address, func(t *testing.T) {
			ip := net.ParseIP(row.Address)
			require.NotNilf(t, ip, "the shared table must carry a parsable address: %s", row.Address)
			require.Equalf(t, row.Public, isPublicHostAddress(ip), "row %s (%s)", row.Address, row.Class)
		})
		exercised[row.Class] = true
	}
	for _, class := range guard.Classes {
		require.Truef(t, exercised[class], "the shared table must exercise the %s class", class)
	}
}

// TestJWKSHostGuardIsInstalledAtConnectTime proves the framework transport hooks
// the guard, and that the hook judges the address the dialer is about to use.
func TestJWKSHostGuardIsInstalledAtConnectTime(t *testing.T) {
	transport, ok := jwksHTTPClient(nil, 0, false).Transport.(*http.Transport)
	require.True(t, ok, "the framework client must install its own guarded transport")
	require.NotNil(t, transport.DialContext, "the guarded transport must dial through the guard")

	require.ErrorIs(t, guardJWKSConnection("tcp", "127.0.0.1:443", nil), errHostNotPublic)
	require.ErrorIs(t, guardJWKSConnection("tcp", "[::1]:443", nil), errHostNotPublic)
	require.ErrorIs(t, guardJWKSConnection("tcp", "169.254.169.254:80", nil), errHostNotPublic)
	require.ErrorIs(t, guardJWKSConnection("tcp", "10.0.0.1:443", nil), errHostNotPublic)
	require.NoError(t, guardJWKSConnection("tcp", "8.8.8.8:443", nil))
	require.NoError(t, guardJWKSConnection("tcp", "[2606:4700:4700::1111]:443", nil))

	// The override pins the caller-facing transport instead of the guard.
	overridden := jwksHTTPClient(nil, 0, true)
	require.NotNil(t, overridden.Transport)
	require.Same(t, http.DefaultTransport, overridden.Transport,
		"allow-private must leave the default transport in place")
}

// TestJWKSValidatorRefusesNonPublicEndpoints proves the guard is active by
// default for literal addresses and for names that resolve to a non-public
// address, and that the documented override lifts it. Neither case reaches a
// server.
func TestJWKSValidatorRefusesNonPublicEndpoints(t *testing.T) {
	endpoints := []string{
		"https://127.0.0.1:1/jwks.json",
		"https://localhost:1/jwks.json",
		"https://169.254.169.254/jwks.json",
	}
	key := newTestRSAKey(t)
	for _, endpoint := range endpoints {
		t.Run(endpoint, func(t *testing.T) {
			_, guardedErr := validateTestToken(newTestJWKSValidator(t, JWKSValidatorOptions{
				Issuer:       jwksFixtureIssuer,
				JWKSURI:      endpoint,
				Now:          frozenJWKSClock(jwksFixtureNow),
				FetchTimeout: 500 * time.Millisecond,
			}), signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
			require.Error(t, guardedErr)
			require.ErrorIs(t, guardedErr, errHostNotPublic,
				"a non-public endpoint must be refused by the host guard")
			require.Contains(t, guardedErr.Error(), "not a public address")

			_, openErr := validateTestToken(newTestJWKSValidator(t, JWKSValidatorOptions{
				Issuer:            jwksFixtureIssuer,
				JWKSURI:           endpoint,
				Now:               frozenJWKSClock(jwksFixtureNow),
				FetchTimeout:      500 * time.Millisecond,
				AllowPrivateHosts: true,
			}), signTestRS256Token(t, "key-1", key, testJWKSClaims(nil)))
			require.Error(t, openErr, "the endpoint stays unreachable")
			require.NotErrorIs(t, openErr, errHostNotPublic,
				"the documented allow-private override lifts the guard")
		})
	}
}

// TestBootstrapOIDCDiscoveryRefusesNonPublicEndpoints proves the guard covers
// the discovery bootstrap, not only JWKS fetches.
func TestBootstrapOIDCDiscoveryRefusesNonPublicEndpoints(t *testing.T) {
	for _, discoveryURL := range []string{
		"https://127.0.0.1:1/.well-known/openid-configuration",
		"https://169.254.169.254/latest/meta-data/iam/security-credentials/",
		"https://localhost:1/.well-known/openid-configuration",
	} {
		t.Run(discoveryURL, func(t *testing.T) {
			_, err := BootstrapOIDCDiscovery(context.Background(), discoveryURL, "https://127.0.0.1:1", nil)
			require.Error(t, err)
			require.ErrorIs(t, err, errHostNotPublic)
		})
	}
}

// hungJWKSTestServer serves healthy key sets for the first healthyFetches
// requests and then hangs every later request until the test releases it,
// modeling a dead or hostile upstream.
type hungJWKSTestServer struct {
	server  *httptest.Server
	key     map[string]string
	fetches atomic.Int64
	started chan struct{}
	once    sync.Once
	release func()
}

func newHungJWKSTestServer(t *testing.T, healthyFetches int, key map[string]string) *hungJWKSTestServer {
	t.Helper()
	hung := &hungJWKSTestServer{
		key:     key,
		started: make(chan struct{}),
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	hung.release = func() { releaseOnce.Do(func() { close(release) }) }

	hung.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if int(hung.fetches.Add(1)) <= healthyFetches {
			writeJWKSJSON(w, map[string]any{"keys": []map[string]string{hung.key}})
			return
		}
		hung.once.Do(func() { close(hung.started) })
		<-release
		w.WriteHeader(http.StatusGatewayTimeout)
	}))
	// Cleanups run last-registered-first, so the blocked handler must be
	// released BEFORE httptest.Server.Close waits for it.
	t.Cleanup(hung.server.Close)
	t.Cleanup(hung.release)
	return hung
}

func (s *hungJWKSTestServer) jwksURL() string { return s.server.URL + "/jwks.json" }

func (s *hungJWKSTestServer) client() *http.Client { return s.server.Client() }

func (s *hungJWKSTestServer) fetchCount() int { return int(s.fetches.Load()) }

// The two non-progressing response bodies the fetch bound is pinned against.
const (
	// jwksSlowBodyStalled sends the response headers and then no body at all.
	jwksSlowBodyStalled = "stalled"
	// jwksSlowBodyTrickled sends the response headers and then one byte at a
	// time: a per-read timeout alone lets this run for as long as the upstream
	// keeps dribbling.
	jwksSlowBodyTrickled = "trickled"
)

// slowBodyJWKSTestServer serves a healthy key set for the first healthyFetches
// requests and then answers every later request with headers that arrive
// normally and a body that never makes progress (it stalls or trickles), so the
// test suite pins the framework's end-to-end fetch bound against the shape a
// headers-only timer cannot bound.
type slowBodyJWKSTestServer struct {
	server  *httptest.Server
	key     map[string]string
	mode    string
	fetches atomic.Int64
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newSlowBodyJWKSTestServer(t *testing.T, mode string, healthyFetches int, key map[string]string) *slowBodyJWKSTestServer {
	t.Helper()
	slow := &slowBodyJWKSTestServer{
		key:     key,
		mode:    mode,
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	slow.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if int(slow.fetches.Add(1)) <= healthyFetches {
			writeJWKSJSON(w, map[string]any{"keys": []map[string]string{slow.key}})
			return
		}
		slow.once.Do(func() { close(slow.started) })
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		if !ok {
			return
		}
		flusher.Flush()
		if slow.mode == jwksSlowBodyStalled {
			<-slow.release
			return
		}
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-slow.release:
				return
			case <-ticker.C:
				if _, err := w.Write([]byte(" ")); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}))
	// Cleanups run last-registered-first, so the blocked handler must be
	// released BEFORE httptest.Server.Close waits for it.
	t.Cleanup(slow.server.Close)
	t.Cleanup(func() { close(slow.release) })
	return slow
}

func (s *slowBodyJWKSTestServer) jwksURL() string { return s.server.URL + "/jwks.json" }

func (s *slowBodyJWKSTestServer) client() *http.Client { return s.server.Client() }

func (s *slowBodyJWKSTestServer) fetchCount() int { return int(s.fetches.Load()) }

func validateTestTokenKey(t *testing.T, validator BearerTokenClaimsValidator, kid string, key *rsa.PrivateKey) error {
	t.Helper()
	_, err := validateTestToken(validator, signTestRS256Token(t, kid, key, testJWKSClaims(nil)))
	return err
}

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
	writeIgnoringErr(w, []byte(body))
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
	writeIgnoringErr(w, body)
}

func writeIgnoringErr(w http.ResponseWriter, body []byte) {
	// A write error here surfaces as a client-side failure in the assertion that
	// follows, so it needs no separate handling in the test key/document server.
	_, _ = w.Write(body) //nolint:errcheck
}
