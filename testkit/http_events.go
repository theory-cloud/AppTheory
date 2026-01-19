package testkit

import (
	"context"
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory"
)

// HTTPEventOptions configures synthetic HTTP events for local testing.
type HTTPEventOptions struct {
	Query    map[string][]string
	Headers  map[string]string
	Cookies  []string
	Body     []byte
	IsBase64 bool
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

func splitPathAndQuery(path string, query map[string][]string) (string, string) {
	parsed := strings.TrimSpace(path)
	rawPath := parsed
	rawQuery := ""
	if i := strings.Index(parsed, "?"); i >= 0 {
		rawPath = parsed[:i]
		rawQuery = parsed[i+1:]
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
