package localrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func deriveAssemblyAllowNoSurface(t *testing.T, dir string) (*Spec, error) {
	t.Helper()
	stacks, err := loadAssembly(dir)
	if err != nil {
		t.Fatalf("load assembly: %v", err)
	}
	return deriveSpecInternal(dir, stacks)
}

func snsDeriveResources(topicProperties map[string]any, subscriptionProperties map[string]any) map[string]any {
	resources := map[string]any{
		"Fn":    withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Topic": map[string]any{"Type": typeSNSTopic, "Properties": topicProperties},
		"Sub": map[string]any{
			"Type":       typeSNSSubscription,
			"Properties": subscriptionProperties,
		},
	}
	return resources
}

func TestDeriveSNSSubscriptionRegistersValidPolicy(t *testing.T) {
	resources := snsDeriveResources(
		map[string]any{"TopicName": "events"},
		map[string]any{
			"TopicArn": map[string]any{"Ref": "Topic"},
			"Protocol": "lambda",
			"Endpoint": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			"FilterPolicy": map[string]any{
				"eventType": []any{"keep"},
				"priority":  []any{map[string]any{"numeric": []any{">=", 10}}},
			},
		},
	)
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %+v", spec.Subscriptions)
	}
	subscription := spec.Subscriptions[0]
	if subscription.Protocol != "lambda" || subscription.Function != "Fn" {
		t.Fatalf("subscription = %+v", subscription)
	}
	if subscription.FilterPolicyScope != snsFilterScopeAttributes {
		t.Fatalf("scope = %q", subscription.FilterPolicyScope)
	}
	if !strings.Contains(string(subscription.FilterPolicy), `"numeric":[">=",10]`) {
		t.Fatalf("policy was not compacted: %s", subscription.FilterPolicy)
	}
}

func TestDeriveSNSSkipsFIFOCustomerManagedTargets(t *testing.T) {
	cases := map[string]map[string]any{
		"lambda": {
			"TopicArn": map[string]any{"Ref": "Topic"},
			"Protocol": "lambda",
			"Endpoint": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
		},
		"http": {
			"TopicArn": map[string]any{"Ref": "Topic"},
			"Protocol": "http",
			"Endpoint": "http://127.0.0.1:18120/",
		},
	}
	for name, subscription := range cases {
		t.Run(name, func(t *testing.T) {
			resources := snsDeriveResources(
				map[string]any{"TopicName": "events.fifo", "FifoTopic": true},
				subscription,
			)
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			spec, err := deriveAssemblyAllowNoSurface(t, dir)
			if err != nil {
				t.Fatalf("derive: %v", err)
			}
			if len(spec.Subscriptions) != 0 {
				t.Fatalf("FIFO %s subscription was registered: %+v", name, spec.Subscriptions)
			}
			reasons := map[string]string{}
			for _, skipped := range spec.Skipped {
				reasons[skipped.LogicalID] = skipped.Reason
			}
			if !strings.Contains(reasons["Sub"], "FIFO topics cannot deliver") {
				t.Fatalf("reason = %q", reasons["Sub"])
			}
		})
	}
}

func TestDeriveSNSSkipsNonLoopbackHTTP(t *testing.T) {
	resources := snsDeriveResources(
		map[string]any{"TopicName": "events"},
		map[string]any{
			"TopicArn": map[string]any{"Ref": "Topic"},
			"Protocol": "https",
			"Endpoint": "https://example.com/hook",
		},
	)
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Subscriptions) != 0 {
		t.Fatalf("non-loopback HTTP subscription was registered: %+v", spec.Subscriptions)
	}
	reasons := map[string]string{}
	for _, skipped := range spec.Skipped {
		reasons[skipped.LogicalID] = skipped.Reason
	}
	if !strings.Contains(reasons["Sub"], "not a loopback") {
		t.Fatalf("skipped = %+v", spec.Skipped)
	}
}

