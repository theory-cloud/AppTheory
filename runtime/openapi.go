package apptheory

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

const (
	openAPISourceResponse = "response"
	openAPITypeInteger    = "integer"
	openAPITypeNumber     = "number"
	openAPITypeObject     = "object"
	openAPITypeString     = "string"
)

// OpenAPISpec describes the typed-handler route table used for deterministic OpenAPI generation.
type OpenAPISpec struct {
	Title   string             `json:"title"`
	Version string             `json:"version"`
	Routes  []OpenAPIRouteSpec `json:"routes"`
}

// OpenAPIRouteSpec describes one typed handler operation in the OpenAPI route table.
type OpenAPIRouteSpec struct {
	Method        string              `json:"method"`
	Path          string              `json:"path"`
	OperationID   string              `json:"operation_id"`
	Summary       string              `json:"summary,omitempty"`
	Tags          []string            `json:"tags,omitempty"`
	SuccessStatus int                 `json:"success_status,omitempty"`
	Request       OpenAPIRequestSpec  `json:"request,omitempty"`
	Response      OpenAPIResponseSpec `json:"response"`
}

// OpenAPIRequestSpec describes request fields bound by a typed handler.
type OpenAPIRequestSpec struct {
	Fields []OpenAPIFieldSpec `json:"fields,omitempty"`
}

// OpenAPIResponseSpec describes the successful JSON response emitted by a typed handler.
type OpenAPIResponseSpec struct {
	Description string             `json:"description,omitempty"`
	Fields      []OpenAPIFieldSpec `json:"fields,omitempty"`
}

// OpenAPIFieldSpec describes one request or response field in the typed-handler contract.
type OpenAPIFieldSpec struct {
	Field      string                  `json:"field"`
	Source     string                  `json:"source"`
	Name       string                  `json:"name"`
	Type       string                  `json:"type"`
	Array      bool                    `json:"array,omitempty"`
	Required   bool                    `json:"required,omitempty"`
	Validation []OpenAPIValidationRule `json:"validation,omitempty"`
}

// OpenAPIValidationRule mirrors the declarative validation vocabulary for OpenAPI schema output.
type OpenAPIValidationRule struct {
	Rule  string `json:"rule"`
	Value any    `json:"value,omitempty"`
}

// GenerateOpenAPI returns the deterministic OpenAPI 3.1 document for a typed-handler route table.
func GenerateOpenAPI(spec OpenAPISpec) (map[string]any, error) {
	title := strings.TrimSpace(spec.Title)
	version := strings.TrimSpace(spec.Version)
	if title == "" {
		return nil, errors.New("apptheory: openapi title is required")
	}
	if version == "" {
		return nil, errors.New("apptheory: openapi version is required")
	}

	paths := map[string]any{}
	routes := append([]OpenAPIRouteSpec(nil), spec.Routes...)
	sort.SliceStable(routes, func(i, j int) bool {
		leftPath := normalizeOpenAPIPath(routes[i].Path)
		rightPath := normalizeOpenAPIPath(routes[j].Path)
		if leftPath != rightPath {
			return leftPath < rightPath
		}
		leftMethod := normalizeOpenAPIMethod(routes[i].Method)
		rightMethod := normalizeOpenAPIMethod(routes[j].Method)
		if methodRank(leftMethod) != methodRank(rightMethod) {
			return methodRank(leftMethod) < methodRank(rightMethod)
		}
		return leftMethod < rightMethod
	})

	seen := map[string]struct{}{}
	for _, route := range routes {
		path := normalizeOpenAPIPath(route.Path)
		method := normalizeOpenAPIMethod(route.Method)
		if path == "" {
			return nil, errors.New("apptheory: openapi route path is required")
		}
		if method == "" {
			return nil, fmt.Errorf("apptheory: openapi route %s method is required", path)
		}
		operationID := strings.TrimSpace(route.OperationID)
		if operationID == "" {
			return nil, fmt.Errorf("apptheory: openapi route %s %s operation_id is required", strings.ToUpper(method), path)
		}
		key := method + " " + path
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("apptheory: openapi route %s is duplicated", key)
		}
		seen[key] = struct{}{}

		operation, err := openAPIOperation(route, operationID)
		if err != nil {
			return nil, err
		}
		pathItem, ok := paths[path].(map[string]any)
		if !ok {
			pathItem = map[string]any{}
			paths[path] = pathItem
		}
		pathItem[method] = operation
	}

	return map[string]any{
		"components": openAPIComponents(),
		"info": map[string]any{
			"title":   title,
			"version": version,
		},
		"openapi": "3.1.0",
		"paths":   paths,
	}, nil
}

