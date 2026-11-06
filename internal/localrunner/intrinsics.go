package localrunner

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// CloudFormation intrinsic resolution at template time.
//
// A property can depend only on template state (a parameter Default, a
// condition evaluated from defaults, or a mapping) or on a deployed resource.
// The runner resolves the first kind locally and fails closed on the second.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/conditions-section-structure.html

// templateContext is one stack's template-time intrinsic environment.
type templateContext struct {
	Parameters map[string]templateParameter
	Conditions map[string]json.RawMessage
	Mappings   map[string]map[string]map[string]any
}

// unresolvedTemplateError names a value that cannot be known before a stack is
// deployed. The caller keeps the property unresolved and fails closed when the
// function is served.
type unresolvedTemplateError struct {
	Name   string
	Reason string
}

func (e *unresolvedTemplateError) Error() string {
	if e.Reason != "" {
		return e.Name + ": " + e.Reason
	}
	return e.Name + " cannot be resolved before the stack is deployed"
}

const parametersDefaultRule = "CloudFormation uses the default values unless users specify another value, and " +
	"\"If you omit the default attribute, users are required to specify a value for that parameter\" " +
	"(https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html)"

const (
	fnAnd = "Fn::And"
	fnOr  = "Fn::Or"
)

// resolveTemplateInt resolves an integer property. It returns the fallback and
// resolved=true when the property is absent, the resolved value when the
// expression is template-time, and resolved=false with the intrinsic name when
// the value depends on a deployed resource.
func resolveTemplateInt(raw json.RawMessage, ctx templateContext, fallback int) (int, bool, string, error) {
	if len(raw) == 0 || string(raw) == jsonNull {
		return fallback, true, "", nil
	}
	var number int
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true, "", nil
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		parsed, parseErr := strconv.Atoi(strings.TrimSpace(text))
		if parseErr != nil {
			return 0, false, intExpression(raw), fmt.Errorf("literal %q is not an integer", text)
		}
		return parsed, true, "", nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false, intExpression(raw), fmt.Errorf("property is not valid JSON: %w", err)
	}
	resolved, err := ctx.resolve(value)
	if err != nil {
		var unresolved *unresolvedTemplateError
		if asUnresolved(err, &unresolved) {
			return fallback, false, intExpression(raw), nil
		}
		return 0, false, intExpression(raw), err
	}
	if resolved == nil {
		// An Fn::If that selects AWS::NoValue removes the property:
		// "Removes the corresponding resource property when specified as a
		// return value in the Fn::If intrinsic function"
		// (https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/pseudo-parameter-reference.html).
		// The property takes the same default the runner applies to an omitted
		// property.
		return fallback, true, "", nil
	}
	converted, err := templateInt(resolved)
	if err != nil {
		return 0, false, intExpression(raw), err
	}
	return converted, true, "", nil
}

func asUnresolved(err error, target **unresolvedTemplateError) bool {
	for err != nil {
		if unresolved, ok := err.(*unresolvedTemplateError); ok {
			*target = unresolved
			return true
		}
		type unwrapper interface{ Unwrap() error }
		next, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = next.Unwrap()
	}
	return false
}

//nolint:gocyclo // one branch per intrinsic form.
func (c templateContext) resolve(value any) (any, error) {
	switch typed := value.(type) {
	case nil, string, bool, float64:
		return typed, nil
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			resolved, err := c.resolve(item)
			if err != nil {
				return nil, err
			}
			out = append(out, resolved)
		}
		return out, nil
	case map[string]any:
		switch {
		case typed["Ref"] != nil:
			id, ok := typed["Ref"].(string)
			if !ok || id == "" {
				return nil, fmt.Errorf("ref must name a parameter or resource")
			}
			return c.refValue(id)
		case typed["Fn::GetAtt"] != nil:
			id, attr, err := parseGetAtt(typed["Fn::GetAtt"])
			if err != nil {
				return nil, &unresolvedTemplateError{Name: "Fn::GetAtt", Reason: err.Error()}
			}
			return nil, &unresolvedTemplateError{
				Name: "Fn::GetAtt " + id + "." + attr,
				Reason: "the attribute belongs to a deployed resource and has no local value; " +
					"a runtime reference resolves after provisioning instead",
			}
		case typed["Fn::If"] != nil:
			return c.ifValue(typed["Fn::If"])
		case typed["Fn::FindInMap"] != nil:
			return c.findInMap(typed["Fn::FindInMap"])
		case typed["Fn::Join"] != nil:
			return c.joinValue(typed["Fn::Join"])
		case typed["Condition"] != nil:
			name, ok := typed["Condition"].(string)
			if !ok || name == "" {
				return nil, fmt.Errorf("condition must name a condition")
			}
			value, err := c.condition(name)
			if err != nil {
				return nil, err
			}
			return value, nil
		default:
			return nil, &unresolvedTemplateError{Name: intrinsicName(typed)}
		}
	default:
		return nil, fmt.Errorf("unsupported template value type %T", value)
	}
}

