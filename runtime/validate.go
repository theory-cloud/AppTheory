package apptheory

import (
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

const (
	ValidationRuleRequired  = "required"
	ValidationRuleMin       = "min"
	ValidationRuleMax       = "max"
	ValidationRuleMinLength = "min_length"
	ValidationRuleMaxLength = "max_length"
	ValidationRulePattern   = "pattern"
	ValidationRuleEnum      = "enum"
)

// ValidationFieldError describes one canonical declarative validation failure.
type ValidationFieldError struct {
	Field   string `json:"field"`
	Rule    string `json:"rule"`
	Message string `json:"message"`
}

type validationRuleSpec struct {
	rule  string
	value string
}

func validateBoundRequest(value any) error {
	root := prepareBindTarget(reflect.ValueOf(value))
	if !root.IsValid() || root.Kind() != reflect.Struct {
		return nil
	}

	fieldErrors := validateStructValue(root)
	if len(fieldErrors) == 0 {
		return nil
	}
	return newValidationFailedError(fieldErrors)
}

func validateStructValue(target reflect.Value) []ValidationFieldError {
	targetType := target.Type()
	var out []ValidationFieldError
	for i := 0; i < target.NumField(); i++ {
		fieldType := targetType.Field(i)
		fieldValue := target.Field(i)

		if fieldType.PkgPath != "" && !fieldType.Anonymous {
			continue
		}

		if fieldType.Anonymous {
			embedded := prepareFieldValue(fieldValue)
			if embedded.IsValid() && embedded.Kind() == reflect.Struct {
				out = append(out, validateStructValue(embedded)...)
				continue
			}
		}

		rules := parseValidationTag(fieldType.Tag.Get("validate"))
		if len(rules) == 0 {
			continue
		}

		fieldName := validationFieldName(fieldType)
		for _, rule := range rules {
			fieldErr, ok := validateFieldRule(fieldName, fieldValue, rule)
			if !ok {
				continue
			}
			out = append(out, fieldErr)
			if rule.rule == ValidationRuleRequired {
				break
			}
		}
	}
	return out
}

func parseValidationTag(tag string) []validationRuleSpec {
	parts := strings.Split(tag, ",")
	rules := make([]validationRuleSpec, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "-" {
			continue
		}
		name, value, _ := strings.Cut(part, "=")
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		switch name {
		case ValidationRuleRequired, ValidationRuleMin, ValidationRuleMax,
			ValidationRuleMinLength, ValidationRuleMaxLength, ValidationRulePattern, ValidationRuleEnum:
			rules = append(rules, validationRuleSpec{rule: name, value: value})
		}
	}
	return rules
}

func validateFieldRule(fieldName string, value reflect.Value, rule validationRuleSpec) (ValidationFieldError, bool) {
	v := prepareValidationValue(value)
	switch rule.rule {
	case ValidationRuleRequired:
		return validateRequiredRule(fieldName, v, rule)
	case ValidationRuleMin:
		return validateNumericRule(fieldName, v, rule, func(actual, limit float64) bool { return actual < limit }, ">=")
	case ValidationRuleMax:
		return validateNumericRule(fieldName, v, rule, func(actual, limit float64) bool { return actual > limit }, "<=")
	case ValidationRuleMinLength:
		return validateLengthRule(fieldName, v, rule, func(actual, limit int) bool { return actual < limit }, ">=")
	case ValidationRuleMaxLength:
		return validateLengthRule(fieldName, v, rule, func(actual, limit int) bool { return actual > limit }, "<=")
	case ValidationRulePattern:
		return validatePatternRule(fieldName, v, rule)
	case ValidationRuleEnum:
		return validateEnumRule(fieldName, v, rule)
	}
	return ValidationFieldError{}, false
}

func validateRequiredRule(fieldName string, value reflect.Value, rule validationRuleSpec) (ValidationFieldError, bool) {
	if !isValidationZero(value) {
		return ValidationFieldError{}, false
	}
	return validationFieldError(fieldName, rule.rule, fmt.Sprintf("%s is required", fieldName)), true
}

func validateNumericRule(
	fieldName string,
	value reflect.Value,
	rule validationRuleSpec,
	fails func(float64, float64) bool,
	operator string,
) (ValidationFieldError, bool) {
	limit, ok := parseValidationFloat(rule.value)
	if !ok {
		return ValidationFieldError{}, false
	}
	actual, ok := validationNumericValue(value)
	if !ok || !fails(actual, limit) {
		return ValidationFieldError{}, false
	}
	return validationFieldError(fieldName, rule.rule, fmt.Sprintf("%s must be %s %s", fieldName, operator, rule.value)), true
}

func validateLengthRule(
	fieldName string,
	value reflect.Value,
	rule validationRuleSpec,
	fails func(int, int) bool,
	operator string,
) (ValidationFieldError, bool) {
	limit, ok := parseValidationInt(rule.value)
	if !ok {
		return ValidationFieldError{}, false
	}
	actual, ok := validationLength(value)
	if !ok || !fails(actual, limit) {
		return ValidationFieldError{}, false
	}
	return validationFieldError(fieldName, rule.rule, fmt.Sprintf("%s length must be %s %s", fieldName, operator, rule.value)), true
}

func validatePatternRule(fieldName string, value reflect.Value, rule validationRuleSpec) (ValidationFieldError, bool) {
	actual, ok := validationStringValue(value)
	if !ok {
		return ValidationFieldError{}, false
	}
	matched, err := regexp.MatchString(rule.value, actual)
	if err != nil || matched {
		return ValidationFieldError{}, false
	}
	return validationFieldError(fieldName, rule.rule, fmt.Sprintf("%s must match pattern", fieldName)), true
}

func validateEnumRule(fieldName string, value reflect.Value, rule validationRuleSpec) (ValidationFieldError, bool) {
	actual, ok := validationStringValue(value)
	if !ok {
		actual = fmt.Sprint(value.Interface())
	}
	allowed := splitValidationEnum(rule.value)
	if len(allowed) == 0 {
		return ValidationFieldError{}, false
	}
	for _, option := range allowed {
		if actual == option {
			return ValidationFieldError{}, false
		}
	}
	return validationFieldError(fieldName, rule.rule, fmt.Sprintf("%s must be one of %s", fieldName, strings.Join(allowed, ", "))), true
}

func prepareValidationValue(v reflect.Value) reflect.Value {
	for v.IsValid() && v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return reflect.Value{}
		}
		v = v.Elem()
	}
	return v
}

