package sanitization

import (
	"fmt"
	"strings"
	"unicode"
)

const redactedValue = "[REDACTED]"

const (
	emptyMaskedValue = "(empty)"
	maskedValue      = "***masked***"
)

// AllowedFields are field names that should bypass sanitization.
var AllowedFields = map[string]bool{
	"card_bin":   true,
	"card_brand": true,
	"card_type":  true,
}

// SanitizationType defines how to sanitize a field.
type SanitizationType int

const (
	FullyRedact SanitizationType = iota
	PartialMask
)

// SensitiveFields defines fields that require explicit sanitization behavior.
//
// This list is intentionally keyed by lowercased field name.
var SensitiveFields = map[string]SanitizationType{
	"cvv":           FullyRedact,
	"security_code": FullyRedact,
	"cvv2":          FullyRedact,
	"cvc":           FullyRedact,
	"cvc2":          FullyRedact,

	"cardholder":      FullyRedact,
	"cardholder_name": FullyRedact,

	"card_number": PartialMask,
	"number":      PartialMask,

	"account_number": PartialMask,
	"ssn":            PartialMask,
	"tin":            PartialMask,
	"tax_id":         PartialMask,
	"ein":            PartialMask,

	"password":    FullyRedact,
	"secret":      FullyRedact,
	"private_key": FullyRedact,
	"secret_key":  FullyRedact,

	"api_token":            FullyRedact,
	"api_key_id":           PartialMask,
	"authorization":        FullyRedact,
	"authorization_id":     FullyRedact,
	"authorization_header": FullyRedact,
}

// SanitizeLogString removes control characters that could enable log forging.
func SanitizeLogString(value string) string {
	if value == "" {
		return value
	}
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	return value
}

// SanitizeFieldValue sanitizes a field value based on its key name.
//
// This function is intentionally deterministic and safe-by-default for known sensitive keys.
func SanitizeFieldValue(key string, value any) any {
	keyLower := strings.ToLower(strings.TrimSpace(key))
	if keyLower == "" {
		return sanitizeValue(value)
	}
	if AllowedFields[keyLower] {
		return sanitizeValue(value)
	}

	if typ, ok := SensitiveFields[keyLower]; ok {
		switch typ {
		case FullyRedact:
			return redactedValue
		case PartialMask:
			if keyLower == "card_number" || keyLower == "number" {
				return maskCardNumberValue(value)
			}
			return maskRestrictedValue(value)
		default:
			return redactedValue
		}
	}

	// Substring-based fallback: treat obvious secrets/tokens as fully redacted.
	blockedSubstrings := []string{
		"secret",
		"token",
		"password",
		"private_key",
		"client_secret",
		"api_key",
		"authorization",
	}
	for _, substr := range blockedSubstrings {
		if strings.Contains(keyLower, substr) {
			return redactedValue
		}
	}

	return sanitizeValue(value)
}

// MaskFirstLast keeps the first prefixLen and last suffixLen characters and masks the middle.
// Behavior matches Lift's sanitization helpers.
func MaskFirstLast(value string, prefixLen, suffixLen int) string {
	if value == "" {
		return emptyMaskedValue
	}
	if prefixLen < 0 || suffixLen < 0 {
		return maskedValue
	}
	if len(value) <= prefixLen+suffixLen {
		return maskedValue
	}
	return value[:prefixLen] + "***" + value[len(value)-suffixLen:]
}

// MaskFirstLast4 keeps the first and last 4 characters and masks the middle.
func MaskFirstLast4(value string) string {
	return MaskFirstLast(value, 4, 4)
}

func sanitizeValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return SanitizeLogString(typed)
	case []byte:
		return SanitizeLogString(string(typed))
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = SanitizeFieldValue(k, v)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i := range typed {
			out[i] = sanitizeValue(typed[i])
		}
		return out
	default:
		return SanitizeLogString(fmt.Sprintf("%v", typed))
	}
}

func maskRestrictedValue(value any) string {
	switch v := value.(type) {
	case string:
		return maskRestrictedString(v)
	case []byte:
		return maskRestrictedString(string(v))
	default:
		return redactedValue
	}
}

func maskRestrictedString(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return redactedValue
	}

	// For numeric-ish strings, mask all but last 4 digits.
	cleaned := stripNonDigits(value)
	if len(cleaned) >= 4 {
		if len(cleaned) == 4 {
			return strings.Repeat("*", 4)
		}
		return strings.Repeat("*", len(cleaned)-4) + cleaned[len(cleaned)-4:]
	}

	// For alphanumeric identifiers, show last 4.
	if len(value) >= 4 {
		return "..." + value[len(value)-4:]
	}
	return redactedValue
}

func stripNonDigits(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func maskCardNumberValue(value any) string {
	switch v := value.(type) {
	case string:
		return maskCardNumberString(v)
	case []byte:
		return maskCardNumberString(string(v))
	default:
		return redactedValue
	}
}

func maskCardNumberString(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return redactedValue
	}
	cleaned := stripNonDigits(value)
	if len(cleaned) < 4 {
		return redactedValue
	}

	// PCI-friendly: show BIN + last 4 when available.
	if len(cleaned) > 10 {
		return cleaned[:6] + strings.Repeat("*", len(cleaned)-10) + cleaned[len(cleaned)-4:]
	}
	if len(cleaned) > 4 {
		return strings.Repeat("*", len(cleaned)-4) + cleaned[len(cleaned)-4:]
	}
	return strings.Repeat("*", 4)
}