func TestDeriveSNSRefusesPolicyItCannotApply(t *testing.T) {
	cases := map[string]map[string]any{
		"or": {
			"$or": []any{map[string]any{"kind": []any{"order"}}},
		},
		"cidr": {
			"ip": []any{map[string]any{"cidr": "10.0.0.0/8"}},
		},
		"nested attribute": {
			"kind": map[string]any{"nested": []any{"x"}},
		},
	}
	for name, policy := range cases {
		t.Run(name, func(t *testing.T) {
			resources := snsDeriveResources(
				map[string]any{"TopicName": "events"},
				map[string]any{
					"TopicArn":     map[string]any{"Ref": "Topic"},
					"Protocol":     "lambda",
					"Endpoint":     map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"FilterPolicy": policy,
				},
			)
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			if err == nil {
				t.Fatalf("policy %v must be refused at derive time", policy)
			}
			var unsupportedErr *UnsupportedError
			if !errors.As(err, &unsupportedErr) {
				t.Fatalf("want a named unsupported error, got %T: %v", err, err)
			}
			if unsupportedErr.Construct != "Sub" {
				t.Fatalf("refusal names %q", unsupportedErr.Construct)
			}
		})
	}
}

func TestDeriveSNSSQSToFIFOTopicRegisters(t *testing.T) {
	resources := snsDeriveResources(
		map[string]any{"TopicName": "events.fifo", "FifoTopic": true, "ContentBasedDeduplication": true},
		map[string]any{
			"TopicArn":           map[string]any{"Ref": "Topic"},
			"Protocol":           "sqs",
			"Endpoint":           map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
			"RawMessageDelivery": true,
		},
	)
	resources["Queue"] = map[string]any{
		"Type":       typeSQSQueue,
		"Properties": map[string]any{"QueueName": "events.fifo", "FifoQueue": true},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %+v", spec.Subscriptions)
	}
	subscription := spec.Subscriptions[0]
	if subscription.Protocol != "sqs" || subscription.Queue != "Queue" || !subscription.RawMessageDelivery {
		t.Fatalf("subscription = %+v", subscription)
	}
}

// TestSNSFilterOrOperatorStandardExample pins AWS's standard OR example:
// {"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization"]},
// {"namespace":["AWS/EC2"]}]} has the logic
// "source" && ("metricName" || "namespace").
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrOperatorStandardExample(t *testing.T) {
	policy := `{"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization"]},{"namespace":["AWS/EC2"]}]}`
	cases := []struct {
		name       string
		scope      string
		body       string
		attributes map[string]snsMessageAttribute
		want       bool
	}{
		{
			name:  "attribute scope matches the metricName branch",
			scope: snsFilterScopeAttributes,
			attributes: map[string]snsMessageAttribute{
				"source":     snsTestAttribute("String", "aws.cloudwatch"),
				"metricName": snsTestAttribute("String", "CPUUtilization"),
			},
			want: true,
		},
		{
			name:  "attribute scope matches the namespace branch",
			scope: snsFilterScopeAttributes,
			attributes: map[string]snsMessageAttribute{
				"source":    snsTestAttribute("String", "aws.cloudwatch"),
				"namespace": snsTestAttribute("String", "AWS/EC2"),
			},
			want: true,
		},
		{
			name:  "attribute scope rejects source alone",
			scope: snsFilterScopeAttributes,
			attributes: map[string]snsMessageAttribute{
				"source": snsTestAttribute("String", "aws.cloudwatch"),
			},
			want: false,
		},
		{
			name:  "attribute scope rejects a branch without the sibling key",
			scope: snsFilterScopeAttributes,
			attributes: map[string]snsMessageAttribute{
				"metricName": snsTestAttribute("String", "CPUUtilization"),
			},
			want: false,
		},
		{
			name:  "body scope matches the metricName branch",
			scope: snsFilterScopeBody,
			body:  `{"source":"aws.cloudwatch","metricName":"CPUUtilization"}`,
			want:  true,
		},
		{
			name:  "body scope matches the namespace branch",
			scope: snsFilterScopeBody,
			body:  `{"source":"aws.cloudwatch","namespace":"AWS/EC2"}`,
			want:  true,
		},
		{
			name:  "body scope rejects source alone",
			scope: snsFilterScopeBody,
			body:  `{"source":"aws.cloudwatch"}`,
			want:  false,
		},
		{
			name:  "body scope rejects an unmatched branch value",
			scope: snsFilterScopeBody,
			body:  `{"source":"aws.cloudwatch","metricName":"ReadLatency"}`,
			want:  false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, policy, testCase.scope)
			matched, err := snsMessageMatchesFilter(normalized, testCase.scope, snsTestMessage(testCase.body, testCase.attributes))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}
}