// GenerateOpenAPIJSON returns the byte-stable canonical JSON encoding of GenerateOpenAPI.
func GenerateOpenAPIJSON(spec OpenAPISpec) ([]byte, error) {
	doc, err := GenerateOpenAPI(spec)
	if err != nil {
		return nil, err
	}
	return json.Marshal(doc)
}

func openAPIComponents() map[string]any {
	return map[string]any{
		"responses": map[string]any{
			"AppBadRequest": map[string]any{
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{"$ref": "#/components/schemas/AppTheoryError"},
					},
				},
				"description": "AppTheory bad request error envelope",
			},
			"AppValidationFailed": map[string]any{
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{"$ref": "#/components/schemas/AppTheoryError"},
					},
				},
				"description": "AppTheory validation failure error envelope",
			},
		},
		"schemas": map[string]any{
			"AppTheoryError": map[string]any{
				"additionalProperties": false,
				"properties": map[string]any{
					"error": map[string]any{
						"additionalProperties": true,
						"properties": map[string]any{
							"code":       map[string]any{"type": openAPITypeString},
							"details":    map[string]any{"additionalProperties": true, "type": openAPITypeObject},
							"message":    map[string]any{"type": openAPITypeString},
							"request_id": map[string]any{"type": openAPITypeString},
						},
						"required": []string{"code", "message"},
						"type":     openAPITypeObject,
					},
				},
				"required": []string{"error"},
				"type":     openAPITypeObject,
			},
		},
	}
}

func openAPIOperation(route OpenAPIRouteSpec, operationID string) (map[string]any, error) {
	successStatus := route.SuccessStatus
	if successStatus == 0 {
		successStatus = 200
	}
	if successStatus < 100 || successStatus > 599 {
		return nil, fmt.Errorf("apptheory: openapi route %s %s success_status must be an HTTP status", strings.ToUpper(route.Method), route.Path)
	}

	successResponse, err := openAPISuccessResponse(route.Response)
	if err != nil {
		return nil, err
	}

	operation := map[string]any{
		"operationId": operationID,
		"responses": map[string]any{
			strconv.Itoa(successStatus): successResponse,
			"400":                       map[string]any{"$ref": "#/components/responses/AppBadRequest"},
			"422":                       map[string]any{"$ref": "#/components/responses/AppValidationFailed"},
		},
	}

	parameters, err := openAPIParameters(route.Request.Fields)
	if err != nil {
		return nil, err
	}
	if len(parameters) > 0 {
		operation["parameters"] = parameters
	}

	bodyFields, err := openAPIFieldsForSource(route.Request.Fields, bindSourceBody)
	if err != nil {
		return nil, err
	}
	if len(bodyFields) > 0 {
		operation["requestBody"] = map[string]any{
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": openAPIObjectSchema(bodyFields),
				},
			},
			"required": true,
		}
	}

	summary := strings.TrimSpace(route.Summary)
	if summary != "" {
		operation["summary"] = summary
	}
	tags := sortedOpenAPITags(route.Tags)
	if len(tags) > 0 {
		operation["tags"] = tags
	}
	return operation, nil
}

func openAPISuccessResponse(response OpenAPIResponseSpec) (map[string]any, error) {
	description := strings.TrimSpace(response.Description)
	if description == "" {
		description = "success"
	}
	out := map[string]any{"description": description}
	fields, err := openAPIFieldsForSource(response.Fields, openAPISourceResponse)
	if err != nil {
		return nil, err
	}
	if len(fields) > 0 {
		out["content"] = map[string]any{
			"application/json": map[string]any{
				"schema": openAPIObjectSchema(fields),
			},
		}
	}
	return out, nil
}

