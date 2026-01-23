package apptheory

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory/pkg/streamer"
)

type WebSocketHandler func(*Context) (*Response, error)

type webSocketRoute struct {
	RouteKey string
	Handler  WebSocketHandler
}

type WebSocketClientFactory func(context.Context, string) (streamer.Client, error)

func defaultWebSocketClientFactory(ctx context.Context, endpoint string) (streamer.Client, error) {
	return streamer.NewClient(ctx, endpoint)
}

func WithWebSocketSupport() Option {
	return func(app *App) {
		app.webSocketEnabled = true
	}
}

func WithWebSocketClientFactory(factory WebSocketClientFactory) Option {
	return func(app *App) {
		app.webSocketClientFactory = factory
	}
}

func (a *App) WebSocket(routeKey string, handler WebSocketHandler) *App {
	if a == nil {
		return a
	}
	routeKey = strings.TrimSpace(routeKey)
	if routeKey == "" || handler == nil {
		return a
	}
	a.webSocketEnabled = true
	a.webSocketRoutes = append(a.webSocketRoutes, webSocketRoute{RouteKey: routeKey, Handler: handler})
	return a
}

func (a *App) webSocketHandlerForRoute(routeKey string) WebSocketHandler {
	if a == nil {
		return nil
	}
	routeKey = strings.TrimSpace(routeKey)
	if routeKey == "" {
		return nil
	}
	for _, route := range a.webSocketRoutes {
		if route.RouteKey == routeKey {
			return route.Handler
		}
	}
	return nil
}

type WebSocketContext struct {
	ctx context.Context

	clock Clock
	ids   IDGenerator

	RequestID   string
	RemainingMS int

	ConnectionID       string
	RouteKey           string
	DomainName         string
	Stage              string
	EventType          string
	ManagementEndpoint string

	Body []byte

	clientFactory WebSocketClientFactory
	client        streamer.Client
	clientErr     error
}

