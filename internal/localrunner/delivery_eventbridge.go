package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// The EventBridge deliverer fires one rule. A scheduled rule fires on the run
// clock; a pattern rule registers on the runner's bus and receives every
// matching PutEvents entry. Targets, input shaping, retries and dead-letter
// delivery are the documented behaviors:
//
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-transform-target-input.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html
// https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html
//
// A target failure is retried on the run clock: the first retry is after ten
// seconds, the delay doubles and is capped at five minutes, and the target's
// RetryPolicy bounds the attempts and the event age. When the retry budget is
// exhausted, or the event is older than MaximumEventAgeInSeconds, the shaped
// payload goes to the target's standard SQS dead-letter queue with the
// documented attributes RULE_ARN, TARGET_ARN, ERROR_CODE, ERROR_MESSAGE,
// EXHAUSTED_RETRY_CONDITION and RETRY_ATTEMPTS.
//
// Local note: AWS invokes a Lambda target asynchronously, so the Lambda service
// accepts the invocation even when the handler fails and the handler error
// follows Lambda's async retry/DLQ path. The local runner treats a handler
// error as the target's failure so the EventBridge retry and DLQ behavior is
// observable on a real row; the difference is documented.

const (
	eventBridgeDefaultMaxRetries = 185
	eventBridgeDefaultMaxAge     = 86400 * time.Second
	eventBridgeRetryBase         = 10 * time.Second
	eventBridgeRetryMaximum      = 5 * time.Minute
	eventBridgeConditionRetries  = "MaximumRetryAttempts"
	eventBridgeConditionAge      = "MaximumEventAgeInSeconds"
	eventBridgeErrorFromTarget   = "ERROR_FROM_TARGET"
	eventBridgeConnectionFailure = "CONNECTION_FAILURE"
)

// EventBridgeDeliverer delivers one EventBridge rule.
type EventBridgeDeliverer struct {
	source   DeliverySource
	rule     RuleSpec
	bus      *eventBridgeBus
	schedule scheduleSpec
	env      DelivererEnv
}

// NewEventBridgeDeliverer builds the deliverer for one registered rule.
func NewEventBridgeDeliverer(source DeliverySource, bus *eventBridgeBus) (Deliverer, error) {
	if source.Rule == nil {
		return nil, fmt.Errorf("source %s is not an EventBridge rule", source.ID)
	}
	rule := *source.Rule
	var schedule scheduleSpec
	if strings.TrimSpace(rule.Schedule) != "" {
		parsed, err := parseScheduleExpression(rule.Schedule)
		if err != nil {
			return nil, fmt.Errorf("rule %s: %w", source.ID, err)
		}
		schedule = parsed
	}
	return &EventBridgeDeliverer{source: source, rule: rule, bus: bus, schedule: schedule}, nil
}

// Start arms a schedule or registers a pattern rule on its bus.
func (d *EventBridgeDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	d.env = env
	if !d.rule.Enabled {
		env.State.SetPaused(true)
		env.State.SetPhase(DeliveryPhasePaused)
		<-ctx.Done()
		return nil
	}
	env.State.SetPaused(false)
	if strings.TrimSpace(d.rule.Schedule) != "" {
		env.State.SetPhase(DeliveryPhaseArmed)
		return d.runSchedule(ctx)
	}
	if d.bus == nil {
		return errors.New("the EventBridge rule has no local bus")
	}
	runtime := &eventBridgeRuleRuntime{
		rule: d.rule,
		fire: func(ctx context.Context, event map[string]any) {
			d.fireRuleEvent(ctx, event)
		},
	}
	runtime.setActive(true)
	d.bus.register(runtime)
	defer d.bus.unregister(runtime)
	env.State.SetPhase(DeliveryPhaseArmed)
	<-ctx.Done()
	return nil
}