func openAPIParameters(fields []OpenAPIFieldSpec) ([]any, error) {
	var params []OpenAPIFieldSpec
	for _, field := range fields {
		source := normalizeOpenAPISource(field.Source)
		switch source {
		case bindSourcePath, bindSourceQuery, bindSourceHeader:
			field.Source = source
			params = append(params, field)
		case bindSourceBody:
			continue
		default:
			return nil, fmt.Errorf("apptheory: openapi request field %s has unsupported source %q", field.Field, field.Source)
		}
	}
	sort.SliceStable(params, func(i, j int) bool {
		leftRank := sourceRank(params[i].Source)
		rightRank := sourceRank(params[j].Source)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return strings.TrimSpace(params[i].Name) < strings.TrimSpace(params[j].Name)
	})

	out := make([]any, 0, len(params))
	for _, field := range params {
		name := strings.TrimSpace(field.Name)
		if name == "" {
			return nil, fmt.Errorf("apptheory: openapi request field %s name is required", field.Field)
		}
		out = append(out, map[string]any{
			"in":       field.Source,
			"name":     name,
			"required": openAPIFieldRequired(field),
			"schema":   openAPIFieldSchema(field),
		})
	}
	return out, nil
}

func openAPIFieldsForSource(fields []OpenAPIFieldSpec, source string) ([]OpenAPIFieldSpec, error) {
	source = normalizeOpenAPISource(source)
	out := make([]OpenAPIFieldSpec, 0, len(fields))
	for _, field := range fields {
		fieldSource := normalizeOpenAPISource(field.Source)
		if source == openAPISourceResponse && fieldSource == "" {
			fieldSource = openAPISourceResponse
		}
		if fieldSource != source {
			continue
		}
		name := strings.TrimSpace(field.Name)
		if name == "" {
			return nil, fmt.Errorf("apptheory: openapi field %s name is required", field.Field)
		}
		field.Source = fieldSource
		field.Name = name
		out = append(out, field)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func openAPIObjectSchema(fields []OpenAPIFieldSpec) map[string]any {
	properties := map[string]any{}
	required := make([]string, 0, len(fields))
	for _, field := range fields {
		properties[field.Name] = openAPIFieldSchema(field)
		if openAPIFieldRequired(field) {
			required = append(required, field.Name)
		}
	}
	sort.Strings(required)
	schema := map[string]any{
		"additionalProperties": false,
		"properties":           properties,
		"type":                 openAPITypeObject,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func openAPIFieldSchema(field OpenAPIFieldSpec) map[string]any {
	baseType := normalizeOpenAPIType(field.Type)
	var schema map[string]any
	if field.Array {
		items := map[string]any{"type": baseType}
		if baseType == openAPITypeObject {
			items["additionalProperties"] = true
		}
		schema = map[string]any{"items": items, "type": "array"}
	} else {
		schema = map[string]any{"type": baseType}
		if baseType == openAPITypeObject {
			schema["additionalProperties"] = true
		}
	}

	for _, rule := range field.Validation {
		applyOpenAPIValidationRule(schema, baseType, field.Array, rule)
	}
	return schema
}

func applyOpenAPIValidationRule(schema map[string]any, baseType string, array bool, rule OpenAPIValidationRule) {
	switch strings.TrimSpace(rule.Rule) {
	case ValidationRuleRequired:
		return
	case ValidationRuleMin, ValidationRuleMax:
		applyOpenAPINumericRule(schema, baseType, array, rule)
	case ValidationRuleMinLength, ValidationRuleMaxLength:
		applyOpenAPILengthRule(schema, baseType, array, rule)
	case ValidationRulePattern:
		applyOpenAPIPatternRule(schema, baseType, array, rule.Value)
	case ValidationRuleEnum:
		applyOpenAPIEnumRule(schema, rule.Value)
	}
}

func applyOpenAPINumericRule(schema map[string]any, baseType string, array bool, rule OpenAPIValidationRule) {
	if array || (baseType != openAPITypeInteger && baseType != openAPITypeNumber) {
		return
	}
	value, ok := openAPINumberValue(rule.Value)
	if !ok {
		return
	}
	if strings.TrimSpace(rule.Rule) == ValidationRuleMin {
		schema["minimum"] = value
		return
	}
	schema["maximum"] = value
}

func applyOpenAPILengthRule(schema map[string]any, baseType string, array bool, rule OpenAPIValidationRule) {
	value, ok := openAPIIntegerValue(rule.Value)
	if !ok {
		return
	}
	if strings.TrimSpace(rule.Rule) == ValidationRuleMinLength {
		applyOpenAPILength(schema, baseType, array, ValidationRuleMin, value)
		return
	}
	applyOpenAPILength(schema, baseType, array, ValidationRuleMax, value)
}

func applyOpenAPIPatternRule(schema map[string]any, baseType string, array bool, value any) {
	if !array && baseType == openAPITypeString {
		schema["pattern"] = fmt.Sprint(value)
	}
}

func applyOpenAPIEnumRule(schema map[string]any, value any) {
	if values := openAPIEnumValues(value); len(values) > 0 {
		schema["enum"] = values
	}
}

func applyOpenAPILength(schema map[string]any, baseType string, array bool, kind string, value json.Number) {
	if array {
		if kind == ValidationRuleMin {
			schema["minItems"] = value
		} else {
			schema["maxItems"] = value
		}
		return
	}
	if baseType == openAPITypeObject {
		if kind == ValidationRuleMin {
			schema["minProperties"] = value
		} else {
			schema["maxProperties"] = value
		}
		return
	}
	if kind == ValidationRuleMin {
		schema["minLength"] = value
	} else {
		schema["maxLength"] = value
	}
}

func openAPIFieldRequired(field OpenAPIFieldSpec) bool {
	if normalizeOpenAPISource(field.Source) == bindSourcePath || field.Required {
		return true
	}
	for _, rule := range field.Validation {
		if strings.TrimSpace(rule.Rule) == ValidationRuleRequired {
			return true
		}
	}
	return false
}

func normalizeOpenAPIPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

func normalizeOpenAPIMethod(method string) string {
	return strings.ToLower(strings.TrimSpace(method))
}

func normalizeOpenAPISource(source string) string {
	return strings.ToLower(strings.TrimSpace(source))
}

func normalizeOpenAPIType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "int", "integer":
		return openAPITypeInteger
	case "float", "number":
		return openAPITypeNumber
	case "bool", "boolean":
		return "boolean"
	case "object", "map":
		return openAPITypeObject
	default:
		return openAPITypeString
	}
}

func methodRank(method string) int {
	order := []string{"get", "put", "post", "delete", "options", "head", "patch", "trace"}
	for i, candidate := range order {
		if method == candidate {
			return i
		}
	}
	return len(order)
}

func sourceRank(source string) int {
	switch source {
	case bindSourcePath:
		return 0
	case bindSourceQuery:
		return 1
	case bindSourceHeader:
		return 2
	case bindSourceBody:
		return 3
	case openAPISourceResponse:
		return 4
	default:
		return 99
	}
}

func sortedOpenAPITags(tags []string) []string {
	set := map[string]struct{}{}
	for _, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed == "" {
			continue
		}
		set[trimmed] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for tag := range set {
		out = append(out, tag)
	}
	sort.Strings(out)
	return out
}

func openAPIEnumValues(value any) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(item))
		}
		return out
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(fmt.Sprint(item)))
		}
		return out
	case string:
		parts := strings.Split(typed, "|")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
		return out
	default:
		if value == nil {
			return nil
		}
		return []string{strings.TrimSpace(fmt.Sprint(value))}
	}
}

func openAPINumberValue(value any) (json.Number, bool) {
	switch typed := value.(type) {
	case json.Number:
		return openAPIValidNumber(typed)
	case string:
		return openAPIValidNumber(json.Number(strings.TrimSpace(typed)))
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return json.Number(strconv.FormatInt(reflected.Int(), 10)), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return json.Number(strconv.FormatUint(reflected.Uint(), 10)), true
	case reflect.Float32, reflect.Float64:
		return openAPIValidNumber(json.Number(strconv.FormatFloat(reflected.Float(), 'f', -1, 64)))
	default:
		return "", false
	}
}

func openAPIIntegerValue(value any) (json.Number, bool) {
	number, ok := openAPINumberValue(value)
	if !ok {
		return "", false
	}
	if _, err := strconv.ParseInt(number.String(), 10, 64); err == nil {
		return number, true
	}
	if _, err := strconv.ParseUint(number.String(), 10, 64); err == nil {
		return number, true
	}
	return "", false
}

func openAPIValidNumber(value json.Number) (json.Number, bool) {
	if strings.TrimSpace(value.String()) == "" {
		return "", false
	}
	if _, err := strconv.ParseFloat(value.String(), 64); err != nil {
		return "", false
	}
	return value, true
}
