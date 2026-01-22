package testkit

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// HTTPEventOptions configures synthetic HTTP events for local testing.
type HTTPEventOptions struct {
	Query        map[string][]string
	Headers      map[string]string
	MultiHeaders map[string][]string
	Cookies      []string
	Body         []byte
	IsBase64     bool
}

func APIGatewayV2Request(method, path string, opts HTTPEventOptions) events.APIGatewayV2HTTPRequest {
	rawPath, rawQuery := splitPathAndQuery(path, opts.Query)
	headers := cloneHeaderMap(opts.Headers)

	body := string(opts.Body)
	if opts.IsBase64 {
		body = base64.StdEncoding.EncodeToString(opts.Body)
	}

	queryStringParameters := map[string]string{}
	for key, values := range opts.Query {
		if len(values) > 0 {
			queryStringParameters[key] = values[0]
		}
	}

	return events.APIGatewayV2HTTPRequest{
		Version:        "2.0",
		RouteKey:       "$default",
		RawPath:        rawPath,
		RawQueryString: rawQuery,
		Cookies:        append([]string(nil), opts.Cookies...),
		Headers:        headers,
		QueryStringParameters: func() map[string]string {
			if len(queryStringParameters) == 0 {
				return nil
			}
			return queryStringParameters
		}(),
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method: strings.ToUpper(strings.TrimSpace(method)),
				Path:   rawPath,
			},
		},
		Body:            body,
		IsBase64Encoded: opts.IsBase64,
	}
}

func LambdaFunctionURLRequest(method, path string, opts HTTPEventOptions) events.LambdaFunctionURLRequest {
	rawPath, rawQuery := splitPathAndQuery(path, opts.Query)
	headers := cloneHeaderMap(opts.Headers)

	body := string(opts.Body)
	if opts.IsBase64 {
		body = base64.StdEncoding.EncodeToString(opts.Body)
	}

	queryStringParameters := map[string]string{}
	for key, values := range opts.Query {
		if len(values) > 0 {
			queryStringParameters[key] = values[0]
		}
	}

	return events.LambdaFunctionURLRequest{
		Version:        "2.0",
		RawPath:        rawPath,
		RawQueryString: rawQuery,
		Cookies:        append([]string(nil), opts.Cookies...),
		Headers:        headers,
		QueryStringParameters: func() map[string]string {
			if len(queryStringParameters) == 0 {
				return nil
			}
			return queryStringParameters
		}(),
		RequestContext: events.LambdaFunctionURLRequestContext{
			HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{
				Method: strings.ToUpper(strings.TrimSpace(method)),
				Path:   rawPath,
			},
		},
		Body:            body,
		IsBase64Encoded: opts.IsBase64,
	}
}

func ALBTargetGroupRequest(method, path string, opts HTTPEventOptions) events.ALBTargetGroupRequest {
	rawPath, rawQuery := splitPathAndQuery(path, opts.Query)
	headers, multiHeaders := mergeALBHeaders(opts)
	queryStringParameters, multiValueQueryStringParameters := parseALBQuery(rawQuery, opts.Query)
	body := encodeBody(opts.Body, opts.IsBase64)

	return events.ALBTargetGroupRequest{
		HTTPMethod: strings.ToUpper(strings.TrimSpace(method)),
		Path:       rawPath,
		Headers:    headers,
		MultiValueHeaders: func() map[string][]string {
			if len(multiHeaders) == 0 {
				return nil
			}
			return multiHeaders
		}(),
		QueryStringParameters: func() map[string]string {
			if len(queryStringParameters) == 0 {
				return nil
			}
			return queryStringParameters
		}(),
		MultiValueQueryStringParameters: func() map[string][]string {
			if len(multiValueQueryStringParameters) == 0 {
				return nil
			}
			return multiValueQueryStringParameters
		}(),
		RequestContext: events.ALBTargetGroupRequestContext{
			ELB: events.ELBContext{
				TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000",
			},
		},
		Body:            body,
		IsBase64Encoded: opts.IsBase64,
	}
}

func mergeALBHeaders(opts HTTPEventOptions) (map[string]string, map[string][]string) {
	headers := cloneHeaderMap(opts.Headers)

	multiHeaders := map[string][]string{}
	for key, values := range opts.MultiHeaders {
		multiHeaders[key] = append([]string(nil), values...)
	}
	for key, value := range headers {
		if _, ok := multiHeaders[key]; ok {
			continue
		}
		multiHeaders[key] = []string{value}
	}
	for key, values := range multiHeaders {
		if len(values) == 0 {
			continue
		}
		if _, ok := headers[key]; ok {
			continue
		}
		headers[key] = values[0]
	}

	if len(opts.Cookies) > 0 {
		if _, ok := multiHeaders["cookie"]; !ok {
			multiHeaders["cookie"] = append([]string(nil), opts.Cookies...)
			headers["cookie"] = opts.Cookies[0]
		}
	}

	return headers, multiHeaders
}

func parseALBQuery(rawQuery string, query map[string][]string) (map[string]string, map[string][]string) {
	if len(query) == 0 && rawQuery != "" {
		if values, err := url.ParseQuery(rawQuery); err == nil {
			query = map[string][]string{}
			for key, vs := range values {
				query[key] = append([]string(nil), vs...)
			}
		}
	}

	queryStringParameters := map[string]string{}
	multiValueQueryStringParameters := map[string][]string{}
	for key, values := range query {
		if len(values) == 0 {
			continue
		}
		queryStringParameters[key] = values[0]
		multiValueQueryStringParameters[key] = append([]string(nil), values...)
	}
	return queryStringParameters, multiValueQueryStringParameters
}

func encodeBody(body []byte, isBase64 bool) string {
	if len(body) == 0 {
		return ""
	}
	if isBase64 {
		return base64.StdEncoding.EncodeToString(body)
	}
	return string(body)
}

func (e *Env) InvokeAPIGatewayV2(
	ctx context.Context,
	app *apptheory.App,
	event events.APIGatewayV2HTTPRequest,
) events.APIGatewayV2HTTPResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeAPIGatewayV2(ctx, event)
}

func (e *Env) InvokeLambdaFunctionURL(
	ctx context.Context,
	app *apptheory.App,
	event events.LambdaFunctionURLRequest,
) events.LambdaFunctionURLResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeLambdaFunctionURL(ctx, event)
}

func (e *Env) InvokeALB(
	ctx context.Context,
	app *apptheory.App,
	event events.ALBTargetGroupRequest,
) events.ALBTargetGroupResponse {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.ServeALB(ctx, event)
}

func splitPathAndQuery(path string, query map[string][]string) (string, string) {
	parsed := strings.TrimSpace(path)
	rawPath, rawQuery, ok := strings.Cut(parsed, "?")
	if !ok {
		rawPath = parsed
		rawQuery = ""
	}

	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		rawPath = "/"
	}
	if !strings.HasPrefix(rawPath, "/") {
		rawPath = "/" + rawPath
	}

	if len(query) == 0 {
		return rawPath, rawQuery
	}

	values := url.Values{}
	for key, vs := range query {
		values[key] = append([]string(nil), vs...)
	}
	return rawPath, values.Encode()
}

func cloneHeaderMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return map[string]string{}
	}
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}
