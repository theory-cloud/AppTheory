package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func testTemplateContext() templateContext {
	return templateContext{
		Parameters: map[string]templateParameter{
			"MemorySize": {Type: "Number", Default: json.RawMessage(`512`)},
			"Stage":      {Type: "String", Default: json.RawMessage(`"prod"`)},
			"NoDefault":  {Type: "Number"},
		},
		Conditions: map[string]json.RawMessage{
			"IsProd":   json.RawMessage(`{"Fn::Equals":[{"Ref":"Stage"},"prod"]}`),
			"IsDev":    json.RawMessage(`{"Fn::Not":[{"Condition":"IsProd"}]}`),
			"AllTrue":  json.RawMessage(`{"Fn::And":[{"Condition":"IsProd"},{"Fn::Equals":[{"Ref":"MemorySize"},"512"]}]}`),
			"AnyTrue":  json.RawMessage(`{"Fn::Or":[{"Condition":"IsDev"},{"Condition":"IsProd"}]}`),
			"HasSmall": json.RawMessage(`{"Fn::Contains":[["small","large"],"small"]}`),
		},
		Mappings: map[string]map[string]map[string]any{
			"Sizes": {
				"small": {"memory": float64(256), "timeout": float64(5)},
				"large": {"memory": "1024", "timeout": float64(30)},
			},
		},
	}
}

func TestResolveTemplateIntForms(t *testing.T) {
	context := testTemplateContext()
	cases := []struct {
		name     string
		raw      string
		expected int
		resolved bool
	}{
		{"absent", ``, 128, true},
		{"literal", `256`, 256, true},
		{"ref parameter default", `{"Ref":"MemorySize"}`, 512, true},
		{"fn if true", `{"Fn::If":["IsProd",1024,256]}`, 1024, true},
		{"fn if false", `{"Fn::If":["IsDev",1024,256]}`, 256, true},
		{"fn if no value true", `{"Fn::If":["IsProd",{"Ref":"AWS::NoValue"},1024]}`, 128, true},
		{"fn if no value false", `{"Fn::If":["IsDev",{"Ref":"AWS::NoValue"},1024]}`, 1024, true},
		{"find in map number", `{"Fn::FindInMap":["Sizes","small","memory"]}`, 256, true},
		{"find in map string", `{"Fn::FindInMap":["Sizes","large","memory"]}`, 1024, true},
		{"join", `{"Fn::Join":["",["51","2"]]}`, 512, true},
		{"parameter without default", `{"Ref":"NoDefault"}`, 128, false},
		{"getatt", `{"Fn::GetAtt":["Fn","Arn"]}`, 128, false},
		{"unknown condition", `{"Fn::If":["Missing",1,2]}`, 128, false},
		{"unknown mapping", `{"Fn::FindInMap":["Missing","a","b"]}`, 128, false},
	}
	for _, testCase := range cases {
		value, resolved, expression, err := resolveTemplateInt(json.RawMessage(testCase.raw), context, 128)
		if err != nil {
			t.Fatalf("%s: %v", testCase.name, err)
		}
		if resolved != testCase.resolved {
			t.Fatalf("%s: resolved = %v, want %v", testCase.name, resolved, testCase.resolved)
		}
		if resolved && value != testCase.expected {
			t.Fatalf("%s: value = %d, want %d", testCase.name, value, testCase.expected)
		}
		if !resolved && expression == "" {
			t.Fatalf("%s: unresolved value has no expression name", testCase.name)
		}
	}
}

func TestTemplateConditions(t *testing.T) {
	context := testTemplateContext()
	cases := []struct {
		name     string
		expected bool
	}{
		{"IsProd", true},
		{"IsDev", false},
		{"AllTrue", true},
		{"AnyTrue", true},
		{"HasSmall", true},
	}
	for _, testCase := range cases {
		value, err := context.condition(testCase.name)
		if err != nil {
			t.Fatalf("%s: %v", testCase.name, err)
		}
		if value != testCase.expected {
			t.Fatalf("%s = %v, want %v", testCase.name, value, testCase.expected)
		}
	}
	if _, err := context.condition("Missing"); err == nil {
		t.Fatal("an unknown condition did not fail closed")
	}
}

func TestParameterWithoutDefaultNamesTheParameterAndPage(t *testing.T) {
	context := testTemplateContext()
	_, err := context.refValue("NoDefault")
	if err == nil {
		t.Fatal("a parameter without a default resolved")
	}
	message := err.Error()
	for _, needle := range []string{"NoDefault", "has no Default", "parameters-section-structure"} {
		if !strings.Contains(message, needle) {
			t.Fatalf("error %q does not contain %q", message, needle)
		}
	}
}

