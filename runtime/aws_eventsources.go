package apptheory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

// EventContext is the shared context for non-HTTP Lambda triggers (SQS, EventBridge, DynamoDB Streams).
type EventContext struct {
	ctx context.Context

	clock Clock
	ids   IDGenerator

	RequestID   string
	RemainingMS int

	values map[string]any
}

func (c *EventContext) Context() context.Context {
	if c == nil || c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

func (c *EventContext) Now() time.Time {
	if c == nil || c.clock == nil {
		return time.Now()
	}
	return c.clock.Now()
}

func (c *EventContext) NewID() string {
	if c == nil || c.ids == nil {
		return RandomIDGenerator{}.NewID()
	}
	return c.ids.NewID()
}

func (c *EventContext) Set(key string, value any) {
	if c == nil {
		return
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	if c.values == nil {
		c.values = map[string]any{}
	}
	c.values[key] = value
}

func (c *EventContext) Get(key string) any {
	if c == nil || c.values == nil {
		return nil
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	return c.values[key]
}

func (a *App) eventContext(ctx context.Context) *EventContext {
	if ctx == nil {
		ctx = context.Background()
	}

	requestID := ""
	if lc, ok := lambdacontext.FromContext(ctx); ok {
		requestID = strings.TrimSpace(lc.AwsRequestID)
	}
	if requestID == "" {
		requestID = a.newRequestID()
	}

	return &EventContext{
		ctx:         ctx,
		clock:       a.clock,
		ids:         a.ids,
		RequestID:   requestID,
		RemainingMS: remainingMSFromContext(ctx, a.clock),
	}
}

type SQSHandler func(*EventContext, events.SQSMessage) error

type sqsRoute struct {
	QueueName string
	Handler   SQSHandler
}

// SQS registers a handler for an SQS queue by queue name.
func (a *App) SQS(queueName string, handler SQSHandler) *App {
	if a == nil {
		return a
	}
	queueName = strings.TrimSpace(queueName)
	if queueName == "" || handler == nil {
		return a
	}
	a.sqsRoutes = append(a.sqsRoutes, sqsRoute{QueueName: queueName, Handler: handler})
	return a
}

func sqsQueueNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func (a *App) sqsHandlerForEvent(event events.SQSEvent) SQSHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		queueName := sqsQueueNameFromARN(record.EventSourceARN)
		if queueName == "" {
			continue
		}
		for _, route := range a.sqsRoutes {
			if route.QueueName == queueName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

func batchItemFailures[Record any, Failure any](
	records []Record,
	handler func(Record) error,
	recordID func(Record) string,
	failureForID func(string) Failure,
) []Failure {
	failures := make([]Failure, 0, len(records))
	for _, record := range records {
		if handler != nil {
			if err := handler(record); err == nil {
				continue
			}
		}

		id := strings.TrimSpace(recordID(record))
		if id == "" {
			continue
		}
		failures = append(failures, failureForID(id))
	}
	return failures
}

func serveBatchItemFailures[Record any, Failure any](
	ctx context.Context,
	a *App,
	records []Record,
	handler func(*EventContext, Record) error,
	recordID func(Record) string,
	failureForID func(string) Failure,
) []Failure {
	var runner func(Record) error
	if handler != nil {
		evtCtx := a.eventContext(ctx)
		runner = func(record Record) error {
			return handler(evtCtx, record)
		}
	}
	return batchItemFailures(records, runner, recordID, failureForID)
}

func wrapEventRecordHandler[Record any](
	a *App,
	handler func(*EventContext, Record) error,
	coerce func(any) (Record, bool),
	invalidTypeError string,
) func(*EventContext, Record) error {
	if a == nil || handler == nil || len(a.eventMiddlewares) == 0 || coerce == nil {
		return handler
	}

	wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
		record, ok := coerce(event)
		if !ok {
			return nil, errors.New(invalidTypeError)
		}
		return nil, handler(ctx, record)
	})

	return func(ctx *EventContext, record Record) error {
		_, err := wrapped(ctx, record)
		return err
	}
}

func wrapEventRecordHandlerWithOutput[Record any](
	a *App,
	handler func(*EventContext, Record) (any, error),
	coerce func(any) (Record, bool),
	invalidTypeError string,
) func(*EventContext, Record) (any, error) {
	if a == nil || handler == nil || len(a.eventMiddlewares) == 0 || coerce == nil {
		return handler
	}

	wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
		record, ok := coerce(event)
		if !ok {
			return nil, errors.New(invalidTypeError)
		}
		return handler(ctx, record)
	})

	return func(ctx *EventContext, record Record) (any, error) {
		return wrapped(ctx, record)
	}
}

