package localrunner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Lambda event filtering for an SQS event source evaluates Amazon EventBridge
// event-pattern syntax against the SQS record. Metadata fields (messageId,
// attributes, messageAttributes, eventSourceARN, awsRegion, ...) are matched
// directly and the record's data field is `body`, whose JSON fields are matched
// as nested data. Multiple filters are ORed; a message that matches none is
// deleted from the queue without invoking the function.
//
// A pattern-object key is always a field name, so a field named `numeric`,
// `prefix`, `exists` or any other operator name is matched as ordinary data. An
// operator is read only from an object inside a rule list.
//
// A mapping's FilterCriteria is validated against the operator grammar when the
// mapping is derived, as Lambda validates it when CreateEventSourceMapping is
// called. A pattern this evaluator cannot apply exactly is refused at plan time
// instead of being accepted and silently matching nothing.
//
// See
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html,
// the EventBridge pattern reference
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html,
// and
// https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-filtering.html.

type eventFilterCriteria struct {
	Filters []eventFilter `json:"Filters"`
}

type eventFilter struct {
	Pattern string `json:"Pattern"`
}

const (
	eventFilterMaximumFilters = 5
	// Filter.Pattern in AWS::Lambda::EventSourceMapping has a documented
	// maximum of 4096 characters:
	// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-eventsourcemapping-filter.html
	eventFilterPatternMaximumLength = 4096
	// eventPatternOrKey is EventBridge's multiple-fields-or keyword.
	eventPatternOrKey = "$or"
)

// normalizeEventFilterCriteria validates a mapping's FilterCriteria and returns
// it in compact form, or nil when the mapping has no filters. AWS allows up to
// five filters per mapping and requires each Pattern to be a JSON object in
// EventBridge pattern syntax; the operator grammar is validated here so a
// malformed pattern cannot start a mapping that silently matches nothing.
func normalizeEventFilterCriteria(raw json.RawMessage, logicalID string) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	var criteria eventFilterCriteria
	if err := json.Unmarshal(raw, &criteria); err != nil {
		return nil, unsupported(logicalID, "FilterCriteria is not a valid FilterCriteria object: %v", err)
	}
	if len(criteria.Filters) == 0 {
		return nil, nil
	}
	if len(criteria.Filters) > eventFilterMaximumFilters {
		return nil, unsupported(logicalID, "FilterCriteria declares %d filters; AWS allows up to five per event source mapping", len(criteria.Filters))
	}
	for index, filter := range criteria.Filters {
		position := index + 1
		pattern := strings.TrimSpace(filter.Pattern)
		if pattern == "" {
			return nil, unsupported(logicalID, "FilterCriteria filter %d has an empty Pattern", position)
		}
		if length := utf8.RuneCountInString(pattern); length > eventFilterPatternMaximumLength {
			return nil, unsupported(
				logicalID,
				"FilterCriteria filter %d Pattern is %d characters; AWS allows at most %d (https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-eventsourcemapping-filter.html)",
				position,
				length,
				eventFilterPatternMaximumLength,
			)
		}
		value, err := decodePatternValue([]byte(pattern))
		if err != nil {
			return nil, unsupported(logicalID, "FilterCriteria filter %d Pattern is not valid JSON: %v", position, err)
		}
		object, ok := value.(map[string]any)
		if !ok {
			return nil, unsupported(logicalID, "FilterCriteria filter %d Pattern must be a JSON object", position)
		}
		if err := validateEventFilterPattern(object); err != nil {
			return nil, unsupported(
				logicalID,
				"FilterCriteria filter %d Pattern is not a valid Lambda event filter pattern: %v",
				position,
				err,
			)
		}
	}
	encoded, err := json.Marshal(criteria)
	if err != nil {
		return nil, fmt.Errorf("%s: encode FilterCriteria: %w", logicalID, err)
	}
	return encoded, nil
}

