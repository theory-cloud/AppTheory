package localrunner

import (
	"errors"
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
