package apptheory

import (
	"strings"
	"unicode"
)

// OriginURL reconstructs the canonical origin URL (scheme + host) from edge-copied original-host
// headers first, then falls back to generic forwarded headers when needed.
func OriginURL(headers map[string][]string) string {
	headers = canonicalizeHeaders(headers)

	forwardedProto, _ := parseForwardedHeader(firstHeaderValue(headers, "forwarded"))

	host := originalHostFromCanonicalizedHeaders(headers)
	if host == "" {
		return ""
	}

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
