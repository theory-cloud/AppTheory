package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEventFilterPatternValidationEdges(t *testing.T) {
	number := func(value string) json.Number { return json.Number(value) }
	cases := []struct {
		name    string
		pattern map[string]any
	}{
		{"scalar field", map[string]any{"a": "scalar"}},
		{"empty rule list", map[string]any{"a": []any{}}},
		{"list rule", map[string]any{"a": []any{[]any{"x"}}}},
		{"bad scalar rule", map[string]any{"a": []any{1.5}}},
		{"or not list", map[string]any{"$or": "x"}},
		{"or empty", map[string]any{"$or": []any{}}},
		{"or scalar alternative", map[string]any{"$or": []any{"x"}}},
		{"operator arity", map[string]any{"a": []any{map[string]any{"prefix": "x", "suffix": "y"}}}},
		{"prefix not string", map[string]any{"a": []any{map[string]any{"prefix": 1}}}},
		{"exists not bool", map[string]any{"a": []any{map[string]any{"exists": "yes"}}}},
		{"unknown operator", map[string]any{"a": []any{map[string]any{"matches": "x"}}}},
		{"numeric not list", map[string]any{"a": []any{map[string]any{"numeric": 1}}}},
		{"numeric empty", map[string]any{"a": []any{map[string]any{"numeric": []any{}}}}},
		{"numeric bad operator", map[string]any{"a": []any{map[string]any{"numeric": []any{"!=", number("1")}}}}},
		{"numeric bad arity", map[string]any{"a": []any{map[string]any{"numeric": []any{"=", number("1"), number("2")}}}}},
		{"numeric range bad arity", map[string]any{"a": []any{map[string]any{"numeric": []any{">", number("1"), number("2")}}}}},
		{"numeric bound", map[string]any{"a": []any{map[string]any{"numeric": []any{"=", "one"}}}}},
		{"numeric overflow", map[string]any{"a": []any{map[string]any{"numeric": []any{"=", number("1e999999")}}}}},
		{"numeric range end", map[string]any{"a": []any{map[string]any{"numeric": []any{">", number("1"), "=", number("2")}}}}},
		{"anything-but arity", map[string]any{"a": []any{map[string]any{"anything-but": map[string]any{"prefix": "x", "suffix": "y"}}}}},
		{"anything-but equals-ignore-case", map[string]any{"a": []any{map[string]any{"anything-but": map[string]any{"equals-ignore-case": "x"}}}}},
		{"anything-but unknown", map[string]any{"a": []any{map[string]any{"anything-but": map[string]any{"numeric": "x"}}}}},
		{"anything-but empty", map[string]any{"a": []any{map[string]any{"anything-but": []any{}}}}},
		{"anything-but mixed", map[string]any{"a": []any{map[string]any{"anything-but": []any{"x", number("1")}}}}},
		{"anything-but bad item", map[string]any{"a": []any{map[string]any{"anything-but": []any{true}}}}},
		{"anything-but scalar type", map[string]any{"a": []any{map[string]any{"anything-but": 1.5}}}},
		{"prefix list empty", map[string]any{"a": []any{map[string]any{"prefix": []any{}}}}},
		{"prefix list item", map[string]any{"a": []any{map[string]any{"prefix": []any{1}}}}},
	}
	for _, testCase := range cases {
		if err := validateEventFilterPattern(testCase.pattern); err == nil {
			t.Errorf("%s: the pattern must be refused", testCase.name)
		}
	}
	valid := []map[string]any{
		{"$or": []any{map[string]any{"a": []any{"x"}}, map[string]any{"b": []any{"y"}}}},
		{"a": []any{map[string]any{"numeric": []any{">", number("1"), "<=", number("2")}}}},
		{"a": []any{map[string]any{"anything-but": "x"}}},
		{"a": []any{map[string]any{"anything-but": []any{number("1")}}}},
		{"a": []any{map[string]any{"anything-but": map[string]any{"prefix": []any{"x"}}}}},
		{"a": []any{map[string]any{"anything-but": map[string]any{"suffix": "x"}}}},
		{"a": []any{map[string]any{"exists": true}}},
		{"a": []any{map[string]any{"equals-ignore-case": "x"}}},
	}
	for index, pattern := range valid {
		if err := validateEventFilterPattern(pattern); err != nil {
			t.Errorf("valid pattern %d: %v", index, err)
		}
	}
}

