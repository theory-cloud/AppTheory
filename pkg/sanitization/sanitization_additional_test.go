package sanitization

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeFieldValue_RedactsMasksAndRecurses(t *testing.T) {
	t.Parallel()

	if got := SanitizeFieldValue("cvv", "123"); got != redactedValue {
		t.Fatalf("expected cvv to be redacted, got %#v", got)
	}

	if got := SanitizeFieldValue("authorization", "Bearer secret"); got != redactedValue {
		t.Fatalf("expected authorization to be redacted, got %#v", got)
	}

	if got := SanitizeFieldValue("access_token", "tok"); got != redactedValue {
		t.Fatalf("expected substring token to be redacted, got %#v", got)
	}

	if got := SanitizeFieldValue("ssn", "123-45-6789"); got != "*****6789" {
		t.Fatalf("expected ssn to be masked, got %#v", got)
	}

	if got := SanitizeFieldValue("card_number", "4111111111111111"); got != "411111******1111" {
		t.Fatalf("expected card number to be pci-masked, got %#v", got)
	}

	// Allowed fields should be preserved (except for log sanitization).
	if got := SanitizeFieldValue("card_brand", "visa\r\n"); got != "visa" {
		t.Fatalf("expected allowed field to be sanitized but not masked, got %#v", got)
	}

	// Unknown fields should be sanitized but not redacted.
	if got := SanitizeFieldValue("ok", "a\nb"); got != "ab" {
		t.Fatalf("expected log sanitization for unknown keys, got %#v", got)
	}

	// Nested structures should recurse.
	out, ok := SanitizeFieldValue("obj", map[string]any{"cvv": "123", "ok": "a\nb"}).(map[string]any)
	if !ok {
		t.Fatalf("expected map output, got %T", out)
	}
	if out["cvv"] != redactedValue || out["ok"] != "ab" {
		t.Fatalf("unexpected nested sanitization result: %#v", out)
	}

	arr, ok := sanitizeValue([]any{"a\nb", map[string]any{"password": "x"}}).([]any)
	if !ok || len(arr) != 2 {
		t.Fatalf("expected []any output, got %#v (%T)", arr, arr)
	}
	if arr[0] != "ab" {
		t.Fatalf("expected array element to be sanitized, got %#v", arr[0])
	}
	if m, ok := arr[1].(map[string]any); !ok || m["password"] != redactedValue {
		t.Fatalf("expected nested map to redact password, got %#v (%T)", arr[1], arr[1])
	}
}

func TestSanitizeJSON_EmptyMalformedAndBodyJSONString(t *testing.T) {
	t.Parallel()

	if got := SanitizeJSON(nil); got != emptyMaskedValue {
		t.Fatalf("expected empty marker, got %q", got)
	}

	got := SanitizeJSON([]byte(`{`))
	if !strings.HasPrefix(got, "(malformed JSON:") {
		t.Fatalf("expected malformed marker, got %q", got)
	}

	// "body" may contain an embedded JSON string (common in AWS events).
	input := []byte(`{"body":"{\"authorization\":\"Bearer secret\",\"ok\":\"v\"}"}`)
	out := SanitizeJSON(input)
	if strings.Contains(out, "Bearer secret") {
		t.Fatalf("expected embedded body json string to be sanitized, got: %s", out)
	}

	var outer map[string]any
	if err := json.Unmarshal([]byte(out), &outer); err != nil {
		t.Fatalf("expected sanitized output to be valid json, got error: %v\nout=%s", err, out)
	}
	bodyValue, ok := outer["body"].(string)
	if !ok {
		t.Fatalf("expected body to be string, got %#v (%T)", outer["body"], outer["body"])
	}
	var inner map[string]any
	if err := json.Unmarshal([]byte(bodyValue), &inner); err != nil {
		t.Fatalf("expected body string to be valid json, got error: %v\nbody=%q", err, bodyValue)
	}
	if inner["ok"] != "v" {
		t.Fatalf("expected embedded body to preserve ok, got %#v", inner)
	}
	if inner["authorization"] != redactedValue {
		t.Fatalf("expected embedded body to redact authorization, got %#v", inner)
	}
}

func TestXMLMaskHelpers_HandleEscapedAndShortValues(t *testing.T) {
	t.Parallel()

	escaped := "&lt;AcctNum&gt;4111111111111111&lt;/AcctNum&gt;"
	if out := MaskCardNumber(escaped); strings.Contains(out, "4111111111111111") {
		t.Fatalf("expected escaped xml card number to be masked, got %s", out)
	}

	if out := MaskCardNumber("<AcctNum>123</AcctNum>"); out != "<AcctNum>123</AcctNum>" {
		t.Fatalf("expected short card number to remain unchanged, got %s", out)
	}

	mask := MaskCompletelyFunc(redactedValue)
	if out := mask("<CVV>123</CVV>"); out != "<CVV>"+redactedValue+"</CVV>" {
		t.Fatalf("expected full replacement, got %s", out)
	}

	if out := MaskTokenLastFour("<TransArmorToken></TransArmorToken>"); out != "<TransArmorToken></TransArmorToken>" {
		t.Fatalf("expected empty token to remain unchanged, got %s", out)
	}
	if out := MaskTokenLastFour("<TransArmorToken>abcd</TransArmorToken>"); out != "<TransArmorToken>abcd</TransArmorToken>" {
		t.Fatalf("expected 4-char token to remain unchanged, got %s", out)
	}
	if out := MaskTokenLastFour("<TransArmorToken>abcdef</TransArmorToken>"); !strings.Contains(out, "**cdef") {
		t.Fatalf("expected token to be masked to last4, got %s", out)
	}
}
