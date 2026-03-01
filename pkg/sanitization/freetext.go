package sanitization

import (
	"regexp"
)

var (
	freeTextEmailPattern = regexp.MustCompile(`(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b`)
	freeTextSSNPattern   = regexp.MustCompile(`\b\d{3}-?\d{2}-?\d{4}\b`)
	freeTextJWTToken     = regexp.MustCompile(`\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b`)

	freeTextBearerToken = regexp.MustCompile(`(?i)\b(bearer)\s+([^\s,;]+)`)

	freeTextKeyValueSecret = regexp.MustCompile(
		`(?i)\b(` +
			`authorization|` +
			`api[_-]?key|` +
			`client[_-]?secret|` +
			`password|` +
			`secret|` +
			`private[_-]?key|` +
			`secret[_-]?key|` +
			`access[_-]?token|` +
			`refresh[_-]?token|` +
			`id[_-]?token|` +
			`token` +
			`)(\s*[:=]\s*)([^\s,;]+)`,
	)

	// PAN candidates: 13-19 digits with optional single separators (space or dash).
	freeTextPANCandidate = regexp.MustCompile(`\d(?:[ -]?\d){12,18}`)
)

// ScrubFreeText applies best-effort scrubbing to unstructured strings (for example, provider error messages).
//
// It is intended as a complement to structured sanitization (SanitizeFieldValue / SanitizeJSONValue), since
// upstream errors are often plain text blobs.
func ScrubFreeText(value string) string {
	out := SanitizeLogString(value)
	if out == "" {
		return out
	}

	out = freeTextJWTToken.ReplaceAllString(out, redactedValue)
	out = freeTextBearerToken.ReplaceAllString(out, "$1 "+redactedValue)
	out = freeTextKeyValueSecret.ReplaceAllString(out, "$1$2"+redactedValue)
	out = freeTextEmailPattern.ReplaceAllString(out, redactedValue)

	out = freeTextSSNPattern.ReplaceAllStringFunc(out, maskRestrictedString)

	out = freeTextPANCandidate.ReplaceAllStringFunc(out, func(match string) string {
		digits := stripNonDigits(match)
		if len(digits) < 13 || len(digits) > 19 {
			return match
		}
		if !isLuhnValid(digits) {
			return match
		}
		return maskCardNumberString(digits)
	})

	return out
}

func isLuhnValid(number string) bool {
	sum := 0
	alt := false
	for i := len(number) - 1; i >= 0; i-- {
		d := int(number[i] - '0')
		if d < 0 || d > 9 {
			return false
		}
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}