type batchEventSpec[Record any, Failure any, Response any] struct {
	coerce              func(any) (Record, bool)
	invalidTypeError    string
	recordID            func(Record) string
	failureForID        func(string) Failure
	responseForFailures func([]Failure) Response
}

type batchItemFailure interface {
	~struct {
		ItemIdentifier string `json:"itemIdentifier"`
	}
}

type batchItemFailuresResponse[Failure any] interface {
	~struct {
		BatchItemFailures []Failure `json:"batchItemFailures"`
	}
}

func newBatchEventSpec[Record any, Failure batchItemFailure, Response batchItemFailuresResponse[Failure]](
	invalidTypeError string,
	recordID func(Record) string,
) batchEventSpec[Record, Failure, Response] {
	return batchEventSpec[Record, Failure, Response]{
		coerce: func(event any) (Record, bool) {
			record, ok := event.(Record)
			return record, ok
		},
		invalidTypeError: invalidTypeError,
		recordID:         recordID,
		failureForID: func(id string) Failure {
			return Failure{ItemIdentifier: id}
		},
		responseForFailures: func(failures []Failure) Response {
			return Response{BatchItemFailures: failures}
		},
	}
}

func serveBatchEvent[Record any, Failure any, Response any](
	ctx context.Context,
	a *App,
	records []Record,
	handler func(*EventContext, Record) error,
	spec batchEventSpec[Record, Failure, Response],
) Response {
	handler = wrapEventRecordHandler(a, handler, spec.coerce, spec.invalidTypeError)
	failures := serveBatchItemFailures(ctx, a, records, handler, spec.recordID, spec.failureForID)
	return spec.responseForFailures(failures)
}

var sqsBatchSpec = newBatchEventSpec[events.SQSMessage, events.SQSBatchItemFailure, events.SQSEventResponse](
	"apptheory: invalid sqs record type",
	func(msg events.SQSMessage) string { return msg.MessageId },
)

// ServeSQS routes an SQS event to the registered queue handler and returns a partial batch failure response.
//
// If the queue is unrecognized, it fails closed by returning all messages as failures.
func (a *App) ServeSQS(ctx context.Context, event events.SQSEvent) events.SQSEventResponse {
	return serveBatchEvent(ctx, a, event.Records, a.sqsHandlerForEvent(event), sqsBatchSpec)
}

type KinesisHandler func(*EventContext, events.KinesisEventRecord) error

type kinesisRoute struct {
	StreamName string
	Handler    KinesisHandler
}

// Kinesis registers a handler for a Kinesis stream by stream name.
func (a *App) Kinesis(streamName string, handler KinesisHandler) *App {
	if a == nil {
		return a
	}
	streamName = strings.TrimSpace(streamName)
	if streamName == "" || handler == nil {
		return a
	}
	a.kinesisRoutes = append(a.kinesisRoutes, kinesisRoute{StreamName: streamName, Handler: handler})
	return a
}

func kinesisStreamNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	last := parts[len(parts)-1]
	_, name, ok := strings.Cut(last, "/")
	if ok {
		return strings.TrimSpace(name)
	}
	return strings.TrimSpace(last)
}

func (a *App) kinesisHandlerForEvent(event events.KinesisEvent) KinesisHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		streamName := kinesisStreamNameFromARN(record.EventSourceArn)
		if streamName == "" {
			continue
		}
		for _, route := range a.kinesisRoutes {
			if route.StreamName == streamName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

var kinesisBatchSpec = newBatchEventSpec[events.KinesisEventRecord, events.KinesisBatchItemFailure, events.KinesisEventResponse](
	"apptheory: invalid kinesis record type",
	func(record events.KinesisEventRecord) string { return record.EventID },
)

// ServeKinesis routes a Kinesis event to the registered stream handler and returns a partial batch failure response.
//
// If the stream is unrecognized, it fails closed by returning all records as failures.
func (a *App) ServeKinesis(ctx context.Context, event events.KinesisEvent) events.KinesisEventResponse {
	return serveBatchEvent(ctx, a, event.Records, a.kinesisHandlerForEvent(event), kinesisBatchSpec)
}

type SNSHandler func(*EventContext, events.SNSEventRecord) (any, error)

type snsRoute struct {
	TopicName string
	Handler   SNSHandler
}

// SNS registers a handler for an SNS topic by topic name.
func (a *App) SNS(topicName string, handler SNSHandler) *App {
	if a == nil {
		return a
	}
	topicName = strings.TrimSpace(topicName)
	if topicName == "" || handler == nil {
		return a
	}
	a.snsRoutes = append(a.snsRoutes, snsRoute{TopicName: topicName, Handler: handler})
	return a
}

func snsTopicNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	parts := strings.Split(arn, ":")
	if len(parts) == 0 {
		return ""
	}
	return strings.TrimSpace(parts[len(parts)-1])
}

