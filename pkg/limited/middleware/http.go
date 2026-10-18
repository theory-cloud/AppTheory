// Package middleware provides HTTP middleware for the AppTheory limited rate limiter.
package middleware

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"github.com/theory-cloud/apptheory/v6/pkg/limited"
)

type contextKey string

const (
	IdentifierKey contextKey = "rate_limit_identifier"
)

const credentialFingerprintAlgorithm = "hmac-sha256"

// identifierFingerprintDomain is a stable framework domain separator, not a
// verification secret. It keeps credential-derived limiter keys deterministic
// without storing the source credential itself.
const identifierFingerprintDomain = "apptheory/rate-limit/identifier-fingerprint/v1" //nolint:gosec // stable domain separator, not a credential.

// Options configures the HTTP rate limiting middleware.
type Options struct {
	Limiter limited.RateLimiter

	ExtractIdentifier func(r *http.Request) string
	ExtractResource   func(r *http.Request) string
	ExtractOperation  func(r *http.Request) string

	ErrorHandler func(w http.ResponseWriter, r *http.Request, decision *limited.LimitDecision)
	OnSuccess    func(r *http.Request, decision *limited.LimitDecision)
	OnRateLimit  func(r *http.Request, decision *limited.LimitDecision)

	SkipRequest func(r *http.Request) bool

	// TrustedProxyCIDRs lists proxy address ranges whose X-Forwarded-For and
	// X-Real-IP headers are honored. Values that do not parse as an IP or CIDR
	// are ignored. When empty, forwarded headers are never trusted.
	TrustedProxyCIDRs []string

	// AllowCredentialIdentity enables default rate-limit identities derived
	// from X-API-Key and Authorization bearer credentials. Credentials are
	// always HMAC-fingerprinted, never used raw. Disabled by default.
	AllowCredentialIdentity bool
}

func Middleware(opts Options) func(http.HandlerFunc) http.HandlerFunc {
	trustedProxies := parseTrustedProxyCIDRs(opts.TrustedProxyCIDRs)
	if opts.ExtractIdentifier == nil {
		opts.ExtractIdentifier = defaultIdentifierExtractor(trustedProxies, opts.AllowCredentialIdentity)
	}
	if opts.ExtractResource == nil {
		opts.ExtractResource = defaultExtractResource
	}
	if opts.ExtractOperation == nil {
		opts.ExtractOperation = defaultExtractOperation
	}
	if opts.ErrorHandler == nil {
		opts.ErrorHandler = defaultErrorHandler
	}

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if opts.SkipRequest != nil && opts.SkipRequest(r) {
				next(w, r)
				return
			}

			key := limited.RateLimitKey{
				Identifier: opts.ExtractIdentifier(r),
				Resource:   opts.ExtractResource(r),
				Operation:  opts.ExtractOperation(r),
				Metadata: map[string]string{
					"path":       r.URL.Path,
					"user_agent": r.UserAgent(),
					"ip":         clientIP(r, trustedProxies),
				},
			}

			if atomicLimiter, ok := opts.Limiter.(limited.AtomicRateLimiter); ok {
				decision, err := atomicLimiter.CheckAndIncrement(r.Context(), key)
				if err != nil {
					setFailOpenHeaders(w)
					next(w, r)
					return
				}
				handleDecision(w, r, decision, &opts, next)
				return
			}

			decision, err := opts.Limiter.CheckLimit(r.Context(), key)
			if err != nil {
				setFailOpenHeaders(w)
				next(w, r)
				return
			}

			if decision.Allowed {
				if err := opts.Limiter.RecordRequest(r.Context(), key); err != nil {
					_ = err
				}
			}

			handleDecision(w, r, decision, &opts, next)
		}
	}
}

func handleDecision(w http.ResponseWriter, r *http.Request, decision *limited.LimitDecision, opts *Options, next http.HandlerFunc) {
	remaining := decision.Limit - decision.CurrentCount
	if remaining < 0 {
		remaining = 0
	}

	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(decision.Limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(decision.ResetsAt.Unix(), 10))

	if !decision.Allowed {
		if decision.RetryAfter != nil {
			w.Header().Set("Retry-After", strconv.Itoa(int(decision.RetryAfter.Seconds())))
		}
		if opts.OnRateLimit != nil {
			opts.OnRateLimit(r, decision)
		}
		opts.ErrorHandler(w, r, decision)
		return
	}

	if opts.OnSuccess != nil {
		opts.OnSuccess(r, decision)
	}
	next(w, r)
}

func setFailOpenHeaders(w http.ResponseWriter) {
	w.Header().Set("X-RateLimit-Limit", "0")
	w.Header().Set("X-RateLimit-Remaining", "0")
	w.Header().Set("X-RateLimit-Reset", "0")
}