// validateEventFilterPattern checks one EventBridge pattern against the
// comparison-operator grammar Lambda documents. It is deliberately strict: a
// construct this evaluator does not implement exactly is refused here, so a
// derived mapping can never silently match nothing.
//
// A field value must be an array of rules or a nested pattern object; an
// operator is a single-key object inside a rule array. Values in rule arrays
// are scalars or operator objects. The operator set, the `numeric` comparison
// forms, `$or`, and the leaf-only `exists` rule are documented at
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html
// and
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html.
// The 4096-character pattern maximum is documented for Filter.Pattern at
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-eventsourcemapping-filter.html.
func validateEventFilterPattern(pattern map[string]any) error {
	return validateFilterPatternObject(pattern, "")
}

func validateFilterPatternObject(pattern map[string]any, path string) error {
	for _, key := range sortedKeys(pattern) {
		value := pattern[key]
		child := joinFilterPath(path, key)
		if key == eventPatternOrKey {
			if err := validateFilterPatternOr(value, child); err != nil {
				return err
			}
			continue
		}
		switch typed := value.(type) {
		case []any:
			if err := validateFilterRuleList(typed, child); err != nil {
				return err
			}
		case map[string]any:
			if err := validateFilterPatternObject(typed, child); err != nil {
				return err
			}
		default:
			return eventPatternValidationError(
				child,
				value,
				"a field must hold a list of rules or a nested pattern object, not a scalar",
			)
		}
	}
	return nil
}

func validateFilterPatternOr(value any, path string) error {
	alternatives, ok := value.([]any)
	if !ok {
		return eventPatternValidationError(path, value, "$or value must be a list of objects")
	}
	if len(alternatives) == 0 {
		return eventPatternValidationError(path, value, "$or value must not be an empty list")
	}
	for index, alternative := range alternatives {
		alternativePath := fmt.Sprintf("%s[%d]", path, index)
		object, ok := alternative.(map[string]any)
		if !ok {
			return eventPatternValidationError(alternativePath, alternative, "$or values must be objects")
		}
		if err := validateFilterPatternObject(object, alternativePath); err != nil {
			return err
		}
	}
	return nil
}

func validateFilterRuleList(rules []any, path string) error {
	if len(rules) == 0 {
		return eventPatternValidationError(path, rules, "a rule list must not be empty")
	}
	for index, rule := range rules {
		rulePath := fmt.Sprintf("%s[%d]", path, index)
		switch typed := rule.(type) {
		case map[string]any:
			if err := validateFilterOperator(typed, rulePath); err != nil {
				return err
			}
		case []any:
			return eventPatternValidationError(rulePath, typed, "a rule must be a scalar or an operator object, not a list")
		case nil, string, json.Number, bool:
			// A scalar rule matches one literal value.
		default:
			return eventPatternValidationError(rulePath, typed, "a rule must be a scalar or an operator object")
		}
	}
	return nil
}

func validateFilterOperator(rule map[string]any, path string) error {
	if len(rule) != 1 {
		return eventPatternValidationError(path, rule, "an operator object must have exactly one key")
	}
	var operator string
	var value any
	for key, raw := range rule {
		operator, value = key, raw
	}
	operatorPath := joinFilterPath(path, operator)
	switch operator {
	case filterOperatorPrefix, filterOperatorSuffix, filterOperatorEqualsIgnoreCase:
		if _, ok := value.(string); !ok {
			return eventPatternValidationError(operatorPath, value, "%q value must be a string", operator)
		}
	case filterOperatorExists:
		if _, ok := value.(bool); !ok {
			return eventPatternValidationError(operatorPath, value, "exists value must be true or false")
		}
	case filterOperatorNumeric:
		return validateFilterNumeric(value, operatorPath)
	case filterOperatorAnythingBut:
		return validateFilterAnythingBut(value, operatorPath)
	default:
		return eventPatternValidationError(
			operatorPath,
			value,
			"unknown operator %q; the local evaluator supports prefix, suffix, equals-ignore-case, anything-but, numeric and exists",
			operator,
		)
	}
	return nil
}

