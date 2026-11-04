package localrunner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Amazon SNS subscription filter policies are evaluated per subscription when
// a message is published. A policy is a JSON object whose keys are property
// names; every key must match (AND across keys) and at least one value in a
// key's rule list must match (OR within a key):
// https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html
//
// Two scopes are supported:
//
//   - MessageAttributes (the default) matches the published message
//     attributes. Only top-level attributes participate, and the attribute's
//     data type decides the comparison: String uses string rules, Number uses
//     numeric rules, and String.Array matches when any element matches.
//   - MessageBody matches the message body, which must be a well-formed JSON
//     object. A body that is not JSON matches no body-scope policy.
//     https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html
//
// The operator grammar (exact, prefix, suffix, anything-but, numeric, exists
// and equals-ignore-case) coincides with the EventBridge pattern grammar E1b
// implements, so the validators and the single-value operator primitives are
// reused from sqs_filter.go. Two SNS differences are handled here:
//
//   - `$or` is not SNS filter-policy syntax. A policy that uses it is refused
//     at plan time instead of being accepted and silently matching nothing.
//   - `exists` matches key presence, not only a leaf value, and an
//     anything-but rule against a String.Array matches only when no element is
//     excluded.
//
// The `cidr` operator is also refused by name: this evaluator does not
// implement it, and a policy it cannot apply exactly must not start.

const (
	// snsFilterScopeAttributes is the default FilterPolicyScope.
	snsFilterScopeAttributes = "MessageAttributes"
	// snsFilterScopeBody matches the JSON message body.
	snsFilterScopeBody = "MessageBody"
)

// normalizeSNSFilterPolicy validates a subscription filter policy against the
// SNS operator grammar and returns it in compact form, or nil when the
// subscription has no policy. Validation happens at plan time so a policy the
// local evaluator cannot apply exactly fails closed instead of silently
// filtering every message.
func normalizeSNSFilterPolicy(raw json.RawMessage, scope, logicalID string) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 || strings.TrimSpace(string(raw)) == jsonNull {
		return nil, nil
	}
	value, err := decodePatternValue(raw)
	if err != nil {
		return nil, unsupported(logicalID, "SNS FilterPolicy is not valid JSON: %v", err)
	}
	pattern, ok := value.(map[string]any)
	if !ok {
		return nil, unsupported(logicalID, "SNS FilterPolicy must be a JSON object")
	}
	if err := validateSNSFilterObject(pattern, scope, ""); err != nil {
		return nil, unsupported(logicalID, "SNS FilterPolicy is not valid for scope %s: %v", scope, err)
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// Keep operators such as ">=" readable in plan output and docs; the
	// escaped form is equivalent JSON but obscures the rule.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(pattern); err != nil {
		return nil, fmt.Errorf("%s: encode SNS FilterPolicy: %w", logicalID, err)
	}
	return bytes.TrimSpace(buffer.Bytes()), nil
}

func validateSNSFilterObject(pattern map[string]any, scope, path string) error {
	for _, key := range sortedKeys(pattern) {
		value := pattern[key]
		child := joinFilterPath(path, key)
		if strings.HasPrefix(key, "$") {
			return fmt.Errorf("key %q: SNS filter policies have no %q operator; AND across keys and OR within a key are the only combinators", child, key)
		}
		switch typed := value.(type) {
		case []any:
			if err := rejectSNSUnsupportedOperator(typed, child); err != nil {
				return err
			}
			if err := validateFilterRuleList(typed, child); err != nil {
				return err
			}
		case map[string]any:
			if scope != snsFilterScopeBody {
				return fmt.Errorf(
					"key %q: a MessageAttributes policy key must hold a rule list, not a nested object",
					child,
				)
			}
			if err := validateSNSFilterObject(typed, scope, child); err != nil {
				return err
			}
		default:
			return fmt.Errorf("key %q: a property must hold a list of rules", child)
		}
	}
	return nil
}

// rejectSNSUnsupportedOperator names an operator this evaluator does not
// implement. E1b's validator already refuses unknown operators; the distinct
// message here tells a reader that `cidr` is an SNS operator the local runner
// has not implemented rather than a typo.
func rejectSNSUnsupportedOperator(rules []any, path string) error {
	for index, rule := range rules {
		object, ok := rule.(map[string]any)
		if !ok {
			continue
		}
		if _, isCIDR := object["cidr"]; isCIDR {
			return fmt.Errorf(
				"key %s[%d]: the SNS cidr operator is not implemented locally; remove it or use prefix/anything-but",
				path,
				index,
			)
		}
	}
	return nil
}

