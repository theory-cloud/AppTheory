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
		if functionResource, ok := stack.Template.Resources[functionID]; ok {
			if functionName, nameErr := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  functionID,
				Type:       typeLambdaFunction,
				Properties: functionResource.Properties,
			}); nameErr == nil {
				eventSource.FunctionName = functionName
			}
		}
		if mappingType == backendSQS {
			if err := applySQSMappingOptions(&eventSource, props, source.Properties); err != nil {
				return err
			}
		} else {
			if err := applyStreamMappingOptions(&eventSource, props, source.Properties, stack); err != nil {
				return err
			}
		}
		spec.EventSources = append(spec.EventSources, eventSource)
	}
	return nil
}

// deriveEventRules reads EventBridge rules and every deliverable target. A
// rule whose targets cannot be delivered is reported under skipped; a rule
// with at least one supported target keeps that target and reports the others.
//
//nolint:gocognit,gocyclo // the rule contract is one ordered validation pass.
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
		busName, err := resolveRuleBusName(stack, props.EventBusName)
		if err != nil {
			return unsupported(logicalID, "%s", err.Error())
		}
		schedule := strings.TrimSpace(props.ScheduleExpression)
		if schedule != "" {
			if busName != defaultEventBus {
				return unsupported(logicalID, "a scheduled rule is only supported on the default event bus, got %q", busName)
			}
			parsed, parseErr := parseScheduleExpression(schedule)
			if parseErr != nil {
				return unsupported(logicalID, "%s", parseErr.Error())
			}
			if parsed.rateInterval == 0 && parsed.cron == nil {
				return unsupported(logicalID, "the schedule expression is empty")
			}
		}
		eventPattern := append(json.RawMessage(nil), props.EventPattern...)
		if len(eventPattern) > 0 {
			if !json.Valid(eventPattern) {
				return unsupported(logicalID, "EventBridge rule EventPattern is not valid JSON")
			}
			resolved, resolveErr := resolveEventPatternRefs(stack, eventPattern)
			if resolveErr != nil {
				return unsupported(logicalID, "EventPattern: %s", resolveErr.Error())
			}
			eventPattern = resolved
		}
		targets, functionTargets, err := deriveRuleTargets(stack, types, logicalID, props.Targets)
		if err != nil {
			return err
		}
		if len(targets) == 0 {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeEventsRule,
				Reason:    "EventBridge rule has no Lambda, SQS or SNS target the local runner can deliver",
			})
			continue
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
			BusName:      busName,
			ARN:          ruleARN(busName, name),
			Schedule:     schedule,
			EventPattern: eventPattern,
			Targets:      functionTargets,
			TargetSpecs:  targets,
			Enabled:      !strings.EqualFold(strings.TrimSpace(props.State), "DISABLED"),
		})
	}
	return nil
}

// resolveEventPatternRefs replaces CloudFormation references inside an event
// pattern with the local values the runner derives. A pattern's bucket name,
// table name or queue ARN comes from a Ref or Fn::GetAtt in the template; the
// bus compares the real PutEvents envelope against the pattern, so an
// unresolved token could never match.
func resolveEventPatternRefs(stack assemblyStack, raw json.RawMessage) (json.RawMessage, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	resolved, err := resolvePatternValue(stack, value)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(resolved)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

//nolint:gocognit,gocyclo // the CloudFormation value grammar is explicit.
func resolvePatternValue(stack assemblyStack, value any) (any, error) {
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			resolved, err := resolvePatternValue(stack, item)
			if err != nil {
				return nil, err
			}
			out[index] = resolved
		}
		return out, nil
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok {
			return patternReferenceValue(stack, id, "")
		}
		if rawGetAtt, ok := typed["Fn::GetAtt"]; ok {
			id, attr, err := parseGetAtt(rawGetAtt)
			if err != nil {
				return nil, err
			}
			return patternReferenceValue(stack, id, attr)
		}
		if rawJoin, ok := typed["Fn::Join"]; ok {
			join, ok := rawJoin.([]any)
			if !ok || len(join) != 2 {
				return nil, fmt.Errorf("Fn::Join must be [delimiter, parts]")
			}
			delimiter, ok := join[0].(string)
			if !ok {
				return nil, fmt.Errorf("Fn::Join delimiter must be a string")
			}
			parts, ok := join[1].([]any)
			if !ok {
				return nil, fmt.Errorf("Fn::Join parts must be an array")
			}
			var builder strings.Builder
			for _, part := range parts {
				resolved, err := resolvePatternValue(stack, part)
				if err != nil {
					return nil, err
				}
				fmt.Fprint(&builder, resolved)
				builder.WriteString(delimiter)
			}
			return strings.TrimSuffix(builder.String(), delimiter), nil
		}
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved, err := resolvePatternValue(stack, item)
			if err != nil {
				return nil, err
			}
			out[key] = resolved
		}
		return out, nil
	default:
		return value, nil
	}
}