// defaultExtractIdentifier applies the secure defaults: no trusted proxies and
// credential-derived identities disabled.
func defaultExtractIdentifier(r *http.Request) string {
	return extractIdentifier(r, nil, false)
}

func defaultIdentifierExtractor(trustedProxies []netip.Prefix, allowCredentialIdentity bool) func(r *http.Request) string {
	return func(r *http.Request) string {
		return extractIdentifier(r, trustedProxies, allowCredentialIdentity)
	}
}

func extractIdentifier(r *http.Request, trustedProxies []netip.Prefix, allowCredentialIdentity bool) string {
	if val := r.Context().Value(IdentifierKey); val != nil {
		if id, ok := val.(string); ok {
			if id = strings.TrimSpace(id); id != "" {
				return id
			}
		}
	}

	if allowCredentialIdentity {
		if apiKey := strings.TrimSpace(r.Header.Get("X-API-Key")); apiKey != "" {
			return fingerprintCredentialIdentifier("api_key", apiKey)
		}

		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			if token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")); token != "" {
				return fingerprintCredentialIdentifier("bearer", token)
			}
		}
	}

	return clientIP(r, trustedProxies)
}

func fingerprintCredentialIdentifier(kind, credentialValue string) string {
	mac := hmac.New(sha256.New, []byte(identifierFingerprintDomain))
	_, _ = mac.Write([]byte(kind))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(credentialValue))
	return kind + ":" + credentialFingerprintAlgorithm + ":" + hex.EncodeToString(mac.Sum(nil))
}

func parseTrustedProxyCIDRs(values []string) []netip.Prefix {
	if len(values) == 0 {
		return nil
	}

	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}

		if prefix, err := netip.ParsePrefix(value); err == nil {
			prefixes = append(prefixes, prefix.Masked())
			continue
		}

		if addr, err := netip.ParseAddr(value); err == nil {
			addr = addr.Unmap()
			prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
		}
	}

	if len(prefixes) == 0 {
		return nil
	}
	return prefixes
}

func isTrustedProxy(addr netip.Addr, trustedProxies []netip.Prefix) bool {
	if !addr.IsValid() {
		return false
	}

	for _, prefix := range trustedProxies {
		if prefix.Contains(addr) {
			return true
		}
		if unmapped := addr.Unmap(); unmapped != addr && prefix.Contains(unmapped) {
			return true
		}
	}
	return false
}

func defaultExtractResource(r *http.Request) string {
	path := r.URL.Path
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return "/"
	}
	return path
}

func defaultExtractOperation(r *http.Request) string {
	return r.Method
}

func defaultErrorHandler(w http.ResponseWriter, _ *http.Request, _ *limited.LimitDecision) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	if _, err := w.Write([]byte(`{"error":"rate_limit_exceeded","message":"Too many requests. Please retry later."}`)); err != nil {
		_ = err
	}
}

// getClientIP applies the secure defaults: forwarded headers are not trusted.
func getClientIP(r *http.Request) string {
	return clientIP(r, nil)
}

// clientIP returns the client address. Forwarded headers are consulted only
// when the transport peer (RemoteAddr) belongs to a trusted proxy range.
func clientIP(r *http.Request, trustedProxies []netip.Prefix) string {
	remoteAddr, ok := parseIP(r.RemoteAddr)
	if !ok {
		return strings.TrimSpace(r.RemoteAddr)
	}

	if isTrustedProxy(remoteAddr, trustedProxies) {
		if forwarded, ok := forwardedClientIP(r, trustedProxies); ok {
			return forwarded.String()
		}
	}

	return remoteAddr.String()
}

// forwardedClientIP walks X-Forwarded-For from right to left, skipping trusted
// proxies, so client-supplied entries to the left cannot win. Malformed entries
// are ignored.
func forwardedClientIP(r *http.Request, trustedProxies []netip.Prefix) (netip.Addr, bool) {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		entries := strings.Split(xff, ",")
		for i := len(entries) - 1; i >= 0; i-- {
			addr, ok := parseIP(entries[i])
			if !ok || isTrustedProxy(addr, trustedProxies) {
				continue
			}
			return addr, true
		}
	}

	if addr, ok := parseIP(r.Header.Get("X-Real-IP")); ok {
		return addr, true
	}

	return netip.Addr{}, false
}

func parseIP(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return netip.Addr{}, false
	}

	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.Unmap(), true
	}

	host, _, err := net.SplitHostPort(value)
	if err != nil {
		return netip.Addr{}, false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

func WithIdentifier(r *http.Request, identifier string) *http.Request {
	ctx := context.WithValue(r.Context(), IdentifierKey, identifier)
	return r.WithContext(ctx)
}
