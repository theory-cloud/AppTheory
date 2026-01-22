package apptheory

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

func (a *App) ServeAPIGatewayV2(ctx context.Context, event events.APIGatewayV2HTTPRequest) events.APIGatewayV2HTTPResponse {
	req, err := requestFromAPIGatewayV2(event)
	if err != nil {
		return apigatewayV2ResponseFromResponse(responseForError(err))
	}
	return apigatewayV2ResponseFromResponse(a.Serve(ctx, req))
}

func (a *App) ServeLambdaFunctionURL(ctx context.Context, event events.LambdaFunctionURLRequest) events.LambdaFunctionURLResponse {
	req, err := requestFromLambdaFunctionURL(event)
	if err != nil {
		return lambdaFunctionURLResponseFromResponse(responseForError(err))
	}
	return lambdaFunctionURLResponseFromResponse(a.Serve(ctx, req))
}

func requestFromAPIGatewayV2(event events.APIGatewayV2HTTPRequest) (Request, error) {
	return requestFromHTTPEvent(
		event.RawQueryString,
		event.QueryStringParameters,
		event.Headers,
		event.Cookies,
		event.RawPath,
		event.RequestContext.HTTP.Method,
		event.RequestContext.HTTP.Path,
		event.Body,
		event.IsBase64Encoded,
	)
}

func requestFromLambdaFunctionURL(event events.LambdaFunctionURLRequest) (Request, error) {
	return requestFromHTTPEvent(
		event.RawQueryString,
		event.QueryStringParameters,
		event.Headers,
		event.Cookies,
		event.RawPath,
		event.RequestContext.HTTP.Method,
		event.RequestContext.HTTP.Path,
		event.Body,
		event.IsBase64Encoded,
	)
}

func requestFromHTTPEvent(
	rawQueryString string,
	queryStringParameters map[string]string,
	singleHeaders map[string]string,
	cookies []string,
	rawPath string,
	requestContextHTTPMethod string,
	requestContextHTTPPath string,
	body string,
	isBase64Encoded bool,
) (Request, error) {
	rawQuery := strings.TrimPrefix(rawQueryString, "?")
	query, err := parseEventRawQuery(rawQuery, queryStringParameters)
	if err != nil {
		return Request{}, err
	}

	headers := headersFromSingle(singleHeaders, len(cookies) > 0)
	if len(cookies) > 0 {
		headers["cookie"] = append([]string(nil), cookies...)
	}

	path := rawPath
	if path == "" {
		path = requestContextHTTPPath
	}

	return Request{
		Method:   requestContextHTTPMethod,
		Path:     path,
		Query:    query,
		Headers:  headers,
		Body:     []byte(body),
		IsBase64: isBase64Encoded,
	}, nil
}

func apigatewayV2ResponseFromResponse(resp Response) events.APIGatewayV2HTTPResponse {
	out := events.APIGatewayV2HTTPResponse{
		StatusCode:        resp.Status,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
		Cookies:           append([]string(nil), resp.Cookies...),
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

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

func lambdaFunctionURLResponseFromResponse(resp Response) events.LambdaFunctionURLResponse {
	out := events.LambdaFunctionURLResponse{
		StatusCode:      resp.Status,
		Headers:         map[string]string{},
		Cookies:         append([]string(nil), resp.Cookies...),
		IsBase64Encoded: resp.IsBase64,
		Body:            string(resp.Body),
	}

	for key, values := range resp.Headers {
		if len(values) == 0 {
			continue
		}
		out.Headers[key] = strings.Join(values, ",")
	}

	if resp.IsBase64 {
		out.Body = base64.StdEncoding.EncodeToString(resp.Body)
	}

	return out
}

func headersFromSingle(headers map[string]string, ignoreCookieHeader bool) map[string][]string {
	out := map[string][]string{}
	for key, value := range headers {
		if ignoreCookieHeader && strings.EqualFold(key, "cookie") {
			continue
		}
		out[key] = []string{value}
	}
	return out
}

func parseEventRawQuery(raw string, single map[string]string) (map[string][]string, error) {
	if raw != "" {
		values, err := url.ParseQuery(raw)
		if err != nil {
			return nil, &AppError{Code: errorCodeBadRequest, Message: errorMessageInvalidQueryString}
		}
		out := map[string][]string{}
		for key, vs := range values {
			out[key] = append([]string(nil), vs...)
		}
		return out, nil
	}

	out := map[string][]string{}
	for key, value := range single {
		out[key] = []string{value}
	}
	return out, nil
}
