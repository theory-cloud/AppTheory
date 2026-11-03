package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// deriveEventSourceMappings reads the event source mappings the app deploys.
// Each supported mapping names the function the runner starts and the queue,
// table or stream a generated event must refer to. An unsupported source is
// reported under skipped; it is never silently dropped.
//
//nolint:gocyclo,gocognit // the switch is the explicit source-type contract the runner supports.
func deriveEventSourceMappings(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeEventSourceMap {
			continue
		}
		var props eventSourceMappingProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse event source mapping properties: %w", stack.Name, id, err)
		}
		logicalID := qualify(stacks, stack.Name, id)
		functionID, ok := findRefByType(props.FunctionName, types, typeLambdaFunction)
		if !ok {
			return unsupported(logicalID, "event source mapping does not target a Lambda function")
		}
		refs := refsIn(props.EventSourceARN)
		if len(refs) == 0 {
			return unsupported(logicalID, "event source mapping has no resolvable eventSourceArn")
		}
		ref := refs[0]
		sourceType := types[ref.ID]
		var mappingType string
		switch sourceType {
		case typeSQSQueue:
			if ref.Attr != "" && ref.Attr != attrArn {
				return unsupported(logicalID, "SQS event source mapping must reference the queue Arn, got %q", ref.Attr)
			}
			mappingType = backendSQS
		case typeDynamoTable:
			if ref.Attr != "" && ref.Attr != "StreamArn" {
				return unsupported(logicalID, "DynamoDB event source mapping must reference the table StreamArn, got %q", ref.Attr)
			}
			mappingType = backendDynamoDB
		case typeKinesisStream:
			if ref.Attr != "" && ref.Attr != attrArn {
				return unsupported(logicalID, "Kinesis event source mapping must reference the stream Arn, got %q", ref.Attr)
			}
			mappingType = backendKinesis
		default:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeEventSourceMap,
				Reason:    fmt.Sprintf("event source type %s is not delivered locally", sourceType),
			})
			continue
		}
		source := stack.Template.Resources[ref.ID]
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  ref.ID,
			Type:       sourceType,
			Properties: source.Properties,
		})
		if err != nil {
			return fmt.Errorf("%s: resolve %s source name: %w", logicalID, mappingType, err)
		}
		enabled := props.Enabled == nil || *props.Enabled
		eventSource := EventSourceSpec{
			LogicalID:               logicalID,
			Stack:                   stack.Name,
			Function:                qualify(stacks, stack.Name, functionID),
			Type:                    mappingType,
			Source:                  qualify(stacks, stack.Name, ref.ID),
			SourceName:              name,
			SourceARN:               localSourceARN(mappingType, name),
			BatchSize:               eventSourceBatchSize(mappingType, props.BatchSize),
			ReportBatchItemFailures: containsStringList(props.FunctionResponseTypes, "ReportBatchItemFailures"),
			Enabled:                 enabled,
			StartingPosition:        props.StartingPosition,
		}
		if mappingType == backendSQS {
			if err := applySQSMappingOptions(&eventSource, props, source.Properties); err != nil {
				return err
			}
		}
		spec.EventSources = append(spec.EventSources, eventSource)
	}
	return nil
}

// deriveEventRules reads EventBridge rules with Lambda targets. A rule with any
// other target is reported; the runner has no way to deliver that target.
func deriveEventRules(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeEventsRule {
			continue
		}
		var props eventRuleProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse EventBridge rule properties: %w", stack.Name, id, err)
		}
		logicalID := qualify(stacks, stack.Name, id)
		if strings.TrimSpace(props.ScheduleExpression) != "" && len(props.EventPattern) > 0 {
			return unsupported(logicalID, "EventBridge rule declares both ScheduleExpression and EventPattern")
		}
		if strings.TrimSpace(props.ScheduleExpression) == "" && len(props.EventPattern) == 0 {
			return unsupported(logicalID, "EventBridge rule declares neither ScheduleExpression nor EventPattern")
		}
		var targets []string
		for _, target := range props.Targets {
			functionID, ok := findRefByType(target.ARN, types, typeLambdaFunction, attrArn)
			if !ok {
				continue
			}
			targets = append(targets, qualify(stacks, stack.Name, functionID))
		}
		if len(targets) == 0 {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeEventsRule,
				Reason:    "EventBridge rule has no Lambda function target the local runner can invoke",
			})
			continue
		}
		if len(props.EventPattern) > 0 && !json.Valid(props.EventPattern) {
			return unsupported(logicalID, "EventBridge rule EventPattern is not valid JSON")
		}
		name := strings.TrimSpace(props.Name)
		if name == "" {
			resolved, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  id,
				Type:       typeEventsRule,
				Properties: resource.Properties,
			})
			if err != nil {
				return err
			}
			name = resolved
		}
		spec.Rules = append(spec.Rules, RuleSpec{
			LogicalID:    logicalID,
			Stack:        stack.Name,
			Name:         name,
			ARN:          "arn:" + LocalPartition + ":events:" + LocalRegion + ":" + LocalAccountID + ":rule/" + name,
			Schedule:     strings.TrimSpace(props.ScheduleExpression),
			EventPattern: append(json.RawMessage(nil), props.EventPattern...),
			Targets:      targets,
			Enabled:      !strings.EqualFold(strings.TrimSpace(props.State), "DISABLED"),
		})
	}
	return nil
}

