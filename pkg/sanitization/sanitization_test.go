package sanitization

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeLogString_StripsCRLF(t *testing.T) {
	got := SanitizeLogString("a\r\nb\nc\rd")
	if got != "abcd" {
		t.Fatalf("expected abcd, got %q", got)
	}
}

func TestSanitizeJSON_RedactsKnownFields(t *testing.T) {
	input := []byte(`{"card_number":"4111111111111111","cvv":"123","nested":{"authorization":"Bearer secret"},"ok":"v"}`)
	out := SanitizeJSON(input)

	if !strings.Contains(out, `"cvv": "[REDACTED]"`) {
		t.Fatalf("expected cvv redacted, got: %s", out)
	}
	if !strings.Contains(out, `"authorization": "[REDACTED]"`) {
		t.Fatalf("expected authorization redacted, got: %s", out)
	}
	if strings.Contains(out, "4111111111111111") {
		t.Fatalf("expected card number masked, got: %s", out)
	}
	if !strings.Contains(out, `"ok": "v"`) {
		t.Fatalf("expected ok preserved, got: %s", out)
	}

	var parsed any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("expected valid json, got error: %v\nout=%s", err, out)
	}
}

func TestSanitizeXML_MasksPatterns(t *testing.T) {
	input := `<AcctNum>4111111111111111</AcctNum><CVV>123</CVV><TransArmorToken>abc123def456</TransArmorToken>`
	out := SanitizeXML(input, PaymentXMLPatterns)

	if strings.Contains(out, "4111111111111111") {
		t.Fatalf("expected acct num masked, got: %s", out)
	}
	if strings.Contains(out, "<CVV>123</CVV>") {
		t.Fatalf("expected cvv redacted, got: %s", out)
	}
	if strings.Contains(out, "abc123def456") {
		t.Fatalf("expected token masked, got: %s", out)
	}
}