func isValidationZero(v reflect.Value) bool {
	if !v.IsValid() {
		return true
	}
	if v.Kind() == reflect.String {
		return strings.TrimSpace(v.String()) == ""
	}
	if v.Kind() == reflect.Slice || v.Kind() == reflect.Array || v.Kind() == reflect.Map {
		return v.Len() == 0
	}
	return v.IsZero()
}

func validationNumericValue(v reflect.Value) (float64, bool) {
	if !v.IsValid() {
		return 0, false
	}
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(v.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(v.Uint()), true
	case reflect.Float32, reflect.Float64:
		return v.Float(), true
	default:
		return 0, false
	}
}

func validationLength(v reflect.Value) (int, bool) {
	if !v.IsValid() {
		return 0, false
	}
	switch v.Kind() {
	case reflect.String, reflect.Slice, reflect.Array, reflect.Map:
		return v.Len(), true
	default:
		return 0, false
	}
}

func validationStringValue(v reflect.Value) (string, bool) {
	if !v.IsValid() || v.Kind() != reflect.String {
		return "", false
	}
	return v.String(), true
}

func parseValidationFloat(value string) (float64, bool) {
	out, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return out, err == nil
}

func parseValidationInt(value string) (int, bool) {
	out, err := strconv.Atoi(strings.TrimSpace(value))
	return out, err == nil
}

func splitValidationEnum(value string) []string {
	parts := strings.Split(value, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func validationFieldName(field reflect.StructField) string {
	for _, tagName := range []string{"json", "query", "path", "header"} {
		if name := bindTagValue(field, tagName); name != "" {
			return name
		}
	}
	name := strings.TrimSpace(field.Name)
	if name == "" {
		return "field"
	}
	return strings.ToLower(name[:1]) + name[1:]
}

func validationFieldError(field, rule, message string) ValidationFieldError {
	return ValidationFieldError{Field: field, Rule: rule, Message: message}
}

func newValidationFailedError(fieldErrors []ValidationFieldError) *AppTheoryError {
	return NewAppTheoryError(errorCodeValidationFailed, bindErrorMessageValidation).
		WithStatusCode(422).
		WithDetails(map[string]any{"errors": fieldErrors})
}
