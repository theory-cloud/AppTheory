package sanitization

import (
	"regexp"
	"strings"
)

// XMLSanitizationPattern defines a regex-based sanitization rule for XML elements.
type XMLSanitizationPattern struct {
	Pattern     *regexp.Regexp
	MaskingFunc func(match string) string
	Name        string
}

// SanitizeXML sanitizes XML content using configurable patterns.
//
// It supports both regular XML (<AcctNum>...</AcctNum>) and HTML-escaped XML (&lt;AcctNum&gt;...&lt;/AcctNum&gt;).
func SanitizeXML(xmlString string, patterns []XMLSanitizationPattern) string {
	result := xmlString
	for _, pattern := range patterns {
		result = pattern.Pattern.ReplaceAllStringFunc(result, pattern.MaskingFunc)
	}
	return result
}

// MaskCardNumber shows BIN + last 4 digits of card numbers (PCI-friendly).
func MaskCardNumber(match string) string {
	isEscaped := strings.Contains(match, "&gt;")

	var start, end int
	if isEscaped {
		start = strings.Index(match, "&gt;") + 4
		end = strings.LastIndex(match, "&lt;")
	} else {
		start = strings.Index(match, ">") + 1
		end = strings.LastIndex(match, "<")
	}

	if end > start {
		number := match[start:end]
		if len(number) > 10 {
			masked := number[:6] + strings.Repeat("*", len(number)-10) + number[len(number)-4:]
			return match[:start] + masked + match[end:]
		}
		if len(number) > 4 {
			masked := strings.Repeat("*", len(number)-4) + number[len(number)-4:]
			return match[:start] + masked + match[end:]
		}
	}

	return match
}

// MaskCompletelyFunc returns a function that replaces the inner text with a fixed replacement.
func MaskCompletelyFunc(replacement string) func(string) string {
	return func(match string) string {
		isEscaped := strings.Contains(match, "&gt;")

		var start, end int
		if isEscaped {
			start = strings.Index(match, "&gt;") + 4
			end = strings.LastIndex(match, "&lt;")
		} else {
			start = strings.Index(match, ">") + 1
			end = strings.LastIndex(match, "<")
		}

		if end >= start {
			return match[:start] + replacement + match[end:]
		}
		return match
	}
}

// MaskTokenLastFour shows only the last 4 characters of tokens.
func MaskTokenLastFour(match string) string {
	isEscaped := strings.Contains(match, "&gt;")

	if strings.Contains(match, "><") || strings.Contains(match, "&gt;&lt;") {
		return match
	}

	var start, end int
	if isEscaped {
		start = strings.Index(match, "&gt;") + 4
		end = strings.LastIndex(match, "&lt;")
	} else {
		start = strings.Index(match, ">") + 1
		end = strings.LastIndex(match, "<")
	}

	if end > start {
		token := match[start:end]
		if len(token) > 4 {
			masked := strings.Repeat("*", len(token)-4) + token[len(token)-4:]
			return match[:start] + masked + match[end:]
		}
	}

	return match
}
