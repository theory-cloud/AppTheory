package apptheory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// CacheControlSSR returns a conservative Cache-Control value for dynamic SSR.
func CacheControlSSR() string {
	return "private, no-store"
}

// CacheControlSSG returns a Cache-Control value suitable for edge-cached SSG HTML (no browser caching).
func CacheControlSSG() string {
	return "public, max-age=0, s-maxage=31536000"
}

// CacheControlISR returns a Cache-Control value suitable for ISR (edge-cached with stale-while-revalidate).
func CacheControlISR(revalidateSeconds, staleWhileRevalidateSeconds int) string {
	if revalidateSeconds < 0 {
		revalidateSeconds = 0
	}
	if staleWhileRevalidateSeconds < 0 {
		staleWhileRevalidateSeconds = 0
	}

	parts := []string{
		"public",
		"max-age=0",
		fmt.Sprintf("s-maxage=%d", revalidateSeconds),
	}
	if staleWhileRevalidateSeconds > 0 {
		parts = append(parts, fmt.Sprintf("stale-while-revalidate=%d", staleWhileRevalidateSeconds))
	}
	return strings.Join(parts, ", ")
}

// ETag returns a deterministic, strong ETag for the provided bytes.
//
// The returned value includes quotes (e.g. `"abc..."`).
func ETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// MatchesIfNoneMatch reports whether the request headers contain an If-None-Match value that matches the given etag.
func MatchesIfNoneMatch(headers map[string][]string, etag string) bool {
	etag = strings.TrimSpace(etag)
	if etag == "" {
		return false
	}

	headers = canonicalizeHeaders(headers)
	for _, header := range headers["if-none-match"] {
		for _, token := range splitCommaValues(header) {
			if token == "*" {
				return true
			}
			if strings.HasPrefix(token, "W/") {
				token = strings.TrimSpace(strings.TrimPrefix(token, "W/"))
			}
			if token == etag {
				return true
			}
		}
	}
	return false
}

// Vary merges Vary header values with deterministic ordering.
//
// Values are split on commas, trimmed, lowercased, de-duplicated, and sorted.
func Vary(existing []string, add ...string) []string {
	seen := map[string]struct{}{}
	var out []string

	addValue := func(value string) {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" {
			return
		}
		if _, ok := seen[value]; ok {
			return
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}

	for _, v := range existing {
		for _, token := range splitCommaValues(v) {
			addValue(token)
		}
	}
	for _, v := range add {
		for _, token := range splitCommaValues(v) {
			addValue(token)
		}
	}

	sort.Strings(out)
	return out
}

func splitCommaValues(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}