func TestEnvironmentResolverResolvesParametersAndConditions(t *testing.T) {
	runner := &Runner{}
	context := testTemplateContext()
	resources := map[string]map[string]ResourceSpec{}
	value, err := runner.resolveExpressionWithTemplate(`{"Ref":"MemorySize"}`, "Stack", resources, resourceValues{}, context)
	if err != nil || value != "512" {
		t.Fatalf("parameter Ref = %q, %v", value, err)
	}
	value, err = runner.resolveExpressionWithTemplate(`{"Fn::If":["IsProd",{"Ref":"MemorySize"},"128"]}`, "Stack", resources, resourceValues{}, context)
	if err != nil || value != "512" {
		t.Fatalf("Fn::If = %q, %v", value, err)
	}
	value, err = runner.resolveExpressionWithTemplate(`{"Fn::FindInMap":["Sizes","small","memory"]}`, "Stack", resources, resourceValues{}, context)
	if err != nil || value != "256" {
		t.Fatalf("Fn::FindInMap = %q, %v", value, err)
	}
}

func TestParseFunctionResolvesTemplateLimits(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{
			Parameters: testTemplateContext().Parameters,
			Conditions: testTemplateContext().Conditions,
			Mappings:   testTemplateContext().Mappings,
		},
	}
	resource := templateResource{
		Type: typeLambdaFunction,
		Properties: json.RawMessage(`{
			"Runtime":"nodejs24.x",
			"Handler":"index.handler",
			"MemorySize":{"Fn::If":["IsProd",{"Ref":"MemorySize"},256]},
			"Timeout":{"Fn::FindInMap":["Sizes","small","timeout"]},
			"Code":{"ZipFile":"exports.handler = async () => ({statusCode: 200});"}
		}`),
	}
	function, err := parseFunction("", stack, "Fn", resource)
	if err != nil {
		t.Fatal(err)
	}
	if function.UnresolvedMemorySize || function.UnresolvedTimeout {
		t.Fatalf("limits stayed unresolved: %+v", function)
	}
	if function.MemoryMB != 512 || function.Timeout != 5 {
		t.Fatalf("limits = %d/%d, want 512/5", function.MemoryMB, function.Timeout)
	}
}

func TestParseFunctionAppliesDefaultsWhenFnIfSelectsNoValue(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{
			Parameters: testTemplateContext().Parameters,
			Conditions: testTemplateContext().Conditions,
		},
	}
	resource := templateResource{
		Type: typeLambdaFunction,
		Properties: json.RawMessage(`{
			"Runtime":"nodejs24.x",
			"Handler":"index.handler",
			"MemorySize":{"Fn::If":["IsProd",{"Ref":"AWS::NoValue"},2048]},
			"Timeout":{"Fn::If":["IsProd",{"Ref":"AWS::NoValue"},60]},
			"Code":{"ZipFile":"exports.handler = async () => ({statusCode: 200});"}
		}`),
	}
	function, err := parseFunction("", stack, "Fn", resource)
	if err != nil {
		t.Fatal(err)
	}
	if function.UnresolvedMemorySize || function.UnresolvedTimeout || function.MemorySizeExpression != "" || function.TimeoutExpression != "" {
		t.Fatalf("an AWS::NoValue limit stayed unresolved: %+v", function)
	}
	if function.MemoryMB != 128 || function.Timeout != 3 {
		t.Fatalf("limits = %d/%d, want the documented defaults 128/3", function.MemoryMB, function.Timeout)
	}
	if err := unresolvedLimitsError(function); err != nil {
		t.Fatalf("a resolved default failed the served-function check: %v", err)
	}
}

func TestParseFunctionKeepsAnUnresolvableLimitFailClosed(t *testing.T) {
	stack := assemblyStack{
		Name:     "Stack",
		Template: template{Parameters: testTemplateContext().Parameters},
	}
	resource := templateResource{
		Type: typeLambdaFunction,
		Properties: json.RawMessage(`{
			"Runtime":"nodejs24.x",
			"Handler":"index.handler",
			"MemorySize":{"Ref":"NoDefault"},
			"Timeout":{"Fn::GetAtt":["Fn","Arn"]},
			"Code":{"ZipFile":"exports.handler = async () => ({statusCode: 200});"}
		}`),
	}
	function, err := parseFunction("", stack, "Fn", resource)
	if err != nil {
		t.Fatal(err)
	}
	if !function.UnresolvedMemorySize || !function.UnresolvedTimeout {
		t.Fatalf("limits resolved unexpectedly: %+v", function)
	}
	if function.MemorySizeExpression != "Ref" || function.TimeoutExpression != "Fn::GetAtt" {
		t.Fatalf("expressions = %q/%q", function.MemorySizeExpression, function.TimeoutExpression)
	}
	if err := unresolvedLimitsError(function); err == nil {
		t.Fatal("an unresolved served function did not fail closed")
	}
}