// patternReferenceValue resolves one Ref or GetAtt inside a pattern.
//
//nolint:gocyclo // one branch per resource type.
func patternReferenceValue(stack assemblyStack, id, attr string) (any, error) {
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return nil, fmt.Errorf("reference to %s names no resource", id)
	}
	name, err := resourceName(ResourceSpec{
		Stack:      stack.Name,
		LogicalID:  id,
		Type:       resource.Type,
		Properties: resource.Properties,
	})
	if err != nil {
		return nil, err
	}
	switch resource.Type {
	case typeS3Bucket:
		if attr == attrArn {
			return "arn:" + LocalPartition + ":s3:::" + name, nil
		}
		return name, nil
	case typeDynamoTable:
		if attr == attrArn {
			return "arn:" + LocalPartition + ":dynamodb:" + LocalRegion + ":" + LocalAccountID + ":table/" + name, nil
		}
		return name, nil
	case typeSQSQueue:
		if attr == attrArn || attr == "" {
			return localSourceARN(backendSQS, name), nil
		}
		return name, nil
	case typeSNSTopic:
		return "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + name, nil
	case typeKinesisStream:
		if attr == attrArn {
			return localSourceARN(backendKinesis, name), nil
		}
		return name, nil
	case typeLambdaFunction:
		if attr == attrArn {
			return "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + name, nil
		}
		return name, nil
	case typeEventsRule:
		if attr == attrArn {
			return "arn:" + LocalPartition + ":events:" + LocalRegion + ":" + LocalAccountID + ":rule/" + name, nil
		}
		return name, nil
	default:
		return name, nil
	}
}

// resolveRuleBusName resolves EventBusName: literal, or a Ref to an
// AWS::Events::EventBus. An omitted name is the default bus.
func resolveRuleBusName(stack assemblyStack, raw json.RawMessage) (string, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return defaultEventBus, nil
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		literal = strings.TrimSpace(literal)
		if literal == "" {
			return defaultEventBus, nil
		}
		return literal, nil
	}
	for _, ref := range refsIn(raw) {
		resource, ok := stack.Template.Resources[ref.ID]
		if !ok || resource.Type != typeEventsBus {
			continue
		}
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  ref.ID,
			Type:       typeEventsBus,
			Properties: resource.Properties,
		})
		if err != nil {
			return "", err
		}
		return name, nil
	}
	return "", fmt.Errorf("EventBusName is not a literal or an AWS::Events::EventBus reference")
}

// ruleARN builds the rule ARN AWS reports. A custom bus is part of the ARN.
func ruleARN(busName, ruleName string) string {
	resource := ruleName
	if busName != "" && busName != "default" {
		resource = busName + "/" + ruleName
	}
	return "arn:" + LocalPartition + ":events:" + LocalRegion + ":" + LocalAccountID + ":rule/" + resource
}