func validateFilterNumeric(value any, path string) error {
	parts, ok := value.([]any)
	if !ok {
		return eventPatternValidationError(path, value, "numeric value must be a list of comparison operators and numbers")
	}
	if len(parts) == 0 {
		return eventPatternValidationError(path, value, "numeric value must not be an empty list")
	}
	// Lambda documents one comparison, or a two-sided range with a lower bound
	// (">" or ">=") followed by an upper bound ("<" or "<=").
	operator, ok := parts[0].(string)
	if !ok || !isNumericOperator(operator) {
		return eventPatternValidationError(fmt.Sprintf("%s[0]", path), parts[0], "numeric comparison must be one of <, <=, =, >=, >")
	}
	if err := validateNumericArity(operator, parts, path); err != nil {
		return err
	}
	for index := 1; index < len(parts); index += 2 {
		if err := validateNumericBound(parts[index], fmt.Sprintf("%s[%d]", path, index)); err != nil {
			return err
		}
	}
	if len(parts) == 4 {
		upper, ok := parts[2].(string)
		if !ok || (upper != "<" && upper != "<=") {
			return eventPatternValidationError(
				fmt.Sprintf("%s[2]", path),
				parts[2],
				"a two-sided numeric range must end with < or <=",
			)
		}
	}
	return nil
}

func validateNumericArity(operator string, parts []any, path string) error {
	if operator == ">" || operator == ">=" {
		if len(parts) != 2 && len(parts) != 4 {
			return eventPatternValidationError(
				path,
				parts,
				"numeric comparison %q takes one operator and one number, or a lower bound followed by an upper bound",
				operator,
			)
		}
		return nil
	}
	if len(parts) != 2 {
		return eventPatternValidationError(
			path,
			parts,
			"numeric comparison %q takes one operator and one number",
			operator,
		)
	}
	return nil
}

func validateNumericBound(value any, path string) error {
	number, ok := value.(json.Number)
	if !ok {
		return eventPatternValidationError(path, value, "numeric comparison needs a number")
	}
	if _, err := number.Float64(); err != nil {
		return eventPatternValidationError(path, value, "numeric comparison value is not representable as a 64-bit float")
	}
	return nil
}

func validateFilterAnythingBut(value any, path string) error {
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) != 1 {
			return eventPatternValidationError(path, typed, "anything-but object must have exactly one of prefix or suffix")
		}
		for key, raw := range typed {
			child := joinFilterPath(path, key)
			switch key {
			case filterOperatorPrefix, filterOperatorSuffix:
				if err := validateFilterStringOrStringList(raw, child); err != nil {
					return err
				}
			case filterOperatorEqualsIgnoreCase:
				return eventPatternValidationError(
					child,
					raw,
					"anything-but with equals-ignore-case is not implemented locally; use a list of scalar values instead",
				)
			default:
				return eventPatternValidationError(
					child,
					raw,
					"unknown anything-but operator %q; the local evaluator supports prefix and suffix",
					key,
				)
			}
		}
	case []any:
		if len(typed) == 0 {
			return eventPatternValidationError(path, typed, "anything-but list must not be empty")
		}
		hasString, hasNumber := false, false
		for index, item := range typed {
			switch item.(type) {
			case string:
				hasString = true
			case json.Number:
				hasNumber = true
			default:
				return eventPatternValidationError(
					fmt.Sprintf("%s[%d]", path, index),
					item,
					"anything-but list values must be strings or numbers",
				)
			}
		}
		if hasString && hasNumber {
			return eventPatternValidationError(path, typed, "anything-but list values must be all strings or all numbers")
		}
	case string, json.Number:
		// The documented scalar form.
	default:
		return eventPatternValidationError(
			path,
			value,
			"anything-but value must be a string, a number, a non-empty list of strings or numbers, a prefix object or a suffix object",
		)
	}
	return nil
}

