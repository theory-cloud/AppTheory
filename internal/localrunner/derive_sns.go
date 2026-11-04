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
// Subscription entries of AWS::SNS::Topic. Every supported subscription is
// registered with the delivery engine, which observes publishes on moto and
// performs the fan-out. A target the runner cannot deliver, an HTTP endpoint
// that is not loopback, or a target SNS itself does not support for a FIFO
// topic is reported under skipped with a named reason.
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
			fifo, err := snsTopicFIFO(stack, topicID)
			if err != nil {
				return fmt.Errorf("%s/%s: %w", stack.Name, id, err)
			}
			if err := appendSNSSubscription(spec, stacks, stack, types, logicalID,
				qualify(stacks, stack.Name, topicID), fifo, props); err != nil {
				return err
			}
		case typeSNSTopic:
			var props struct {
				FifoTopic    bool                        `json:"FifoTopic"`
				TopicName    string                      `json:"TopicName"`
				Subscription []snsSubscriptionProperties `json:"Subscription"`
			}
			if len(resource.Properties) == 0 {
				continue
			}
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return fmt.Errorf("%s/%s: parse SNS topic subscriptions: %w", stack.Name, id, err)
			}
			topicID := qualify(stacks, stack.Name, id)
			fifo := props.FifoTopic || strings.HasSuffix(strings.TrimSpace(props.TopicName), ".fifo")
			for index, inline := range props.Subscription {
				logicalID := topicID + "/Subscription" + strconv.Itoa(index)
				if err := appendSNSSubscription(spec, stacks, stack, types, logicalID, topicID, fifo, inline); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// snsTopicFIFO reports whether a standalone subscription's topic is FIFO. A
// FIFO topic is named with the .fifo suffix and sets FifoTopic.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sns-topic.html
func snsTopicFIFO(stack assemblyStack, topicID string) (bool, error) {
	resource, ok := stack.Template.Resources[topicID]
	if !ok {
		return false, nil
	}
	var props struct {
		FifoTopic bool   `json:"FifoTopic"`
		TopicName string `json:"TopicName"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return false, fmt.Errorf("parse SNS topic %s properties: %w", topicID, err)
		}
	}
	return props.FifoTopic || strings.HasSuffix(strings.TrimSpace(props.TopicName), ".fifo"), nil
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
	topicFIFO bool,
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
	if topicFIFO && (protocol == snsProtocolLambda || protocol == snsProtocolHTTP || protocol == snsProtocolHTTPS) {
		// SNS FIFO topics cannot deliver to customer-managed endpoints; Lambda
		// needs an SQS queue in front of it.
		// https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html
		spec.Skipped = append(spec.Skipped, Skipped{
			LogicalID: logicalID,
			Kind:      typeSNSSubscription,
			Reason: fmt.Sprintf(
				"SNS FIFO topics cannot deliver to %s endpoints; subscribe an SQS queue and map it to the target (https://docs.aws.amazon.com/sns/latest/dg/fifo-message-delivery.html)",
				protocol,
			),
		})
		return nil
	}
	switch protocol {
	case snsProtocolLambda:
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
	case snsProtocolSQS:
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
	case snsProtocolHTTP, snsProtocolHTTPS:
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
		policy, err := normalizeSNSFilterPolicy(props.FilterPolicy, scope, logicalID)
		if err != nil {
			return err
		}
		subscription.FilterPolicy = policy
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
