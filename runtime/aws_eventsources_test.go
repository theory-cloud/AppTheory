package apptheory

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

type fixedIDGenerator string

func (f fixedIDGenerator) NewID() string { return string(f) }

func TestEventContext_UsesLambdaRequestIDWhenPresent(t *testing.T) {
	app := New(WithIDGenerator(fixedIDGenerator("fallback")))

	lc := &lambdacontext.LambdaContext{AwsRequestID: "aws_req_1"}
	ctx := lambdacontext.NewContext(context.Background(), lc)
	evtCtx := app.eventContext(ctx)
	if evtCtx.RequestID != "aws_req_1" {
		t.Fatalf("expected request id from lambdacontext, got %q", evtCtx.RequestID)
	}

	evtCtx = app.eventContext(context.Background())
	if evtCtx.RequestID != "fallback" {
		t.Fatalf("expected fallback request id, got %q", evtCtx.RequestID)
	}
}

func TestServeSQS_BatchFailuresAndMiddleware(t *testing.T) {
	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, event any) (any, error) {
			ctx.Set("mw", "ok")
			return next(ctx, event)
		}
	})

	app.SQS("queue1", func(ctx *EventContext, msg events.SQSMessage) error {
		if ctx.Get("mw") != "ok" {
			return errors.New("missing middleware marker")
		}
		if msg.MessageId == "2" {
			return errors.New("fail")
		}
		return nil
	})

	out := app.ServeSQS(context.Background(), events.SQSEvent{
		Records: []events.SQSMessage{
			{MessageId: "1", EventSourceARN: "arn:aws:sqs:us-east-1:123:queue1"},
			{MessageId: "2", EventSourceARN: "arn:aws:sqs:us-east-1:123:queue1"},
		},
	})
	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "2" {
		t.Fatalf("unexpected failures: %#v", out.BatchItemFailures)
	}

	// Unrecognized queue fails closed.
	out = app.ServeSQS(context.Background(), events.SQSEvent{
		Records: []events.SQSMessage{
			{MessageId: "1", EventSourceARN: "arn:aws:sqs:us-east-1:123:unknown"},
		},
	})
	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "1" {
		t.Fatalf("expected fail-closed for unknown queue, got %#v", out.BatchItemFailures)
	}
}

func TestServeKinesis_BatchFailures(t *testing.T) {
	app := New()
	app.Kinesis("stream1", func(_ *EventContext, record events.KinesisEventRecord) error {
		if record.EventID == "bad" {
			return errors.New("fail")
		}
		return nil
	})

	out := app.ServeKinesis(context.Background(), events.KinesisEvent{
		Records: []events.KinesisEventRecord{
			{EventID: "ok", EventSourceArn: "arn:aws:kinesis:us-east-1:123:stream/stream1"},
			{EventID: "bad", EventSourceArn: "arn:aws:kinesis:us-east-1:123:stream/stream1"},
		},
	})
	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "bad" {
		t.Fatalf("unexpected failures: %#v", out.BatchItemFailures)
	}
}