func (a *App) snsHandlerForEvent(event events.SNSEvent) SNSHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		topicName := snsTopicNameFromARN(record.SNS.TopicArn)
		if topicName == "" {
			continue
		}
		for _, route := range a.snsRoutes {
			if route.TopicName == topicName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

// ServeSNS routes an SNS event to the registered topic handler.
//
// If the topic is unrecognized, it fails closed by returning an error.
//
// The returned output value is ignored by AWS for SNS triggers, but is useful for tests and local invocation tooling.
func (a *App) ServeSNS(ctx context.Context, event events.SNSEvent) ([]any, error) {
	handler := a.snsHandlerForEvent(event)
	if handler == nil {
		return nil, errors.New("apptheory: unrecognized sns topic")
	}

	handler = wrapEventRecordHandlerWithOutput(
		a,
		handler,
		func(event any) (events.SNSEventRecord, bool) {
			record, ok := event.(events.SNSEventRecord)
			return record, ok
		},
		"apptheory: invalid sns record type",
	)

	evtCtx := a.eventContext(ctx)
	outputs := make([]any, 0, len(event.Records))
	for _, record := range event.Records {
		out, err := handler(evtCtx, record)
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, out)
	}
	return outputs, nil
}

type EventBridgeSelector struct {
	RuleName   string
	Source     string
	DetailType string
}

func EventBridgeRule(ruleName string) EventBridgeSelector {
	return EventBridgeSelector{RuleName: strings.TrimSpace(ruleName)}
}

func EventBridgePattern(source, detailType string) EventBridgeSelector {
	return EventBridgeSelector{
		Source:     strings.TrimSpace(source),
		DetailType: strings.TrimSpace(detailType),
	}
}

type EventBridgeHandler func(*EventContext, events.EventBridgeEvent) (any, error)

type eventBridgeRoute struct {
	Selector EventBridgeSelector
	Handler  EventBridgeHandler
}

// EventBridge registers an EventBridge handler.
//
// Matching rules:
// - If selector.RuleName is set, it matches when any event resource ARN refers to that rule name.
// - Otherwise, it matches on selector.Source + selector.DetailType (when provided).
func (a *App) EventBridge(selector EventBridgeSelector, handler EventBridgeHandler) *App {
	if a == nil {
		return a
	}
	if handler == nil {
		return a
	}
	selector.RuleName = strings.TrimSpace(selector.RuleName)
	selector.Source = strings.TrimSpace(selector.Source)
	selector.DetailType = strings.TrimSpace(selector.DetailType)
	if selector.RuleName == "" && selector.Source == "" && selector.DetailType == "" {
		return a
	}
	a.eventBridgeRoutes = append(a.eventBridgeRoutes, eventBridgeRoute{Selector: selector, Handler: handler})
	return a
}

func eventBridgeRuleNameFromARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	if _, after, ok := strings.Cut(arn, ":rule/"); ok {
		after = strings.TrimPrefix(after, "/")
		if after == "" {
			return ""
		}
		if rule, _, ok := strings.Cut(after, "/"); ok {
			return rule
		}
		return after
	}
	if _, after, ok := strings.Cut(arn, "rule/"); ok {
		after = strings.TrimPrefix(after, "/")
		if after == "" {
			return ""
		}
		if rule, _, ok := strings.Cut(after, "/"); ok {
			return rule
		}
		return after
	}
	return ""
}

func (a *App) eventBridgeHandlerForEvent(event events.EventBridgeEvent) EventBridgeHandler {
	if a == nil {
		return nil
	}

	for _, route := range a.eventBridgeRoutes {
		if route.Handler == nil {
			continue
		}
		sel := route.Selector
		if sel.RuleName != "" {
			for _, resource := range event.Resources {
				if eventBridgeRuleNameFromARN(resource) == sel.RuleName {
					return route.Handler
				}
			}
			continue
		}

		if sel.Source != "" && strings.TrimSpace(event.Source) != sel.Source {
			continue
		}
		if sel.DetailType != "" && strings.TrimSpace(event.DetailType) != sel.DetailType {
			continue
		}
		return route.Handler
	}

	return nil
}

