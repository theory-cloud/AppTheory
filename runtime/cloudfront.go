package apptheory

import (
	"strings"
	"unicode"
)

// OriginURL reconstructs the canonical origin URL (scheme + host) from edge-copied original-host
// headers first, then falls back to generic forwarded headers when needed.
func OriginURL(headers map[string][]string) string {
	canonical := canonicalizeHeaders(headers)
	return originURLForHost(canonical, originalHostFromCanonicalizedHeaders(canonical))
}

// AuthoritativeOriginURL derives the origin for metadata that must name the
// deployment's own authority rather than a value the caller supplied.
//
// The platform-set `host` header is deployment-authoritative. With
// honorForwardedHost false the origin is derived from `host` alone: the
// forwarded-host headers (x-apptheory-original-host, x-facetheory-original-host,
// x-forwarded-host, and the Forwarded `host=` parameter) are ignored, so an
// injected forwarded host cannot steer the result.
//
// With honorForwardedHost true — the caller has an explicit trusted-host
// allowlist and must still verify the result — the edge forward chain is
// consulted with the same priority as OriginURL, then falls back to `host`. The
// caller is responsible for rejecting an origin whose authority is not
// allowlisted.
func AuthoritativeOriginURL(headers map[string][]string, honorForwardedHost bool) string {
	canonical := canonicalizeHeaders(headers)
	if honorForwardedHost {
		return originURLForHost(canonical, originalHostFromCanonicalizedHeaders(canonical))
	}
	return originURLForHost(canonical, hostHeaderValue(canonical))
}

// hostHeaderValue reads the platform-set `host` header, trimming a comma suffix.
func hostHeaderValue(headers map[string][]string) string {
	return strings.TrimSpace(firstCommaToken(firstHeaderValue(headers, "host")))
}

// originURLForHost combines a host with the protocol the edge recorded, defaulting to https.
func originURLForHost(headers map[string][]string, host string) string {
	if host == "" {
		return ""
	}

	forwardedProto, _ := parseForwardedHeader(firstHeaderValue(headers, "forwarded"))

	proto := firstHeaderValue(headers, "cloudfront-forwarded-proto")
	if proto == "" {
		proto = firstHeaderValue(headers, "x-forwarded-proto")
	}
	if proto == "" {
		proto = forwardedProto
	}
	proto = strings.ToLower(strings.TrimSpace(firstCommaToken(proto)))
	if proto == "" {
		proto = "https"
	}

	return proto + "://" + host
}

// OriginalHost extracts the best available viewer-facing host without depending on raw Host forwarding.
func OriginalHost(headers map[string][]string) string {
	return originalHostFromCanonicalizedHeaders(canonicalizeHeaders(headers))
}

// OriginalURI returns the viewer URI captured by the edge contract when available.
func OriginalURI(headers map[string][]string) string {
	return originalURIFromCanonicalizedHeaders(canonicalizeHeaders(headers))
}

// ClientIP extracts a stable client IP address from CloudFront and generic forwarded headers.
func ClientIP(headers map[string][]string) string {
	headers = canonicalizeHeaders(headers)

	if value := firstHeaderValue(headers, "cloudfront-viewer-address"); value != "" {
		if ip := parseCloudFrontViewerAddress(value); ip != "" {
			return ip
		}
	}

	if value := firstHeaderValue(headers, "x-forwarded-for"); value != "" {
		ip := strings.TrimSpace(firstCommaToken(value))
		if ip != "" {
			return ip
		}
	}

	return ""
}

func firstCommaToken(value string) string {
	if idx := strings.Index(value, ","); idx >= 0 {
		return value[:idx]
	}
	return value
}

func originalHostFromCanonicalizedHeaders(headers map[string][]string) string {
	_, forwardedHost := parseForwardedHeader(firstHeaderValue(headers, "forwarded"))

	host := firstHeaderValue(headers, "x-apptheory-original-host")
	if host == "" {
		host = firstHeaderValue(headers, "x-facetheory-original-host")
	}
	if host == "" {
		host = firstHeaderValue(headers, "x-forwarded-host")
	}
	if host == "" {
		host = forwardedHost
	}
	if host == "" {
		host = firstHeaderValue(headers, "host")
	}
	host = firstCommaToken(host)
	return strings.TrimSpace(host)
}

func originalURIFromCanonicalizedHeaders(headers map[string][]string) string {
	value := firstHeaderValue(headers, "x-apptheory-original-uri")
	if value == "" {
		value = firstHeaderValue(headers, "x-facetheory-original-uri")
	}
	return strings.TrimSpace(value)
}

func parseForwardedHeader(value string) (proto string, host string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}

	first := value
	if idx := strings.Index(first, ","); idx >= 0 {
		first = first[:idx]
	}

	parts := strings.Split(first, ";")
	for _, part := range parts {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		val = strings.Trim(val, "\"")
		switch key {
		case "proto":
			if proto == "" {
				proto = val
			}
		case "host":
			if host == "" {
				host = val
			}
		}
	}
	return proto, host
}

func parseCloudFrontViewerAddress(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "\"")
	if value == "" {
		return ""
	}

	if strings.HasPrefix(value, "[") {
		if idx := strings.Index(value, "]"); idx > 1 {
			return strings.TrimSpace(value[1:idx])
		}
	}

	lastColon := strings.LastIndex(value, ":")
	if lastColon <= 0 {
		return value
	}

	ipPart := strings.TrimSpace(value[:lastColon])
	portPart := strings.TrimSpace(value[lastColon+1:])
	if ipPart == "" || portPart == "" {
		return value
	}

	for _, r := range portPart {
		if !unicode.IsDigit(r) {
			return value
		}
	}

	return ipPart
}
