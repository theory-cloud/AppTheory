package localrunner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// S3 event notifications.
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html
//
// A bucket's notification configuration declares up to four destination kinds:
// Lambda functions, SQS queues, SNS topics and (with the empty
// EventBridgeConfiguration object) EventBridge. The configuration's Event
// values carry AWS's s3: prefix (for example s3:ObjectCreated:*); the record the
// destination receives names the event without the prefix (ObjectCreated:Put).
// The local watcher observes creates and deletes only, so an event name it
// cannot produce is refused at plan time instead of being accepted and never
// firing.
//
// Two template shapes carry the configuration:
//
//   - AWS::S3::Bucket.NotificationConfiguration, the CloudFormation property
//     with one Event per entry and a Filter.S3Key rule list.
//   - Custom::S3BucketNotifications.NotificationConfiguration, the shape CDK's
//     Bucket.addEventNotification emits. The custom resource calls
//     PutBucketNotificationConfiguration at deploy time, so the configuration
//     never appears on the bucket resource itself. Its properties are the
//     bucket API's shape: Events, LambdaFunctionArn/QueueArn/TopicArn and
//     Filter.Key.FilterRules.
//
// The runner reads both, so an L2 declaration and an L1 escape hatch are served
// the same way.

const (
	notificationDestinationFunction    = "function"
	notificationDestinationQueue       = "queue"
	notificationDestinationTopic       = "topic"
	notificationDestinationEventBridge = "eventbridge"
	// typeBucketNotifications is the custom resource CDK emits for
	// Bucket.addEventNotification.
	typeBucketNotifications = "Custom::S3BucketNotifications"
)

// s3ProducibleEvents is the set of notification event names the local watcher
// can produce: an observed create is reported as ObjectCreated:Put and an
// observed delete as ObjectRemoved:Delete. Every other event type S3 defines
// (Copy, CompleteMultipartUpload, Post, DeleteMarkerCreated, ObjectRestore,
// ObjectTagging, ObjectAcl, LifecycleExpiration, LifecycleTransition,
// IntelligentTiering, Replication and ReducedRedundancyLostObject) would be
// accepted and silently never fire, so it is refused at derive time.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html
var s3ProducibleEvents = []string{
	"s3:ObjectCreated:*",
	"s3:ObjectCreated:Put",
	"s3:ObjectRemoved:*",
	"s3:ObjectRemoved:Delete",
}

// NotificationFilterRule is one prefix or suffix rule of a notification's key
// filter.
type NotificationFilterRule struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// NotificationSpec is one destination of a bucket's notification configuration.
// A bucket with two SQS entries and one Lambda entry produces three specs, so
// plan and describe report each destination separately.
type NotificationSpec struct {
	// LogicalID is the qualified id plan and describe report. It is stable:
	// <bucket>/notification/<index>.
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Bucket    string `json:"bucket"`
	// BucketName is the physical bucket name the run provisioned.
	BucketName string `json:"bucketName"`
	// ConfigurationID is the id recorded in the notification's
	// s3.configurationId. AWS assigns one when the configuration is applied.
	ConfigurationID string `json:"configurationId"`
	// DestinationType is function, queue, topic or eventbridge.
	DestinationType string `json:"destinationType"`
	// Destination is the qualified logical id of the target resource.
	Destination string `json:"destination"`
	// DestinationARN is the provider ARN the template declares for the target.
	DestinationARN string `json:"destinationArn,omitempty"`
	// DestinationName is the physical name delivery needs: a function name, a
	// queue name or a topic ARN.
	DestinationName string `json:"destinationName,omitempty"`
	// Events are the declared event names with their s3: prefix, verbatim.
	Events []string `json:"events,omitempty"`
	// FilterRules are the prefix/suffix rules, in declared order.
	FilterRules []NotificationFilterRule `json:"filterRules,omitempty"`
	// EventBridge is true for the bucket's EventBridgeConfiguration.
	EventBridge bool `json:"eventBridge,omitempty"`
}

