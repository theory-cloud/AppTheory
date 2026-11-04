package localrunner

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// deriveSNSSubscriptions reads AWS::SNS::Subscription resources and the inline
// Subscription entries of AWS::SNS::Topic. Every subscription is registered
// with the delivery engine; the SNS deliverer lands in E6. A target the runner
// cannot deliver, or an HTTP endpoint that is not loopback, is reported under
// skipped with a named reason.
//
// The resource shape is the CloudFormation SNS subscription reference:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-subscription.html
// The inline form is the AWS::SNS::Topic Subscription property:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-topic.html
//
// HTTP(S) subscriptions are local-only: the runner never contacts the network.
// An HTTP endpoint is therefore accepted only when it names a loopback host.
func deriveSNSSubscriptions(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		switch resource.Type {
		case typeSNSSubscription:
			var props snsSubscriptionProperties
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("%s/%s: parse SNS subscription properties: %w", stack.Name, id, err)
			}
			logicalID := qualify(stacks, stack.Name, id)
			topicID, ok := findRefByType(props.TopicARN, types, typeSNSTopic)
			if !ok {
				spec.Skipped = append(spec.Skipped, Skipped{
					LogicalID: logicalID,
					Kind:      typeSNSSubscription,
					Reason:    "SNS subscription does not target an SNS topic the local runner provisions",
				})
				continue
			}
			if err := appendSNSSubscription(spec, stacks, stack, types, logicalID,
				qualify(stacks, stack.Name, topicID), props); err != nil {
				return err
			}
		case typeSNSTopic:
			var props struct {
				Subscription []snsSubscriptionProperties `json:"Subscription"`
			}
			if len(resource.Properties) == 0 {
				continue
			}
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("%s/%s: parse SNS topic subscriptions: %w", stack.Name, id, err)
			}
			topicID := qualify(stacks, stack.Name, id)
			for index, inline := range props.Subscription {
				logicalID := topicID + "/Subscription" + strconv.Itoa(index)
				if err := appendSNSSubscription(spec, stacks, stack, types, logicalID, topicID, inline); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// snsSubscriptionProperties is the shared shape of the standalone resource and
// the inline topic property.
type snsSubscriptionProperties struct {
	TopicARN           json.RawMessage `json:"TopicArn"`
	Protocol           string          `json:"Protocol"`
	Endpoint           json.RawMessage `json:"Endpoint"`
	RawMessageDelivery bool            `json:"RawMessageDelivery"`
	FilterPolicy       json.RawMessage `json:"FilterPolicy"`
	FilterPolicyScope  string          `json:"FilterPolicyScope"`
}

// appendSNSSubscription resolves one subscription target and registers it. A
// target the local runner cannot deliver is reported, never silently dropped.
//
//nolint:gocyclo // one branch per supported subscription protocol.
func appendSNSSubscription(
	spec *Spec,
	stacks []assemblyStack,
	stack assemblyStack,
	types map[string]string,
	logicalID string,
	topicID string,
	props snsSubscriptionProperties,
) error {
	protocol := strings.ToLower(strings.TrimSpace(props.Protocol))
	subscription := SubscriptionSpec{
		LogicalID:          logicalID,
		Stack:              stack.Name,
		Kind:               string(DeliveryKindSNS),
		Topic:              topicID,
		Protocol:           protocol,
		RawMessageDelivery: props.RawMessageDelivery,
	}
	switch protocol {
	case "lambda":
		functionID, ok := findRefByType(props.Endpoint, types, typeLambdaFunction, attrArn)
		if !ok {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSSubscription,
				Reason:    "SNS lambda subscription endpoint is not a Lambda function Arn the local runner can invoke",
			})
			return nil
		}
		subscription.Function = qualify(stacks, stack.Name, functionID)
		subscription.Endpoint = subscription.Function
	case "sqs":
		queueID, ok := findRefByType(props.Endpoint, types, typeSQSQueue, attrArn)
		if !ok {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSSubscription,
				Reason:    "SNS sqs subscription endpoint is not an SQS queue Arn the local runner provisions",
			})
			return nil
		}
		subscription.Queue = qualify(stacks, stack.Name, queueID)
		subscription.Endpoint = subscription.Queue
	case "http", "https":
		endpoint := resolvedString(props.Endpoint)
		if endpoint == "" {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSSubscription,
				Reason:    "SNS HTTP subscription endpoint is not a literal URL",
			})
			return nil
		}
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Hostname() == "" {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSSubscription,
				Reason:    fmt.Sprintf("SNS HTTP subscription endpoint %q is not an absolute URL", endpoint),
			})
			return nil
		}
		if !loopbackHost(parsed.Hostname()) {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSSubscription,
				Reason: fmt.Sprintf(
					"SNS HTTP subscription endpoint %q is not a loopback URL; the local runner never contacts the network",
					endpoint,
				),
			})
			return nil
		}
		subscription.Endpoint = endpoint
	default:
		spec.Skipped = append(spec.Skipped, Skipped{
			LogicalID: logicalID,
			Kind:      typeSNSSubscription,
			Reason: fmt.Sprintf(
				"SNS %s subscriptions are outside the local runner (SMS, email and mobile push are out of scope)",
				protocol,
			),
		})
		return nil
	}
	scope := strings.TrimSpace(props.FilterPolicyScope)
	if scope == "" {
		scope = "MessageAttributes"
	}
	switch scope {
	case "MessageAttributes", "MessageBody":
	default:
		return unsupported(logicalID, "SNS FilterPolicyScope must be MessageAttributes or MessageBody (got %q)", scope)
	}
	if len(props.FilterPolicy) > 0 && strings.TrimSpace(string(props.FilterPolicy)) != jsonNull {
		var policy any
		if err := json.Unmarshal(props.FilterPolicy, &policy); err != nil {
			return unsupported(logicalID, "SNS FilterPolicy is not valid JSON: %v", err)
		}
		if _, ok := policy.(map[string]any); !ok {
			return unsupported(logicalID, "SNS FilterPolicy must be a JSON object")
		}
		subscription.FilterPolicy = append(json.RawMessage(nil), props.FilterPolicy...)
		subscription.FilterPolicyScope = scope
	}
	spec.Subscriptions = append(spec.Subscriptions, subscription)
	return nil
}

// loopbackHost reports whether a host names this machine's loopback interface.
// The runner accepts no other HTTP target, so an SNS subscription cannot make
// the local run contact the network.
func loopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
