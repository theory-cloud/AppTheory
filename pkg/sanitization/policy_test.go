package sanitization

import "testing"

func TestNewPolicySanitizer_NilPolicyUsesDefault(t *testing.T) {
	t.Parallel()

	fn, err := NewPolicySanitizer(nil)
	if err != nil {
		t.Fatalf("NewPolicySanitizer: %v", err)
	}

	if got := fn("cvv", "123"); got != redactedValue {
		t.Fatalf("expected default sanitizer behavior, got %#v", got)
	}
}

func TestNewPolicySanitizer_InvalidPolicyErrors(t *testing.T) {
	t.Parallel()

	if _, err := NewPolicySanitizer(&Policy{Rules: []PolicyRule{{Key: "", Action: PolicyAllow}}}); err == nil {
		t.Fatal("expected missing key to return error")
	}

	if _, err := NewPolicySanitizer(&Policy{
		Rules: []PolicyRule{{Key: "authorization_id", Action: PolicyAction("nope")}},
	}); err == nil {
		t.Fatal("expected invalid action to return error")
	}
}

func TestPolicySanitizer_RulesOverrideDefaultsAndRecurse(t *testing.T) {
	t.Parallel()

	fn, err := NewPolicySanitizer(&Policy{
		AllowedFields:     []string{"authorization_id"},
		FullyRedactFields: []string{"merchant_uid"},
		PartialMaskFields: []string{"custom_pan"},
		Rules: []PolicyRule{
			{ParentKey: "data", Key: "authorization_id", Action: PolicyAction("redact")},
			{Key: "custom_pan2", Action: PolicyAction("partial")},
		},
	})
	if err != nil {
		t.Fatalf("NewPolicySanitizer: %v", err)
	}

	in := map[string]any{
		"authorization_id": "auth_1",
		"merchant_uid":     "muid_1",
		"custom_pan":       "4111111111111111",
		"custom_pan2":      "4111111111111111",
		"data": map[string]any{
			"authorization_id": "auth_2",
		},
		"raw": RawJSON([]byte(`{"card_number":"4111111111111111","cvv":"123"}`)),
		"arr": []any{
			"a\nb",
			map[string]any{"merchant_uid": "muid_2"},
		},
		"n": 123,
	}

	out, ok := fn("root", in).(map[string]any)
	if !ok {
		t.Fatalf("expected map output, got %T (%#v)", out, out)
	}

	if out["authorization_id"] != "auth_1" {
		t.Fatalf("expected authorization_id to be preserved, got %#v", out["authorization_id"])
	}
	if out["merchant_uid"] != redactedValue {
		t.Fatalf("expected merchant_uid to be redacted by policy, got %#v", out["merchant_uid"])
	}
	if out["custom_pan"] != "************1111" {
		t.Fatalf("expected custom_pan to be masked, got %#v", out["custom_pan"])
	}
	if out["custom_pan2"] != "************1111" {
		t.Fatalf("expected custom_pan2 to be masked, got %#v", out["custom_pan2"])
	}

	data, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatalf("expected data to be map, got %T (%#v)", out["data"], out["data"])
	}
	if data["authorization_id"] != redactedValue {
		t.Fatalf("expected data.authorization_id to be redacted by parent rule, got %#v", data["authorization_id"])
	}

	raw, ok := out["raw"].(map[string]any)
	if !ok {
		t.Fatalf("expected raw to be structured object, got %T (%#v)", out["raw"], out["raw"])
	}
	if raw["card_number"] != "411111******1111" {
		t.Fatalf("expected raw.card_number to be masked, got %#v", raw["card_number"])
	}
	if raw["cvv"] != redactedValue {
		t.Fatalf("expected raw.cvv to be redacted, got %#v", raw["cvv"])
	}

	arr, ok := out["arr"].([]any)
	if !ok || len(arr) != 2 {
		t.Fatalf("expected arr to be []any with 2 items, got %#v (%T)", out["arr"], out["arr"])
	}
	if arr[0] != "ab" {
		t.Fatalf("expected arr[0] to be sanitized string, got %#v", arr[0])
	}
	m, ok := arr[1].(map[string]any)
	if !ok {
		t.Fatalf("expected arr[1] to be map, got %#v (%T)", arr[1], arr[1])
	}
	if m["merchant_uid"] != redactedValue {
		t.Fatalf("expected arr[1].merchant_uid to be redacted by policy, got %#v", m["merchant_uid"])
	}

	if out["n"] != "123" {
		t.Fatalf("expected n to be formatted as string, got %#v", out["n"])
	}
}