func containsStringList(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), needle) {
			return true
		}
	}
	return false
}

// subscriptionFilterProperties is one AWS::Logs::SubscriptionFilter. The runner
// registers the filter with the delivery engine; the CloudWatch Logs backend
// and the Kinesis or Lambda destination delivery land in E5.
type subscriptionFilterProperties struct {
	LogGroupName   json.RawMessage `json:"LogGroupName"`
	FilterName     string          `json:"FilterName"`
	FilterPattern  string          `json:"FilterPattern"`
	DestinationARN json.RawMessage `json:"DestinationArn"`
	Distribution   string          `json:"Distribution"`
}

// subscriptionDestination is the resolved target of a CloudWatch Logs
// subscription filter.
type subscriptionDestination struct {
	// LogicalID is the qualified resource the filter names.
	LogicalID string
	// Type is function or stream.
	Type string
	// Function or Stream is the qualified destination, whichever applies.
	Function string
	Stream   string
}

// deriveSubscriptions reads CloudWatch Logs subscription filters and resolves
// the destination the runner will deliver to. A destination the runner cannot
// deliver is reported, never dropped.
//
// The filter shape is the CloudWatch Logs SubscriptionFilter resource
// (https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_SubscriptionFilter.html);
// a cross-account destination is an AWS::Logs::Destination whose TargetArn names
// the stream (https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_Destination.html).
func deriveSubscriptions(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeLogsSubscription {
			continue
		}
		var props subscriptionFilterProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse subscription filter properties: %w", stack.Name, id, err)
		}
		logicalID := qualify(stacks, stack.Name, id)
		destination, ok, err := resolveSubscriptionDestination(stack, types, props.DestinationARN)
		if err != nil {
			return unsupported(logicalID, "%s", err.Error())
		}
		if !ok {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeLogsSubscription,
				Reason:    "subscription destination is not a local Lambda function or Kinesis stream",
			})
			continue
		}
		spec.Subscriptions = append(spec.Subscriptions, SubscriptionSpec{
			LogicalID:       logicalID,
			Stack:           stack.Name,
			Kind:            string(DeliveryKindCloudWatchLogs),
			LogGroup:        subscriptionLogGroup(stack, props.LogGroupName),
			FilterName:      strings.TrimSpace(props.FilterName),
			FilterPattern:   strings.TrimSpace(props.FilterPattern),
			Distribution:    strings.TrimSpace(props.Distribution),
			Destination:     qualify(stacks, stack.Name, destination.LogicalID),
			DestinationType: destination.Type,
			Function:        qualifyWhenSet(stacks, stack.Name, destination.Function),
			Stream:          qualifyWhenSet(stacks, stack.Name, destination.Stream),
		})
	}
	return nil
}