// ServeEventBridge routes an EventBridge event to the first matching handler.
//
// If no handler matches, it returns (nil, nil).
func (a *App) ServeEventBridge(ctx context.Context, event events.EventBridgeEvent) (any, error) {
	handler := a.eventBridgeHandlerForEvent(event)
	if handler == nil {
		return nil, nil
	}

	evtCtx := a.eventContext(ctx)
	if a != nil && len(a.eventMiddlewares) > 0 {
		original := handler
		wrapped := a.applyEventMiddlewares(func(ctx *EventContext, event any) (any, error) {
			ev, ok := event.(events.EventBridgeEvent)
			if !ok {
				return nil, errors.New("apptheory: invalid eventbridge event type")
			}
			return original(ctx, ev)
		})
		return wrapped(evtCtx, event)
	}

	return handler(evtCtx, event)
}

type DynamoDBStreamHandler func(*EventContext, events.DynamoDBEventRecord) error

type dynamoDBRoute struct {
	TableName string
	Handler   DynamoDBStreamHandler
}

// DynamoDB registers a DynamoDB Streams handler by table name.
func (a *App) DynamoDB(tableName string, handler DynamoDBStreamHandler) *App {
	if a == nil {
		return a
	}
	tableName = strings.TrimSpace(tableName)
	if tableName == "" || handler == nil {
		return a
	}
	a.dynamoDBRoutes = append(a.dynamoDBRoutes, dynamoDBRoute{TableName: tableName, Handler: handler})
	return a
}

func dynamoDBTableNameFromStreamARN(arn string) string {
	arn = strings.TrimSpace(arn)
	if arn == "" {
		return ""
	}
	if _, after, ok := strings.Cut(arn, ":table/"); ok {
		if table, _, ok := strings.Cut(after, "/stream/"); ok {
			return table
		}
		if table, _, ok := strings.Cut(after, "/"); ok {
			return table
		}
		return after
	}
	return ""
}

func (a *App) dynamoDBHandlerForEvent(event events.DynamoDBEvent) DynamoDBStreamHandler {
	if a == nil {
		return nil
	}
	for _, record := range event.Records {
		tableName := dynamoDBTableNameFromStreamARN(record.EventSourceArn)
		if tableName == "" {
			continue
		}
		for _, route := range a.dynamoDBRoutes {
			if route.TableName == tableName {
				return route.Handler
			}
		}
		break
	}
	return nil
}

var dynamoDBBatchSpec = newBatchEventSpec[events.DynamoDBEventRecord, events.DynamoDBBatchItemFailure, events.DynamoDBEventResponse](
	"apptheory: invalid dynamodb record type",
	func(record events.DynamoDBEventRecord) string { return record.EventID },
)

// ServeDynamoDBStream routes a DynamoDB Streams event to the registered table handler and returns a partial batch failure response.
//
// If the table is unrecognized, it fails closed by returning all records as failures.
func (a *App) ServeDynamoDBStream(ctx context.Context, event events.DynamoDBEvent) events.DynamoDBEventResponse {
	return serveBatchEvent(ctx, a, event.Records, a.dynamoDBHandlerForEvent(event), dynamoDBBatchSpec)
}

type lambdaEnvelope struct {
	Records        json.RawMessage `json:"Records"`
	RequestContext json.RawMessage `json:"requestContext"`
	RouteKey       *string         `json:"routeKey"`
	DetailType     *string         `json:"detail-type"`
}

type recordProbe struct {
	EventSource    string `json:"eventSource"`
	EventSourceAlt string `json:"EventSource"`
}

func (a *App) handleLambdaRecords(ctx context.Context, event json.RawMessage, env lambdaEnvelope) (any, bool, error) {
	if len(env.Records) == 0 {
		return nil, false, nil
	}

	var probes []recordProbe
	if err := json.Unmarshal(env.Records, &probes); err != nil || len(probes) == 0 {
		return nil, false, nil
	}

	source := strings.TrimSpace(probes[0].EventSource)
	if source == "" {
		source = strings.TrimSpace(probes[0].EventSourceAlt)
	}

	switch source {
	case "aws:sqs":
		var sqs events.SQSEvent
		if err := json.Unmarshal(event, &sqs); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse sqs event: %w", err)
		}
		return a.ServeSQS(ctx, sqs), true, nil
	case "aws:dynamodb":
		var ddb events.DynamoDBEvent
		if err := json.Unmarshal(event, &ddb); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse dynamodb stream event: %w", err)
		}
		return a.ServeDynamoDBStream(ctx, ddb), true, nil
	case "aws:kinesis":
		var kin events.KinesisEvent
		if err := json.Unmarshal(event, &kin); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse kinesis event: %w", err)
		}
		return a.ServeKinesis(ctx, kin), true, nil
	case "aws:sns":
		var sns events.SNSEvent
		if err := json.Unmarshal(event, &sns); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse sns event: %w", err)
		}
		out, err := a.ServeSNS(ctx, sns)
		return out, true, err
	default:
		return nil, false, nil
	}
}