// TestSNSFilterOrOperatorNestedExample pins both nested forms AWS documents:
// an `$or` inside a branch of another `$or`, and an `$or` inside a nested body
// key. The expected logic is the simplified logic AWS prints for each policy.
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrOperatorNestedExample(t *testing.T) {
	nestedBodyPolicy := `{"$or":[{"metricName":["CPUUtilization","ReadLatency"]},{"namespace":["AWS/EC2","AWS/ES"]}],"detail":{"scope":["Service"],"$or":[{"source":["aws.cloudwatch"]},{"type":["CloudWatch Alarm State Change"]}]}}`
	bodyCases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "metricName with scope and source",
			body: `{"metricName":"CPUUtilization","detail":{"scope":"Service","source":"aws.cloudwatch"}}`,
			want: true,
		},
		{
			name: "ReadLatency with scope and type",
			body: `{"metricName":"ReadLatency","detail":{"scope":"Service","type":"CloudWatch Alarm State Change"}}`,
			want: true,
		},
		{
			name: "namespace with scope and source",
			body: `{"namespace":"AWS/ES","detail":{"scope":"Service","source":"aws.cloudwatch"}}`,
			want: true,
		},
		{
			name: "AWS/ES with scope and type",
			body: `{"namespace":"AWS/ES","detail":{"scope":"Service","type":"CloudWatch Alarm State Change"}}`,
			want: true,
		},
		{
			name: "nested scope without source or type",
			body: `{"metricName":"CPUUtilization","detail":{"scope":"Service"}}`,
			want: false,
		},
		{
			name: "nested source without scope",
			body: `{"metricName":"CPUUtilization","detail":{"source":"aws.cloudwatch"}}`,
			want: false,
		},
		{
			name: "no top-level branch matches",
			body: `{"other":"x","detail":{"scope":"Service","source":"aws.cloudwatch"}}`,
			want: false,
		},
	}
	for _, testCase := range bodyCases {
		t.Run("nested body key: "+testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, nestedBodyPolicy, snsFilterScopeBody)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeBody, snsTestMessage(testCase.body, nil))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}

	// ("source" && "metricName") OR ("source" && "metricType" && "metricId")
	// OR ("source" && "metricType" && "spaceId")
	nestedOrPolicy := `{"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization","ReadLatency"]},{"metricType":["MetricType"],"$or":[{"metricId":[1234,4321]},{"spaceId":[1000,2000,3000]}]}]}`
	attributeCases := []struct {
		name       string
		attributes map[string]snsMessageAttribute
		want       bool
	}{
		{
			name: "source and metricName",
			attributes: map[string]snsMessageAttribute{
				"source":     snsTestAttribute("String", "aws.cloudwatch"),
				"metricName": snsTestAttribute("String", "ReadLatency"),
			},
			want: true,
		},
		{
			name: "source, metricType and metricId",
			attributes: map[string]snsMessageAttribute{
				"source":     snsTestAttribute("String", "aws.cloudwatch"),
				"metricType": snsTestAttribute("String", "MetricType"),
				"metricId":   snsTestAttribute("Number", "4321"),
			},
			want: true,
		},
		{
			name: "source, metricType and spaceId",
			attributes: map[string]snsMessageAttribute{
				"source":     snsTestAttribute("String", "aws.cloudwatch"),
				"metricType": snsTestAttribute("String", "MetricType"),
				"spaceId":    snsTestAttribute("Number", "2000"),
			},
			want: true,
		},
		{
			name: "source alone",
			attributes: map[string]snsMessageAttribute{
				"source": snsTestAttribute("String", "aws.cloudwatch"),
			},
			want: false,
		},
		{
			name: "source and metricType without the nested branch",
			attributes: map[string]snsMessageAttribute{
				"source":     snsTestAttribute("String", "aws.cloudwatch"),
				"metricType": snsTestAttribute("String", "MetricType"),
			},
			want: false,
		},
		{
			name: "source and metricId without metricType",
			attributes: map[string]snsMessageAttribute{
				"source":   snsTestAttribute("String", "aws.cloudwatch"),
				"metricId": snsTestAttribute("Number", "1234"),
			},
			want: false,
		},
	}
	for _, testCase := range attributeCases {
		t.Run("nested or: "+testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, nestedOrPolicy, snsFilterScopeAttributes)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeAttributes, snsTestMessage("", testCase.attributes))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}
}

