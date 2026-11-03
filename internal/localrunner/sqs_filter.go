package localrunner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Lambda event filtering for an SQS event source evaluates Amazon EventBridge
// event-pattern syntax against the SQS record. Metadata fields (messageId,
// attributes, messageAttributes, eventSourceARN, awsRegion, ...) are matched
// directly and the record's data field is `body`, whose JSON fields are matched
// as nested data. Multiple filters are ORed; a message that matches none is
// deleted from the queue without invoking the function.
//
// See https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
// and
// https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-filtering.html.

type eventFilterCriteria struct {
	Filters []eventFilter `json:"Filters"`
}

type eventFilter struct {
	Pattern string `json:"Pattern"`
}

// normalizeEventFilterCriteria validates a mapping's FilterCriteria and returns
// it in compact form, or nil when the mapping has no filters. AWS allows up to
// five filters per mapping and requires each Pattern to be a JSON object in
// EventBridge pattern syntax.
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
	if len(criteria.Filters) > 5 {
		return nil, unsupported(logicalID, "FilterCriteria declares %d filters; AWS allows up to five per event source mapping", len(criteria.Filters))
	}
	for index, filter := range criteria.Filters {
		pattern := strings.TrimSpace(filter.Pattern)
		if pattern == "" {
			return nil, unsupported(logicalID, "FilterCriteria filter %d has an empty Pattern", index+1)
		}
		value, err := decodePatternValue([]byte(pattern))
		if err != nil {
			return nil, unsupported(logicalID, "FilterCriteria filter %d Pattern is not valid JSON: %v", index+1, err)
		}
		if _, ok := value.(map[string]any); !ok {
			return nil, unsupported(logicalID, "FilterCriteria filter %d Pattern must be a JSON object", index+1)
		}
	}
	encoded, err := json.Marshal(criteria)
	if err != nil {
		return nil, fmt.Errorf("%s: encode FilterCriteria: %w", logicalID, err)
	}
	return encoded, nil
}

// sqsRecordMatchesFilters reports whether one SQS record satisfies at least one
// filter. An empty FilterCriteria matches every record.
func sqsRecordMatchesFilters(criteria json.RawMessage, record map[string]any, body string) bool {
	if len(bytes.TrimSpace(criteria)) == 0 {
		return true
	}
	var parsed eventFilterCriteria
	if err := json.Unmarshal(criteria, &parsed); err != nil {
		return false
	}
	if len(parsed.Filters) == 0 {
		return true
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return false
	}
	decoded, err := decodePatternValue(encoded)
	if err != nil {
		return false
	}
	target, ok := decoded.(map[string]any)
	if !ok {
		return false
	}
	if parsedBody, err := decodePatternValue([]byte(body)); err == nil {
		target["body"] = parsedBody
	} else {
		target["body"] = body
	}
	for _, filter := range parsed.Filters {
		pattern, err := decodePatternValue([]byte(filter.Pattern))
		if err != nil {
			continue
		}
		if eventPatternMatches(pattern, target) {
			return true
		}
	}
	return false
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

// eventPatternMatches applies one EventBridge pattern to a value. An object
// pattern matches when every key matches; "$or" matches when any nested pattern
// matches.
func eventPatternMatches(pattern, value any) bool {
	switch typed := pattern.(type) {
	case map[string]any:
		target, ok := value.(map[string]any)
		if !ok {
			// A pattern consisting of an operator on a scalar is evaluated by
			// matchPatternValue.
			return matchPatternValue(typed, value, true)
		}
		for key, expected := range typed {
			if key == "$or" {
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
	case []any:
		return matchPatternValue(typed, value, true)
	default:
		return matchPatternValue(typed, value, true)
	}
}

// matchPatternValue applies a pattern node to one field. present reports
// whether the field exists in its parent object.
//
//nolint:gocognit,gocyclo // the nested switch is EventBridge's documented operator grammar.
func matchPatternValue(pattern, value any, present bool) bool {
	switch typed := pattern.(type) {
	case nil:
		return !present || value == nil
	case []any:
		// An array of pattern values is an OR. An empty array matches nothing.
		for _, candidate := range typed {
			if matchPatternValue(candidate, value, present) {
				return true
			}
		}
		return false
	case map[string]any:
		if operator, ok := filterOperator(typed); ok {
			return matchFilterOperator(operator, typed, value, present)
		}
		target, ok := value.(map[string]any)
		if !ok {
			return false
		}
		for key, expected := range typed {
			if key == "$or" {
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
			actual, exists := target[key]
			if !matchPatternValue(expected, actual, exists) {
				return false
			}
		}
		return true
	default:
		if !present {
			return false
		}
		return scalarPatternEqual(pattern, value)
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

// filterOperator recognizes the single-key operator objects AWS documents.
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