// refValue resolves a parameter Default or a pseudo parameter. A reference to
// a resource is a provisioning-time value and stays unresolved here.
func (c templateContext) refValue(id string) (any, error) {
	switch id {
	case "AWS::Partition":
		return LocalPartition, nil
	case "AWS::Region":
		return LocalRegion, nil
	case "AWS::AccountId":
		return LocalAccountID, nil
	case "AWS::NoValue":
		return nil, nil
	}
	parameter, ok := c.Parameters[id]
	if !ok {
		// A resource Ref (a table name, a queue URL, ...) is resolved after
		// provisioning by the environment resolver; at template time it has no
		// value.
		return nil, &unresolvedTemplateError{Name: "Ref " + id}
	}
	if len(parameter.Default) == 0 || string(parameter.Default) == jsonNull {
		return nil, &unresolvedTemplateError{
			Name:   "Ref " + id,
			Reason: "parameter " + id + " has no Default; " + parametersDefaultRule,
		}
	}
	var value any
	if err := json.Unmarshal(parameter.Default, &value); err != nil {
		return nil, fmt.Errorf("parameter %s Default is not valid JSON: %w", id, err)
	}
	return c.resolve(value)
}

func (c templateContext) ifValue(raw any) (any, error) {
	parts, ok := raw.([]any)
	if !ok || len(parts) != 3 {
		return nil, fmt.Errorf("Fn::If must be [condition, true value, false value]")
	}
	name, ok := parts[0].(string)
	if !ok || name == "" {
		return nil, fmt.Errorf("Fn::If condition must be a condition name")
	}
	condition, err := c.condition(name)
	if err != nil {
		return nil, err
	}
	if condition {
		return c.resolve(parts[1])
	}
	return c.resolve(parts[2])
}

func (c templateContext) findInMap(raw any) (any, error) {
	parts, ok := raw.([]any)
	if !ok || len(parts) != 3 {
		return nil, fmt.Errorf("Fn::FindInMap must be [map, top-level key, second-level key]")
	}
	keys := make([]string, 0, 3)
	for index, part := range parts {
		resolved, err := c.resolve(part)
		if err != nil {
			return nil, err
		}
		key, keyOK := templateString(resolved)
		if !keyOK {
			return nil, fmt.Errorf("Fn::FindInMap argument %d is not a string", index)
		}
		keys = append(keys, key)
	}
	top, ok := c.Mappings[keys[0]]
	if !ok {
		return nil, &unresolvedTemplateError{Name: "Fn::FindInMap " + keys[0], Reason: "the mapping is not declared in the template"}
	}
	second, secondOK := top[keys[1]]
	if !secondOK {
		return nil, &unresolvedTemplateError{Name: "Fn::FindInMap " + keys[0] + "/" + keys[1], Reason: "the top-level key is not declared"}
	}
	value, mapOK := second[keys[2]]
	if !mapOK {
		return nil, &unresolvedTemplateError{
			Name:   "Fn::FindInMap " + keys[0] + "/" + keys[1] + "/" + keys[2],
			Reason: "the second-level key is not declared",
		}
	}
	return c.resolve(value)
}

func (c templateContext) joinValue(raw any) (any, error) {
	parts, ok := raw.([]any)
	if !ok || len(parts) != 2 {
		return nil, fmt.Errorf("Fn::Join must be [delimiter, parts]")
	}
	delimiter, ok := parts[0].(string)
	if !ok {
		return nil, fmt.Errorf("Fn::Join delimiter must be a string")
	}
	items, ok := parts[1].([]any)
	if !ok {
		return nil, fmt.Errorf("Fn::Join parts must be an array")
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		resolved, err := c.resolve(item)
		if err != nil {
			return nil, err
		}
		text, ok := templateString(resolved)
		if !ok {
			return nil, fmt.Errorf("Fn::Join part is not a string")
		}
		values = append(values, text)
	}
	return strings.Join(values, delimiter), nil
}

// condition evaluates a declared condition from parameter defaults.
func (c templateContext) condition(name string) (bool, error) {
	raw, ok := c.Conditions[name]
	if !ok {
		return false, &unresolvedTemplateError{Name: "Condition " + name, Reason: "the condition is not declared in the template"}
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, fmt.Errorf("condition %s is not valid JSON: %w", name, err)
	}
	return c.conditionValue(value)
}