// TestSNSFilterOrOneObjectIsAnAttributeName pins the second AWS condition: the
// `$or` array must hold at least two objects, otherwise `$or` is an ordinary
// attribute name.
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrOneObjectIsAnAttributeName(t *testing.T) {
	policy := `{"$or":[{"exists":true}]}`
	matched, err := snsMessageMatchesFilter(
		normalizeTestPolicy(t, policy, snsFilterScopeAttributes),
		snsFilterScopeAttributes,
		snsTestMessage("", map[string]snsMessageAttribute{"$or": snsTestAttribute("String", "anything")}),
	)
	if err != nil || !matched {
		t.Fatalf("an attribute named $or must satisfy the one-object fallback: matched=%v err=%v", matched, err)
	}
	matched, err = snsMessageMatchesFilter(
		normalizeTestPolicy(t, policy, snsFilterScopeAttributes),
		snsFilterScopeAttributes,
		snsTestMessage("", map[string]snsMessageAttribute{"metricName": snsTestAttribute("String", "CPUUtilization")}),
	)
	if err != nil || matched {
		t.Fatalf("a policy keyed by $or must not match another attribute: matched=%v err=%v", matched, err)
	}

	literal := `{"$or":["literal"]}`
	matched, err = snsMessageMatchesFilter(
		normalizeTestPolicy(t, literal, snsFilterScopeAttributes),
		snsFilterScopeAttributes,
		snsTestMessage("", map[string]snsMessageAttribute{"$or": snsTestAttribute("String", "literal")}),
	)
	if err != nil || !matched {
		t.Fatalf("an array without objects must be an attribute name: matched=%v err=%v", matched, err)
	}
	matched, err = snsMessageMatchesFilter(
		normalizeTestPolicy(t, `{"$or":[{"exists":true}]}`, snsFilterScopeBody),
		snsFilterScopeBody,
		snsTestMessage(`{"$or":"present"}`, nil),
	)
	if err != nil || !matched {
		t.Fatalf("body scope must match a property named $or: matched=%v err=%v", matched, err)
	}
}

// TestSNSFilterOrNonArrayIsAnAttributeName pins the first AWS condition: the
// `$or` value must be an array, otherwise `$or` is an ordinary property name.
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrNonArrayIsAnAttributeName(t *testing.T) {
	policy := `{"$or":{"kind":["order"]}}`
	cases := []struct {
		name string
		body string
		want bool
	}{
		{name: "property named $or matches", body: `{"$or":{"kind":"order"}}`, want: true},
		{name: "property value mismatch", body: `{"$or":{"kind":"refund"}}`, want: false},
		{name: "nested kind without $or does not match", body: `{"kind":"order"}`, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, policy, snsFilterScopeBody)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeBody, snsTestMessage(testCase.body, nil))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}

	// Attribute-scope policies cannot nest objects, so the same non-array value
	// is refused by the ordinary key grammar instead of being read as OR.
	if _, err := normalizeSNSFilterPolicy(json.RawMessage(policy), snsFilterScopeAttributes, "Sub"); err == nil {
		t.Fatalf("a nested object must be refused in attribute scope")
	}
}