// deriveRuleTargets resolves every target and validates its shaping, retry and
// dead-letter settings. It returns the deliverable targets and the Lambda
// function ids, which stay in RuleSpec.Targets for existing callers.
func deriveRuleTargets(stack assemblyStack, types map[string]string, logicalID string, declared []struct {
	ID               string          `json:"Id"`
	ARN              json.RawMessage `json:"Arn"`
	Input            string          `json:"Input"`
	InputPath        string          `json:"InputPath"`
	InputTransformer *struct {
		InputPathsMap map[string]string `json:"InputPathsMap"`
		InputTemplate string            `json:"InputTemplate"`
	} `json:"InputTransformer"`
	RetryPolicy *struct {
		MaximumRetryAttempts     int `json:"MaximumRetryAttempts"`
		MaximumEventAgeInSeconds int `json:"MaximumEventAgeInSeconds"`
	} `json:"RetryPolicy"`
	DeadLetterConfig *struct {
		ARN json.RawMessage `json:"Arn"`
	} `json:"DeadLetterConfig"`
	SqsParameters *struct {
		MessageGroupID string `json:"MessageGroupId"`
	} `json:"SqsParameters"`
}) ([]RuleTargetSpec, []string, error) {
	var targets []RuleTargetSpec
	var functions []string
	for index, declaredTarget := range declared {
		target, ok, err := resolveRuleTarget(stack, types, logicalID, declaredTarget)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		if target.Type == ruleTargetFunction {
			functions = append(functions, target.Function)
		}
		_ = index
		targets = append(targets, target)
	}
	return targets, functions, nil
}

// resolveRuleTarget resolves one target ARN and applies its settings.
//
//nolint:gocognit,gocyclo // one branch per target type.
func resolveRuleTarget(stack assemblyStack, types map[string]string, logicalID string, declared struct {
	ID               string          `json:"Id"`
	ARN              json.RawMessage `json:"Arn"`
	Input            string          `json:"Input"`
	InputPath        string          `json:"InputPath"`
	InputTransformer *struct {
		InputPathsMap map[string]string `json:"InputPathsMap"`
		InputTemplate string            `json:"InputTemplate"`
	} `json:"InputTransformer"`
	RetryPolicy *struct {
		MaximumRetryAttempts     int `json:"MaximumRetryAttempts"`
		MaximumEventAgeInSeconds int `json:"MaximumEventAgeInSeconds"`
	} `json:"RetryPolicy"`
	DeadLetterConfig *struct {
		ARN json.RawMessage `json:"Arn"`
	} `json:"DeadLetterConfig"`
	SqsParameters *struct {
		MessageGroupID string `json:"MessageGroupId"`
	} `json:"SqsParameters"`
}) (RuleTargetSpec, bool, error) {
	for _, ref := range refsIn(declared.ARN) {
		resource, exists := stack.Template.Resources[ref.ID]
		if !exists {
			continue
		}
		spec := RuleTargetSpec{ID: strings.TrimSpace(declared.ID)}
		switch resource.Type {
		case typeLambdaFunction:
			if ref.Attr != "" && ref.Attr != attrArn {
				continue
			}
			name, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  ref.ID,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
			if err != nil {
				return RuleTargetSpec{}, false, err
			}
			spec.Type = "function"
			spec.Function = qualify([]assemblyStack{stack}, stack.Name, ref.ID)
			spec.FunctionName = name
			spec.ARN = "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + name
		case typeSQSQueue:
			if ref.Attr != "" && ref.Attr != attrArn {
				continue
			}
			name, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  ref.ID,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
			if err != nil {
				return RuleTargetSpec{}, false, err
			}
			spec.Type = backendSQS
			spec.Queue = qualify([]assemblyStack{stack}, stack.Name, ref.ID)
			spec.QueueName = name
			spec.ARN = localSourceARN(backendSQS, name)
			if declared.SqsParameters != nil {
				spec.SQSMessageGroupID = strings.TrimSpace(declared.SqsParameters.MessageGroupID)
			}
		case typeSNSTopic:
			if ref.Attr != "" && ref.Attr != attrArn && !strings.EqualFold(ref.Attr, "TopicArn") {
				continue
			}
			name, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  ref.ID,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
			if err != nil {
				return RuleTargetSpec{}, false, err
			}
			spec.Type = "sns"
			spec.Topic = qualify([]assemblyStack{stack}, stack.Name, ref.ID)
			spec.TopicARN = "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + name
			spec.ARN = spec.TopicARN
		default:
			continue
		}
		if declared.SqsParameters != nil && spec.Type != backendSQS {
			return RuleTargetSpec{}, false, unsupported(logicalID, "SqsParameters is only valid on an SQS target")
		}
		if err := applyRuleTargetSettings(&spec, declared.Input, declared.InputPath, declared.InputTransformer, declared.RetryPolicy, declared.DeadLetterConfig, stack, types, logicalID); err != nil {
			return RuleTargetSpec{}, false, err
		}
		return spec, true, nil
	}
	return RuleTargetSpec{}, false, nil
}