// snsMessageMatchesFilter applies one normalized policy to one published
// message. A nil policy matches every message. An error means the policy could
// not be applied (an invariant violation, because derive-time validation
// accepted it); the caller reports the failure instead of dropping the message
// as a non-match.
func snsMessageMatchesFilter(policy json.RawMessage, scope string, message snsMessage) (bool, error) {
	if len(bytes.TrimSpace(policy)) == 0 {
		return true, nil
	}
	value, err := decodePatternValue(policy)
	if err != nil {
		return false, fmt.Errorf("decode SNS FilterPolicy: %w", err)
	}
	pattern, ok := value.(map[string]any)
	if !ok {
		return false, fmt.Errorf("the SNS FilterPolicy is not a JSON object")
	}
	switch scope {
	case "", snsFilterScopeAttributes:
		target := make(map[string]any, len(message.Attributes))
		for name, attribute := range message.Attributes {
			target[name] = snsAttributeMatchValue(attribute)
		}
		return snsMatchObject(pattern, target), nil
	case snsFilterScopeBody:
		target, ok := snsBodyTarget(message.Message)
		if !ok {
			// SNS documents body-scope policies against a well-formed JSON
			// object; any other body matches nothing.
			return false, nil
		}
		return snsMatchObject(pattern, target), nil
	default:
		return false, fmt.Errorf("unknown SNS FilterPolicyScope %q", scope)
	}
}

// snsBodyTarget parses a message body for a body-scope policy. Only a JSON
// object is a valid target; a scalar, an array or non-JSON text matches
// nothing.
func snsBodyTarget(message string) (any, bool) {
	value, err := decodePatternValue([]byte(message))
	if err != nil {
		return nil, false
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, false
	}
	return value, true
}

// snsAttributeMatchValue converts one message attribute to the value SNS
// compares. A String.Array attribute is compared element by element; a Binary
// attribute is opaque and matches only an exists rule.
func snsAttributeMatchValue(attribute snsMessageAttribute) any {
	switch attribute.DataType {
	case snsDataTypeString:
		return attribute.StringValue
	case snsDataTypeNumber:
		return json.Number(attribute.StringValue)
	case snsDataTypeStringArray:
		decoded, err := decodePatternValue([]byte(attribute.StringValue))
		if err != nil {
			return []any{}
		}
		if elements, ok := decoded.([]any); ok {
			return elements
		}
		return []any{}
	default:
		return snsOpaqueAttribute{dataType: attribute.DataType}
	}
}

// snsOpaqueAttribute is a value no equality or range rule can match; it still
// counts as present for an exists rule.
type snsOpaqueAttribute struct {
	dataType string
}

// snsMatchObject applies a policy object to a document. Unlike EventBridge,
// SNS has no `$or` keyword: every key is a property name. When the document
// value is an array, the object is applied to each element and matches when
// one element matches, which is how SNS reads a policy against an array.
func snsMatchObject(pattern map[string]any, value any) bool {
	if elements, ok := value.([]any); ok {
		for _, element := range elements {
			if snsMatchObject(pattern, element) {
				return true
			}
		}
		return false
	}
	target, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for key, expected := range pattern {
		actual, present := target[key]
		if !snsMatchValue(expected, actual, present) {
			return false
		}
	}
	return true
}

// snsMatchValue applies one policy property value: a rule list (OR), a nested
// policy object for body scope, or a scalar exact match.
func snsMatchValue(pattern, value any, present bool) bool {
	switch typed := pattern.(type) {
	case []any:
		return snsAnyRuleMatches(typed, value, present)
	case map[string]any:
		return present && snsMatchObject(typed, value)
	default:
		return snsScalarMatches(typed, value, present)
	}
}

func snsScalarMatches(pattern, value any, present bool) bool {
	if !present {
		return false
	}
	if elements, ok := value.([]any); ok {
		for _, element := range elements {
			if scalarPatternEqual(pattern, element) {
				return true
			}
		}
		return false
	}
	return scalarPatternEqual(pattern, value)
}

func snsAnyRuleMatches(rules []any, value any, present bool) bool {
	for _, rule := range rules {
		if snsMatchRule(rule, value, present) {
			return true
		}
	}
	return false
}

// snsMatchRule applies one rule: a scalar exact match or a single-key operator
// object. The operator primitives are the same ones E1b uses for EventBridge
// patterns; the array and exists differences are handled before delegating.
func snsMatchRule(rule any, value any, present bool) bool {
	switch typed := rule.(type) {
	case map[string]any:
		operator, ok := filterOperator(typed)
		if !ok {
			return false
		}
		return snsMatchOperator(operator, typed, value, present)
	case []any:
		return snsAnyRuleMatches(typed, value, present)
	default:
		return snsScalarMatches(typed, value, present)
	}
}

func snsMatchOperator(operator string, pattern map[string]any, value any, present bool) bool {
	switch operator {
	case filterOperatorExists:
		want, ok := pattern[filterOperatorExists].(bool)
		if !ok {
			return false
		}
		// SNS's exists rule matches key presence; unlike EventBridge it is not
		// restricted to leaf nodes.
		return want == present
	case filterOperatorAnythingBut:
		if !present {
			return false
		}
		if elements, ok := value.([]any); ok {
			for _, element := range elements {
				if matchAnythingBut(pattern[filterOperatorAnythingBut], element, true) {
					return false
				}
			}
			return true
		}
		return !matchAnythingBut(pattern[filterOperatorAnythingBut], value, present)
	default:
		if elements, ok := value.([]any); ok {
			for _, element := range elements {
				if matchFilterOperator(operator, pattern, element, true) {
					return true
				}
			}
			return false
		}
		return matchFilterOperator(operator, pattern, value, present)
	}
}

const (
	snsDataTypeString      = "String"
	snsDataTypeNumber      = "Number"
	snsDataTypeStringArray = "String.Array"
	snsDataTypeBinary      = "Binary"
)