// TestSNSFilterOrReservedKeywordIsAnAttributeName pins the third AWS condition:
// when a branch object uses a reserved keyword as a field name (AWS names
// numeric and prefix), `$or` is an ordinary attribute name.
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrReservedKeywordIsAnAttributeName(t *testing.T) {
	policy := `{"$or":[{"numeric":["=",123]},{"prefix":"abc"}]}`
	cases := []struct {
		name       string
		attributes map[string]snsMessageAttribute
		want       bool
	}{
		{
			name:       "numeric rule applies to the attribute named $or",
			attributes: map[string]snsMessageAttribute{"$or": snsTestAttribute("Number", "123")},
			want:       true,
		},
		{
			name:       "prefix rule applies to the attribute named $or",
			attributes: map[string]snsMessageAttribute{"$or": snsTestAttribute("String", "abcdef")},
			want:       true,
		},
		{
			name:       "neither rule applies",
			attributes: map[string]snsMessageAttribute{"$or": snsTestAttribute("String", "zzz")},
			want:       false,
		},
		{
			name: "numeric and prefix attributes without $or do not match",
			attributes: map[string]snsMessageAttribute{
				"numeric": snsTestAttribute("Number", "123"),
				"prefix":  snsTestAttribute("String", "abcdef"),
			},
			want: false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, policy, snsFilterScopeAttributes)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeAttributes, snsTestMessage("", testCase.attributes))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}

	bodyCases := []struct {
		name string
		body string
		want bool
	}{
		{name: "body property named $or matches numeric", body: `{"$or":123}`, want: true},
		{name: "body property named $or matches prefix", body: `{"$or":"abcdef"}`, want: true},
		{name: "nested numeric and prefix fields do not match", body: `{"numeric":123,"prefix":"abcdef"}`, want: false},
	}
	for _, testCase := range bodyCases {
		t.Run(testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, policy, snsFilterScopeBody)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeBody, snsTestMessage(testCase.body, nil))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}
}

// TestSNSFilterOrArrayElementsDoNotCombine pins per-element application: an
// `$or` branch is evaluated against one array element, so a multi-field branch
// never combines values from two different elements.
func TestSNSFilterOrArrayElementsDoNotCombine(t *testing.T) {
	policy := `{"items":{"$or":[{"a":["x"],"b":["y"]},{"c":["z"]}]}}`
	cases := []struct {
		name string
		body string
		want bool
	}{
		{name: "fields split across elements do not match", body: `{"items":[{"a":"x"},{"b":"y"}]}`, want: false},
		{name: "one element with both fields matches", body: `{"items":[{"a":"x","b":"y"}]}`, want: true},
		{name: "a later element matches a different branch", body: `{"items":[{"a":"x"},{"c":"z"}]}`, want: true},
		{name: "a single object target matches", body: `{"items":{"a":"x","b":"y"}}`, want: true},
		{name: "no element or branch matches", body: `{"items":[{"a":"x"}]}`, want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			normalized := normalizeTestPolicy(t, policy, snsFilterScopeBody)
			matched, err := snsMessageMatchesFilter(normalized, snsFilterScopeBody, snsTestMessage(testCase.body, nil))
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}
}

// TestSNSFilterOrCombinationComplexity pins the documented complexity:
// the sum of the per-branch products, with a nested body key multiplied by
// its nesting level.
// https://docs.aws.amazon.com/sns/latest/dg/and-or-logic.html
func TestSNSFilterOrCombinationComplexity(t *testing.T) {
	cases := []struct {
		name   string
		policy string
		want   int
	}{
		{
			name:   "or constraints example",
			policy: `{"source":["aws.cloudwatch"],"$or":[{"metricName":["CPUUtilization","ReadLatency"]},{"metricType":["MetricType"],"$or":[{"metricId":[1234,4321]},{"spaceId":[1000,2000,3000]}]}]}`,
			want:   7,
		},
		{
			name:   "nested body example",
			policy: `{"$or":[{"metricName":["CPUUtilization","ReadLatency"]},{"namespace":["AWS/EC2","AWS/ES"]}],"detail":{"scope":["Service"],"$or":[{"source":["aws.cloudwatch"]},{"type":["CloudWatch Alarm State Change"]}]}}`,
			want:   32,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			value, err := decodePatternValue([]byte(testCase.policy))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			pattern, ok := value.(map[string]any)
			if !ok {
				t.Fatalf("policy is not a JSON object")
			}
			if got := snsFilterCombinations(pattern, 1); got != testCase.want {
				t.Fatalf("combinations = %d, want %d", got, testCase.want)
			}
		})
	}
}

