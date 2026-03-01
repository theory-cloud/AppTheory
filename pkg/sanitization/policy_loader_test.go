package sanitization

import "testing"

func TestPolicyFromText_EmptyAndNullReturnNil(t *testing.T) {
	t.Parallel()

	if p, err := PolicyFromText(""); err != nil || p != nil {
		t.Fatalf("expected empty to return (nil, nil), got (%#v, %v)", p, err)
	}
	if p, err := PolicyFromText("   "); err != nil || p != nil {
		t.Fatalf("expected whitespace to return (nil, nil), got (%#v, %v)", p, err)
	}
	if p, err := PolicyFromText("null"); err != nil || p != nil {
		t.Fatalf("expected null to return (nil, nil), got (%#v, %v)", p, err)
	}
}

func TestPolicyFromText_JSONParsesAndValidates(t *testing.T) {
	t.Parallel()

	raw := `{
  "allowed_fields": ["merchant_token", "merchant_ref"],
  "fully_redact_fields": ["token", "authorization"],
  "partial_mask_fields": ["processor_token"],
  "rules": [
    {"parent_key":"tokenDetails","key":"token","action":"fully_redact"},
    {"parent_key":"cardWithPanDetails","key":"accountNumber","action":"partial_mask"}
  ]
}`

	p, err := PolicyFromText(raw)
	if err != nil {
		t.Fatalf("PolicyFromText: %v", err)
	}
	if p == nil {
		t.Fatal("expected policy to be non-nil")
	}
	if len(p.AllowedFields) != 2 || p.AllowedFields[0] != "merchant_token" {
		t.Fatalf("unexpected allowed fields: %#v", p.AllowedFields)
	}

	if _, err := NewPolicySanitizer(p); err != nil {
		t.Fatalf("NewPolicySanitizer: %v", err)
	}
}

func TestPolicyFromText_YAMLParsesAndValidates(t *testing.T) {
	t.Parallel()

	raw := `
allowed_fields:
  - merchant_token
fully_redact_fields:
  - token
rules:
  - parent_key: tokenDetails
    key: token
    action: fully_redact
`

	p, err := PolicyFromText(raw)
	if err != nil {
		t.Fatalf("PolicyFromText: %v", err)
	}
	if p == nil {
		t.Fatal("expected policy to be non-nil")
	}
	if len(p.AllowedFields) != 1 || p.AllowedFields[0] != "merchant_token" {
		t.Fatalf("unexpected allowed fields: %#v", p.AllowedFields)
	}

	if _, err := NewPolicySanitizer(p); err != nil {
		t.Fatalf("NewPolicySanitizer: %v", err)
	}
}

func TestPolicyFromText_InvalidPolicyFailsFast(t *testing.T) {
	t.Parallel()

	raw := `{"rules":[{"key":"authorization_id","action":"nope"}]}`
	if p, err := PolicyFromText(raw); err == nil || p != nil {
		t.Fatalf("expected invalid policy to return error, got (%#v, %v)", p, err)
	}
}

func TestPolicyFromEnv_LoadsWhenSet(t *testing.T) {
	if p, err := PolicyFromEnv("APP_SANITIZATION_POLICY_TEST_UNSET"); err != nil || p != nil {
		t.Fatalf("expected unset env to return (nil, nil), got (%#v, %v)", p, err)
	}

	t.Setenv("APP_SANITIZATION_POLICY_TEST", `{"allowed_fields":["merchant_token"]}`)
	p, err := PolicyFromEnv("APP_SANITIZATION_POLICY_TEST")
	if err != nil {
		t.Fatalf("PolicyFromEnv: %v", err)
	}
	if p == nil || len(p.AllowedFields) != 1 || p.AllowedFields[0] != "merchant_token" {
		t.Fatalf("unexpected policy: %#v", p)
	}
}

func TestPolicyFromEnv_EmptyEnvVarNameErrors(t *testing.T) {
	t.Parallel()

	if _, err := PolicyFromEnv(""); err == nil {
		t.Fatal("expected empty env var name to return error")
	}
}

func TestPolicyFromEnv_InvalidPolicyErrors(t *testing.T) {
	t.Setenv("APP_SANITIZATION_POLICY_TEST", `{"rules":[{"key":"authorization_id","action":"nope"}]}`)
	if p, err := PolicyFromEnv("APP_SANITIZATION_POLICY_TEST"); err == nil || p != nil {
		t.Fatalf("expected invalid env policy to return error, got (%#v, %v)", p, err)
	}
}