func TestFilterCriteriaDecodingEdges(t *testing.T) {
	if _, err := decodeEventFilterPatterns(json.RawMessage(`{"Filters":`)); err == nil {
		t.Fatal("invalid JSON must fail")
	}
	if patterns, err := decodeEventFilterPatterns(json.RawMessage(`{"Filters":[]}`)); err != nil || len(patterns) != 0 {
		t.Fatalf("empty filters: %v %d", err, len(patterns))
	}
	if _, err := decodeEventFilterPatterns(json.RawMessage(`{"Filters":[{"Pattern":"{"}]}`)); err == nil {
		t.Fatal("an invalid pattern must fail")
	}
	if _, err := decodeEventFilterPatterns(json.RawMessage(`{"Filters":[{"Pattern":"42"}]}`)); err == nil {
		t.Fatal("a non-object pattern must fail")
	}
	if _, err := decodeEventFilterPatterns(json.RawMessage(`{"Filters":[{"Pattern":"{\"a\":\"scalar\"}"}]}`)); err == nil {
		t.Fatal("an invalid filter pattern must fail")
	}
	if _, err := decodePatternValue([]byte(`{} {}`)); err == nil {
		t.Fatal("trailing content must fail")
	}
	if matched, err := sqsRecordMatchesFilters(nil, map[string]any{"a": "x"}, "body"); err != nil || !matched {
		t.Fatalf("empty criteria: %v %v", matched, err)
	}
	if matched, err := recordMatchesEventFilters(json.RawMessage("  "), map[string]any{}); err != nil || !matched {
		t.Fatalf("blank criteria: %v %v", matched, err)
	}
	criteria := json.RawMessage(`{"Filters":[{"Pattern":"{\"a\":[{\"prefix\":\"x\"}]}"}]}`)
	if matched, err := sqsRecordMatchesFilters(criteria, map[string]any{"a": "xyz"}, "body"); err != nil || !matched {
		t.Fatalf("prefix match: %v %v", matched, err)
	}
	if matched, err := sqsRecordMatchesFilters(criteria, map[string]any{"a": 1}, "body"); err != nil || matched {
		t.Fatalf("non-string prefix: %v %v", matched, err)
	}
}

