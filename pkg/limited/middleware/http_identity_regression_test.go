package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v6/pkg/limited"
)

type capturingLimiter struct {
	keys []limited.RateLimitKey
}

func (c *capturingLimiter) CheckLimit(_ context.Context, key limited.RateLimitKey) (*limited.LimitDecision, error) {
	c.keys = append(c.keys, key)
	return &limited.LimitDecision{
		Allowed:      true,
		CurrentCount: 1,
		Limit:        10,
		ResetsAt:     time.Unix(1700000000, 0).UTC(),
	}, nil
}

func (*capturingLimiter) RecordRequest(context.Context, limited.RateLimitKey) error { return nil }

func (*capturingLimiter) GetUsage(context.Context, limited.RateLimitKey) (*limited.UsageStats, error) {
	return nil, errors.New("not implemented")
}

func captureKey(t *testing.T, opts Options, req *http.Request) limited.RateLimitKey {
	t.Helper()

	limiter := &capturingLimiter{}
	opts.Limiter = limiter

	Middleware(opts)(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})(httptest.NewRecorder(), req)

	require.Len(t, limiter.keys, 1)
	return limiter.keys[0]
}

func TestMiddleware_DefaultIdentityIgnoresSpoofedForwardedHeaders(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "203.0.113.9:443"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.Header.Set("X-Real-IP", "5.6.7.8")

	key := captureKey(t, Options{}, req)

	require.Equal(t, "203.0.113.9", key.Identifier)
	require.Equal(t, "203.0.113.9", key.Metadata["ip"])
}

func TestMiddleware_TrustedProxyHonorsForwardedHeaders(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "10.1.2.3:5555"
	// The leftmost entry is client-supplied and must not win; the rightmost
	// untrusted hop is the address the trusted proxy observed.
	req.Header.Set("X-Forwarded-For", "203.0.113.66, 198.51.100.7")

	key := captureKey(t, Options{TrustedProxyCIDRs: []string{"10.0.0.0/8"}}, req)

	require.Equal(t, "198.51.100.7", key.Identifier)
	require.Equal(t, "198.51.100.7", key.Metadata["ip"])
}

func TestClientIP_ForwardedHeadersRequireTrustedTransportPeer(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "198.51.100.20:443"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	require.Equal(t, "198.51.100.20", clientIP(req, parseTrustedProxyCIDRs([]string{"10.0.0.0/8"})))
}

func TestClientIP_TrustedProxyIgnoresMalformedForwardedForAndUsesRealIP(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "10.1.2.3:5555"
	req.Header.Set("X-Forwarded-For", "not-an-ip, also-bad")
	req.Header.Set("X-Real-IP", "198.51.100.7")

	trusted := parseTrustedProxyCIDRs([]string{"10.0.0.0/8", "not-a-cidr", ""})

	require.Equal(t, "198.51.100.7", clientIP(req, trusted))
}

func TestClientIP_ParsesIPv6RemoteAddr(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)

	req.RemoteAddr = "[2001:db8::1]:8443"
	require.Equal(t, "2001:db8::1", clientIP(req, nil))

	req.RemoteAddr = "2001:db8::2"
	require.Equal(t, "2001:db8::2", clientIP(req, nil))

	req.RemoteAddr = "[2001:db8:1::10]:8443"
	req.Header.Set("X-Forwarded-For", "2001:db8:2::99")
	require.Equal(t, "2001:db8:2::99", clientIP(req, parseTrustedProxyCIDRs([]string{"2001:db8:1::/48"})))
}

func TestClientIP_IPv4MappedIPv6RemoteAddrIsNormalized(t *testing.T) {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "[::ffff:203.0.113.9]:443"

	require.Equal(t, "203.0.113.9", clientIP(req, nil))
}

func TestParseTrustedProxyCIDRs_IgnoresMalformedValues(t *testing.T) {
	prefixes := parseTrustedProxyCIDRs([]string{
		"",
		" 10.0.0.0/8 ",
		"not-an-ip",
		"192.0.2.10",
		"2001:db8::/32",
	})

	require.Len(t, prefixes, 3)
	require.True(t, isTrustedProxy(netip.MustParseAddr("10.4.5.6"), prefixes))
	require.True(t, isTrustedProxy(netip.MustParseAddr("192.0.2.10"), prefixes))
	require.True(t, isTrustedProxy(netip.MustParseAddr("2001:db8::1"), prefixes))
	require.False(t, isTrustedProxy(netip.MustParseAddr("8.8.8.8"), prefixes))
}

func TestMiddleware_DefaultIdentityIgnoresCredentials(t *testing.T) {
	const apiKey = "raw-secret-api-key"     //nolint:gosec // test fixture value, not a credential.
	const token = "raw-secret-bearer-token" //nolint:gosec // test fixture value, not a credential.

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "203.0.113.9:443"
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Authorization", "Bearer "+token)

	key := captureKey(t, Options{}, req)

	require.Equal(t, "203.0.113.9", key.Identifier)
	require.NotContains(t, key.Identifier, apiKey)
	require.NotContains(t, key.Identifier, token)
}

func TestMiddleware_CredentialIdentityIsFingerprinted(t *testing.T) {
	const token = "raw-secret-bearer-token" //nolint:gosec // test fixture value, not a credential.

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "203.0.113.9:443"
	req.Header.Set("Authorization", "Bearer "+token)

	key := captureKey(t, Options{AllowCredentialIdentity: true}, req)

	require.True(t, strings.HasPrefix(key.Identifier, "bearer:hmac-sha256:"))
	require.Len(t, strings.TrimPrefix(key.Identifier, "bearer:hmac-sha256:"), 64)
	require.NotContains(t, key.Identifier, token)
	require.Equal(t, "203.0.113.9", key.Metadata["ip"])

	entry := limited.RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: time.Unix(1700000000, 0).Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	entry.SetKeys()

	require.NotContains(t, entry.Identifier, token)
	require.NotContains(t, entry.PK, token)
	require.NotContains(t, entry.SK, token)
}

func TestDefaultIdentifierExtractor_FingerprintsCredentialsDeterministically(t *testing.T) {
	const apiKey = "raw-secret-api-key" //nolint:gosec // test fixture value, not a credential.

	extract := defaultIdentifierExtractor(nil, true)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	req.RemoteAddr = "203.0.113.9:443"
	req.Header.Set("X-API-Key", apiKey)

	id := extract(req)
	require.True(t, strings.HasPrefix(id, "api_key:hmac-sha256:"))
	require.Len(t, strings.TrimPrefix(id, "api_key:hmac-sha256:"), 64)
	require.NotContains(t, id, apiKey)
	require.Equal(t, id, extract(req))

	other := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com/test", nil)
	other.RemoteAddr = req.RemoteAddr
	other.Header.Set("X-API-Key", apiKey+"-different")
	require.NotEqual(t, id, extract(other))

	// An explicit context identifier still takes precedence.
	identified := WithIdentifier(req, "user:123")
	require.Equal(t, "user:123", extract(identified))
}