// runSchedule fires every due occurrence on the run clock.
func (d *EventBridgeDeliverer) runSchedule(ctx context.Context) error {
	next, err := d.schedule.next(d.env.Clock.Now())
	if err != nil {
		return err
	}
	for {
		if ctx.Err() != nil {
			return nil
		}
		now := d.env.Clock.Now()
		if next.After(now) {
			waitClock(ctx, d.env.Clock, next.Sub(now))
			if ctx.Err() != nil {
				return nil
			}
			now = d.env.Clock.Now()
		}
		for !next.After(now) {
			d.fireScheduled(ctx, next)
			following, err := d.schedule.next(next)
			if err != nil {
				d.env.State.Failed(err)
				d.env.State.SetPhase(DeliveryPhaseFailed)
				return err
			}
			next = following
		}
	}
}

// fireScheduled delivers the documented scheduled-event envelope.
func (d *EventBridgeDeliverer) fireScheduled(ctx context.Context, scheduled time.Time) {
	raw, err := BuildEventBridgeEvent(d.rule, nil, "", "", scheduled)
	if err != nil {
		d.env.State.Failed(err)
		return
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		d.env.State.Failed(err)
		return
	}
	d.env.State.Fired()
	d.deliverTargets(ctx, event)
}

// fireRuleEvent delivers one event a matching pattern rule received.
func (d *EventBridgeDeliverer) fireRuleEvent(ctx context.Context, event map[string]any) {
	d.env.State.Fired()
	d.deliverTargets(ctx, event)
}

// deliverTargets shapes and delivers the event to every target.
func (d *EventBridgeDeliverer) deliverTargets(ctx context.Context, event map[string]any) {
	for _, target := range d.rule.TargetSpecs {
		if ctx.Err() != nil {
			return
		}
		payload, err := eventBridgeInput(target, event, d.rule, d.env.Clock.Now())
		if err != nil {
			d.env.State.Failed(err)
			d.env.Logf("rule %s: shape input for %s: %v", d.source.ID, target.ID, err)
			continue
		}
		d.deliverTarget(ctx, target, payload, event)
	}
}

// deliverTarget delivers one target with its retry policy and DLQ.
func (d *EventBridgeDeliverer) deliverTarget(ctx context.Context, target RuleTargetSpec, payload []byte, event map[string]any) {
	maxRetries := eventBridgeDefaultMaxRetries
	maxAge := eventBridgeDefaultMaxAge
	if target.RetryPolicy != nil {
		maxRetries = target.RetryPolicy.MaximumRetryAttempts
		if target.RetryPolicy.MaximumEventAgeInSeconds > 0 {
			maxAge = time.Duration(target.RetryPolicy.MaximumEventAgeInSeconds) * time.Second
		}
	}
	if maxRetries < 0 {
		maxRetries = 0
	}
	started := d.env.Clock.Now()
	failures := 0
	for {
		code, err := d.attemptTarget(ctx, target, payload, event)
		if err == nil {
			d.env.State.Delivered()
			return
		}
		failures++
		d.env.State.Failed(err)
		condition := ""
		switch {
		case d.env.Clock.Now().Sub(started) >= maxAge:
			condition = eventBridgeConditionAge
		case failures > maxRetries:
			condition = eventBridgeConditionRetries
		}
		if condition != "" {
			d.deadLetter(ctx, target, payload, code, err, condition, failures)
			return
		}
		if ctx.Err() != nil {
			return
		}
		waitClock(ctx, d.env.Clock, eventBridgeRetryDelay(failures))
	}
}