func TestEventPatternMatcherEdges(t *testing.T) {
	number := json.Number("1")
	if eventPatternMatches("scalar", map[string]any{}) {
		t.Fatal("a non-object pattern cannot match")
	}
	if matchPatternObject(map[string]any{"a": []any{"x"}}, []any{}) {
		t.Fatal("an empty event array cannot match")
	}
	if matchPatternObject(map[string]any{"a": []any{"x"}}, "scalar") {
		t.Fatal("a scalar event cannot match an object pattern")
	}
	if matchPatternObject(map[string]any{"$or": "not-a-list"}, map[string]any{}) {
		t.Fatal("a malformed $or cannot match")
	}
	if !matchPatternObject(map[string]any{"$or": []any{map[string]any{"a": []any{"x"}}}}, map[string]any{"a": "x"}) {
		t.Fatal("a matching $or alternative must match")
	}
	if !matchPatternValue(nil, nil, false) {
		t.Fatal("an absent null field matches")
	}
	if matchPatternValue(nil, "x", true) {
		t.Fatal("a present non-null field does not match null")
	}
	if matchRuleList(nil, "x", true) {
		t.Fatal("an empty rule list cannot match")
	}
	if !matchRuleList([]any{map[string]any{"prefix": "x"}}, []any{"xyz"}, true) {
		t.Fatal("a rule must match one array element")
	}
	if !matchFilterRule([]any{map[string]any{"prefix": "x"}}, "xyz", true) {
		t.Fatal("a nested rule list must match")
	}
	if matchFilterRule(map[string]any{"unknown": "x"}, "x", true) {
		t.Fatal("an unknown operator must not match")
	}
	if _, ok := filterOperator(map[string]any{"prefix": "x", "suffix": "y"}); ok {
		t.Fatal("an operator object must have one key")
	}
	if matchFilterOperator("unknown", nil, "x", true) {
		t.Fatal("an unknown operator must not match")
	}
	if matchFilterOperator(filterOperatorExists, map[string]any{"exists": "yes"}, "x", true) {
		t.Fatal("a non-boolean exists must not match")
	}
	if matchFilterOperator(filterOperatorExists, map[string]any{"exists": true}, "x", false) {
		t.Fatal("exists true on an absent field must not match")
	}
	if matchFilterOperator(filterOperatorExists, map[string]any{"exists": true}, map[string]any{"a": 1}, true) {
		t.Fatal("exists does not match an intermediate node")
	}
	if matchFilterOperator(filterOperatorPrefix, map[string]any{"prefix": "x"}, 1, true) {
		t.Fatal("prefix needs a string value")
	}
	if matchFilterOperator(filterOperatorEqualsIgnoreCase, map[string]any{"equals-ignore-case": "X"}, "x", true) != true {
		t.Fatal("equals-ignore-case must match")
	}
	if matchAnythingBut([]any{"a"}, "b", true) {
		t.Fatal("anything-but must not match a listed value")
	}
	if matchAnythingBut(map[string]any{"prefix": "a", "suffix": "b"}, "x", true) {
		t.Fatal("anything-but needs one operator")
	}
	if matchAnythingBut(map[string]any{"unknown": "a"}, "x", true) {
		t.Fatal("an unknown anything-but operator must not match")
	}
	if matchAnythingBut("a", "b", true) {
		t.Fatal("anything-but scalar mismatch")
	}
	if !matchAnythingBut("a", "a", true) {
		t.Fatal("anything-but scalar match")
	}
	if matchAnythingButString("a", "x", false, strings.HasPrefix) {
		t.Fatal("an absent field cannot match an exclusion")
	}
	if matchAnythingButString("a", 1, true, strings.HasPrefix) {
		t.Fatal("a non-string field cannot match an exclusion")
	}
	if !matchAnythingButString([]any{"x", 1}, "xyz", true, strings.HasPrefix) {
		t.Fatal("an exclusion list must match one string")
	}
	if matchAnythingButString(1, "xyz", true, strings.HasPrefix) {
		t.Fatal("an invalid exclusion must not match")
	}
	if matchNumeric("x", number, true) {
		t.Fatal("a non-list numeric value cannot match")
	}
	if matchNumeric([]any{}, number, true) {
		t.Fatal("an empty numeric list cannot match")
	}
	if matchNumeric([]any{"="}, number, true) {
		t.Fatal("an odd numeric list cannot match")
	}
	if matchNumeric([]any{"=", number}, number, false) {
		t.Fatal("an absent numeric field cannot match")
	}
	if matchNumeric([]any{"=", number}, "x", true) {
		t.Fatal("a non-numeric field cannot match")
	}
	if matchNumeric([]any{1, number}, number, true) {
		t.Fatal("a non-string operator cannot match")
	}
	if matchNumeric([]any{"=", "x"}, number, true) {
		t.Fatal("a non-numeric bound cannot match")
	}
	if matchNumeric([]any{"=", json.Number("2")}, number, true) {
		t.Fatal("a mismatched bound cannot match")
	}
	if !matchNumeric([]any{">=", json.Number("1"), "<", json.Number("2")}, number, true) {
		t.Fatal("a range must match")
	}
	if numericComparison("!=", 1, 1) {
		t.Fatal("an unknown comparison cannot match")
	}
	if value, ok := numericValue(1.5); !ok || value != 1.5 {
		t.Fatal("float numeric value")
	}
	if value, ok := numericValue(2); !ok || value != 2 {
		t.Fatal("int numeric value")
	}
	if _, ok := numericValue("x"); ok {
		t.Fatal("a string is not numeric")
	}
	if !scalarPatternEqual(true, true) || scalarPatternEqual(true, "true") {
		t.Fatal("boolean scalar equality")
	}
	if !scalarPatternEqual(json.Number("1"), json.Number("1")) || scalarPatternEqual(json.Number("1"), json.Number("1.0")) {
		t.Fatal("number scalar equality is by representation")
	}
	if !scalarPatternEqual(1.0, 1.0) || !scalarPatternEqual(1, 1) {
		t.Fatal("float and int scalar equality")
	}
	if scalarPatternEqual([]any{}, 1) {
		t.Fatal("an unsupported pattern scalar cannot match")
	}
}