// resolveSubscriptionDestination maps a filter's DestinationArn to the local
// Lambda function or Kinesis stream. A CloudWatch Logs destination
// (AWS::Logs::Destination) is followed to its TargetArn.
func resolveSubscriptionDestination(stack assemblyStack, types map[string]string, raw json.RawMessage) (subscriptionDestination, bool, error) {
	for _, ref := range refsIn(raw) {
		switch types[ref.ID] {
		case typeLambdaFunction:
			if ref.Attr != "" && ref.Attr != attrArn {
				return subscriptionDestination{}, false, fmt.Errorf("subscription destination must reference the function Arn, got %q", ref.Attr)
			}
			return subscriptionDestination{LogicalID: ref.ID, Type: "function", Function: ref.ID}, true, nil
		case typeKinesisStream:
			if ref.Attr != "" && ref.Attr != attrArn {
				return subscriptionDestination{}, false, fmt.Errorf("subscription destination must reference the stream Arn, got %q", ref.Attr)
			}
			return subscriptionDestination{LogicalID: ref.ID, Type: "stream", Stream: ref.ID}, true, nil
		case typeLogsDestination:
			target, found := logDestinationStream(stack, types, ref.ID)
			if !found {
				return subscriptionDestination{}, false, nil
			}
			return subscriptionDestination{LogicalID: ref.ID, Type: "stream", Stream: target}, true, nil
		}
	}
	// A destination ARN that is not a Ref (CDK emits Fn::Join for an
	// account-scoped destination) still names the destination in its literal
	// tail.
	if arn := resolvedString(raw); arn != "" {
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			if resource.Type != typeLogsDestination {
				continue
			}
			if logDestinationName(resource) == arnName(arn) {
				target, found := logDestinationStream(stack, types, id)
				if !found {
					return subscriptionDestination{}, false, nil
				}
				return subscriptionDestination{LogicalID: id, Type: "stream", Stream: target}, true, nil
			}
		}
	}
	return subscriptionDestination{}, false, nil
}

// logDestinationStream follows an AWS::Logs::Destination's TargetArn to the
// Kinesis stream it delivers to.
func logDestinationStream(stack assemblyStack, types map[string]string, id string) (string, bool) {
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return "", false
	}
	var props struct {
		TargetARN json.RawMessage `json:"TargetArn"`
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return "", false
	}
	for _, ref := range refsIn(props.TargetARN) {
		if types[ref.ID] == typeKinesisStream {
			return ref.ID, true
		}
	}
	return "", false
}

func logDestinationName(resource templateResource) string {
	var props struct {
		DestinationName string `json:"DestinationName"`
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return ""
	}
	return strings.TrimSpace(props.DestinationName)
}

// resolvedString flattens a literal string or an Fn::Join whose parts are
// strings. A part the template computes (Ref, Fn::GetAtt) becomes empty, so
// only a literal tail in the joined value is usable for name matching.
func resolvedString(raw json.RawMessage) string {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return flattenString(value)
}

func flattenString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		join, ok := typed["Fn::Join"].([]any)
		if !ok || len(join) != 2 {
			return ""
		}
		delimiter, ok := join[0].(string)
		if !ok {
			return ""
		}
		parts, ok := join[1].([]any)
		if !ok {
			return ""
		}
		var builder strings.Builder
		for _, part := range parts {
			builder.WriteString(flattenString(part))
			builder.WriteString(delimiter)
		}
		if len(parts) > 0 {
			return strings.TrimSuffix(builder.String(), delimiter)
		}
		return ""
	default:
		return ""
	}
}

// arnName returns the last segment of an ARN, which is the resource name.
func arnName(arn string) string {
	if index := strings.LastIndex(arn, ":"); index >= 0 {
		return arn[index+1:]
	}
	return ""
}

// subscriptionLogGroup resolves a filter's LogGroupName: a literal name, or the
// physical name of the log group the template references.
func subscriptionLogGroup(stack assemblyStack, raw json.RawMessage) string {
	if id, ok := directRefID(raw); ok {
		resource, exists := stack.Template.Resources[id]
		if !exists || resource.Type != typeLogGroup {
			return ""
		}
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  id,
			Type:       typeLogGroup,
			Properties: resource.Properties,
		})
		if err != nil {
			return ""
		}
		return name
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err != nil {
		return ""
	}
	return strings.TrimSpace(literal)
}

// qualifyWhenSet qualifies a logical id only when the destination set it.
func qualifyWhenSet(stacks []assemblyStack, stack, logicalID string) string {
	if logicalID == "" {
		return ""
	}
	return qualify(stacks, stack, logicalID)
}