// attemptTarget performs one target invocation and returns the documented
// error code for a failure.
func (d *EventBridgeDeliverer) attemptTarget(ctx context.Context, target RuleTargetSpec, payload []byte, event map[string]any) (string, error) {
	switch target.Type {
	case ruleTargetFunction:
		result, err := d.env.InvokeTarget(ctx, target.Function, payload)
		if err != nil {
			return eventBridgeConnectionFailure, err
		}
		if result.HandlerError != "" {
			return eventBridgeErrorFromTarget, errors.New(result.HandlerError)
		}
		return "", nil
	case backendSQS:
		if d.env.Backend.SQS == nil {
			return eventBridgeConnectionFailure, errors.New("the SQS backend is not running")
		}
		found, err := d.env.Backend.SQS.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(target.QueueName)})
		if err != nil {
			return eventBridgeConnectionFailure, fmt.Errorf("resolve target queue %s: %w", target.QueueName, err)
		}
		input := &sqs.SendMessageInput{QueueUrl: found.QueueUrl, MessageBody: aws.String(string(payload))}
		if group := eventBridgeMessageGroup(target.SQSMessageGroupID, event); group != "" {
			input.MessageGroupId = aws.String(group)
		}
		if _, err := d.env.Backend.SQS.SendMessage(ctx, input); err != nil {
			return eventBridgeConnectionFailure, fmt.Errorf("send to target queue %s: %w", target.QueueName, err)
		}
		return "", nil
	case ruleTargetSNS:
		if d.env.Backend.PublishSNS == nil {
			return eventBridgeConnectionFailure, errors.New("the SNS backend is not running")
		}
		if err := d.env.Backend.PublishSNS(ctx, target.TopicARN, LocalSNSMessage{Message: string(payload)}); err != nil {
			return eventBridgeConnectionFailure, err
		}
		return "", nil
	default:
		return eventBridgeErrorFromTarget, fmt.Errorf("unsupported EventBridge target type %q", target.Type)
	}
}

// deadLetter sends the shaped payload to the target's DLQ with the documented
// attributes. A target with no DLQ records the failure and drops the event, as
// AWS does.
func (d *EventBridgeDeliverer) deadLetter(ctx context.Context, target RuleTargetSpec, payload []byte, code string, failure error, condition string, attempts int) {
	if target.DeadLetterQueueName == "" {
		d.env.Logf("rule %s: target %s exhausted (%s): %v", d.source.ID, target.ID, condition, failure)
		return
	}
	if d.env.Backend.SQS == nil {
		d.env.State.Failed(errors.New("the SQS backend is not running for the dead-letter queue"))
		return
	}
	found, err := d.env.Backend.SQS.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(target.DeadLetterQueueName)})
	if err != nil {
		d.env.State.Failed(fmt.Errorf("resolve dead-letter queue %s: %w", target.DeadLetterQueueName, err))
		return
	}
	attributes := map[string]sqstypes.MessageAttributeValue{
		"RULE_ARN":                  stringAttribute(d.rule.ARN),
		"TARGET_ARN":                stringAttribute(target.ARN),
		"ERROR_CODE":                stringAttribute(code),
		"ERROR_MESSAGE":             stringAttribute(failure.Error()),
		"EXHAUSTED_RETRY_CONDITION": stringAttribute(condition),
		"RETRY_ATTEMPTS":            stringAttribute(fmt.Sprint(attempts)),
	}
	if _, err := d.env.Backend.SQS.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:          found.QueueUrl,
		MessageBody:       aws.String(string(payload)),
		MessageAttributes: attributes,
	}); err != nil {
		d.env.State.Failed(fmt.Errorf("send to dead-letter queue %s: %w", target.DeadLetterQueueName, err))
		return
	}
	d.env.State.DeadLettered()
}

func stringAttribute(value string) sqstypes.MessageAttributeValue {
	return sqstypes.MessageAttributeValue{
		DataType:    aws.String("String"),
		StringValue: aws.String(value),
	}
}

// eventBridgeMessageGroup resolves SqsParameters.MessageGroupId: a literal, or
// a JSON path into the original event.
func eventBridgeMessageGroup(parameter string, event map[string]any) string {
	trimmed := strings.TrimSpace(parameter)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "$.") {
		if value, ok := lookupEventPath(event, trimmed); ok {
			return fmt.Sprint(value)
		}
		return ""
	}
	return trimmed
}

// eventBridgeRetryDelay is the documented retry backoff shape, on the run
// clock: ten seconds, doubling, capped at five minutes.
func eventBridgeRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := eventBridgeRetryBase
	for index := 1; index < attempt; index++ {
		delay *= 2
		if delay >= eventBridgeRetryMaximum {
			return eventBridgeRetryMaximum
		}
	}
	return delay
}
