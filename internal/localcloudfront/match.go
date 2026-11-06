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
	patternRunes := []rune(pattern)
	valueRunes := []rune(value)
	var patternIndex, valueIndex int
	starIndex, starValueIndex := -1, -1
	for valueIndex < len(valueRunes) {
		switch {
		case patternIndex < len(patternRunes) && (patternRunes[patternIndex] == '?' || patternRunes[patternIndex] == valueRunes[valueIndex]):
			patternIndex++
			valueIndex++
		case patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*':
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
	for patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(patternRunes)
}

func lowerHeaderName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