// applySQSMappingOptions validates the SQS mapping configuration AWS rejects
// and records the queue settings plan and describe report.
//
// The rules are the EventSourceMappingConfiguration API
// (https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html)
// and "Creating and configuring an Amazon SQS event source mapping"
// (https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html):
// BatchSize is 1..10,000 and above 10 requires a batching window of at least
// one second; MaximumBatchingWindowInSeconds is 0..300 and applies only to
// standard queues; a FIFO queue's maximum batch size is 10 and it has no
// batching window; ScalingConfig.MaximumConcurrency is 2..1000.
func applySQSMappingOptions(eventSource *EventSourceSpec, props eventSourceMappingProperties, sourceProperties json.RawMessage) error {
	var queue sqsQueueProperties
	if len(sourceProperties) > 0 {
		if err := json.Unmarshal(sourceProperties, &queue); err != nil {
			return fmt.Errorf("%s: parse SQS queue properties: %w", eventSource.LogicalID, err)
		}
	}
	eventSource.FIFO = queue.FifoQueue
	eventSource.VisibilityTimeout = queue.VisibilityTimeout
	if eventSource.VisibilityTimeout <= 0 {
		// The SQS default visibility timeout is 30 seconds.
		eventSource.VisibilityTimeout = 30
	}
	eventSource.MaxReceiveCount = sqsMaxReceiveCount(queue.RedrivePolicy)
	eventSource.MaximumBatchingWindowInSeconds = props.MaximumBatchingWindowInSeconds
	if props.ScalingConfig != nil {
		eventSource.MaximumConcurrency = props.ScalingConfig.MaximumConcurrency
	}

	if err := validateSQSMappingOptions(eventSource); err != nil {
		return err
	}
	filters, err := normalizeEventFilterCriteria(props.FilterCriteria, eventSource.LogicalID)
	if err != nil {
		return err
	}
	eventSource.FilterCriteria = filters
	return nil
}

// validateSQSMappingOptions applies the ranges and related-setting rules from
// the EventSourceMappingConfiguration API and the SQS configuration page.
func validateSQSMappingOptions(eventSource *EventSourceSpec) error {
	batchSize := eventSource.BatchSize
	window := eventSource.MaximumBatchingWindowInSeconds
	maxConcurrency := eventSource.MaximumConcurrency
	switch {
	case batchSize < 1 || batchSize > 10000:
		return unsupported(eventSource.LogicalID, "SQS BatchSize must be between 1 and 10000 (got %d)", batchSize)
	case window < 0 || window > 300:
		return unsupported(eventSource.LogicalID, "SQS MaximumBatchingWindowInSeconds must be between 0 and 300 (got %d)", window)
	case eventSource.FIFO && window > 0:
		return unsupported(
			eventSource.LogicalID,
			"SQS FIFO queue %s does not support MaximumBatchingWindowInSeconds; AWS documents the batching window for standard queues only (https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)",
			eventSource.SourceName,
		)
	case eventSource.FIFO && batchSize > 10:
		return unsupported(eventSource.LogicalID, "SQS FIFO queue %s supports a maximum BatchSize of 10 (got %d)", eventSource.SourceName, batchSize)
	case !eventSource.FIFO && batchSize > 10 && window < 1:
		return unsupported(
			eventSource.LogicalID,
			"SQS BatchSize %d is greater than 10, so MaximumBatchingWindowInSeconds must be at least 1 (https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html)",
			batchSize,
		)
	case maxConcurrency != 0 && (maxConcurrency < 2 || maxConcurrency > 1000):
		return unsupported(eventSource.LogicalID, "SQS ScalingConfig.MaximumConcurrency must be between 2 and 1000 (got %d)", maxConcurrency)
	}
	return nil
}

// sqsMaxReceiveCount reads maxReceiveCount from a queue's RedrivePolicy. The
// policy is an object in a CloudFormation template and a JSON string in the SQS
// API, so both forms are accepted.
func sqsMaxReceiveCount(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	trimmed := strings.TrimSpace(string(raw))
	var text string
	if strings.HasPrefix(trimmed, `"`) {
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0
		}
		trimmed = text
	}
	var policy struct {
		MaxReceiveCount json.RawMessage `json:"maxReceiveCount"`
	}
	if err := json.Unmarshal([]byte(trimmed), &policy); err != nil {
		return 0
	}
	count, err := parseIntJSON(policy.MaxReceiveCount)
	if err != nil {
		return 0
	}
	return count
}

// eventSourceBatchSize returns the batch size the provider uses when the
// template omits it. AWS defaults are 10 for SQS and 100 for stream sources.
func eventSourceBatchSize(sourceType string, declared int) int {
	if declared > 0 {
		return declared
	}
	if sourceType == backendSQS {
		return 10
	}
	return 100
}

func localSourceARN(sourceType, name string) string {
	switch sourceType {
	case backendSQS:
		return "arn:" + LocalPartition + ":sqs:" + LocalRegion + ":" + LocalAccountID + ":" + name
	case backendDynamoDB:
		return "arn:" + LocalPartition + ":dynamodb:" + LocalRegion + ":" + LocalAccountID + ":table/" + name + "/stream/local"
	case backendKinesis:
		return "arn:" + LocalPartition + ":kinesis:" + LocalRegion + ":" + LocalAccountID + ":stream/" + name
	default:
		return ""
	}
}