type s3NotificationProperties struct {
	NotificationConfiguration *cfnNotificationConfiguration `json:"NotificationConfiguration"`
}

// cfnNotificationConfiguration is the AWS::S3::Bucket property shape.
type cfnNotificationConfiguration struct {
	LambdaConfigurations []struct {
		Event    string                    `json:"Event"`
		Function json.RawMessage           `json:"Function"`
		Filter   *cfnNotificationKeyFilter `json:"Filter"`
	} `json:"LambdaConfigurations"`
	QueueConfigurations []struct {
		Event  string                    `json:"Event"`
		Queue  json.RawMessage           `json:"Queue"`
		Filter *cfnNotificationKeyFilter `json:"Filter"`
	} `json:"QueueConfigurations"`
	TopicConfigurations []struct {
		Event  string                    `json:"Event"`
		Topic  json.RawMessage           `json:"Topic"`
		Filter *cfnNotificationKeyFilter `json:"Filter"`
	} `json:"TopicConfigurations"`
	EventBridgeConfiguration json.RawMessage `json:"EventBridgeConfiguration"`
}

type cfnNotificationKeyFilter struct {
	S3Key struct {
		Rules []struct {
			Name  string `json:"Name"`
			Value string `json:"Value"`
		} `json:"Rules"`
	} `json:"S3Key"`
}

// bucketNotificationConfiguration is the custom resource's shape, which is the
// S3 PutBucketNotificationConfiguration API shape.
type bucketNotificationConfiguration struct {
	LambdaFunctionConfigurations []struct {
		Events            []string                     `json:"Events"`
		LambdaFunctionArn json.RawMessage              `json:"LambdaFunctionArn"`
		Filter            *bucketNotificationKeyFilter `json:"Filter"`
	} `json:"LambdaFunctionConfigurations"`
	QueueConfigurations []struct {
		Events   []string                     `json:"Events"`
		QueueArn json.RawMessage              `json:"QueueArn"`
		Filter   *bucketNotificationKeyFilter `json:"Filter"`
	} `json:"QueueConfigurations"`
	TopicConfigurations []struct {
		Events   []string                     `json:"Events"`
		TopicArn json.RawMessage              `json:"TopicArn"`
		Filter   *bucketNotificationKeyFilter `json:"Filter"`
	} `json:"TopicConfigurations"`
	EventBridgeConfiguration json.RawMessage `json:"EventBridgeConfiguration"`
}

type bucketNotificationKeyFilter struct {
	Key struct {
		FilterRules []struct {
			Name  string `json:"Name"`
			Value string `json:"Value"`
		} `json:"FilterRules"`
	} `json:"Key"`
}

// notificationBuilder assigns the stable per-bucket entry indexes.
type notificationBuilder struct {
	spec    *Spec
	stacks  []assemblyStack
	indexes map[string]int
}

func (b *notificationBuilder) next(bucketID, stack, bucketName string) NotificationSpec {
	index := b.indexes[bucketID]
	b.indexes[bucketID] = index + 1
	return NotificationSpec{
		LogicalID:       fmt.Sprintf("%s/notification/%d", bucketID, index),
		Stack:           stack,
		Bucket:          bucketID,
		BucketName:      bucketName,
		ConfigurationID: notificationConfigurationID(bucketName, index),
	}
}

// deriveS3Notifications reads every bucket notification configuration the stack
// declares, in both template shapes. A destination the runner cannot resolve
// fails closed at plan time.
func deriveS3Notifications(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	types := stack.resourceTypes()
	start := len(spec.Notifications)
	builder := &notificationBuilder{spec: spec, stacks: stacks, indexes: map[string]int{}}

	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeS3Bucket {
			continue
		}
		if err := deriveBucketResourceNotifications(builder, stack, types, id, resource); err != nil {
			return err
		}
	}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeBucketNotifications {
			continue
		}
		if err := deriveBucketCustomResourceNotifications(builder, stack, types, id, resource); err != nil {
			return err
		}
	}
	return validateNotificationOverlaps(spec.Notifications[start:])
}

