package apptheory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type lambdaEnvelope struct {
	Records        json.RawMessage `json:"Records"`
	RequestContext json.RawMessage `json:"requestContext"`
	RouteKey       *string         `json:"routeKey"`
	DetailType     *string         `json:"detail-type"`
	DetailTypeAlt  *string         `json:"detailType"`
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
	if env.DetailType == nil && env.DetailTypeAlt == nil {
		return nil, false, nil
	}

	var ev events.EventBridgeEvent
	if err := json.Unmarshal(event, &ev); err != nil {
		return nil, true, fmt.Errorf("apptheory: parse eventbridge event: %w", err)
	}
	if strings.TrimSpace(ev.DetailType) == "" && env.DetailTypeAlt != nil {
		ev.DetailType = strings.TrimSpace(*env.DetailTypeAlt)
	}
	out, err := a.serveEventBridge(ctx, ev, event)
	return out, true, err
}

func (a *App) handleLambdaAppSync(ctx context.Context, event json.RawMessage) (any, bool, error) {
	appSyncEvent, ok, err := appSyncEventFromRawMessage(event)
	if err != nil {
		return nil, true, fmt.Errorf("apptheory: parse appsync event: %w", err)
	}
	if !ok {
		return nil, false, nil
	}
	return a.ServeAppSync(ctx, appSyncEvent), true, nil
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
// - AppSync Lambda resolver
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

	out, ok, err = a.handleLambdaAppSync(ctx, event)
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