func TestParseFunctionValidatesLambdaRanges(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{}}
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"memory below", `{"Runtime":"nodejs24.x","Handler":"index.handler","MemorySize":64,"Code":{"ZipFile":"x"}}`, "MemorySize"},
		{"memory above", `{"Runtime":"nodejs24.x","Handler":"index.handler","MemorySize":40000,"Code":{"ZipFile":"x"}}`, "MemorySize"},
		{"timeout below", `{"Runtime":"nodejs24.x","Handler":"index.handler","Timeout":0,"Code":{"ZipFile":"x"}}`, "Timeout"},
		{"timeout above", `{"Runtime":"nodejs24.x","Handler":"index.handler","Timeout":901,"Code":{"ZipFile":"x"}}`, "Timeout"},
	}
	for _, testCase := range cases {
		resource := templateResource{Type: typeLambdaFunction, Properties: json.RawMessage(testCase.raw)}
		_, err := parseFunction("", stack, "Fn", resource)
		if err == nil || !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("%s: error = %v", testCase.name, err)
		}
	}
}

func TestValidateFunctionLimitQuotesTheLambdaPage(t *testing.T) {
	err := validateFunctionLimit("Fn", "MemorySize", 64, 128, 32768)
	if err == nil || !strings.Contains(err.Error(), "128..32768") || !strings.Contains(err.Error(), "aws-resource-lambda-function") {
		t.Fatalf("memory error = %v", err)
	}
	err = validateFunctionLimit("Fn", "Timeout", 901, 1, 900)
	if err == nil || !strings.Contains(err.Error(), "maximum allowed value is 900 seconds") {
		t.Fatalf("timeout error = %v", err)
	}
}

func TestTemplateResolverRefusalAndValueBranches(t *testing.T) {
	context := testTemplateContext()
	resolve := context.resolve
	for _, value := range []any{
		map[string]any{"Ref": "AWS::Region"},
		map[string]any{"Ref": "AWS::Partition"},
		map[string]any{"Ref": "AWS::AccountId"},
		map[string]any{"Ref": "AWS::NoValue"},
		map[string]any{"Ref": "Missing"},
		map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
		map[string]any{"Fn::If": []any{"IsProd"}},
		map[string]any{"Fn::FindInMap": []any{"Sizes", "missing", "x"}},
		map[string]any{"Fn::FindInMap": []any{"Sizes", "small", "missing"}},
		map[string]any{"Fn::FindInMap": []any{"Sizes", true, "x"}},
		map[string]any{"Fn::Join": []any{"", "x"}},
		map[string]any{"Fn::Join": []any{true, []any{}}},
		map[string]any{"Fn::Join": []any{"", []any{map[string]any{"Ref": "NoDefault"}}}},
		map[string]any{"Fn::Sub": "x"},
		map[string]any{"Condition": "IsProd"},
		map[string]any{"Condition": 1},
	} {
		resolved, err := resolve(value)
		if err != nil && resolved != nil {
			t.Fatalf("expression %v returned both a value and an error", value)
		}
	}
	if _, err := context.refValue("NoDefault"); err == nil {
		t.Fatal("a parameter without a default resolved")
	}
	if _, err := context.conditionValue(map[string]any{"Fn::And": []any{}}); err == nil {
		t.Fatal("an empty Fn::And resolved")
	}
	if _, err := context.conditionValue(map[string]any{"Fn::Not": []any{}}); err == nil {
		t.Fatal("an empty Fn::Not resolved")
	}
	if _, err := context.conditionValue(map[string]any{"Fn::Contains": []any{true, "x"}}); err == nil {
		t.Fatal("Fn::Contains with a non-list resolved")
	}
	if _, err := context.conditionValue(map[string]any{"Condition": 1}); err == nil {
		t.Fatal("a non-string Condition resolved")
	}
	if !asUnresolved(fmt.Errorf("wrapped: %w", &unresolvedTemplateError{Name: "X"}), new(*unresolvedTemplateError)) {
		t.Fatal("a wrapped unresolved error was not recognized")
	}
	if !templateEquals(float64(1), "1") || !templateEquals(true, true) {
		t.Fatal("templateEquals did not compare normalized values")
	}
	if (&unresolvedTemplateError{Name: "X"}).Error() != "X cannot be resolved before the stack is deployed" {
		t.Fatal("the unresolved error message changed shape")
	}
	if _, err := templateInt(map[string]any{}); err == nil {
		t.Fatal("a map became an integer")
	}
	if name := intrinsicName(map[string]any{}); !strings.Contains(name, "empty") {
		t.Fatalf("empty intrinsicName = %q", name)
	}
}

