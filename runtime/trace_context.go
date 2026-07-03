package apptheory

import "strings"

const (
	traceParentHeaderName = "traceparent"
	xAmznTraceIDHeader    = "x-amzn-trace-id"
)

func extractTraceIDFromHeaders(headers map[string][]string) string {
	if traceID := traceIDFromTraceParent(firstNonEmptyHeaderValue(headers, traceParentHeaderName)); traceID != "" {
		return traceID
	}
	return traceIDFromXAmznTraceID(firstNonEmptyHeaderValue(headers, xAmznTraceIDHeader))
}

func firstNonEmptyHeaderValue(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(strings.TrimSpace(key))]
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func traceIDFromTraceParent(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parts := strings.Split(value, "-")
	if len(parts) < 4 {
		return ""
	}
	traceID := strings.ToLower(strings.TrimSpace(parts[1]))
	if len(traceID) != 32 || !isLowerHex(traceID) || allZero(traceID) {
		return ""
	}
	return traceID
}

func traceIDFromXAmznTraceID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	for _, part := range strings.Split(value, ";") {
		key, raw, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "Root") {
			continue
		}
		root := strings.TrimSpace(raw)
		if validXRayRoot(root) {
			return root
		}
		return ""
	}
	return ""
}

func validXRayRoot(root string) bool {
	parts := strings.Split(root, "-")
	if len(parts) != 3 {
		return false
	}
	if parts[0] != "1" || len(parts[1]) != 8 || len(parts[2]) != 24 {
		return false
	}
	return isLowerHex(strings.ToLower(parts[1])) && isLowerHex(strings.ToLower(parts[2])) && !allZero(parts[2])
}

func isLowerHex(value string) bool {
	for _, ch := range value {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') {
			continue
		}
		return false
	}
	return true
}

func allZero(value string) bool {
	for _, ch := range value {
		if ch != '0' {
			return false
		}
	}
	return value != ""
}
