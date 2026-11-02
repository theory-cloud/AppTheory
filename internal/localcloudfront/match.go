package localcloudfront

import "strings"

// MatchPathPattern applies CloudFront's path-pattern rules: a pattern may
// optionally begin with a slash, matching is case-sensitive, `*` matches zero
// or more characters and `?` matches exactly one character. The request path
// always begins with a slash; the default pattern `*` matches every path.
func MatchPathPattern(pattern, requestPath string) bool {
	pattern = strings.TrimPrefix(pattern, "/")
	requestPath = strings.TrimPrefix(requestPath, "/")
	return matchGlob(pattern, requestPath)
}

func matchGlob(pattern, value string) bool {
	// Iterative wildcard matching with single-star backtracking. `?` matches
	// exactly one byte, which is correct for the ASCII paths CloudFront
	// patterns target; multi-byte UTF-8 characters match one byte at a time,
	// mirroring a byte-oriented wildcard.
	var patternIndex, valueIndex int
	starIndex, starValueIndex := -1, -1
	for valueIndex < len(value) {
		switch {
		case patternIndex < len(pattern) && (pattern[patternIndex] == '?' || pattern[patternIndex] == value[valueIndex]):
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && pattern[patternIndex] == '*':
			starIndex = patternIndex
			starValueIndex = valueIndex
			patternIndex++
		case starIndex >= 0:
			patternIndex = starIndex + 1
			starValueIndex++
			valueIndex = starValueIndex
		default:
			return false
		}
	}
	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern)
}

func lowerHeaderName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