func TestTemplateResolverRejectsMalformedExpressions(t *testing.T) {
	context := testTemplateContext()
	if _, _, _, err := resolveTemplateInt(json.RawMessage(`"not-a-number"`), context, 128); err == nil || !strings.Contains(err.Error(), "not an integer") {
		t.Fatalf("a non-integer literal = %v", err)
	}
	if _, _, _, err := resolveTemplateInt(json.RawMessage(`{`), context, 128); err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("malformed JSON = %v", err)
	}
	if _, _, _, err := resolveTemplateInt(json.RawMessage(`{"Ref":1}`), context, 128); err == nil || !strings.Contains(err.Error(), "ref must name") {
		t.Fatalf("a non-string Ref = %v", err)
	}
	if _, _, _, err := resolveTemplateInt(json.RawMessage(`{"Fn::If":["IsProd","x",1]}`), context, 128); err == nil || !strings.Contains(err.Error(), "integer") {
		t.Fatalf("a non-integer branch = %v", err)
	}
	for _, value := range []any{
		map[string]any{"Ref": 1},
		map[string]any{"Ref": ""},
		map[string]any{"Fn::GetAtt": "x"},
		map[string]any{"Fn::If": "x"},
		map[string]any{"Fn::FindInMap": "x"},
		map[string]any{"Fn::Join": "x"},
		map[string]any{"Condition": "Missing"},
		make(chan int),
	} {
		if _, err := context.resolve(value); err == nil {
			t.Fatalf("malformed expression %v resolved", value)
		}
	}
	if id, attr, err := parseGetAtt([]any{"Fn", "Arn"}); err != nil || id != "Fn" || attr != "Arn" {
		t.Fatalf("parseGetAtt = %q/%q %v", id, attr, err)
	}
	for _, value := range []any{"x", []any{"Fn"}, []any{"Fn", "Arn", "x"}, []any{1, "Arn"}} {
		if _, _, err := parseGetAtt(value); err == nil {
			t.Fatalf("malformed GetAtt %v resolved", value)
		}
	}
}

func TestConditionValueRejectsMalformedForms(t *testing.T) {
	context := testTemplateContext()
	value, err := context.conditionValue(true)
	if err != nil || !value {
		t.Fatalf("a boolean condition = %v, %v", value, err)
	}
	cases := []any{
		"not-an-object",
		map[string]any{"Fn::Equals": []any{"only-one"}},
		map[string]any{"Fn::Equals": []any{map[string]any{"Fn::GetAtt": []any{"A", "B"}}, "x"}},
		map[string]any{"Fn::Equals": []any{"x", map[string]any{"Ref": "NoDefault"}}},
		map[string]any{"Fn::And": []any{}},
		map[string]any{"Fn::Or": []any{}},
		map[string]any{"Fn::And": []any{map[string]any{"Fn::Equals": []any{map[string]any{"Ref": "NoDefault"}, "x"}}}},
		map[string]any{"Fn::Not": []any{map[string]any{"Fn::Equals": []any{map[string]any{"Ref": "NoDefault"}, "x"}}}},
		map[string]any{"Fn::Contains": []any{"only-one"}},
		map[string]any{"Fn::Contains": []any{map[string]any{"Ref": "NoDefault"}, "x"}},
		map[string]any{"Fn::Contains": []any{[]any{"x"}, map[string]any{"Ref": "NoDefault"}}},
		map[string]any{"Fn::Sub": "${x}"},
	}
	for _, value := range cases {
		if _, err := context.conditionValue(value); err == nil {
			t.Fatalf("condition %v resolved", value)
		}
	}
	if templateEquals(map[string]any{"a": 1}, map[string]any{"a": 1}) != true {
		t.Fatal("equal maps compared unequal")
	}
	if templateEquals(map[string]any{"a": 1}, map[string]any{"a": 2}) != false {
		t.Fatal("different maps compared equal")
	}
}
