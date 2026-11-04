package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

func deriveTestStack(resources map[string]templateResource) assemblyStack {
	return assemblyStack{Name: "S", Template: template{Resources: resources}}
}

func deriveTestResources() map[string]templateResource {
	return map[string]templateResource{
		"Fn":       {Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn","Runtime":"provided.al2023","Handler":"bootstrap"}`)},
		"Queue":    {Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)},
		"Fifo":     {Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"fifo.fifo","FifoQueue":true}`)},
		"Topic":    {Type: typeSNSTopic, Properties: json.RawMessage(`{"TopicName":"topic"}`)},
		"Table":    {Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"table","StreamSpecification":{"StreamEnabled":true,"StreamViewType":"NEW_IMAGE"}}`)},
		"Stream":   {Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"stream"}`)},
		"Bucket":   {Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket"}`)},
		"Group":    {Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":"/group"}`)},
		"Rule":     {Type: typeEventsRule, Properties: json.RawMessage(`{"Name":"rule","EventPattern":{"source":["app.test"]}}`)},
		"Bus":      {Type: typeEventsBus, Properties: json.RawMessage(`{"Name":"custom"}`)},
		"Dest":     {Type: typeLogsDestination, Properties: json.RawMessage(`{"DestinationName":"dest","TargetArn":{"Fn::GetAtt":["Stream","Arn"]}}`)},
		"NoTarget": {Type: typeLogsDestination, Properties: json.RawMessage(`{"DestinationName":"dest","TargetArn":"arn:aws:kinesis:us-east-1:123456789012:stream/other"}`)},
	}
}

func TestDeriveEventSourceMappingErrors(t *testing.T) {
	cases := map[string]string{
		"function literal": `{"FunctionName":"literal","EventSourceArn":{"Fn::GetAtt":["Queue","Arn"]}}`,
		"literal source":   `{"FunctionName":{"Fn::GetAtt":["Fn","Arn"]},"EventSourceArn":"arn:aws:sqs:us-east-1:123456789012:queue"}`,
		"sqs attr":         `{"FunctionName":{"Fn::GetAtt":["Fn","Arn"]},"EventSourceArn":{"Fn::GetAtt":["Queue","StreamArn"]}}`,
		"dynamo attr":      `{"FunctionName":{"Fn::GetAtt":["Fn","Arn"]},"EventSourceArn":{"Fn::GetAtt":["Table","Arn"]}}`,
		"kinesis attr":     `{"FunctionName":{"Fn::GetAtt":["Fn","Arn"]},"EventSourceArn":{"Fn::GetAtt":["Stream","StreamName"]}}`,
	}
	for name, properties := range cases {
		resources := deriveTestResources()
		resources["Mapping"] = templateResource{Type: typeEventSourceMap, Properties: json.RawMessage(properties)}
		stack := deriveTestStack(resources)
		if err := deriveEventSourceMappings(&Spec{}, []assemblyStack{stack}, stack); err == nil {
			t.Errorf("%s: the mapping must be refused", name)
		}
	}
	// An unsupported source type is reported as skipped, not dropped.
	resources := deriveTestResources()
	resources["Mapping"] = templateResource{Type: typeEventSourceMap, Properties: json.RawMessage(`{"FunctionName":{"Fn::GetAtt":["Fn","Arn"]},"EventSourceArn":{"Ref":"Bucket"}}`)}
	stack := deriveTestStack(resources)
	spec := &Spec{}
	if err := deriveEventSourceMappings(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatal(err)
	}
	if len(spec.Skipped) != 1 {
		t.Fatalf("skipped: %+v", spec.Skipped)
	}
}

func TestDeriveEventRuleErrors(t *testing.T) {
	cases := map[string]string{
		"invalid properties":  `bad`,
		"bad schedule":        `{"ScheduleExpression":"rate(five minutes)"}`,
		"neither":             `{}`,
		"both":                `{"ScheduleExpression":"rate(5 minutes)","EventPattern":{"source":["a"]}}`,
		"custom bus schedule": `{"ScheduleExpression":"rate(5 minutes)","EventBusName":{"Ref":"Bus"}}`,
	}
	for name, properties := range cases {
		resources := deriveTestResources()
		resources["Rule"] = templateResource{Type: typeEventsRule, Properties: json.RawMessage(properties)}
		stack := deriveTestStack(resources)
		if err := deriveEventRules(&Spec{}, []assemblyStack{stack}, stack); err == nil {
			t.Errorf("%s: the rule must be refused", name)
		}
	}
}