func validateFilterStringOrStringList(value any, path string) error {
	switch typed := value.(type) {
	case string:
		return nil
	case []any:
		if len(typed) == 0 {
			return eventPatternValidationError(path, typed, "a prefix/suffix list must not be empty")
		}
		for index, item := range typed {
			if _, ok := item.(string); !ok {
				return eventPatternValidationError(
					fmt.Sprintf("%s[%d]", path, index),
					item,
					"prefix/suffix values must be strings",
				)
			}
		}
		return nil
	default:
		return eventPatternValidationError(path, value, "prefix/suffix value must be a string or a non-empty list of strings")
	}
}

func isNumericOperator(operator string) bool {
	switch operator {
	case "<", "<=", "=", ">=", ">":
		return true
	default:
		return false
	}
}

func joinFilterPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func eventPatternValidationError(path string, value any, format string, args ...any) error {
	reason := fmt.Sprintf(format, args...)
	if path == "" {
		return fmt.Errorf("%s (value %s)", reason, filterPatternValue(value))
	}
	return fmt.Errorf("key %q has value %s: %s", path, filterPatternValue(value), reason)
}

func filterPatternValue(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprintf("%v", value)
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

// sqsRecordMatchesFilters reports whether one SQS record satisfies at least one
// filter. An empty FilterCriteria matches every record. The criteria and every
// pattern are re-validated here so a pattern that somehow bypassed derive-time
// validation is reported instead of being treated as a non-match and deleted.
func sqsRecordMatchesFilters(criteria json.RawMessage, record map[string]any, body string) (bool, error) {
	if len(bytes.TrimSpace(criteria)) == 0 {
		return true, nil
	}
	var parsed eventFilterCriteria
	if err := json.Unmarshal(criteria, &parsed); err != nil {
		return false, fmt.Errorf("decode FilterCriteria: %w", err)
	}
	if len(parsed.Filters) == 0 {
		return true, nil
	}
	patterns := make([]map[string]any, 0, len(parsed.Filters))
	for index, filter := range parsed.Filters {
		pattern, err := decodePatternValue([]byte(filter.Pattern))
		if err != nil {
			return false, fmt.Errorf("filter %d Pattern is not valid JSON: %w", index+1, err)
		}
		object, ok := pattern.(map[string]any)
		if !ok {
			return false, fmt.Errorf("filter %d Pattern is not a JSON object", index+1)
		}
		if err := validateEventFilterPattern(object); err != nil {
			return false, fmt.Errorf("filter %d Pattern is not a valid Lambda event filter pattern: %w", index+1, err)
		}
		patterns = append(patterns, object)
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return false, fmt.Errorf("encode SQS record: %w", err)
	}
	decoded, err := decodePatternValue(encoded)
	if err != nil {
		return false, fmt.Errorf("decode SQS record: %w", err)
	}
	target, ok := decoded.(map[string]any)
	if !ok {
		return false, fmt.Errorf("the SQS record is not a JSON object")
	}
	if parsedBody, err := decodePatternValue([]byte(body)); err == nil {
		target["body"] = parsedBody
	} else {
		target["body"] = body
	}
	for _, pattern := range patterns {
		if eventPatternMatches(pattern, target) {
			return true, nil
		}
	}
	return false, nil
}

// decodePatternValue decodes JSON with json.Number so numbers keep their
// written representation: AWS compares numbers by string representation, so
// 300, 300.0 and 3.0e2 are not equal.
func decodePatternValue(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, fmt.Errorf("trailing content after the JSON value")
	}
	return value, nil
}

// eventPatternMatches applies one EventBridge pattern object to a record. "$or"
// is the only keyword at object level; every other key is a field name.
func eventPatternMatches(pattern, value any) bool {
	object, ok := pattern.(map[string]any)
	if !ok {
		return false
	}
	return matchPatternObject(object, value)
}