// TestSNSFilterPolicyLimits pins the documented 150-combination and 256 KB
// limits, including the sum-of-branches rule for `$or`.
// https://docs.aws.amazon.com/sns/latest/dg/subscription-filter-policy-constraints.html
func TestSNSFilterPolicyLimits(t *testing.T) {
	quoted := func(count int) string {
		values := make([]string, count)
		for index := range values {
			values[index] = fmt.Sprintf("%q", fmt.Sprintf("value-%d", index))
		}
		return strings.Join(values, ",")
	}
	atLimit := fmt.Sprintf(`{"$or":[{"a":[%s]},{"b":["x"]}]}`, quoted(snsFilterPolicyMaximumCombinations-1))
	if _, err := normalizeSNSFilterPolicy(json.RawMessage(atLimit), snsFilterScopeAttributes, "Sub"); err != nil {
		t.Fatalf("a policy at the combination limit must be accepted: %v", err)
	}
	overLimit := fmt.Sprintf(`{"$or":[{"a":[%s]},{"b":["x"]}]}`, quoted(snsFilterPolicyMaximumCombinations))
	if _, err := normalizeSNSFilterPolicy(json.RawMessage(overLimit), snsFilterScopeAttributes, "Sub"); err == nil ||
		!strings.Contains(err.Error(), "value combinations") {
		t.Fatalf("a policy over the combination limit must be refused with the count: %v", err)
	}
	long := strings.Repeat("x", 2048)
	values := make([]string, snsFilterPolicyMaximumCombinations)
	for index := range values {
		values[index] = `"` + long + `"`
	}
	oversized := fmt.Sprintf(`{"a":[%s]}`, strings.Join(values, ","))
	if _, err := normalizeSNSFilterPolicy(json.RawMessage(oversized), snsFilterScopeAttributes, "Sub"); err == nil ||
		!strings.Contains(err.Error(), "bytes") {
		t.Fatalf("a policy over the size limit must be refused: %v", err)
	}
}

func TestSNSFilterCombinationSaturation(t *testing.T) {
	if got := snsFilterMultiply(0, 5); got != 0 {
		t.Fatalf("zero product = %d", got)
	}
	if got := snsFilterMultiply(10, 10); got != 100 {
		t.Fatalf("in-range product = %d", got)
	}
	if got := snsFilterMultiply(20, 20); got != snsFilterPolicyMaximumCombinations+1 {
		t.Fatalf("overflowing product = %d", got)
	}
	if got := snsFilterAdd(10, 20); got != 30 {
		t.Fatalf("in-range sum = %d", got)
	}
	if got := snsFilterAdd(snsFilterPolicyMaximumCombinations, 1); got != snsFilterPolicyMaximumCombinations+1 {
		t.Fatalf("overflowing sum = %d", got)
	}
	if got := snsFilterValueCombinations("scalar", 2); got != 2 {
		t.Fatalf("scalar combinations = %d", got)
	}
	if got := snsFilterValueCombinations(map[string]any{"a": []any{"x"}}, snsFilterPolicyMaximumCombinations); got != snsFilterPolicyMaximumCombinations+1 {
		t.Fatalf("deeply nested combinations = %d", got)
	}
	if branches, ok := snsFilterOrBranches([]any{}); ok || branches != nil {
		t.Fatalf("an empty array must not be the $or operator")
	}
	if _, ok := snsFilterOrBranches([]any{map[string]any{"a": []any{"x"}}, "scalar"}); ok {
		t.Fatalf("an array with a non-object branch must not be the $or operator")
	}
}