//nolint:gocognit,gocyclo // one branch per target setting.
func applyRuleTargetSettings(
	spec *RuleTargetSpec,
	input, inputPath string,
	transformer *struct {
		InputPathsMap map[string]string `json:"InputPathsMap"`
		InputTemplate string            `json:"InputTemplate"`
	},
	retryPolicy *struct {
		MaximumRetryAttempts     int `json:"MaximumRetryAttempts"`
		MaximumEventAgeInSeconds int `json:"MaximumEventAgeInSeconds"`
	},
	deadLetter *struct {
		ARN json.RawMessage `json:"Arn"`
	},
	stack assemblyStack,
	types map[string]string,
	logicalID string,
) error {
	count := 0
	if strings.TrimSpace(input) != "" {
		count++
		if !json.Valid([]byte(input)) {
			return unsupported(logicalID, "EventBridge target Input is not valid JSON")
		}
		spec.Input = input
	}
	if strings.TrimSpace(inputPath) != "" {
		count++
		if !strings.HasPrefix(strings.TrimSpace(inputPath), "$.") {
			return unsupported(logicalID, "EventBridge target InputPath %q must start with $.", inputPath)
		}
		spec.InputPath = strings.TrimSpace(inputPath)
	}
	if transformer != nil {
		count++
		template := strings.TrimSpace(transformer.InputTemplate)
		if template == "" {
			return unsupported(logicalID, "EventBridge target InputTransformer has no InputTemplate")
		}
		for name, path := range transformer.InputPathsMap {
			if !strings.HasPrefix(strings.TrimSpace(path), "$.") {
				return unsupported(logicalID, "EventBridge target InputPathsMap %s=%q must start with $.", name, path)
			}
		}
		spec.InputTransformer = &RuleInputTransformer{
			InputPathsMap: transformer.InputPathsMap,
			InputTemplate: transformer.InputTemplate,
		}
	}
	if count > 1 {
		return unsupported(logicalID, "EventBridge target declares more than one of Input, InputPath and InputTransformer")
	}
	if retryPolicy != nil {
		if retryPolicy.MaximumRetryAttempts < -1 || retryPolicy.MaximumRetryAttempts > 185 {
			return unsupported(logicalID, "EventBridge target MaximumRetryAttempts must be between -1 and 185 (got %d)", retryPolicy.MaximumRetryAttempts)
		}
		if retryPolicy.MaximumEventAgeInSeconds != 0 &&
			(retryPolicy.MaximumEventAgeInSeconds < 60 || retryPolicy.MaximumEventAgeInSeconds > 86400) {
			return unsupported(logicalID, "EventBridge target MaximumEventAgeInSeconds must be between 60 and 86400 (got %d)", retryPolicy.MaximumEventAgeInSeconds)
		}
		spec.RetryPolicy = &RuleRetryPolicy{
			MaximumRetryAttempts:     retryPolicy.MaximumRetryAttempts,
			MaximumEventAgeInSeconds: retryPolicy.MaximumEventAgeInSeconds,
		}
	}
	if deadLetter != nil {
		queue, name, err := resolveDeadLetterQueue(stack, types, deadLetter.ARN)
		if err != nil {
			return unsupported(logicalID, "%s", err.Error())
		}
		spec.DeadLetterQueue = queue
		spec.DeadLetterQueueName = name
	}
	if spec.SQSMessageGroupID != "" && spec.Type != backendSQS {
		return unsupported(logicalID, "SqsParameters is only valid on an SQS target")
	}
	if spec.Type == backendSQS {
		fifo, err := queueIsFIFO(stack, types, spec.QueueName)
		if err != nil {
			return err
		}
		if fifo && spec.SQSMessageGroupID == "" {
			return unsupported(logicalID, "an SQS FIFO target requires SqsParameters.MessageGroupId")
		}
	}
	return nil
}