func deriveBucketResourceNotifications(
	builder *notificationBuilder,
	stack assemblyStack,
	types map[string]string,
	id string,
	resource templateResource,
) error {
	var props s3NotificationProperties
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse S3 bucket properties: %w", stack.Name, id, err)
		}
	}
	config := props.NotificationConfiguration
	if config == nil {
		return nil
	}
	bucketName, err := resourceName(ResourceSpec{
		Stack: stack.Name, LogicalID: id, Type: resource.Type, Properties: resource.Properties,
	})
	if err != nil {
		return fmt.Errorf("%s/%s: %w", stack.Name, id, err)
	}
	bucketID := qualify(builder.stacks, stack.Name, id)

	add := func(destinationType string, events []string, raw json.RawMessage, rules []NotificationFilterRule) error {
		return builder.add(stack, id, types, bucketID, bucketName, destinationType, events, raw, rules)
	}

	for _, entry := range config.LambdaConfigurations {
		if err := add(notificationDestinationFunction, []string{entry.Event}, entry.Function, cfnFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	for _, entry := range config.QueueConfigurations {
		if err := add(notificationDestinationQueue, []string{entry.Event}, entry.Queue, cfnFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	for _, entry := range config.TopicConfigurations {
		if err := add(notificationDestinationTopic, []string{entry.Event}, entry.Topic, cfnFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	if len(strings.TrimSpace(string(config.EventBridgeConfiguration))) > 0 {
		appendEventBridgeNotification(builder, bucketID, stack.Name, bucketName)
	}
	return nil
}

func deriveBucketCustomResourceNotifications(
	builder *notificationBuilder,
	stack assemblyStack,
	types map[string]string,
	id string,
	resource templateResource,
) error {
	var props struct {
		BucketName                json.RawMessage                  `json:"BucketName"`
		NotificationConfiguration *bucketNotificationConfiguration `json:"NotificationConfiguration"`
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return fmt.Errorf("%s/%s: parse bucket notification properties: %w", stack.Name, id, err)
	}
	if props.NotificationConfiguration == nil {
		return nil
	}
	bucketID, ok := directRefID(props.BucketName)
	if !ok || types[bucketID] != typeS3Bucket {
		return unsupported(stack.Name+"/"+id, "bucket notifications do not reference an AWS::S3::Bucket")
	}
	bucketName, err := resourceName(ResourceSpec{
		Stack: stack.Name, LogicalID: bucketID, Type: typeS3Bucket,
		Properties: stack.Template.Resources[bucketID].Properties,
	})
	if err != nil {
		return fmt.Errorf("%s/%s: %w", stack.Name, id, err)
	}
	qualifiedBucket := qualify(builder.stacks, stack.Name, bucketID)
	config := props.NotificationConfiguration

	add := func(destinationType string, events []string, raw json.RawMessage, rules []NotificationFilterRule) error {
		return builder.add(stack, id, types, qualifiedBucket, bucketName, destinationType, events, raw, rules)
	}

	for _, entry := range config.LambdaFunctionConfigurations {
		if err := add(notificationDestinationFunction, entry.Events, entry.LambdaFunctionArn, bucketFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	for _, entry := range config.QueueConfigurations {
		if err := add(notificationDestinationQueue, entry.Events, entry.QueueArn, bucketFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	for _, entry := range config.TopicConfigurations {
		if err := add(notificationDestinationTopic, entry.Events, entry.TopicArn, bucketFilterRules(entry.Filter)); err != nil {
			return err
		}
	}
	if len(strings.TrimSpace(string(config.EventBridgeConfiguration))) > 0 {
		appendEventBridgeNotification(builder, qualifiedBucket, stack.Name, bucketName)
	}
	return nil
}

// add appends one resolved destination configuration.
func (b *notificationBuilder) add(
	stack assemblyStack,
	resourceID string,
	types map[string]string,
	bucketID, bucketName, destinationType string,
	events []string,
	raw json.RawMessage,
	rules []NotificationFilterRule,
) error {
	target, err := resolveNotificationTarget(stack, types, destinationType, raw)
	if err != nil {
		return unsupported(stack.Name+"/"+resourceID, "%v", err)
	}
	notification := b.next(bucketID, stack.Name, bucketName)
	notification.DestinationType = destinationType
	notification.Destination = qualify(b.stacks, stack.Name, target.logicalID)
	notification.DestinationARN = target.value.ARN
	notification.DestinationName = target.value.Name
	notification.Events = events
	notification.FilterRules = rules
	if err := validateNotificationSpec(notification); err != nil {
		return unsupported(stack.Name+"/"+resourceID, "%v", err)
	}
	b.spec.Notifications = append(b.spec.Notifications, notification)
	return nil
}

func appendEventBridgeNotification(builder *notificationBuilder, bucketID, stack, bucketName string) {
	notification := builder.next(bucketID, stack, bucketName)
	notification.DestinationType = notificationDestinationEventBridge
	notification.Destination = bucketID
	notification.DestinationName = bucketName
	notification.EventBridge = true
	notification.Events = []string{"s3:ObjectCreated:*", "s3:ObjectRemoved:*"}
	builder.spec.Notifications = append(builder.spec.Notifications, notification)
}

func cfnFilterRules(filter *cfnNotificationKeyFilter) []NotificationFilterRule {
	if filter == nil {
		return nil
	}
	rules := make([]NotificationFilterRule, 0, len(filter.S3Key.Rules))
	for _, rule := range filter.S3Key.Rules {
		rules = append(rules, NotificationFilterRule{Name: strings.TrimSpace(rule.Name), Value: rule.Value})
	}
	return rules
}

func bucketFilterRules(filter *bucketNotificationKeyFilter) []NotificationFilterRule {
	if filter == nil {
		return nil
	}
	rules := make([]NotificationFilterRule, 0, len(filter.Key.FilterRules))
	for _, rule := range filter.Key.FilterRules {
		rules = append(rules, NotificationFilterRule{Name: strings.TrimSpace(rule.Name), Value: rule.Value})
	}
	return rules
}

// notificationTarget is a resolved destination resource.
type notificationTarget struct {
	logicalID string
	value     resourceValue
}

// resolveNotificationTarget resolves the destination reference to the resource
// that holds its physical name and ARN.
func resolveNotificationTarget(stack assemblyStack, types map[string]string, destinationType string, raw json.RawMessage) (notificationTarget, error) {
	resourceType := typeLambdaFunction
	attributes := []string{"Arn"}
	switch destinationType {
	case notificationDestinationQueue:
		resourceType = typeSQSQueue
		attributes = []string{"Arn"}
	case notificationDestinationTopic:
		resourceType = typeSNSTopic
		attributes = []string{"TopicArn", "Arn"}
	}
	id, ok := findRefByType(raw, types, resourceType, attributes...)
	if !ok && destinationType == notificationDestinationTopic {
		// A `Ref` on an AWS::SNS::Topic resolves to the topic ARN and carries no
		// GetAtt attribute; findRefByType already accepts a bare reference.
		id, ok = findRefByType(raw, types, resourceType)
	}
	if !ok {
		return notificationTarget{}, fmt.Errorf(
			"%s notification destination is not a %s the runner can resolve",
			destinationType, resourceType,
		)
	}
	resource := stack.Template.Resources[id]
	name, err := resourceName(ResourceSpec{
		Stack: stack.Name, LogicalID: id, Type: resource.Type, Properties: resource.Properties,
	})
	if err != nil {
		return notificationTarget{}, err
	}
	arn := notificationTargetARN(destinationType, id, resource, name)
	return notificationTarget{
		logicalID: id,
		value:     resourceValue{Type: resourceType, Name: name, ARN: arn},
	}, nil
}

// notificationTargetARN derives the ARN shape AWS documents for each
// destination. The runner's own provisioning uses the same shapes.
func notificationTargetARN(destinationType, _ string, resource templateResource, name string) string {
	if destinationType == notificationDestinationFunction {
		var props struct {
			FunctionName string `json:"FunctionName"`
		}
		_ = json.Unmarshal(resource.Properties, &props) //nolint:errcheck // a missing name falls back to the derived one
		if strings.TrimSpace(props.FunctionName) != "" {
			name = strings.TrimSpace(props.FunctionName)
		}
		return "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + name
	}
	if destinationType == notificationDestinationQueue {
		return "arn:" + LocalPartition + ":sqs:" + LocalRegion + ":" + LocalAccountID + ":" + name
	}
	return "arn:" + LocalPartition + ":sns:" + LocalRegion + ":" + LocalAccountID + ":" + name
}

// notificationConfigurationID is the s3.configurationId the record carries. AWS
// assigns it when the notification configuration is applied; the local run
// derives a stable one from the bucket and the entry position.
func notificationConfigurationID(bucket string, index int) string {
	return "local-" + stableHash(bucket+"/"+fmt.Sprint(index), 16)
}

// validateNotificationSpec refuses a configuration the runner cannot reproduce.
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html
func validateNotificationSpec(notification NotificationSpec) error {
	if len(notification.FilterRules) > 2 {
		return fmt.Errorf(
			"%s declares %d key filter rules; S3 accepts at most one prefix and one suffix",
			notification.LogicalID, len(notification.FilterRules),
		)
	}
	seen := map[string]struct{}{}
	for _, rule := range notification.FilterRules {
		name := strings.ToLower(strings.TrimSpace(rule.Name))
		if name != "prefix" && name != "suffix" {
			return fmt.Errorf("%s filter rule %q is not prefix or suffix", notification.LogicalID, rule.Name)
		}
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("%s declares the %s filter twice", notification.LogicalID, name)
		}
		seen[name] = struct{}{}
		if strings.Contains(rule.Value, "*") {
			return fmt.Errorf(
				"%s %s filter value %q contains a wildcard; an S3 notification filter prefix or suffix cannot contain a wildcard "+
					"(https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html)",
				notification.LogicalID, name, rule.Value,
			)
		}
	}
	if notification.EventBridge {
		return nil
	}
	if len(notification.Events) == 0 {
		return fmt.Errorf("%s declares no Event", notification.LogicalID)
	}
	for _, event := range notification.Events {
		if !strings.HasPrefix(event, "s3:") {
			return fmt.Errorf(
				"%s event %q must carry the s3: prefix the notification configuration uses",
				notification.LogicalID, event,
			)
		}
		if !containsStringList(s3ProducibleEvents, event) {
			return fmt.Errorf(
				"%s event %q is not supported locally: the local watcher observes creates and deletes only (producible events: %s)",
				notification.LogicalID, event, strings.Join(s3ProducibleEvents, ", "),
			)
		}
	}
	return nil
}

// validateNotificationOverlaps refuses filter combinations AWS rejects on one
// bucket. Two configurations with intersecting event types may not have both
// overlapping prefixes and overlapping suffixes:
//
//	https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html
//
// The page: "Your notification configurations that use Filter can't define
// filtering rules with overlapping prefixes for the same event types. They can
// only do so, if the overlapping prefixes that are used with suffixes that
// don't overlap." A missing rule is the root filter, which "match[es] any other
// prefix and suffix"; prefixes overlap when one is a prefix of the other ("If a
// given string can begin with both prefixes, the two prefixes are considered
// overlapping") and suffixes overlap when one is a suffix of the other. Pairs
// with disjoint event types may overlap: "You can use overlapping object key
// name filters with different event types."
//
// The EventBridge configuration carries no filter rules and is not part of the
// page's rule, so it is exempt.
func validateNotificationOverlaps(notifications []NotificationSpec) error {
	byBucket := map[string][]NotificationSpec{}
	for _, notification := range notifications {
		if notification.EventBridge {
			continue
		}
		byBucket[notification.Bucket] = append(byBucket[notification.Bucket], notification)
	}
	for _, bucket := range sortedKeys(byBucket) {
		entries := byBucket[bucket]
		for i := 0; i < len(entries); i++ {
			for j := i + 1; j < len(entries); j++ {
				event, shared := s3NotificationSharedEvent(entries[i].Events, entries[j].Events)
				if !shared {
					continue
				}
				if !notificationPrefixesOverlap(entries[i], entries[j]) ||
					!notificationSuffixesOverlap(entries[i], entries[j]) {
					continue
				}
				return fmt.Errorf(
					"%s and %s declare overlapping prefix/suffix filters for the same event type %s; "+
						"S3 rejects this notification configuration: "+
						"https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html",
					entries[i].LogicalID, entries[j].LogicalID, event,
				)
			}
		}
	}
	return nil
}

// s3NotificationEventKinds maps a declared event name to the concrete events
// the local watcher can produce for it. s3:ObjectCreated:* covers
// s3:ObjectCreated:Put, so configurations declaring the wildcard family and the
// concrete event share an event type.
func s3NotificationEventKinds(events []string) map[string]struct{} {
	kinds := map[string]struct{}{}
	for _, event := range events {
		switch strings.TrimSpace(event) {
		case "s3:ObjectCreated:*", "s3:ObjectCreated:Put":
			kinds[s3RecordObjectCreatedPut] = struct{}{}
		case "s3:ObjectRemoved:*", "s3:ObjectRemoved:Delete":
			kinds[s3RecordObjectRemovedDelete] = struct{}{}
		}
	}
	return kinds
}

// s3NotificationSharedEvent returns the first event type two configurations
// share, if any.
func s3NotificationSharedEvent(a, b []string) (string, bool) {
	aKinds := s3NotificationEventKinds(a)
	for _, event := range b {
		for kind := range s3NotificationEventKinds([]string{event}) {
			if _, shared := aKinds[kind]; shared {
				return "s3:" + kind, true
			}
		}
	}
	return "", false
}

// notificationPrefixesOverlap reports whether a key can begin with both
// configurations' prefixes. A configuration without a prefix rule has the root
// prefix, which matches any other prefix.
func notificationPrefixesOverlap(a, b NotificationSpec) bool {
	aPrefix, aSet := notificationFilterValue(a.FilterRules, "prefix")
	bPrefix, bSet := notificationFilterValue(b.FilterRules, "prefix")
	if !aSet || !bSet {
		return true
	}
	return strings.HasPrefix(aPrefix, bPrefix) || strings.HasPrefix(bPrefix, aPrefix)
}

// notificationSuffixesOverlap reports whether a key can end with both
// configurations' suffixes. A configuration without a suffix rule has the root
// suffix, which matches any other suffix.
func notificationSuffixesOverlap(a, b NotificationSpec) bool {
	aSuffix, aSet := notificationFilterValue(a.FilterRules, "suffix")
	bSuffix, bSet := notificationFilterValue(b.FilterRules, "suffix")
	if !aSet || !bSet {
		return true
	}
	return strings.HasSuffix(aSuffix, bSuffix) || strings.HasSuffix(bSuffix, aSuffix)
}

func notificationFilterValue(rules []NotificationFilterRule, name string) (string, bool) {
	for _, rule := range rules {
		if strings.EqualFold(strings.TrimSpace(rule.Name), name) {
			return rule.Value, true
		}
	}
	return "", false
}

// SortNotifications orders the derived configurations for stable output.
func SortNotifications(notifications []NotificationSpec) {
	sort.Slice(notifications, func(i, j int) bool { return notifications[i].LogicalID < notifications[j].LogicalID })
}