func TestResolveEventPatternRefsEdges(t *testing.T) {
	stack := deriveTestStack(deriveTestResources())
	if _, err := resolveEventPatternRefs(stack, json.RawMessage(`{`)); err == nil {
		t.Fatal("invalid JSON must fail")
	}
	bad := []string{
		`{"Fn::GetAtt":"bad"}`,
		`{"Fn::Join":[1,[]]}`,
		`{"Fn::Join":["-","bad"]}`,
		`{"Fn::Join":["-",[{"Fn::GetAtt":"bad"}]]}`,
		`{"Ref":"Missing"}`,
	}
	for _, raw := range bad {
		if _, err := resolveEventPatternRefs(stack, json.RawMessage(raw)); err == nil {
			t.Errorf("%s must fail", raw)
		}
	}
	resolved, err := resolveEventPatternRefs(stack, json.RawMessage(`{
		"bucket":[{"Fn::GetAtt":["Bucket","Arn"]}],
		"table":[{"Fn::GetAtt":["Table","Arn"]}],
		"queue":[{"Fn::GetAtt":["Queue","Name"]}],
		"stream":[{"Fn::GetAtt":["Stream","Name"]}],
		"fn":[{"Fn::GetAtt":["Fn","Name"]}],
		"rule":[{"Fn::GetAtt":["Rule","Name"]}],
		"group":[{"Ref":"Group"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(resolved)
	for _, want := range []string{"arn:aws:s3:::bucket", "arn:aws:dynamodb", "queue", "stream", "fn", "rule", "/group"} {
		if !strings.Contains(text, want) {
			t.Fatalf("resolved pattern misses %q: %s", want, text)
		}
	}
}

func TestResolveRuleBusNameEdges(t *testing.T) {
	stack := deriveTestStack(deriveTestResources())
	if name, err := resolveRuleBusName(stack, json.RawMessage(`"   "`)); err != nil || name != defaultEventBus {
		t.Fatalf("blank bus: %q %v", name, err)
	}
	if name, err := resolveRuleBusName(stack, json.RawMessage(`{"Ref":"Bus"}`)); err != nil || name != "custom" {
		t.Fatalf("custom bus: %q %v", name, err)
	}
	if _, err := resolveRuleBusName(stack, json.RawMessage(`{"Fn::GetAtt":["Missing","Arn"]}`)); err == nil {
		t.Fatal("an unresolvable bus must fail")
	}
}

func TestRuleTargetResolutionEdges(t *testing.T) {
	rule := func(properties string) (*Spec, error) {
		resources := deriveTestResources()
		delete(resources, "Rule")
		resources["TargetRule"] = templateResource{Type: typeEventsRule, Properties: json.RawMessage(properties)}
		stack := deriveTestStack(resources)
		spec := &Spec{}
		return spec, deriveEventRules(spec, []assemblyStack{stack}, stack)
	}
	skipped := map[string]string{
		"missing ref":      `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Missing","Arn"]}}]}`,
		"sqs attr":         `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Queue","Name"]}}]}`,
		"sns attr":         `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Topic","Name"]}}]}`,
		"unsupported type": `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Group","Arn"]}}]}`,
	}
	for name, properties := range skipped {
		spec, err := rule(properties)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(spec.Rules) != 0 || len(spec.Skipped) != 1 {
			t.Errorf("%s: rules %+v skipped %+v", name, spec.Rules, spec.Skipped)
		}
	}
	grouped, err := rule(`{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Queue","Arn"]},"SqsParameters":{"MessageGroupId":"g"}}]}`)
	if err != nil || len(grouped.Rules) != 1 || grouped.Rules[0].TargetSpecs[0].SQSMessageGroupID != "g" {
		t.Fatalf("sqs group: %v %+v", err, grouped.Rules)
	}
	topicArn, err := rule(`{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Topic","TopicArn"]}}]}`)
	if err != nil || len(topicArn.Rules) != 1 || topicArn.Rules[0].TargetSpecs[0].Type != "sns" {
		t.Fatalf("topic arn: %v %+v", err, topicArn.Rules)
	}
	refused := map[string]string{
		"sqs group on lambda": `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"SqsParameters":{"MessageGroupId":"g"}}]}`,
		"retry attempts":      `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"RetryPolicy":{"MaximumRetryAttempts":200}}]}`,
		"retry age":           `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"RetryPolicy":{"MaximumEventAgeInSeconds":10}}]}`,
		"bad input":           `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"Input":"not-json"}]}`,
		"bad input path":      `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"InputPath":"bad"}]}`,
		"empty template":      `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"InputTransformer":{"InputTemplate":"  "}}]}`,
		"bad template path":   `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"InputTransformer":{"InputTemplate":"<x>","InputPathsMap":{"x":"bad"}}}]}`,
		"two inputs":          `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"Input":"{}","InputPath":"$.detail"}]}`,
		"bad dlq":             `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"DeadLetterConfig":{"Arn":"arn:aws:sns:us-east-1:123456789012:topic"}}]}`,
		"fifo dlq":            `{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"DeadLetterConfig":{"Arn":{"Fn::GetAtt":["Fifo","Arn"]}}}]}`,
	}
	for name, properties := range refused {
		if _, ruleErr := rule(properties); ruleErr == nil {
			t.Errorf("%s: the rule must be refused", name)
		}
	}
	dlq, err := rule(`{"EventPattern":{"source":["a"]},"Targets":[{"Id":"t","Arn":{"Fn::GetAtt":["Fn","Arn"]},"DeadLetterConfig":{"Arn":{"Fn::GetAtt":["Queue","Arn"]}}}]}`)
	if err != nil || len(dlq.Rules) != 1 || dlq.Rules[0].TargetSpecs[0].DeadLetterQueueName != "queue" {
		t.Fatalf("dlq: %v %+v", err, dlq.Rules)
	}
}

func TestSubscriptionHelperEdges(t *testing.T) {
	stack := deriveTestStack(deriveTestResources())
	types := stack.resourceTypes()
	if _, _, err := resolveSubscriptionDestination(stack, types, json.RawMessage(`{"Fn::GetAtt":["Fn","Name"]}`)); err == nil {
		t.Fatal("a function destination must use its Arn")
	}
	if _, _, err := resolveSubscriptionDestination(stack, types, json.RawMessage(`{"Fn::GetAtt":["Stream","Name"]}`)); err == nil {
		t.Fatal("a stream destination must use its Arn")
	}
	if destination, ok, err := resolveSubscriptionDestination(stack, types, json.RawMessage(`{"Ref":"NoTarget"}`)); err != nil || ok {
		t.Fatalf("a destination without a stream target: %+v %v %v", destination, ok, err)
	}
	literal := `{"Fn::Join":["",["arn:aws:logs:us-east-1:123456789012:destination:","dest"]]}`
	if destination, ok, err := resolveSubscriptionDestination(stack, types, json.RawMessage(literal)); err != nil || !ok || destination.Stream != "Stream" {
		t.Fatalf("a literal destination: %+v %v %v", destination, ok, err)
	}
	missingTarget := `{"Fn::Join":["",["arn:aws:logs:us-east-1:123456789012:destination:","missing"]]}`
	if _, ok, resolveErr := resolveSubscriptionDestination(stack, types, json.RawMessage(missingTarget)); ok || resolveErr != nil {
		t.Fatalf("an unknown literal destination must not resolve: %v", resolveErr)
	}
	if _, ok := logDestinationStream(stack, types, "Missing"); ok {
		t.Fatal("a missing destination has no stream")
	}
	resources := deriveTestResources()
	resources["BadDest"] = templateResource{Type: typeLogsDestination, Properties: json.RawMessage(`bad`)}
	badStack := deriveTestStack(resources)
	if _, ok := logDestinationStream(badStack, badStack.resourceTypes(), "BadDest"); ok {
		t.Fatal("an invalid destination has no stream")
	}

	if got := subscriptionLogGroup(stack, json.RawMessage(`{"Ref":"Missing"}`)); got != "" {
		t.Fatalf("missing group ref: %q", got)
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`{"Ref":"Group"}`)); got != "/group" {
		t.Fatalf("direct group ref: %q", got)
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`{"Ref":"Fn"}`)); got != "/aws/lambda/fn" {
		t.Fatalf("direct function ref: %q", got)
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`{"Ref":"Rule"}`)); got != "" {
		t.Fatalf("other direct ref: %q", got)
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`{`)); got != "" {
		t.Fatalf("invalid group value: %q", got)
	}
	resources = deriveTestResources()
	resources["Retention"] = templateResource{Type: "Custom::LogRetention", Properties: json.RawMessage(`{"LogGroupName":"/retained"}`)}
	retained := deriveTestStack(resources)
	if got := subscriptionLogGroup(retained, json.RawMessage(`{"Ref":"Retention"}`)); got != "/retained" {
		t.Fatalf("retention ref: %q", got)
	}
	resources = deriveTestResources()
	resources["JoinedGroup"] = templateResource{Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]}}`)}
	joined := deriveTestStack(resources)
	if got := subscriptionLogGroup(joined, json.RawMessage(`{"Ref":"JoinedGroup"}`)); got != "/aws/lambda/fn" {
		t.Fatalf("joined group: %q", got)
	}

	flatten := map[string]any{
		"Fn::Join": []any{"-", []any{"a", "b"}},
	}
	if got := flattenLogGroupValue(stack, flatten); got != "a-b" {
		t.Fatalf("join: %q", got)
	}
	for _, value := range []any{
		map[string]any{"Fn::Join": "bad"},
		map[string]any{"Fn::Join": []any{1, []any{"a"}}},
		map[string]any{"Fn::Join": []any{"-", "bad"}},
		map[string]any{"Fn::Join": []any{"-", []any{"a", map[string]any{"Ref": "Missing"}}}},
		map[string]any{"Ref": "Missing"},
		map[string]any{"Ref": "Rule"},
		[]any{"a"},
	} {
		if got := flattenLogGroupValue(stack, value); got != "" {
			t.Fatalf("flatten %+v: %q", value, got)
		}
	}
	if got := functionLogGroupName(stack, "Missing"); got != "" {
		t.Fatalf("missing function: %q", got)
	}
	if got := subscriptionStreamName(stack, types, "Missing"); got != "" {
		t.Fatalf("missing stream: %q", got)
	}
	if got := subscriptionStreamName(stack, map[string]string{"Ghost": typeKinesisStream}, "Ghost"); got != "" {
		t.Fatalf("stream without a resource: %q", got)
	}
}

func TestResolveStreamDestinationEdges(t *testing.T) {
	stack := deriveTestStack(deriveTestResources())
	config := func(raw string) *struct {
		OnFailure *struct {
			Destination json.RawMessage `json:"Destination"`
		} `json:"OnFailure"`
	} {
		var parsed struct {
			OnFailure *struct {
				Destination json.RawMessage `json:"Destination"`
			} `json:"OnFailure"`
		}
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			t.Fatalf("config: %v", err)
		}
		return &parsed
	}
	if _, _, _, err := resolveStreamDestination(stack, "Mapping", config(`{"OnFailure":{"Destination":{"Fn::GetAtt":["Queue","Name"]}}}`)); err == nil {
		t.Fatal("an SQS destination must use its Arn")
	}
	if _, _, _, err := resolveStreamDestination(stack, "Mapping", config(`{"OnFailure":{"Destination":{"Fn::GetAtt":["Topic","Name"]}}}`)); err == nil {
		t.Fatal("an SNS destination must use its Arn")
	}
	if backend, _, _, err := resolveStreamDestination(stack, "Mapping", config(`{"OnFailure":{"Destination":"arn:aws:sns:us-east-1:123456789012:topic"}}`)); err != nil || backend != backendSNS {
		t.Fatalf("a literal SNS destination: %q %v", backend, err)
	}
	if _, _, _, err := resolveStreamDestination(stack, "Mapping", config(`{"OnFailure":{"Destination":{"Fn::GetAtt":["Missing","Arn"]}}}`)); err == nil {
		t.Fatal("a missing destination must fail")
	}
}