// resolveDeadLetterQueue follows DeadLetterConfig.Arn to the local standard
// SQS queue AWS requires.
func resolveDeadLetterQueue(stack assemblyStack, types map[string]string, raw json.RawMessage) (string, string, error) {
	for _, ref := range refsIn(raw) {
		resource, ok := stack.Template.Resources[ref.ID]
		if !ok || types[ref.ID] != typeSQSQueue {
			continue
		}
		var props sqsQueueProperties
		_ = json.Unmarshal(resource.Properties, &props) //nolint:errcheck // malformed properties fail at provisioning
		if props.FifoQueue {
			return "", "", fmt.Errorf("an EventBridge dead-letter queue must be a standard SQS queue, got FIFO %s", ref.ID)
		}
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  ref.ID,
			Type:       resource.Type,
			Properties: resource.Properties,
		})
		if err != nil {
			return "", "", err
		}
		return qualify([]assemblyStack{stack}, stack.Name, ref.ID), name, nil
	}
	return "", "", fmt.Errorf("DeadLetterConfig.Arn is not a local SQS queue")
}

func queueIsFIFO(stack assemblyStack, _ map[string]string, queueName string) (bool, error) {
	for id, resource := range stack.Template.Resources {
		if resource.Type != typeSQSQueue {
			continue
		}
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  id,
			Type:       resource.Type,
			Properties: resource.Properties,
		})
		if err != nil || name != queueName {
			continue
		}
		var props sqsQueueProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return false, err
		}
		return props.FifoQueue, nil
	}
	return false, nil
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
		filterPattern := strings.TrimSpace(props.FilterPattern)
		if err := validateCloudWatchFilterPattern(filterPattern); err != nil {
			return unsupported(logicalID, "subscription filter pattern is not supported locally: %v", err)
		}
		distribution := strings.TrimSpace(props.Distribution)
		switch distribution {
		case "", "Random", "ByLogStream":
		default:
			return unsupported(logicalID, "subscription Distribution %q is not a CloudWatch Logs distribution", distribution)
		}
		spec.Subscriptions = append(spec.Subscriptions, SubscriptionSpec{
			LogicalID:       logicalID,
			Stack:           stack.Name,
			Kind:            string(DeliveryKindCloudWatchLogs),
			LogGroup:        subscriptionLogGroup(stack, props.LogGroupName),
			FilterName:      strings.TrimSpace(props.FilterName),
			FilterPattern:   filterPattern,
			Distribution:    distribution,
			Destination:     qualify(stacks, stack.Name, destination.LogicalID),
			DestinationType: destination.Type,
			Function:        qualifyWhenSet(stacks, stack.Name, destination.Function),
			Stream:          qualifyWhenSet(stacks, stack.Name, destination.Stream),
			StreamName:      subscriptionStreamName(stack, types, destination.Stream),
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

// subscriptionLogGroup resolves a filter's LogGroupName: a literal name, the
// physical name of a log group the template references, or the default
// /aws/lambda/<function name> group of a Lambda function.
func subscriptionLogGroup(stack assemblyStack, raw json.RawMessage) string {
	for _, ref := range refsIn(raw) {
		resource, exists := stack.Template.Resources[ref.ID]
		if !exists {
			continue
		}
		switch resource.Type {
		case typeLogGroup:
			return logGroupNameFromResource(stack, ref.ID)
		case typeLambdaFunction:
			return functionLogGroupName(stack, ref.ID)
		case "Custom::LogRetention":
			// CDK's log-retention custom resource carries the function's
			// default group name; its GetAtt LogGroupName is the filter's name.
			return logGroupNameFromResource(stack, ref.ID)
		}
	}
	if id, ok := directRefID(raw); ok {
		resource, exists := stack.Template.Resources[id]
		if !exists {
			return ""
		}
		switch resource.Type {
		case typeLogGroup:
			return logGroupNameFromResource(stack, id)
		case typeLambdaFunction:
			return functionLogGroupName(stack, id)
		}
		return ""
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return flattenLogGroupValue(stack, value)
}

// flattenLogGroupValue resolves a literal or an Fn::Join whose parts are
// literals and Lambda or log-group references. CDK emits
// {"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]} for a function's log group.
func flattenLogGroupValue(stack assemblyStack, value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		if id, ok := typed["Ref"].(string); ok {
			resource, exists := stack.Template.Resources[id]
			if !exists {
				return ""
			}
			switch resource.Type {
			case typeLambdaFunction:
				// The Join already supplies the /aws/lambda/ prefix.
				name, err := resourceName(ResourceSpec{
					Stack:      stack.Name,
					LogicalID:  id,
					Type:       typeLambdaFunction,
					Properties: resource.Properties,
				})
				if err != nil {
					return ""
				}
				return name
			case typeLogGroup:
				return logGroupNameFromResource(stack, id)
			}
			return ""
		}
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
			resolved := flattenLogGroupValue(stack, part)
			if resolved == "" {
				return ""
			}
			builder.WriteString(resolved)
			builder.WriteString(delimiter)
		}
		return strings.TrimSuffix(builder.String(), delimiter)
	default:
		return ""
	}
}

// logGroupNameFromResource resolves a log group resource's LogGroupName,
// including the Fn::Join a Lambda function's default group uses.
func logGroupNameFromResource(stack assemblyStack, id string) string {
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return ""
	}
	var props struct {
		LogGroupName json.RawMessage `json:"LogGroupName"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return ""
		}
	}
	var value any
	if err := json.Unmarshal(props.LogGroupName, &value); err != nil {
		return ""
	}
	if name := flattenLogGroupValue(stack, value); name != "" {
		return name
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

func functionLogGroupName(stack assemblyStack, id string) string {
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return ""
	}
	name, err := resourceName(ResourceSpec{
		Stack:      stack.Name,
		LogicalID:  id,
		Type:       typeLambdaFunction,
		Properties: resource.Properties,
	})
	if err != nil {
		return ""
	}
	return "/aws/lambda/" + name
}

// subscriptionStreamName resolves the physical name of the Kinesis stream a
// subscription forwards to.
func subscriptionStreamName(stack assemblyStack, types map[string]string, streamID string) string {
	if streamID == "" || types[streamID] != typeKinesisStream {
		return ""
	}
	resource, ok := stack.Template.Resources[streamID]
	if !ok {
		return ""
	}
	name, err := resourceName(ResourceSpec{
		Stack:      stack.Name,
		LogicalID:  streamID,
		Type:       typeKinesisStream,
		Properties: resource.Properties,
	})
	if err != nil {
		return ""
	}
	return name
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

// applyStreamMappingOptions validates the DynamoDB Streams and Kinesis mapping
// configuration AWS rejects and records the settings plan and describe report.
//
// The rules are the EventSourceMappingConfiguration API
// (https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html),
// "Using AWS Lambda with Amazon DynamoDB"
// (https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html) and "Using Lambda
// to process records from Amazon Kinesis Data Streams"
// (https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html).
func applyStreamMappingOptions(eventSource *EventSourceSpec, props eventSourceMappingProperties, sourceProperties json.RawMessage, stack assemblyStack) error {
	eventSource.MaximumBatchingWindowInSeconds = props.MaximumBatchingWindowInSeconds
	if props.BisectBatchOnFunctionError != nil {
		eventSource.BisectBatchOnFunctionError = *props.BisectBatchOnFunctionError
	}
	eventSource.MaximumRetryAttempts = streamUnlimitedRetries
	if props.MaximumRetryAttempts != nil {
		eventSource.MaximumRetryAttempts = *props.MaximumRetryAttempts
		eventSource.RetryAttemptsSet = true
	}
	if props.MaximumRecordAgeInSeconds != nil {
		eventSource.MaximumRecordAgeInSeconds = *props.MaximumRecordAgeInSeconds
	}
	eventSource.ParallelizationFactor = 1
	if props.ParallelizationFactor != nil {
		eventSource.ParallelizationFactor = *props.ParallelizationFactor
	}
	if props.TumblingWindowInSeconds != nil && *props.TumblingWindowInSeconds > 0 {
		// TumblingWindowInSeconds aggregates records across invocations. No
		// example uses it; refuse it by name rather than deliver an event the
		// handler does not expect.
		return unsupported(eventSource.LogicalID, "TumblingWindowInSeconds is not implemented locally")
	}
	if props.StartingPositionTimestamp != nil {
		eventSource.StartingPositionTimestamp = *props.StartingPositionTimestamp
	}
	switch eventSource.Type {
	case backendDynamoDB:
		if err := applyDynamoTableMappingOptions(eventSource, sourceProperties); err != nil {
			return err
		}
	case backendKinesis:
		eventSource.StartingPosition = normalizeStartingPosition(eventSource.StartingPosition)
	}
	if err := validateStreamMappingOptions(eventSource); err != nil {
		return err
	}
	filters, err := normalizeEventFilterCriteria(props.FilterCriteria, eventSource.LogicalID)
	if err != nil {
		return err
	}
	eventSource.FilterCriteria = filters
	destinationType, destinationName, destinationARN, err := resolveStreamDestination(stack, eventSource.LogicalID, props.DestinationConfig)
	if err != nil {
		return err
	}
	eventSource.DestinationType = destinationType
	eventSource.DestinationName = destinationName
	eventSource.DestinationARN = destinationARN
	return nil
}

// applyDynamoTableMappingOptions reads the table's stream view, hash key and TTL
// setting from the table resource the mapping reads.
func applyDynamoTableMappingOptions(eventSource *EventSourceSpec, sourceProperties json.RawMessage) error {
	var props dynamoTableProperties
	if len(sourceProperties) > 0 {
		if err := json.Unmarshal(sourceProperties, &props); err != nil {
			return fmt.Errorf("%s: parse DynamoDB table properties: %w", eventSource.LogicalID, err)
		}
	}
	eventSource.StreamViewType = strings.TrimSpace(props.StreamSpecification.StreamViewType)
	if eventSource.StreamViewType == "" {
		eventSource.StreamViewType = "NEW_AND_OLD_IMAGES"
	}
	for _, key := range props.KeySchema {
		if strings.EqualFold(key.KeyType, "HASH") {
			eventSource.PartitionKey = key.AttributeName
			break
		}
	}
	if props.TimeToLiveSpecification.Enabled {
		eventSource.TTLAttribute = strings.TrimSpace(props.TimeToLiveSpecification.AttributeName)
	}
	eventSource.StartingPosition = normalizeStartingPosition(eventSource.StartingPosition)
	return nil
}

func normalizeStartingPosition(position string) string {
	trimmed := strings.ToUpper(strings.TrimSpace(position))
	switch trimmed {
	case "", dynamoStreamIteratorTrimHorizon:
		return dynamoStreamIteratorTrimHorizon
	case dynamoStreamIteratorLatest:
		return dynamoStreamIteratorLatest
	case iteratorAtTimestamp:
		return "AT_TIMESTAMP"
	default:
		return trimmed
	}
}

// validateStreamMappingOptions applies the documented ranges.
//
//nolint:gocyclo // the documented ranges are one switch.
func validateStreamMappingOptions(eventSource *EventSourceSpec) error {
	switch eventSource.Type {
	case backendDynamoDB:
		if eventSource.StartingPosition != dynamoStreamIteratorTrimHorizon && eventSource.StartingPosition != dynamoStreamIteratorLatest {
			return unsupported(eventSource.LogicalID, "DynamoDB StartingPosition must be TRIM_HORIZON or LATEST (got %q)", eventSource.StartingPosition)
		}
	case backendKinesis:
		switch eventSource.StartingPosition {
		case dynamoStreamIteratorTrimHorizon, dynamoStreamIteratorLatest:
		case iteratorAtTimestamp:
			if eventSource.StartingPositionTimestamp <= 0 {
				return unsupported(eventSource.LogicalID, "Kinesis StartingPosition AT_TIMESTAMP requires StartingPositionTimestamp")
			}
		default:
			return unsupported(eventSource.LogicalID, "Kinesis StartingPosition must be TRIM_HORIZON, LATEST or AT_TIMESTAMP (got %q)", eventSource.StartingPosition)
		}
	}
	batchSize := eventSource.BatchSize
	window := eventSource.MaximumBatchingWindowInSeconds
	switch {
	case batchSize < 1 || batchSize > 10000:
		return unsupported(eventSource.LogicalID, "stream BatchSize must be between 1 and 10000 (got %d)", batchSize)
	case window < 0 || window > 300:
		return unsupported(eventSource.LogicalID, "stream MaximumBatchingWindowInSeconds must be between 0 and 300 (got %d)", window)
	case eventSource.ParallelizationFactor < 1 || eventSource.ParallelizationFactor > 10:
		return unsupported(eventSource.LogicalID, "ParallelizationFactor must be between 1 and 10 (got %d)", eventSource.ParallelizationFactor)
	case eventSource.MaximumRetryAttempts < -1 || eventSource.MaximumRetryAttempts > 10000:
		return unsupported(eventSource.LogicalID, "MaximumRetryAttempts must be between -1 and 10000 (got %d)", eventSource.MaximumRetryAttempts)
	case eventSource.MaximumRecordAgeInSeconds != 0 &&
		(eventSource.MaximumRecordAgeInSeconds != -1 && (eventSource.MaximumRecordAgeInSeconds < 60 || eventSource.MaximumRecordAgeInSeconds > 604800)):
		return unsupported(eventSource.LogicalID, "MaximumRecordAgeInSeconds must be -1 or between 60 and 604800 (got %d)", eventSource.MaximumRecordAgeInSeconds)
	}
	return nil
}

// resolveStreamDestination follows DestinationConfig.OnFailure to the local SQS
// queue or SNS topic it names.
//
// https://docs.aws.amazon.com/lambda/latest/dg/API_OnFailure.html
//
//nolint:gocyclo // one branch per destination type.
func resolveStreamDestination(stack assemblyStack, logicalID string, config *struct {
	OnFailure *struct {
		Destination json.RawMessage `json:"Destination"`
	} `json:"OnFailure"`
}) (string, string, string, error) {
	if config == nil || config.OnFailure == nil || len(config.OnFailure.Destination) == 0 {
		return "", "", "", nil
	}
	raw := config.OnFailure.Destination
	for _, ref := range refsIn(raw) {
		resource, ok := stack.Template.Resources[ref.ID]
		if !ok {
			continue
		}
		switch resource.Type {
		case typeSQSQueue:
			if ref.Attr != "" && ref.Attr != attrArn {
				return "", "", "", unsupported(logicalID, "on-failure SQS destination must reference the queue Arn or Ref, got %q", ref.Attr)
			}
			name, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  ref.ID,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
			if err != nil {
				return "", "", "", err
			}
			return backendSQS, name, localSourceARN(backendSQS, name), nil
		case typeSNSTopic:
			if ref.Attr != "" && ref.Attr != attrArn && !strings.EqualFold(ref.Attr, "TopicArn") {
				return "", "", "", unsupported(logicalID, "on-failure SNS destination must reference the topic ARN, got %q", ref.Attr)
			}
			name, err := resourceName(ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  ref.ID,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
			if err != nil {
				return "", "", "", err
			}
			arn := "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + name
			return backendSNS, name, arn, nil
		}
	}
	// A literal destination ARN names its queue or topic directly.
	if literal := resolvedString(raw); literal != "" {
		switch {
		case strings.HasPrefix(literal, "arn:"+LocalPartition+":sqs:"):
			return backendSQS, arnName(literal), literal, nil
		case strings.HasPrefix(literal, "arn:"+LocalPartition+":sns:"):
			return backendSNS, arnName(literal), literal, nil
		}
	}
	return "", "", "", unsupported(logicalID, "on-failure destination is not a local SQS queue or SNS topic")
}
