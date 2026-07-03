package apptheory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type openAPIContractFixture struct {
	Setup struct {
		OpenAPI OpenAPISpec `json:"openapi"`
	} `json:"setup"`
	Expect struct {
		OutputJSON string `json:"output_json"`
		Error      struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"expect"`
}

func TestGenerateOpenAPIJSONMatchesContractFixtures(t *testing.T) {
	t.Parallel()

	paths, err := filepath.Glob("../contract-tests/fixtures/openapi/*.json")
	if err != nil {
		t.Fatalf("glob fixtures: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			t.Parallel()
			//nolint:gosec // Contract fixture paths are repository-local test data.
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var fixture openAPIContractFixture
			decodeErr := json.Unmarshal(data, &fixture)
			if decodeErr != nil {
				t.Fatalf("decode fixture: %v", decodeErr)
			}

			got, err := GenerateOpenAPIJSON(fixture.Setup.OpenAPI)
			if fixture.Expect.Error.Message != "" {
				if err == nil || err.Error() != fixture.Expect.Error.Message {
					t.Fatalf("GenerateOpenAPIJSON error = %v, want %q", err, fixture.Expect.Error.Message)
				}
				return
			}
			if err != nil {
				t.Fatalf("GenerateOpenAPIJSON: %v", err)
			}
			if string(got) != fixture.Expect.OutputJSON {
				t.Fatalf("OpenAPI JSON mismatch\nwant: %s\n got: %s", fixture.Expect.OutputJSON, string(got))
			}
		})
	}
}

func TestGenerateOpenAPINormalizesDefaultsAndAliases(t *testing.T) {
	t.Parallel()

	doc, err := GenerateOpenAPI(OpenAPISpec{
		Title:   "  Widgets  ",
		Version: "  1.2.3  ",
		Routes: []OpenAPIRouteSpec{
			{
				Method:      " PATCH ",
				Path:        "widgets",
				OperationID: "patchWidget",
				Tags:        []string{"widgets", "", "inventory", "widgets"},
				Request: OpenAPIRequestSpec{Fields: []OpenAPIFieldSpec{
					{Field: "id", Source: " PATH ", Name: "widget_id", Type: "string"},
					{Field: "flags", Source: "BODY", Name: "flags", Type: "bool", Array: true, Validation: []OpenAPIValidationRule{{Rule: ValidationRuleMinLength, Value: uint(1)}}},
				}},
				Response: OpenAPIResponseSpec{Fields: []OpenAPIFieldSpec{
					{Field: "attrs", Name: "attrs", Type: "map", Validation: []OpenAPIValidationRule{{Rule: ValidationRuleMinLength, Value: 1}, {Rule: ValidationRuleMaxLength, Value: 5}}},
				}},
			},
		},
	})
	if err != nil {
		t.Fatalf("GenerateOpenAPI: %v", err)
	}

	info := requireOpenAPIMap(t, doc["info"])
	if info["title"] != "Widgets" || info["version"] != "1.2.3" {
		t.Fatalf("info was not trimmed: %#v", info)
	}
	paths := requireOpenAPIMap(t, doc["paths"])
	pathItem := requireOpenAPIMap(t, paths["/widgets"])
	operation := requireOpenAPIMap(t, pathItem["patch"])
	if operation["operationId"] != "patchWidget" {
		t.Fatalf("unexpected operationId: %#v", operation["operationId"])
	}
	if got := requireOpenAPIStringSlice(t, operation["tags"]); !stringSliceEqual(got, []string{"inventory", "widgets"}) {
		t.Fatalf("tags not sorted/deduplicated: %#v", got)
	}
	responses := requireOpenAPIMap(t, operation["responses"])
	if _, ok := responses["200"]; !ok {
		t.Fatalf("default 200 response missing: %#v", responses)
	}
	parameters := requireOpenAPIAnySlice(t, operation["parameters"])
	pathParam := requireOpenAPIMap(t, parameters[0])
	if pathParam["required"] != true {
		t.Fatalf("path parameters must be required: %#v", pathParam)
	}
	requestBody := requireOpenAPIMap(t, operation["requestBody"])
	reqContent := requireOpenAPIMap(t, requestBody["content"])
	reqJSON := requireOpenAPIMap(t, reqContent["application/json"])
	reqSchema := requireOpenAPIMap(t, reqJSON["schema"])
	reqProperties := requireOpenAPIMap(t, reqSchema["properties"])
	flagsSchema := requireOpenAPIMap(t, reqProperties["flags"])
	if flagsSchema["type"] != "array" || flagsSchema["minItems"] == nil {
		t.Fatalf("array bool body field was not normalized: %#v", flagsSchema)
	}
	okResponse := requireOpenAPIMap(t, responses["200"])
	if okResponse["description"] != "success" {
		t.Fatalf("default response description missing: %#v", okResponse)
	}
	resContent := requireOpenAPIMap(t, okResponse["content"])
	resJSON := requireOpenAPIMap(t, resContent["application/json"])
	resSchema := requireOpenAPIMap(t, resJSON["schema"])
	resProperties := requireOpenAPIMap(t, resSchema["properties"])
	attrsSchema := requireOpenAPIMap(t, resProperties["attrs"])
	if attrsSchema["type"] != openAPITypeObject || attrsSchema["minProperties"] == nil || attrsSchema["maxProperties"] == nil {
		t.Fatalf("map response field was not normalized: %#v", attrsSchema)
	}
}

func TestGenerateOpenAPIFailsClosed(t *testing.T) {
	t.Parallel()

	validRoute := OpenAPIRouteSpec{
		Method:      "GET",
		Path:        "/widgets",
		OperationID: "listWidgets",
		Response:    OpenAPIResponseSpec{Fields: []OpenAPIFieldSpec{{Field: "id", Source: openAPISourceResponse, Name: "id", Type: openAPITypeString}}},
	}

	tests := []struct {
		name string
		spec OpenAPISpec
		want string
	}{
		{
			name: "missing title",
			spec: OpenAPISpec{Version: "1", Routes: []OpenAPIRouteSpec{validRoute}},
			want: "title is required",
		},
		{
			name: "missing version",
			spec: OpenAPISpec{Title: "Widgets", Routes: []OpenAPIRouteSpec{validRoute}},
			want: "version is required",
		},
		{
			name: "missing path",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", OperationID: "listWidgets"}}},
			want: "route path is required",
		},
		{
			name: "missing method",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Path: "/widgets", OperationID: "listWidgets"}}},
			want: "method is required",
		},
		{
			name: "missing operation id",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets"}}},
			want: "operation_id is required",
		},
		{
			name: "duplicate route",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{validRoute, validRoute}},
			want: "duplicated",
		},
		{
			name: "invalid success status",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets", OperationID: "listWidgets", SuccessStatus: openAPIStatusPtr(99)}}},
			want: "success_status must be an HTTP status",
		},
		{
			name: "unsupported request source",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets", OperationID: "listWidgets", Request: OpenAPIRequestSpec{Fields: []OpenAPIFieldSpec{{Field: "id", Source: "cookie", Name: "id"}}}}}},
			want: "unsupported source",
		},
		{
			name: "blank request parameter name",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets", OperationID: "listWidgets", Request: OpenAPIRequestSpec{Fields: []OpenAPIFieldSpec{{Field: "id", Source: bindSourceQuery}}}}}},
			want: "name is required",
		},
		{
			name: "blank body field name",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "POST", Path: "/widgets", OperationID: "createWidget", Request: OpenAPIRequestSpec{Fields: []OpenAPIFieldSpec{{Field: "name", Source: bindSourceBody}}}}}},
			want: "name is required",
		},
		{
			name: "blank response field name",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets", OperationID: "listWidgets", Response: OpenAPIResponseSpec{Fields: []OpenAPIFieldSpec{{Field: "id", Source: openAPISourceResponse}}}}}},
			want: "name is required",
		},
		{
			name: "decimal length rule",
			spec: OpenAPISpec{Title: "Widgets", Version: "1", Routes: []OpenAPIRouteSpec{{Method: "GET", Path: "/widgets", OperationID: "listWidgets", Response: OpenAPIResponseSpec{Fields: []OpenAPIFieldSpec{{Field: "id", Source: openAPISourceResponse, Name: "id", Validation: []OpenAPIValidationRule{{Rule: ValidationRuleMinLength, Value: 1.25}}}}}}}},
			want: "must be an integer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := GenerateOpenAPI(tt.spec)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("GenerateOpenAPI error = %v, want substring %q", err, tt.want)
			}
		})
	}
}

func TestOpenAPIValidationHelpers(t *testing.T) {
	t.Parallel()

	if got := normalizeOpenAPIType("float"); got != openAPITypeNumber {
		t.Fatalf("float normalized to %q", got)
	}
	if got := normalizeOpenAPIType("unknown"); got != openAPITypeString {
		t.Fatalf("unknown normalized to %q", got)
	}
	if got := methodRank("custom"); got <= methodRank("trace") {
		t.Fatalf("unknown method rank should sort after known methods: %d", got)
	}
	if got := sourceRank("cookie"); got != 99 {
		t.Fatalf("unknown source rank = %d", got)
	}

	stringSchema, err := openAPIFieldSchema(OpenAPIFieldSpec{
		Type: openAPITypeString,
		Validation: []OpenAPIValidationRule{
			{Rule: ValidationRulePattern, Value: "^[a-z]+$"},
			{Rule: ValidationRuleMinLength, Value: json.Number("2")},
			{Rule: ValidationRuleMaxLength, Value: "4"},
			{Rule: ValidationRuleEnum, Value: "red | blue | "},
			{Rule: "ignored", Value: "ignored"},
		},
	})
	if err != nil {
		t.Fatalf("openAPIFieldSchema string: %v", err)
	}
	if stringSchema["pattern"] != "^[a-z]+$" || stringSchema["minLength"] == nil || stringSchema["maxLength"] == nil {
		t.Fatalf("string validation schema missing constraints: %#v", stringSchema)
	}
	if got := requireOpenAPIStringSlice(t, stringSchema["enum"]); !stringSliceEqual(got, []string{"red", "blue"}) {
		t.Fatalf("string enum not normalized: %#v", got)
	}

	numberSchema, err := openAPIFieldSchema(OpenAPIFieldSpec{Type: "number", Validation: []OpenAPIValidationRule{{Rule: ValidationRuleMin, Value: 1.5}, {Rule: ValidationRuleMax, Value: uint64(5)}}})
	if err != nil {
		t.Fatalf("openAPIFieldSchema number: %v", err)
	}
	if numberSchema["minimum"] == nil || numberSchema["maximum"] == nil {
		t.Fatalf("number validation schema missing min/max: %#v", numberSchema)
	}

	arrayObjectSchema, err := openAPIFieldSchema(OpenAPIFieldSpec{Type: openAPITypeObject, Array: true})
	if err != nil {
		t.Fatalf("openAPIFieldSchema array object: %v", err)
	}
	items := requireOpenAPIMap(t, arrayObjectSchema["items"])
	if items["additionalProperties"] != true {
		t.Fatalf("array object items should allow additional properties: %#v", arrayObjectSchema)
	}

	if values := openAPIEnumValues([]any{"a", 2}); !stringSliceEqual(values, []string{"a", "2"}) {
		t.Fatalf("[]any enum values = %#v", values)
	}
	if values := openAPIEnumValues(7); !stringSliceEqual(values, []string{"7"}) {
		t.Fatalf("scalar enum values = %#v", values)
	}
	if values := openAPIEnumValues(nil); values != nil {
		t.Fatalf("nil enum values = %#v", values)
	}
	if _, ok := openAPINumberValue("not-a-number"); ok {
		t.Fatal("invalid number string accepted")
	}
	if _, ok := openAPIIntegerValue(1.25); ok {
		t.Fatal("fractional value accepted as integer")
	}
	if _, ok := openAPINumberValue(struct{}{}); ok {
		t.Fatal("unsupported number value accepted")
	}
}

func openAPIStatusPtr(status int) *int {
	return &status
}

func stringSliceEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func requireOpenAPIMap(t *testing.T, value any) map[string]any {
	t.Helper()
	out, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("value is %T, want map[string]any", value)
	}
	return out
}

func requireOpenAPIAnySlice(t *testing.T, value any) []any {
	t.Helper()
	out, ok := value.([]any)
	if !ok {
		t.Fatalf("value is %T, want []any", value)
	}
	return out
}

func requireOpenAPIStringSlice(t *testing.T, value any) []string {
	t.Helper()
	out, ok := value.([]string)
	if !ok {
		t.Fatalf("value is %T, want []string", value)
	}
	return out
}