func (a *App) handleLambdaEventBridge(ctx context.Context, event json.RawMessage, env lambdaEnvelope) (any, bool, error) {
	if env.DetailType == nil {
		return nil, false, nil
	}

	var ev events.EventBridgeEvent
	if err := json.Unmarshal(event, &ev); err != nil {
		return nil, true, fmt.Errorf("apptheory: parse eventbridge event: %w", err)
	}
	out, err := a.ServeEventBridge(ctx, ev)
	return out, true, err
}

func (a *App) handleLambdaRequestContext(ctx context.Context, event json.RawMessage, env lambdaEnvelope) (any, bool, error) {
	if len(env.RequestContext) == 0 {
		return nil, false, nil
	}

	var probe struct {
		HTTP         json.RawMessage `json:"http"`
		ConnectionID *string         `json:"connectionId"`
		ELB          json.RawMessage `json:"elb"`
	}
	if err := json.Unmarshal(env.RequestContext, &probe); err != nil {
		return nil, false, nil
	}

	if len(probe.HTTP) > 0 {
		if env.RouteKey != nil {
			var http events.APIGatewayV2HTTPRequest
			if err := json.Unmarshal(event, &http); err != nil {
				return nil, true, fmt.Errorf("apptheory: parse apigw v2 event: %w", err)
			}
			return a.ServeAPIGatewayV2(ctx, http), true, nil
		}

		var urlEvent events.LambdaFunctionURLRequest
		if err := json.Unmarshal(event, &urlEvent); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse lambda url event: %w", err)
		}
		return a.ServeLambdaFunctionURL(ctx, urlEvent), true, nil
	}

	if probe.ConnectionID != nil {
		if !a.webSocketEnabled {
			return nil, false, nil
		}

		var ws events.APIGatewayWebsocketProxyRequest
		if err := json.Unmarshal(event, &ws); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse apigw websocket event: %w", err)
		}
		return a.ServeWebSocket(ctx, ws), true, nil
	}

	if len(probe.ELB) > 0 {
		var alb events.ALBTargetGroupRequest
		if err := json.Unmarshal(event, &alb); err != nil {
			return nil, true, fmt.Errorf("apptheory: parse alb event: %w", err)
		}
		if strings.TrimSpace(alb.HTTPMethod) != "" {
			return a.ServeALB(ctx, alb), true, nil
		}
	}

	var proxy events.APIGatewayProxyRequest
	if err := json.Unmarshal(event, &proxy); err != nil {
		return nil, true, fmt.Errorf("apptheory: parse apigw proxy event: %w", err)
	}
	if strings.TrimSpace(proxy.HTTPMethod) != "" {
		return a.serveAPIGatewayProxyLambda(ctx, proxy), true, nil
	}

	return nil, false, nil
}

// HandleLambda routes an untyped Lambda event to the correct AppTheory entrypoint.
//
// Supported triggers:
// - API Gateway v2 (HTTP API)
// - API Gateway REST API v1 (Proxy)
// - Application Load Balancer (Target Group)
// - Lambda Function URL
// - SQS
// - Kinesis
// - SNS
// - EventBridge
// - DynamoDB Streams
// - API Gateway v2 (WebSocket API)
func (a *App) HandleLambda(ctx context.Context, event json.RawMessage) (any, error) {
	if a == nil {
		return nil, errors.New("apptheory: nil app")
	}
	if len(bytes.TrimSpace(event)) == 0 {
		return nil, errors.New("apptheory: empty event")
	}

	var env lambdaEnvelope
	if err := json.Unmarshal(event, &env); err != nil {
		return nil, fmt.Errorf("apptheory: parse event envelope: %w", err)
	}

	out, ok, err := a.handleLambdaRecords(ctx, event, env)
	if err != nil {
		return nil, err
	}
	if ok {
		return out, nil
	}

	out, ok, err = a.handleLambdaEventBridge(ctx, event, env)
	if err != nil {
		return nil, err
	}
	if ok {
		return out, nil
	}

	out, ok, err = a.handleLambdaRequestContext(ctx, event, env)
	if err != nil {
		return nil, err
	}
	if ok {
		return out, nil
	}

	return nil, fmt.Errorf("apptheory: unknown event type")
}
