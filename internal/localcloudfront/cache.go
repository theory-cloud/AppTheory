package localcloudfront

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// CloudFront caching.
//
// The cache key is the distribution domain plus the URL path, extended by the
// query strings, headers and cookies the cache policy names. OPTIONS is cached
// separately from GET and HEAD because the method is part of the key. The TTL
// comes from the origin response exactly as the Expiration page's table states:
// s-maxage wins over max-age, max-age wins over Expires, no-cache/no-store/
// private are not cached unless the minimum TTL is above zero, and the minimum
// and maximum TTL bound the result. Viewer Cache-Control and Pragma are ignored.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-the-cache-key.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html

const (
	// defaultErrorCachingTTL is CloudFront's default error-caching minimum when
	// no custom error response names one.
	defaultErrorCachingTTL = 10 * time.Second
	// maxInvalidationPaths is the documented per-request invalidation quota.
	maxInvalidationPaths = 3000
	// cacheHitHeader and cacheMissHeader are the documented x-cache values.
	cacheHitHeader  = "Hit from cloudfront"
	cacheMissHeader = "Miss from cloudfront"
)

// CacheEntry is one cached origin response and its expiry.
type CacheEntry struct {
	Response OriginResponse
	// Path is the viewer path the entry was stored under, used by invalidations.
	Path string
	// StoredAt and ExpiresAt are on the gateway's clock.
	StoredAt  time.Time
	ExpiresAt time.Time
	// StaleWhileRevalidate and StaleIfError are the origin's Cache-Control
	// extensions.
	StaleWhileRevalidate time.Duration
	StaleIfError         time.Duration
}

// Fresh reports whether the entry is inside its TTL.
func (e CacheEntry) Fresh(now time.Time) bool { return now.Before(e.ExpiresAt) }

// ServeStaleWhileRevalidate reports whether a stale entry may be served while
// the gateway refreshes it.
func (e CacheEntry) ServeStaleWhileRevalidate(now time.Time) bool {
	if e.StaleWhileRevalidate <= 0 {
		return false
	}
	return now.Before(e.ExpiresAt.Add(e.StaleWhileRevalidate))
}

// ServeStaleIfError reports whether a stale entry may be served because the
// origin failed.
func (e CacheEntry) ServeStaleIfError(now time.Time) bool {
	if e.StaleIfError <= 0 {
		return false
	}
	return now.Before(e.ExpiresAt.Add(e.StaleIfError))
}

// Cache stores origin responses for one distribution.
type Cache struct {
	mu      sync.Mutex
	entries map[string]CacheEntry
}

// NewCache returns an empty cache.
func NewCache() *Cache { return &Cache{entries: map[string]CacheEntry{}} }