func TestCloudWatchFilterEdges(t *testing.T) {
	invalid := []string{
		`?`, `-`, `%regex%`, `[abc]`, `*`, `"unterminated`,
		`{`, `{}`, `{"a":1}`,
		`{$. = 1}`, `{$.a}`, `{$.a = }`, `{$.a = "unterminated}`,
		`{$.a[0] = 1}`, `{$.a.* = 1}`, `{$.a..b = 1}`, `{$.a = 1 2}`,
		`{($.a = 1}`, `{$.a = 1} trailing`, `{$.a = "x" "y"}`,
	}
	for _, pattern := range invalid {
		if err := validateCloudWatchFilterPattern(pattern); err == nil {
			t.Errorf("pattern %q must be refused", pattern)
		}
	}
	matches := []struct {
		pattern string
		message string
		want    bool
	}{
		{``, "anything", true},
		{`order`, "an order shipped", true},
		{`order -cancel`, "an order shipped", true},
		{`order -cancel`, "an order canceled", false},
		{`?warn ?error`, "a warn line", true},
		{`?warn ?error`, "nothing", false},
		{`"order shipped"`, "an order shipped today", true},
		{`order shipped`, "an order shipped today", true},
		{`{$.a = "x" || $.b = "y"}`, `{"b":"y"}`, true},
		{`{$.a = "x" && $.b = "y"}`, `{"a":"x","b":"y"}`, true},
		{`{$.event = "order"}`, `{"event":"order"}`, true},
		{`{$.event != "order"}`, `{"event":"refund"}`, true},
		{`{$.count = 2}`, `{"count":2}`, true},
		{`{$.ok = true}`, `{"ok":true}`, true},
		{`{$.missing != null}`, `{}`, true},
		{`{$.a.b = "x"}`, `{"a":{"b":"x"}}`, true},
	}
	for _, testCase := range matches {
		matched, err := cloudWatchFilterMatches(testCase.pattern, testCase.message)
		if err != nil || matched != testCase.want {
			t.Errorf("pattern %q against %q: matched=%v want=%v err=%v", testCase.pattern, testCase.message, matched, testCase.want, err)
		}
	}
	if matched, err := cloudWatchFilterMatches(`{$.event = "order"}`, "not-json"); err != nil || matched {
		t.Fatalf("a non-JSON message cannot match a JSON pattern: %v %v", matched, err)
	}
	if matched, err := cloudWatchFilterMatches(`?warn ?error`, "nothing"); err != nil || matched {
		t.Fatalf("the any-term pattern must not match: %v %v", matched, err)
	}
	if matched, err := cloudWatchFilterMatches(`order -cancel`, "an order canceled"); err != nil || matched {
		t.Fatalf("the exclusion must not match: %v %v", matched, err)
	}
	if _, err := parseCloudWatchTermPattern(`"unterminated`); err == nil {
		t.Fatal("an unterminated quote must fail")
	}
	if _, err := splitCloudWatchTerms(`   `); err == nil {
		t.Fatal("an empty pattern must fail")
	}
	if _, err := parseCloudWatchJSONPattern(`{}`); err == nil {
		t.Fatal("an empty JSON pattern must fail")
	}
	if _, err := parseCloudWatchJSONValue(`"bad`); err == nil {
		t.Fatal("an invalid quoted value must fail")
	}
	if _, err := parseCloudWatchJSONValue(`two terms`); err == nil {
		t.Fatal("a spaced bare value must fail")
	}
	if value, err := parseCloudWatchJSONValue(`null`); err != nil || value != nil {
		t.Fatalf("null value: %v %v", value, err)
	}
	if value, err := parseCloudWatchJSONValue(`false`); err != nil || value != false {
		t.Fatalf("false value: %v %v", value, err)
	}
	if _, ok := lookupCloudWatchPath("scalar", []string{"a"}); ok {
		t.Fatal("a scalar document has no path")
	}
	if _, ok := lookupCloudWatchPath(map[string]any{}, []string{"a"}); ok {
		t.Fatal("a missing field has no value")
	}
	if !cloudWatchJSONEqual(json.Number("1"), float64(1)) || cloudWatchJSONEqual(json.Number("1"), 2.0) {
		t.Fatal("a numeric pattern must compare to a float document")
	}
	if !cloudWatchJSONEqual("x", "x") || cloudWatchJSONEqual("x", 1) {
		t.Fatal("string equality")
	}
	if !cloudWatchJSONEqual(true, true) || cloudWatchJSONEqual(true, "true") {
		t.Fatal("boolean equality")
	}
	if !cloudWatchJSONEqual(nil, nil) || cloudWatchJSONEqual(nil, 1) {
		t.Fatal("null equality")
	}
	if cloudWatchJSONEqual([]any{}, []any{}) {
		t.Fatal("an unsupported pattern value cannot match")
	}
	if _, err := gzipJSON(func() {}); err == nil {
		t.Fatal("an unmarshalable payload must fail")
	}
}
