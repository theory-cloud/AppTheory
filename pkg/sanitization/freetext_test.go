package sanitization

import "testing"

func TestScrubFreeText_RemovesControlChars(t *testing.T) {
	t.Parallel()

	in := "a\r\nb\nc"
	out := ScrubFreeText(in)
	if out != "abc" {
		t.Fatalf("expected control chars to be removed, got %q", out)
	}
}

func TestScrubFreeText_RedactsBearerTokens(t *testing.T) {
	t.Parallel()

	in := "auth failed: Bearer secret_token_123"
	out := ScrubFreeText(in)
	if out == in {
		t.Fatalf("expected bearer token to be scrubbed, got %q", out)
	}
	if out != "auth failed: Bearer "+redactedValue {
		t.Fatalf("unexpected scrub result: %q", out)
	}
}

func TestScrubFreeText_RedactsKeyValueSecrets(t *testing.T) {
	t.Parallel()

	in := "api_key=sk_live_123 password: hunter2 token=tok_1"
	out := ScrubFreeText(in)
	if out == in {
		t.Fatalf("expected secrets to be scrubbed, got %q", out)
	}
	if out != "api_key="+redactedValue+" password: "+redactedValue+" token="+redactedValue {
		t.Fatalf("unexpected scrub result: %q", out)
	}
}

func TestScrubFreeText_MasksSSNs(t *testing.T) {
	t.Parallel()

	in := "bad ssn 123-45-6789"
	out := ScrubFreeText(in)
	if out == in {
		t.Fatalf("expected ssn to be scrubbed, got %q", out)
	}
	if out != "bad ssn *****6789" {
		t.Fatalf("unexpected scrub result: %q", out)
	}
}

func TestScrubFreeText_MasksPANsWhenLuhnValid(t *testing.T) {
	t.Parallel()

	in := "declined: card 4111 1111 1111 1111"
	out := ScrubFreeText(in)
	if out == in {
		t.Fatalf("expected pan to be scrubbed, got %q", out)
	}
	if out != "declined: card 411111******1111" {
		t.Fatalf("unexpected scrub result: %q", out)
	}
}

func TestScrubFreeText_DoesNotMaskPANCandidatesWhenLuhnInvalid(t *testing.T) {
	t.Parallel()

	in := "not a pan 4111111111111112"
	out := ScrubFreeText(in)
	if out != in {
		t.Fatalf("expected invalid luhn to remain unchanged, got %q", out)
	}
}