// Get returns the entry stored under key.
func (c *Cache) Get(key string) (CacheEntry, bool) {
	if c == nil {
		return CacheEntry{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	return entry, ok
}

// Set stores one entry.
func (c *Cache) Set(key string, entry CacheEntry) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = entry
}

// Delete removes one entry.
func (c *Cache) Delete(key string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// Len reports how many entries are cached.
func (c *Cache) Len() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// Invalidate removes every entry whose path matches one of the invalidation
// paths. A path must start with a slash and may contain the * wildcard. The
// return value is the number of entries removed.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html
func (c *Cache) Invalidate(paths []string) int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	removed := 0
	for key, entry := range c.entries {
		for _, pattern := range paths {
			if invalidationPathMatches(pattern, entry.Path) {
				delete(c.entries, key)
				removed++
				break
			}
		}
	}
	return removed
}

// invalidationPathMatches matches one invalidation path against a viewer path.
// The invalidation path is URL-decoded first, as CloudFront documents, and *
// matches any run of characters.
func invalidationPathMatches(pattern, path string) bool {
	decoded, err := url.PathUnescape(pattern)
	if err != nil {
		decoded = pattern
	}
	if !strings.HasPrefix(decoded, "/") {
		return false
	}
	if !strings.Contains(decoded, "*") {
		return decoded == path
	}
	return wildcardMatch(decoded, path)
}

// wildcardMatch is the local * and ? matcher.
func wildcardMatch(pattern, value string) bool {
	p, v := 0, 0
	star, match := -1, 0
	for v < len(value) {
		switch {
		case p < len(pattern) && (pattern[p] == '?' || pattern[p] == value[v]):
			p++
			v++
		case p < len(pattern) && pattern[p] == '*':
			star = p
			match = v
			p++
		case star >= 0:
			p = star + 1
			match++
			v = match
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// CacheKey builds the cache key for one request. The distribution domain and
// the URL path are always part of it; the cache policy adds the query strings,
// headers and cookies it names.
func CacheKey(host, method, path, rawQuery string, header http.Header, policy *CachePolicy) string {
	queryRule, headerRule, cookieRule := newForwardingRule(), newForwardingRule(), newForwardingRule()
	if policy != nil {
		queryRule.addQuery(policy.QueryStrings)
		headerRule.addHeaders(policy.Headers, false)
		cookieRule.addCookies(policy.Cookies)
	}
	var builder strings.Builder
	builder.WriteString(strings.ToUpper(method))
	builder.WriteString("\n")
	builder.WriteString(strings.ToLower(host))
	builder.WriteString("\n")
	builder.WriteString(path)
	if query := selectedQueryKey(rawQuery, queryRule); query != "" {
		builder.WriteString("\n?")
		builder.WriteString(query)
	}
	if headers := selectedHeaderKey(header, headerRule); headers != "" {
		builder.WriteString("\n[")
		builder.WriteString(headers)
		builder.WriteString("]")
	}
	if cookies := selectedCookieKey(header, cookieRule); cookies != "" {
		builder.WriteString("\n(")
		builder.WriteString(cookies)
		builder.WriteString(")")
	}
	return builder.String()
}

func selectedQueryKey(rawQuery string, rule forwardingRule) string {
	segments := splitRawQuery(rawQuery)
	kept := make([]string, 0, len(segments))
	for _, segment := range segments {
		if rule.All || rule.selected(segment.name) {
			kept = append(kept, segment.raw)
		}
	}
	sort.Strings(kept)
	return strings.Join(kept, "&")
}

func selectedHeaderKey(header http.Header, rule forwardingRule) string {
	if !rule.All && len(rule.Whitelist) == 0 {
		return ""
	}
	kept := make([]string, 0, len(header))
	for name, values := range header {
		lower := strings.ToLower(name)
		if lower == headerHost || lower == headerCookie || isHopByHopHeader(lower) || strings.HasPrefix(lower, "cloudfront-") {
			continue
		}
		if !rule.All && !rule.Whitelist[lower] {
			continue
		}
		if len(values) > 0 {
			kept = append(kept, lower+"="+strings.Join(values, ","))
		}
	}
	sort.Strings(kept)
	return strings.Join(kept, "&")
}

func selectedCookieKey(header http.Header, rule forwardingRule) string {
	pairs := parseCookiePairs(header.Values("Cookie"))
	kept := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		if rule.All || rule.selected(pair.Name) {
			kept = append(kept, pair.Name+"="+pair.Value)
		}
	}
	sort.Strings(kept)
	return strings.Join(kept, ";")
}

// CacheControl is the origin Cache-Control subset CloudFront honors.
type CacheControl struct {
	NoCache              bool
	NoStore              bool
	Private              bool
	MaxAge               *time.Duration
	SMaxAge              *time.Duration
	StaleWhileRevalidate time.Duration
	StaleIfError         time.Duration
}

// ParseCacheControl reads the directives CloudFront uses. A malformed directive
// is ignored, as CloudFront ignores a header it cannot parse.
func ParseCacheControl(values []string) CacheControl {
	var control CacheControl
	for _, value := range values {
		for _, directive := range strings.Split(value, ",") {
			name, argument, found := strings.Cut(strings.TrimSpace(directive), "=")
			applyCacheControlDirective(&control, strings.ToLower(strings.TrimSpace(name)), argument, found)
		}
	}
	return control
}

func applyCacheControlDirective(control *CacheControl, name, argument string, found bool) {
	switch name {
	case "no-cache":
		control.NoCache = true
	case "no-store":
		control.NoStore = true
	case "private":
		control.Private = true
	case "max-age":
		if found {
			control.MaxAge = cacheControlSeconds(argument)
		}
	case "s-maxage":
		if found {
			control.SMaxAge = cacheControlSeconds(argument)
		}
	case "stale-while-revalidate":
		if found {
			if seconds, ok := positiveSeconds(argument); ok {
				control.StaleWhileRevalidate = seconds
			}
		}
	case "stale-if-error":
		if found {
			if seconds, ok := positiveSeconds(argument); ok {
				control.StaleIfError = seconds
			}
		}
	}
}

func cacheControlSeconds(argument string) *time.Duration {
	seconds, err := strconv.Atoi(strings.Trim(strings.TrimSpace(argument), `"`))
	if err != nil || seconds < 0 {
		return nil
	}
	duration := time.Duration(seconds) * time.Second
	return &duration
}

func positiveSeconds(argument string) (time.Duration, bool) {
	seconds, err := strconv.Atoi(strings.TrimSpace(argument))
	if err != nil || seconds <= 0 {
		return 0, false
	}
	return time.Duration(seconds) * time.Second, true
}

// OriginTTL returns the cache duration for an origin response and the parsed
// Cache-Control directives.
func (c CachePolicy) OriginTTL(response OriginResponse, now time.Time) (time.Duration, CacheControl) {
	control := ParseCacheControl(originHeaderValues(response.Header, "Cache-Control"))
	minimum := time.Duration(c.MinTTL) * time.Second
	maximum := time.Duration(c.MaxTTL) * time.Second
	if c.MaxTTL <= 0 {
		maximum = 365 * 24 * time.Hour
	}
	var ttl time.Duration
	switch {
	case control.NoCache || control.NoStore || control.Private:
		// A minimum TTL above zero caches the object anyway, as the Expiration
		// page's table states.
		ttl = 0
	case control.SMaxAge != nil:
		ttl = *control.SMaxAge
	case control.MaxAge != nil:
		ttl = *control.MaxAge
	default:
		ttl = time.Duration(c.DefaultTTL) * time.Second
		if expires, ok := parseHTTPDate(originHeaderValue(response.Header, "Expires")); ok {
			// max-age wins over Expires; Expires wins over the default.
			ttl = expires.Sub(now)
		}
	}
	if ttl < minimum {
		ttl = minimum
	}
	if ttl > maximum {
		ttl = maximum
	}
	if ttl < 0 {
		ttl = 0
	}
	return ttl, control
}

// originHeaderValue reads one header case-insensitively. An origin response built by
// the gateway uses canonical keys, but a handler-supplied header map may not.
func originHeaderValue(header http.Header, name string) string {
	values := originHeaderValues(header, name)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func originHeaderValues(header http.Header, name string) []string {
	if values := header.Values(name); len(values) > 0 {
		return values
	}
	for key, values := range header {
		if strings.EqualFold(key, name) {
			return values
		}
	}
	return nil
}

func parseHTTPDate(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// ValidateInvalidationPaths applies the documented invalidation request rules:
// at least one path, no more than 3000 paths, and every path must start with a
// slash. A wildcard is allowed anywhere in the path.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation_Requests.html
func ValidateInvalidationPaths(paths []string) error {
	if len(paths) == 0 {
		return &InvalidationPathError{Reason: "the invalidation batch contains no path"}
	}
	if len(paths) > maxInvalidationPaths {
		return &InvalidationPathError{Reason: fmt.Sprintf(
			"the invalidation batch contains %d paths; CloudFront accepts at most %d per request",
			len(paths), maxInvalidationPaths,
		)}
	}
	for _, path := range paths {
		if !strings.HasPrefix(path, "/") {
			return &InvalidationPathError{Reason: fmt.Sprintf("invalidation path %q does not begin with a slash", path)}
		}
	}
	return nil
}

// InvalidationPathError reports an invalidation path the API refuses.
type InvalidationPathError struct{ Reason string }

func (e *InvalidationPathError) Error() string { return e.Reason }
