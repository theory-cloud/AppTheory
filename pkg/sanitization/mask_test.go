package sanitization

import "testing"

func TestMaskFirstLast4(t *testing.T) {
	t.Parallel()

	if got := MaskFirstLast4(""); got != "(empty)" {
		t.Fatalf("expected empty marker, got %q", got)
	}
	if got := MaskFirstLast4("12345678"); got != "***masked***" {
		t.Fatalf("expected masked marker, got %q", got)
	}
	if got := MaskFirstLast4("1234567890abcdef"); got != "1234***cdef" {
		t.Fatalf("expected first/last preserved, got %q", got)
	}
}

func TestMaskFirstLast(t *testing.T) {
	t.Parallel()

	if got := MaskFirstLast("abcdef", 3, 3); got != "***masked***" {
		t.Fatalf("expected masked marker, got %q", got)
	}
	if got := MaskFirstLast("abcdef", -1, 2); got != "***masked***" {
		t.Fatalf("expected masked marker for negative lengths, got %q", got)
	}
	if got := MaskFirstLast("abcdef", 2, 2); got != "ab***ef" {
		t.Fatalf("expected first/last preserved, got %q", got)
	}
}
