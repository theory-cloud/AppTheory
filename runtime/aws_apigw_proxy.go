package apptheory

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

const apigatewayProxyStreamingRouteStageVariablePrefix = "APPTHEORYSTREAMINGV1"

func (a *App) ServeAPIGatewayProxy(ctx context.Context, event events.APIGatewayProxyRequest) events.APIGatewayProxyResponse {
	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		return apigatewayProxyResponseFromResponse(a.responseForHTTPError(err))
	}
	return apigatewayProxyResponseFromResponse(a.Serve(ctx, req))
}

func (a *App) serveAPIGatewayProxyLambda(ctx context.Context, event events.APIGatewayProxyRequest) any {
	streamingRoute := isAPIGatewayProxyStreamingRoute(event)

	req, err := requestFromAPIGatewayProxy(event)
	if err != nil {
		if streamingRoute {
			return apigatewayProxyStreamingResponseFromResponse(a.responseForHTTPError(err))
		}
		return apigatewayProxyResponseFromResponse(a.responseForHTTPError(err))
	}

	resp := a.Serve(ctx, req)
	if streamingRoute {
		return apigatewayProxyStreamingResponseFromResponse(resp)
	}
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

func isAPIGatewayProxyStreamingRoute(event events.APIGatewayProxyRequest) bool {
	if len(event.StageVariables) == 0 {
		return false
	}

	resource := apigatewayProxyRouteResource(event)
	if resource == "" {
		return false
	}

	method := apigatewayProxyRouteMethod(event)
	if method != "" {
		if _, ok := event.StageVariables[apigatewayProxyStreamingRouteStageVariableName(method, resource)]; ok {
			return true
		}
	}

	_, ok := event.StageVariables[apigatewayProxyStreamingRouteStageVariableName("ANY", resource)]
	return ok
}

func apigatewayProxyRouteMethod(event events.APIGatewayProxyRequest) string {
	method := strings.TrimSpace(event.HTTPMethod)
	if method == "" {
		method = strings.TrimSpace(event.RequestContext.HTTPMethod)
	}
	return strings.ToUpper(method)
}

func apigatewayProxyRouteResource(event events.APIGatewayProxyRequest) string {
	if resource := normalizeAPIGatewayProxyRoutePath(event.Resource); resource != "" {
		return resource
	}
	if resource := normalizeAPIGatewayProxyRoutePath(event.RequestContext.ResourcePath); resource != "" {
		return resource
	}
	return normalizeAPIGatewayProxyRoutePath(event.Path)
}

func normalizeAPIGatewayProxyRoutePath(path string) string {
	trimmed := strings.Trim(strings.TrimSpace(path), "/")
	if trimmed == "" {
		return "/"
	}

	parts := strings.Split(trimmed, "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	if len(out) == 0 {
		return "/"
	}
	return "/" + strings.Join(out, "/")
}

func apigatewayProxyStreamingRouteStageVariableName(method, resource string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(strings.ToUpper(method)) + " " + normalizeAPIGatewayProxyRoutePath(resource)))
	return apigatewayProxyStreamingRouteStageVariablePrefix + hex.EncodeToString(sum[:16])
}

func apigatewayProxyStreamingResponseFromResponse(resp Response) *events.APIGatewayProxyStreamingResponse {
	body := io.Reader(bytes.NewReader(resp.Body))
	if resp.BodyReader != nil {
		if len(resp.Body) > 0 {
			body = io.MultiReader(bytes.NewReader(resp.Body), resp.BodyReader)
		} else {
			body = resp.BodyReader
		}
	}

	out := &events.APIGatewayProxyStreamingResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		Cookies:           append([]string(nil), resp.Cookies...),
		Body:              body,
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
