package apptheory

import (
	"bytes"
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

func (a *App) ServeAPIGatewayProxy(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		return apigatewayProxyResponseFromResponse(responseForError(err))
	}
	return apigatewayProxyResponseFromResponse(a.Serve(ctx, req))
}

func (a *App) serveAPIGatewayProxyLambda(ctx context.Context, event events.APIGatewayProxyRequest) any {
	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		return apigatewayProxyResponseFromResponse(responseForError(err))
	}

	resp := a.Serve(ctx, req)
	if resp.IsBase64 || !isTextEventStream(resp.Headers) {
		return apigatewayProxyResponseFromResponse(resp)
	}
	return apigatewayProxyStreamingResponseFromResponse(resp)
}

func requestFromAPIGatewayProxy(event events.APIGatewayProxyRequest) (Request, error) {
	path := event.Path
	if path == "" {
		path = event.RequestContext.Path
	}

	method := event.HTTPMethod
	if method == "" {
		method = event.RequestContext.HTTPMethod
	}

	return Request{
		Method:   method,
		Path:     path,
		Query:    queryFromProxyEvent(event.QueryStringParameters, event.MultiValueQueryStringParameters),
		Headers:  headersFromProxyEvent(event.Headers, event.MultiValueHeaders),
		Body:     []byte(event.Body),
		IsBase64: event.IsBase64Encoded,
	}, nil
}

func isTextEventStream(headers map[string][]string) bool {
	for _, value := range headers["content-type"] {
		v := strings.TrimSpace(strings.ToLower(value))
		if strings.HasPrefix(v, "text/event-stream") {
			return true
		}
	}
	return false
}

func apigatewayProxyStreamingResponseFromResponse(resp Response) *events.APIGatewayProxyStreamingResponse {
	out := &events.APIGatewayProxyStreamingResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		Cookies:           append([]string(nil), resp.Cookies...),
		Body:              bytes.NewReader(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = values[0]
		out.MultiValueHeaders[key] = append([]string(nil), values...)
	}

	return out
}
