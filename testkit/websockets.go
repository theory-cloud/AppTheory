package testkit

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
	"github.com/theory-cloud/apptheory/runtime"
)

type WebSocketEventOptions struct {
	RouteKey     string
	EventType    string
	ConnectionID string
	DomainName   string
	Stage        string
	RequestID    string
	Body         string
	IsBase64     bool

	Headers               map[string]string
	MultiValueHeaders     map[string][]string
	QueryStringParameters map[string]string
	MultiValueQueryString map[string][]string
}

func WebSocketEvent(opts WebSocketEventOptions) events.APIGatewayWebsocketProxyRequest {
	routeKey := strings.TrimSpace(opts.RouteKey)
	if routeKey == "" {
		routeKey = "$default"
	}

	eventType := strings.TrimSpace(opts.EventType)
	if eventType == "" {
		eventType = "MESSAGE"
	}

	connectionID := strings.TrimSpace(opts.ConnectionID)
	if connectionID == "" {
		connectionID = "conn-1"
	}

	domainName := strings.TrimSpace(opts.DomainName)
	if domainName == "" {
		domainName = "example.execute-api.us-east-1.amazonaws.com"
	}

	stage := strings.TrimSpace(opts.Stage)
	if stage == "" {
		stage = "dev"
	}

	requestID := strings.TrimSpace(opts.RequestID)
	if requestID == "" {
		requestID = "req-1"
	}

	return events.APIGatewayWebsocketProxyRequest{
		Path:                            "/",
		HTTPMethod:                      "POST",
		Headers:                         cloneStringMap(opts.Headers),
		MultiValueHeaders:               cloneStringSliceMap(opts.MultiValueHeaders),
		QueryStringParameters:           cloneStringMap(opts.QueryStringParameters),
		MultiValueQueryStringParameters: cloneStringSliceMap(opts.MultiValueQueryString),
		RequestContext: events.APIGatewayWebsocketProxyRequestContext{
			Stage:        stage,
			RequestID:    requestID,
			ConnectionID: connectionID,
			DomainName:   domainName,
			EventType:    eventType,
			RouteKey:     routeKey,
		},
		Body:            opts.Body,
		IsBase64Encoded: opts.IsBase64,
	}
}

func (e *Env) InvokeWebSocket(
	ctx context.Context,
	app *apptheory.App,
	event events.APIGatewayWebsocketProxyRequest,
) events.APIGatewayProxyResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeWebSocket(ctx, event)
}

type StreamerCall struct {
	Op           string
	ConnectionID string
	Data         []byte
}

type FakeStreamerClient struct {
	mu sync.Mutex

	Endpoint string
	Calls    []StreamerCall

	Connections map[string]streamer.Connection

	PostErr   error
	GetErr    error
	DeleteErr error
}

var _ streamer.Client = (*FakeStreamerClient)(nil)

func NewFakeStreamerClient(endpoint string) *FakeStreamerClient {
	return &FakeStreamerClient{
		Endpoint:    strings.TrimSpace(endpoint),
		Calls:       nil,
		Connections: map[string]streamer.Connection{},
		PostErr:     nil,
		GetErr:      nil,
		DeleteErr:   nil,
	}
}

func (f *FakeStreamerClient) PostToConnection(_ context.Context, connectionID string, data []byte) error {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return errors.New("testkit: connection id is empty")
	}

	f.mu.Lock()
	f.Calls = append(f.Calls, StreamerCall{
		Op:           "post_to_connection",
		ConnectionID: connectionID,
		Data:         append([]byte(nil), data...),
	})
	err := f.PostErr
	f.mu.Unlock()

	return err
}

func (f *FakeStreamerClient) GetConnection(_ context.Context, connectionID string) (streamer.Connection, error) {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return streamer.Connection{}, errors.New("testkit: connection id is empty")
	}

	f.mu.Lock()
	f.Calls = append(f.Calls, StreamerCall{
		Op:           "get_connection",
		ConnectionID: connectionID,
		Data:         nil,
	})
	err := f.GetErr
	conn, ok := f.Connections[connectionID]
	f.mu.Unlock()

	if err != nil {
		return streamer.Connection{}, err
	}
	if !ok {
		return streamer.Connection{}, errors.New("testkit: connection not found")
	}
	return conn, nil
}

func (f *FakeStreamerClient) DeleteConnection(_ context.Context, connectionID string) error {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return errors.New("testkit: connection id is empty")
	}

	f.mu.Lock()
	f.Calls = append(f.Calls, StreamerCall{
		Op:           "delete_connection",
		ConnectionID: connectionID,
		Data:         nil,
	})
	err := f.DeleteErr
	delete(f.Connections, connectionID)
	f.mu.Unlock()

	return err
}

func cloneStringMap(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func cloneStringSliceMap(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}
