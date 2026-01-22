package sanitization

import "testing"

func TestSanitizeLogString_EmptyString_ReturnsEmpty(t *testing.T) {
	t.Parallel()

	if got := SanitizeLogString(""); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestSanitizeFieldValue_EmptyKey_SanitizesValue(t *testing.T) {
	t.Parallel()

	if got := SanitizeFieldValue("   ", []byte("a\r\nb")); got != "ab" {
		t.Fatalf("expected sanitized byte string, got %#v (%T)", got, got)
	}
}

func TestSanitizeFieldValue_UnknownSanitizationType_DefaultsToRedact(t *testing.T) {
	orig, ok := SensitiveFields["weird"]
	SensitiveFields["weird"] = SanitizationType(123)
	t.Cleanup(func() {
		if ok {
			SensitiveFields["weird"] = orig
		} else {
			delete(SensitiveFields, "weird")
		}
	})

	if got := SanitizeFieldValue("weird", "x"); got != redactedValue {
		t.Fatalf("expected default to redact, got %#v", got)
	}
}

func TestSanitizeValue_CoversNilBytesAndDefault(t *testing.T) {
	t.Parallel()

	if got := sanitizeValue(nil); got != nil {
		t.Fatalf("expected nil, got %#v", got)
	}
	if got := sanitizeValue([]byte("a\nb")); got != "ab" {
		t.Fatalf("expected sanitized bytes, got %#v", got)
	}
	if got := sanitizeValue(123); got != "123" {
		t.Fatalf("expected formatted value, got %#v", got)
	}
}

func TestMaskRestrictedValue_DefaultBranch(t *testing.T) {
	t.Parallel()

	if got := maskRestrictedValue(123); got != redactedValue {
		t.Fatalf("expected default to redact, got %q", got)
	}
	if got := SanitizeFieldValue("ssn", []byte("123-45-6789")); got != "*****6789" {
		t.Fatalf("expected byte value to be masked, got %#v", got)
	}
}

func TestMaskRestrictedString_Branches(t *testing.T) {
	t.Parallel()

	if got := maskRestrictedString("1234"); got != "****" {
		t.Fatalf("expected 4 digit mask, got %q", got)
	}
	if got := maskRestrictedString("123456"); got != "**3456" {
		t.Fatalf("expected last4 mask, got %q", got)
	}
	if got := maskRestrictedString("abcde"); got != "...bcde" {
		t.Fatalf("expected last4 suffix, got %q", got)
	}
	if got := maskRestrictedString("abc"); got != redactedValue {
		t.Fatalf("expected short value to redact, got %q", got)
	}
}

func TestMaskCardNumberValue_AndStringBranches(t *testing.T) {
	t.Parallel()

	if got := maskCardNumberValue(123); got != redactedValue {
		t.Fatalf("expected default to redact, got %q", got)
	}
	if got := maskCardNumberString("123"); got != redactedValue {
		t.Fatalf("expected short card to redact, got %q", got)
	}
	if got := maskCardNumberString("1234"); got != "****" {
		t.Fatalf("expected 4 digit mask, got %q", got)
	}
	if got := maskCardNumberString("1234567890"); got != "******7890" {
		t.Fatalf("expected last4 mask, got %q", got)
	}
}