func (c *WebSocketContext) Context() context.Context {
	if c == nil || c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

func (c *WebSocketContext) Now() time.Time {
	if c == nil || c.clock == nil {
		return time.Now()
	}
	return c.clock.Now()
}

func (c *WebSocketContext) NewID() string {
	if c == nil || c.ids == nil {
		return RandomIDGenerator{}.NewID()
	}
	return c.ids.NewID()
}

func (c *WebSocketContext) managementClient() (streamer.Client, error) {
	if c == nil {
		return nil, errors.New("apptheory: nil websocket context")
	}
	if c.client != nil || c.clientErr != nil {
		return c.client, c.clientErr
	}
	if c.clientFactory == nil {
		c.clientErr = errors.New("apptheory: missing websocket client factory")
		return nil, c.clientErr
	}
	client, err := c.clientFactory(c.Context(), c.ManagementEndpoint)
	if err != nil {
		c.clientErr = err
		return nil, err
	}
	if client == nil {
		c.clientErr = errors.New("apptheory: websocket client factory returned nil")
		return nil, c.clientErr
	}
	c.client = client
	return client, nil
}

func (c *WebSocketContext) SendMessage(data []byte) error {
	if c == nil {
		return errors.New("apptheory: nil websocket context")
	}
	connectionID := strings.TrimSpace(c.ConnectionID)
	if connectionID == "" {
		return errors.New("apptheory: websocket connection id is empty")
	}
	client, err := c.managementClient()
	if err != nil {
		return err
	}
	return client.PostToConnection(c.Context(), connectionID, data)
}

func (c *WebSocketContext) SendJSONMessage(value any) error {
	if c == nil {
		return errors.New("apptheory: nil websocket context")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("apptheory: marshal websocket json message: %w", err)
	}
	return c.SendMessage(b)
}

func webSocketManagementEndpoint(domainName, stage string) string {
	domainName = strings.TrimSpace(domainName)
	stage = strings.TrimSpace(stage)
	if domainName == "" || stage == "" {
		return ""
	}
	stage = strings.TrimPrefix(stage, "/")
	stage = strings.TrimSuffix(stage, "/")
	if stage == "" {
		return ""
	}
	return "https://" + domainName + "/" + stage
}

func apigatewayProxyResponseFromResponse(resp Response) events.APIGatewayProxyResponse {
	out := events.APIGatewayProxyResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		IsBase64Encoded:   resp.IsBase64,
		Body:              string(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = values[0]
		out.MultiValueHeaders[key] = append([]string(nil), values...)
	}

	if len(resp.Cookies) > 0 {
		out.Headers["set-cookie"] = resp.Cookies[0]
		out.MultiValueHeaders["set-cookie"] = append([]string(nil), resp.Cookies...)
	}

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

func headersFromProxyEvent(single map[string]string, multi map[string][]string) map[string][]string {
	out := map[string][]string{}
	for key, values := range multi {
		out[key] = append([]string(nil), values...)
	}
	for key, value := range single {
		if _, ok := out[key]; ok {
			continue
		}
		out[key] = []string{value}
	}
	return out
}

func queryFromProxyEvent(single map[string]string, multi map[string][]string) map[string][]string {
	out := map[string][]string{}
	for key, values := range multi {
		out[key] = append([]string(nil), values...)
	}
	for key, value := range single {
		if _, ok := out[key]; ok {
			continue
		}
		out[key] = []string{value}
	}
	return out
}

func (a *App) ServeWebSocket(ctx context.Context, event events.APIGatewayWebsocketProxyRequest) (proxy events.APIGatewayProxyResponse) {
	if a == nil {
		return apigatewayProxyResponseFromResponse(errorResponse(errorCodeInternal, errorMessageInternal, nil))
	}
	if ctx == nil {
		ctx = context.Background()
	}

	routeKey := strings.TrimSpace(event.RequestContext.RouteKey)
	handler := a.webSocketHandlerForRoute(routeKey)
	if handler != nil {
		handler = WebSocketHandler(a.applyMiddlewares(Handler(handler)))
	}

	requestID := strings.TrimSpace(event.RequestContext.RequestID)
	if requestID == "" {
		requestID = a.eventContext(ctx).RequestID
	}

	headers := headersFromProxyEvent(event.Headers, event.MultiValueHeaders)
	query := queryFromProxyEvent(event.QueryStringParameters, event.MultiValueQueryStringParameters)
	req := Request{
		Method:   event.HTTPMethod,
		Path:     event.Path,
		Query:    query,
		Headers:  headers,
		Body:     []byte(event.Body),
		IsBase64: event.IsBase64Encoded,
	}

	normalized, err := normalizeRequest(req)
	if err != nil {
		if a.tier == TierP0 {
			return apigatewayProxyResponseFromResponse(responseForError(err))
		}
		return apigatewayProxyResponseFromResponse(responseForErrorWithRequestID(err, requestID))
	}

	domainName := strings.TrimSpace(event.RequestContext.DomainName)
	stage := strings.TrimSpace(event.RequestContext.Stage)
	managementEndpoint := webSocketManagementEndpoint(domainName, stage)

	wsCtx := &WebSocketContext{
		ctx:                ctx,
		clock:              a.clock,
		ids:                a.ids,
		RequestID:          requestID,
		RemainingMS:        remainingMSFromContext(ctx, a.clock),
		ConnectionID:       strings.TrimSpace(event.RequestContext.ConnectionID),
		RouteKey:           routeKey,
		DomainName:         domainName,
		Stage:              stage,
		EventType:          strings.TrimSpace(event.RequestContext.EventType),
		ManagementEndpoint: managementEndpoint,
		Body:               append([]byte(nil), normalized.Body...),
		clientFactory:      a.webSocketClientFactory,
	}

	requestCtx := &Context{
		ctx:         ctx,
		Request:     normalized,
		Params:      nil,
		clock:       a.clock,
		ids:         a.ids,
		RequestID:   requestID,
		TenantID:    extractTenantID(normalized.Headers, normalized.Query),
		RemainingMS: remainingMSFromContext(ctx, a.clock),
		ws:          wsCtx,
	}

	if handler == nil {
		if a.tier == TierP0 {
			return apigatewayProxyResponseFromResponse(errorResponse(errorCodeNotFound, errorMessageNotFound, nil))
		}
		return apigatewayProxyResponseFromResponse(errorResponseWithRequestID(errorCodeNotFound, errorMessageNotFound, nil, requestID))
	}

	defer func() {
		if r := recover(); r != nil {
			if a.tier == TierP0 {
				proxy = apigatewayProxyResponseFromResponse(errorResponse(errorCodeInternal, errorMessageInternal, nil))
				return
			}
			proxy = apigatewayProxyResponseFromResponse(errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, requestID))
		}
	}()

	out, handlerErr := handler(requestCtx)
	if handlerErr != nil {
		if a.tier == TierP0 {
			return apigatewayProxyResponseFromResponse(responseForError(handlerErr))
		}
		return apigatewayProxyResponseFromResponse(responseForErrorWithRequestID(handlerErr, requestID))
	}

	if out == nil {
		if a.tier == TierP0 {
			return apigatewayProxyResponseFromResponse(errorResponse(errorCodeInternal, errorMessageInternal, nil))
		}
		return apigatewayProxyResponseFromResponse(errorResponseWithRequestID(errorCodeInternal, errorMessageInternal, nil, requestID))
	}

	resp := normalizeResponse(out)
	return apigatewayProxyResponseFromResponse(resp)
}
