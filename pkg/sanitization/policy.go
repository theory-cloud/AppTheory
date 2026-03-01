package sanitization

import (
	"errors"
	"fmt"
	"strings"
)

var errInvalidSanitizationPolicy = errors.New("sanitization: invalid policy")

type PolicyAction string

const (
	PolicyAllow       PolicyAction = "allow"
	PolicyFullyRedact PolicyAction = "fully_redact"
	PolicyPartialMask PolicyAction = "partial_mask"
)

type PolicyRule struct {
	// ParentKey scopes the rule to a single parent key. When empty, the rule applies globally.
	ParentKey string       `json:"parent_key,omitempty" yaml:"parent_key,omitempty"`
	Key       string       `json:"key" yaml:"key"`
	Action    PolicyAction `json:"action" yaml:"action"`
}

// Policy allows services to override field sanitization behavior without providing custom code.
//
// Rules are evaluated before the built-in AllowedFields/SensitiveFields defaults.
type Policy struct {
	AllowedFields     []string     `json:"allowed_fields,omitempty" yaml:"allowed_fields,omitempty"`
	FullyRedactFields []string     `json:"fully_redact_fields,omitempty" yaml:"fully_redact_fields,omitempty"`
	PartialMaskFields []string     `json:"partial_mask_fields,omitempty" yaml:"partial_mask_fields,omitempty"`
	Rules             []PolicyRule `json:"rules,omitempty" yaml:"rules,omitempty"`
}

// NewPolicySanitizer returns a sanitizer function based on the provided policy.
//
// When policy is nil, the default sanitizer (SanitizeFieldValue) is returned.
func NewPolicySanitizer(policy *Policy) (func(key string, value any) any, error) {
	if policy == nil {
		return SanitizeFieldValue, nil
	}
	compiled, err := compilePolicy(*policy)
	if err != nil {
		return nil, err
	}
	s := &policySanitizer{policy: compiled}
	return s.SanitizeFieldValue, nil
}

type compiledPolicy struct {
	global   map[string]PolicyAction
	byParent map[string]map[string]PolicyAction
}

func compilePolicy(policy Policy) (*compiledPolicy, error) {
	out := &compiledPolicy{
		global:   map[string]PolicyAction{},
		byParent: map[string]map[string]PolicyAction{},
	}

	for _, k := range policy.AllowedFields {
		if err := out.setRule("", k, PolicyAllow); err != nil {
			return nil, err
		}
	}
	for _, k := range policy.FullyRedactFields {
		if err := out.setRule("", k, PolicyFullyRedact); err != nil {
			return nil, err
		}
	}
	for _, k := range policy.PartialMaskFields {
		if err := out.setRule("", k, PolicyPartialMask); err != nil {
			return nil, err
		}
	}
	for _, r := range policy.Rules {
		if err := out.setRule(r.ParentKey, r.Key, r.Action); err != nil {
			return nil, err
		}
	}

	return out, nil
}

func normalizePolicyAction(action PolicyAction) (PolicyAction, bool) {
	a := strings.ToLower(strings.TrimSpace(string(action)))
	switch a {
	case "allow":
		return PolicyAllow, true
	case "fully", "redact", "fully_redact":
		return PolicyFullyRedact, true
	case "partial", "mask", "partial_mask":
		return PolicyPartialMask, true
	default:
		return "", false
	}
}

func (p *compiledPolicy) setRule(parentKey string, key string, action PolicyAction) error {
	keyCanonical := canonicalizeSanitizationKey(key)
	if keyCanonical == "" {
		return fmt.Errorf("%w: missing key", errInvalidSanitizationPolicy)
	}

	normalized, ok := normalizePolicyAction(action)
	if !ok {
		return fmt.Errorf("%w: invalid action %q", errInvalidSanitizationPolicy, action)
	}

	parentCanonical := canonicalizeSanitizationKey(parentKey)
	if parentCanonical == "" {
		p.global[keyCanonical] = normalized
		return nil
	}

	m := p.byParent[parentCanonical]
	if m == nil {
		m = map[string]PolicyAction{}
		p.byParent[parentCanonical] = m
	}
	m[keyCanonical] = normalized
	return nil
}

func (p *compiledPolicy) lookup(parentCanonical string, keyCanonical string) (PolicyAction, bool) {
	if parentCanonical != "" {
		if m, ok := p.byParent[parentCanonical]; ok {
			if action, ok := m[keyCanonical]; ok {
				return action, true
			}
		}
	}
	action, ok := p.global[keyCanonical]
	return action, ok
}

type policySanitizer struct {
	policy *compiledPolicy
}

func (s *policySanitizer) SanitizeFieldValue(key string, value any) any {
	return s.sanitizeFieldValueWithParent("", key, value)
}

func (s *policySanitizer) sanitizeFieldValueWithParent(parentKey string, key string, value any) any {
	keyLower := strings.ToLower(strings.TrimSpace(key))
	keyCanonical := canonicalizeSanitizationKey(keyLower)
	if keyLower == "" || keyCanonical == "" {
		return s.sanitizeValueWithParent(parentKey, value)
	}

	parentCanonical := canonicalizeSanitizationKey(parentKey)
	if action, ok := s.policy.lookup(parentCanonical, keyCanonical); ok {
		return s.applyAction(action, parentKey, keyLower, keyCanonical, value)
	}

	if isAllowedField(keyLower, keyCanonical) {
		return s.sanitizeValueWithParent(keyLower, value)
	}

	if typ, ok := sensitiveFieldType(keyLower, keyCanonical); ok {
		return sanitizeSensitiveFieldValue(parentKey, keyLower, keyCanonical, value, typ)
	}

	return s.sanitizeValueWithParent(keyLower, value)
}

func (s *policySanitizer) applyAction(action PolicyAction, parentKey, keyLower, keyCanonical string, value any) any {
	switch action {
	case PolicyAllow:
		return s.sanitizeValueWithParent(keyLower, value)
	case PolicyFullyRedact:
		return redactedValue
	case PolicyPartialMask:
		return sanitizePartialMaskedValue(parentKey, keyLower, keyCanonical, value)
	default:
		return redactedValue
	}
}

func (s *policySanitizer) sanitizeValueWithParent(parentKey string, value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return SanitizeLogString(typed)
	case RawJSON:
		return SanitizeJSONValue([]byte(typed))
	case []byte:
		return SanitizeLogString(string(typed))
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = s.sanitizeFieldValueWithParent(parentKey, k, v)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i := range typed {
			out[i] = s.sanitizeValueWithParent(parentKey, typed[i])
		}
		return out
	default:
		return SanitizeLogString(fmt.Sprintf("%v", typed))
	}
}