func TestServeSNS_OutputsAndMiddleware(t *testing.T) {
	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, event any) (any, error) {
			ctx.Set("mw", "ok")
			return next(ctx, event)
		}
	})

	app.SNS("topic1", func(ctx *EventContext, record events.SNSEventRecord) (any, error) {
		if ctx.Get("mw") != "ok" {
			return nil, errors.New("missing middleware marker")
		}
		return record.SNS.MessageID, nil
	})

	out, err := app.ServeSNS(context.Background(), events.SNSEvent{
		Records: []events.SNSEventRecord{
			{SNS: events.SNSEntity{MessageID: "m1", TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
			{SNS: events.SNSEntity{MessageID: "m2", TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
		},
	})
	if err != nil {
		t.Fatalf("ServeSNS returned error: %v", err)
	}
	if len(out) != 2 || out[0] != "m1" || out[1] != "m2" {
		t.Fatalf("unexpected outputs: %#v", out)
	}

	_, err = app.ServeSNS(context.Background(), events.SNSEvent{
		Records: []events.SNSEventRecord{
			{SNS: events.SNSEntity{MessageID: "m1", TopicArn: "arn:aws:sns:us-east-1:123:unknown"}},
		},
	})
	if err == nil {
		t.Fatal("expected error for unrecognized topic")
	}
}

func TestServeEventBridge_SelectsByRuleAndPattern(t *testing.T) {
	app := New()
	app.UseEvents(func(next EventHandler) EventHandler {
		return func(ctx *EventContext, event any) (any, error) {
			ctx.Set("mw", "ok")
			return next(ctx, event)
		}
	})

	app.EventBridge(EventBridgeRule("my-rule"), func(ctx *EventContext, event events.EventBridgeEvent) (any, error) {
		if ctx.Get("mw") != "ok" {
			return nil, errors.New("missing middleware marker")
		}
		return event.DetailType, nil
	})
	app.EventBridge(EventBridgePattern("src", "type"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) {
		return "pattern", nil
	})

	out, err := app.ServeEventBridge(context.Background(), events.EventBridgeEvent{
		Resources:  []string{"arn:aws:events:us-east-1:123:rule/my-rule"},
		DetailType: "dt",
	})
	if err != nil || out != "dt" {
		t.Fatalf("unexpected rule match: out=%v err=%v", out, err)
	}

	out, err = app.ServeEventBridge(context.Background(), events.EventBridgeEvent{
		Source:     "src",
		DetailType: "type",
	})
	if err != nil || out != "pattern" {
		t.Fatalf("unexpected pattern match: out=%v err=%v", out, err)
	}

	out, err = app.ServeEventBridge(context.Background(), events.EventBridgeEvent{
		Source:     "nope",
		DetailType: "type",
	})
	if err != nil || out != nil {
		t.Fatalf("expected no match to return (nil,nil), got out=%v err=%v", out, err)
	}
}

func TestServeDynamoDBStream_BatchFailures(t *testing.T) {
	app := New()
	app.DynamoDB("tbl", func(_ *EventContext, record events.DynamoDBEventRecord) error {
		if record.EventID == "bad" {
			return errors.New("fail")
		}
		return nil
	})

	out := app.ServeDynamoDBStream(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventID: "ok", EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020"},
			{EventID: "bad", EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020"},
		},
	})
	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "bad" {
		t.Fatalf("unexpected failures: %#v", out.BatchItemFailures)
	}
}

func TestHandleLambda_Dispatch(t *testing.T) {
	app := New(WithTier(TierP0), WithIDGenerator(fixedIDGenerator("req_test")))
	app.Get("/", func(_ *Context) (*Response, error) { return Text(200, "ok"), nil })
	app.SQS("queue1", func(_ *EventContext, _ events.SQSMessage) error { return nil })
	app.Kinesis("stream1", func(_ *EventContext, _ events.KinesisEventRecord) error { return nil })
	app.DynamoDB("tbl", func(_ *EventContext, _ events.DynamoDBEventRecord) error { return nil })
	app.SNS("topic1", func(_ *EventContext, record events.SNSEventRecord) (any, error) { return record.SNS.MessageID, nil })
	app.EventBridge(EventBridgePattern("src", "type"), func(_ *EventContext, _ events.EventBridgeEvent) (any, error) { return "eb", nil })

	_, err := (*App)(nil).HandleLambda(context.Background(), json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected error for nil app")
	}
	_, err = app.HandleLambda(context.Background(), json.RawMessage(`   `))
	if err == nil {
		t.Fatal("expected error for empty event")
	}
	_, err = app.HandleLambda(context.Background(), json.RawMessage(`{not-json}`))
	if err == nil {
		t.Fatal("expected error for invalid json")
	}

	sqsBytes, err := json.Marshal(events.SQSEvent{
		Records: []events.SQSMessage{
			{MessageId: "1", EventSource: "aws:sqs", EventSourceARN: "arn:aws:sqs:us-east-1:123:queue1"},
		},
	})
	if err != nil {
		t.Fatalf("marshal sqs: %v", err)
	}
	out, err := app.HandleLambda(context.Background(), sqsBytes)
	if err != nil {
		t.Fatalf("HandleLambda(sqs) error: %v", err)
	}
	if _, ok := out.(events.SQSEventResponse); !ok {
		t.Fatalf("expected SQSEventResponse, got %T", out)
	}

	ddbBytes, err := json.Marshal(events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventID: "1", EventSource: "aws:dynamodb", EventSourceArn: "arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020"},
		},
	})
	if err != nil {
		t.Fatalf("marshal ddb: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), ddbBytes)
	if err != nil {
		t.Fatalf("HandleLambda(ddb) error: %v", err)
	}
	if _, ok := out.(events.DynamoDBEventResponse); !ok {
		t.Fatalf("expected DynamoDBEventResponse, got %T", out)
	}

	kinBytes, err := json.Marshal(events.KinesisEvent{
		Records: []events.KinesisEventRecord{
			{EventID: "1", EventSource: "aws:kinesis", EventSourceArn: "arn:aws:kinesis:us-east-1:123:stream/stream1"},
		},
	})
	if err != nil {
		t.Fatalf("marshal kinesis: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), kinBytes)
	if err != nil {
		t.Fatalf("HandleLambda(kinesis) error: %v", err)
	}
	if _, ok := out.(events.KinesisEventResponse); !ok {
		t.Fatalf("expected KinesisEventResponse, got %T", out)
	}

	snsBytes, err := json.Marshal(events.SNSEvent{
		Records: []events.SNSEventRecord{
			{EventSource: "aws:sns", SNS: events.SNSEntity{MessageID: "m1", TopicArn: "arn:aws:sns:us-east-1:123:topic1"}},
		},
	})
	if err != nil {
		t.Fatalf("marshal sns: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), snsBytes)
	if err != nil {
		t.Fatalf("HandleLambda(sns) error: %v", err)
	}
	if slice, ok := out.([]any); !ok || len(slice) != 1 || slice[0] != "m1" {
		t.Fatalf("unexpected sns output: %#v (%T)", out, out)
	}

	ebBytes, err := json.Marshal(events.EventBridgeEvent{
		Source:     "src",
		DetailType: "type",
	})
	if err != nil {
		t.Fatalf("marshal eventbridge: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), ebBytes)
	if err != nil || out != "eb" {
		t.Fatalf("unexpected eventbridge output: out=%v err=%v", out, err)
	}

	httpBytes, err := json.Marshal(events.APIGatewayV2HTTPRequest{
		RouteKey: "$default",
		RawPath:  "/",
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: "GET",
				Path:   "/",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal apigw v2: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), httpBytes)
	if err != nil {
		t.Fatalf("HandleLambda(apigw v2) error: %v", err)
	}
	if _, ok := out.(events.APIGatewayV2HTTPResponse); !ok {
		t.Fatalf("expected APIGatewayV2HTTPResponse, got %T", out)
	}

	urlBytes, err := json.Marshal(events.LambdaFunctionURLRequest{
		RawPath: "/",
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{
				Method: "GET",
				Path:   "/",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal lambda url: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), urlBytes)
	if err != nil {
		t.Fatalf("HandleLambda(lambda url) error: %v", err)
	}
	if _, ok := out.(events.LambdaFunctionURLResponse); !ok {
		t.Fatalf("expected LambdaFunctionURLResponse, got %T", out)
	}

	albBytes, err := json.Marshal(events.ALBTargetGroupRequest{
		HTTPMethod: "GET",
		Path:       "/",
		RequestContext: events.ALBTargetGroupRequestContext{
			ELB: events.ELBContext{
				TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/x/abc",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal alb: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), albBytes)
	if err != nil {
		t.Fatalf("HandleLambda(alb) error: %v", err)
	}
	if _, ok := out.(events.ALBTargetGroupResponse); !ok {
		t.Fatalf("expected ALBTargetGroupResponse, got %T", out)
	}

	proxyBytes, err := json.Marshal(events.APIGatewayProxyRequest{
		HTTPMethod: "GET",
		Path:       "/",
	})
	if err != nil {
		t.Fatalf("marshal proxy: %v", err)
	}
	out, err = app.HandleLambda(context.Background(), proxyBytes)
	if err != nil {
		t.Fatalf("HandleLambda(proxy) error: %v", err)
	}
	if _, ok := out.(events.APIGatewayProxyResponse); !ok {
		t.Fatalf("expected APIGatewayProxyResponse, got %T", out)
	}

	_, err = app.HandleLambda(context.Background(), json.RawMessage(`{"foo":"bar"}`))
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
}