//nolint:gocognit,gocyclo // one branch per condition intrinsic.
func (c templateContext) conditionValue(value any) (bool, error) {
	typed, ok := value.(map[string]any)
	if !ok {
		if boolean, ok := value.(bool); ok {
			return boolean, nil
		}
		return false, fmt.Errorf("condition expression is not an object")
	}
	switch {
	case typed["Condition"] != nil:
		name, ok := typed["Condition"].(string)
		if !ok || name == "" {
			return false, fmt.Errorf("condition must name a condition")
		}
		return c.condition(name)
	case typed["Fn::Equals"] != nil:
		parts, ok := typed["Fn::Equals"].([]any)
		if !ok || len(parts) != 2 {
			return false, fmt.Errorf("Fn::Equals must have two arguments")
		}
		left, leftErr := c.resolve(parts[0])
		right, rightErr := c.resolve(parts[1])
		if leftErr != nil {
			return false, leftErr
		}
		if rightErr != nil {
			return false, rightErr
		}
		return templateEquals(left, right), nil
	case typed[fnAnd] != nil || typed[fnOr] != nil:
		operator := fnAnd
		raw := typed[fnAnd]
		if raw == nil {
			operator = fnOr
			raw = typed[fnOr]
		}
		parts, ok := raw.([]any)
		if !ok || len(parts) == 0 {
			return false, fmt.Errorf("%s must have at least one condition", operator)
		}
		result := operator == fnAnd
		for _, part := range parts {
			boolean, err := c.conditionValue(part)
			if err != nil {
				return false, err
			}
			if operator == fnAnd {
				result = result && boolean
			} else {
				result = result || boolean
			}
		}
		return result, nil
	case typed["Fn::Not"] != nil:
		parts, ok := typed["Fn::Not"].([]any)
		if !ok || len(parts) != 1 {
			return false, fmt.Errorf("Fn::Not must have one argument")
		}
		boolean, err := c.conditionValue(parts[0])
		if err != nil {
			return false, err
		}
		return !boolean, nil
	case typed["Fn::Contains"] != nil:
		parts, ok := typed["Fn::Contains"].([]any)
		if !ok || len(parts) != 2 {
			return false, fmt.Errorf("Fn::Contains must have two arguments")
		}
		list, listErr := c.resolve(parts[0])
		if listErr != nil {
			return false, listErr
		}
		items, ok := list.([]any)
		if !ok {
			return false, fmt.Errorf("Fn::Contains first argument is not a list")
		}
		wanted, wantedErr := c.resolve(parts[1])
		if wantedErr != nil {
			return false, wantedErr
		}
		for _, item := range items {
			if templateEquals(item, wanted) {
				return true, nil
			}
		}
		return false, nil
	default:
		return false, &unresolvedTemplateError{Name: intrinsicName(typed)}
	}
}

func templateEquals(left, right any) bool {
	leftText, leftOK := templateString(left)
	rightText, rightOK := templateString(right)
	if leftOK && rightOK {
		return leftText == rightText
	}
	return fmt.Sprintf("%v", left) == fmt.Sprintf("%v", right)
}

func templateString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(typed), true
	case nil:
		return "", true
	default:
		return "", false
	}
}

func templateInt(value any) (int, error) {
	switch typed := value.(type) {
	case float64:
		if math.Trunc(typed) != typed {
			return 0, fmt.Errorf("value %v is not an integer", typed)
		}
		return int(typed), nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err != nil {
			return 0, fmt.Errorf("value %q is not an integer", typed)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("value of type %T is not an integer", value)
	}
}

func intrinsicName(value map[string]any) string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return "an empty expression"
	}
	return keys[0]
}

// validateFunctionLimit applies the AWS::Lambda::Function page's ranges.
// MemorySize: minimum 128, maximum 32768. Timeout: minimum 1, maximum 900.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html
func validateFunctionLimit(functionID, property string, value, minimum, maximum int) error {
	if value >= minimum && value <= maximum {
		return nil
	}
	rule := "the value can be any multiple of 1 MB and the allowed range is 128..32768"
	if property == "Timeout" {
		rule = "\"The default is 3 seconds, and the maximum allowed value is 900 seconds\" and the minimum is 1"
	}
	return fmt.Errorf(
		"function %s: %s %d is outside the AWS::Lambda::Function range %d..%d (%s); "+
			"https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html",
		functionID, property, value, minimum, maximum, rule,
	)
}