// matchPatternObject applies a pattern object to a value: every key is a field
// name and every nested map is a nested pattern object. An operator is never
// read here, because EventBridge reads one only from an object inside a rule
// list; see matchFilterRule.
//
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
func matchPatternObject(pattern map[string]any, value any) bool {
	target, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for key, expected := range pattern {
		if key == eventPatternOrKey {
			alternatives, ok := expected.([]any)
			if !ok {
				return false
			}
			matched := false
			for _, alternative := range alternatives {
				if eventPatternMatches(alternative, value) {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
			continue
		}
		actual, present := target[key]
		if !matchPatternValue(expected, actual, present) {
			return false
		}
	}
	return true
}

// matchPatternValue applies a pattern field value to one field. present reports
// whether the field exists in its parent object. A map reached through a key
// lookup is always a nested pattern object, never an operator.
func matchPatternValue(pattern, value any, present bool) bool {
	switch typed := pattern.(type) {
	case nil:
		return !present || value == nil
	case []any:
		return matchRuleList(typed, value, present)
	case map[string]any:
		return matchPatternObject(typed, value)
	default:
		return present && scalarPatternEqual(typed, value)
	}
}

// matchRuleList applies one field's rule list. The rules are ORed. When the
// event value is an array, EventBridge matches if the intersection of the
// pattern array and the event array is non-empty, which is the same as one
// event element matching one rule:
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-arrays.html
func matchRuleList(rules []any, value any, present bool) bool {
	if elements, ok := value.([]any); ok && present {
		for _, element := range elements {
			if anyRuleMatches(rules, element, true) {
				return true
			}
		}
		return false
	}
	return anyRuleMatches(rules, value, present)
}

func anyRuleMatches(rules []any, value any, present bool) bool {
	for _, rule := range rules {
		if matchFilterRule(rule, value, present) {
			return true
		}
	}
	return false
}

// matchFilterRule applies one rule: a scalar, or a single-key operator object.
// This is the only place an operator is recognized, because an operator object
// is only ever an element of a rule list. A single-key map that is not a
// documented operator cannot reach here through a validated pattern (the
// validator refuses it), so it does not match.
//
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns-content-based-filtering.html
func matchFilterRule(rule any, value any, present bool) bool {
	switch typed := rule.(type) {
	case map[string]any:
		operator, ok := filterOperator(typed)
		if !ok {
			return false
		}
		return matchFilterOperator(operator, typed, value, present)
	case []any:
		// The validator refuses a list inside a rule list; keep the documented
		// OR reading for a pattern that bypassed validation.
		return matchRuleList(typed, value, present)
	default:
		return matchPatternValue(typed, value, present)
	}
}

const (
	filterOperatorPrefix           = "prefix"
	filterOperatorSuffix           = "suffix"
	filterOperatorEqualsIgnoreCase = "equals-ignore-case"
	filterOperatorAnythingBut      = "anything-but"
	filterOperatorNumeric          = "numeric"
	filterOperatorExists           = "exists"
)

// filterOperator recognizes the single-key operator objects AWS documents. It
// is called only by matchFilterRule, for an object inside a rule list.
func filterOperator(pattern map[string]any) (string, bool) {
	if len(pattern) != 1 {
		return "", false
	}
	for key := range pattern {
		switch key {
		case filterOperatorPrefix, filterOperatorSuffix, filterOperatorEqualsIgnoreCase,
			filterOperatorAnythingBut, filterOperatorNumeric, filterOperatorExists:
			return key, true
		}
	}
	return "", false
}

func matchFilterOperator(operator string, pattern map[string]any, value any, present bool) bool {
	switch operator {
	case filterOperatorExists:
		want, ok := pattern[filterOperatorExists].(bool)
		if !ok {
			return false
		}
		if !present {
			return !want
		}
		// "Exists matching only works on leaf nodes. It does not work on
		// intermediate nodes" — an object with children is not a leaf, so
		// neither exists:true nor exists:false matches it.
		// https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
		if _, intermediate := value.(map[string]any); intermediate {
			return false
		}
		return want
	case filterOperatorPrefix, filterOperatorSuffix, filterOperatorEqualsIgnoreCase:
		text, ok := pattern[operator].(string)
		if !ok || !present {
			return false
		}
		actual, ok := value.(string)
		if !ok {
			return false
		}
		switch operator {
		case filterOperatorPrefix:
			return strings.HasPrefix(actual, text)
		case filterOperatorSuffix:
			return strings.HasSuffix(actual, text)
		default:
			return strings.EqualFold(actual, text)
		}
	case filterOperatorAnythingBut:
		return !matchAnythingBut(pattern[filterOperatorAnythingBut], value, present)
	case filterOperatorNumeric:
		return matchNumeric(pattern[filterOperatorNumeric], value, present)
	default:
		return false
	}
}

func matchAnythingBut(pattern, value any, present bool) bool {
	switch typed := pattern.(type) {
	case []any:
		for _, candidate := range typed {
			if matchPatternValue(candidate, value, present) {
				return true
			}
		}
		return false
	case map[string]any:
		if len(typed) != 1 {
			return false
		}
		for operator, raw := range typed {
			switch operator {
			case filterOperatorPrefix:
				return matchAnythingButString(raw, value, present, strings.HasPrefix)
			case filterOperatorSuffix:
				return matchAnythingButString(raw, value, present, strings.HasSuffix)
			}
		}
		return false
	default:
		return present && scalarPatternEqual(typed, value)
	}
}

// matchAnythingButString applies an anything-but prefix or suffix exclusion.
// The exclusion is a string or a list of strings; a field that is absent or not
// a string cannot carry the excluded value, so it does not match the exclusion.
func matchAnythingButString(pattern, value any, present bool, predicate func(string, string) bool) bool {
	if !present {
		return false
	}
	actual, ok := value.(string)
	if !ok {
		return false
	}
	switch typed := pattern.(type) {
	case string:
		return predicate(actual, typed)
	case []any:
		for _, candidate := range typed {
			if text, ok := candidate.(string); ok && predicate(actual, text) {
				return true
			}
		}
	}
	return false
}

// matchNumeric applies the documented numeric operator list: alternating
// comparison operators and numbers, all of which must hold.
func matchNumeric(pattern any, value any, present bool) bool {
	parts, ok := pattern.([]any)
	if !ok || len(parts) == 0 || len(parts)%2 != 0 || !present {
		return false
	}
	actual, ok := numericValue(value)
	if !ok {
		return false
	}
	for index := 0; index < len(parts); index += 2 {
		operator, ok := parts[index].(string)
		if !ok {
			return false
		}
		bound, ok := numericValue(parts[index+1])
		if !ok {
			return false
		}
		if !numericComparison(operator, actual, bound) {
			return false
		}
	}
	return true
}

func numericComparison(operator string, actual, bound float64) bool {
	switch operator {
	case "=":
		return actual == bound
	case ">":
		return actual > bound
	case ">=":
		return actual >= bound
	case "<":
		return actual < bound
	case "<=":
		return actual <= bound
	default:
		return false
	}
}

func numericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

// scalarPatternEqual compares two JSON scalars. Numbers are compared by their
// written representation, as AWS documents for event filtering.
func scalarPatternEqual(pattern, value any) bool {
	switch typed := pattern.(type) {
	case string:
		actual, ok := value.(string)
		return ok && actual == typed
	case bool:
		actual, ok := value.(bool)
		return ok && actual == typed
	case json.Number:
		actual, ok := value.(json.Number)
		return ok && actual.String() == typed.String()
	case float64:
		actual, ok := value.(float64)
		return ok && strconv.FormatFloat(actual, 'g', -1, 64) == strconv.FormatFloat(typed, 'g', -1, 64)
	case int:
		actual, ok := value.(int)
		return ok && actual == typed
	default:
		return false
	}
}
