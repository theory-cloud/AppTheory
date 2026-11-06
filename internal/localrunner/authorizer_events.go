package localrunner

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// REST API Lambda authorizer events and identity sources.
//
// A TOKEN authorizer receives the token from one header; a REQUEST authorizer
// receives the whole request and one value per configured identity source. The
// runner reads the expressions at plan time and refuses one it cannot resolve.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html

const restIdentitySourcePrefix = "method.request."

// restIdentitySource is one parsed REST authorizer identity source.
type restIdentitySource struct {
	raw  string
	kind identitySourceKind
	name string
}

// parseRESTIdentitySource accepts the mapping expressions a REST authorizer can
// use: a header, a query string or a path parameter. API Gateway also accepts
// stage variables and $context expressions; the runner refuses them by name
// rather than passing an empty value.
func parseRESTIdentitySource(raw string) (restIdentitySource, error) {
	source := strings.TrimSpace(raw)
	if !strings.HasPrefix(source, restIdentitySourcePrefix) {
		return restIdentitySource{}, fmt.Errorf(
			"identity source %q is not supported locally; only %sheader.<name>, %squerystring.<name> and %spath.<name> are run",
			raw, restIdentitySourcePrefix, restIdentitySourcePrefix, restIdentitySourcePrefix,
		)
	}
	remaining := strings.TrimPrefix(source, restIdentitySourcePrefix)
	kind, name, found := strings.Cut(remaining, ".")
	if !found || strings.TrimSpace(name) == "" {
		return restIdentitySource{}, fmt.Errorf("identity source %q has no name", raw)
	}
	switch kind {
	case "header":
		return restIdentitySource{raw: source, kind: identitySourceHeader, name: strings.TrimSpace(name)}, nil
	case "querystring":
		return restIdentitySource{raw: source, kind: identitySourceQueryString, name: strings.TrimSpace(name)}, nil
	case "path":
		return restIdentitySource{raw: source, kind: identitySourcePath, name: strings.TrimSpace(name)}, nil
	default:
		return restIdentitySource{}, fmt.Errorf(
			"identity source %q names %q, which the local runner does not resolve",
			raw, kind,
		)
	}
}

// validateRESTIdentitySource fails closed at derive/plan time for an expression
// the transport cannot resolve.
func validateRESTIdentitySource(raw string) error {
	_, err := parseRESTIdentitySource(raw)
	return err
}

// value resolves the expression against the request. A header name is
// case-insensitive; a query string and a path parameter name are
// case-sensitive. An empty result means the source is absent or empty.
func (s restIdentitySource) value(header http.Header, rawQuery string, params map[string]string) string {
	switch s.kind {
	case identitySourceHeader:
		return strings.TrimSpace(header.Get(s.name))
	case identitySourceQueryString:
		values, err := url.ParseQuery(rawQuery)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(values.Get(s.name))
	case identitySourcePath:
		return strings.TrimSpace(params[s.name])
	default:
		return ""
	}
}

// restIdentitySourceValues resolves every configured source in order, which is
// the authorizer's cache key with caching enabled.
func restIdentitySourceValues(header http.Header, rawQuery string, params map[string]string, sources []string) ([]string, error) {
	values := make([]string, 0, len(sources))
	for _, source := range sources {
		parsed, err := parseRESTIdentitySource(source)
		if err != nil {
			return nil, err
		}
		values = append(values, parsed.value(header, rawQuery, params))
	}
	return values, nil
}

// missingRESTIdentitySource names the first configured source the request does
// not carry. API Gateway refuses such a request without invoking the authorizer.
func missingRESTIdentitySource(header http.Header, rawQuery string, params map[string]string, sources []string) (string, error) {
	for _, source := range sources {
		parsed, err := parseRESTIdentitySource(source)
		if err != nil {
			return "", err
		}
		if parsed.value(header, rawQuery, params) == "" {
			return parsed.raw, nil
		}
	}
	return "", nil
}

// methodARN is the documented REST API method ARN:
// arn:aws:execute-api:<region>:<account>:<api-id>/<stage>/<METHOD>/<resource>.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
func methodARN(api APISpec, method, path string) string {
	suffix := strings.TrimPrefix(path, "/")
	return "arn:" + LocalPartition + ":execute-api:" + LocalRegion + ":" + LocalAccountID +
		":" + localPhysicalID("api", api.LogicalID) + "/" + api.Stage + "/" + strings.ToUpper(method) +
		"/" + suffix
}

// buildRESTAuthorizerEvent builds the documented event for a REST TOKEN or
// REQUEST authorizer.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-input.html
func buildRESTAuthorizerEvent(request InvokeRequest, restType, token string) ([]byte, error) {
	method := strings.ToUpper(request.Method)
	arn := methodARN(request.API, method, request.Path)
	if restType == authorizerTypeToken {
		event := map[string]any{
			"type":               "TOKEN",
			"authorizationToken": token,
			"methodArn":          arn,
		}
		return json.Marshal(event)
	}
	body, encoded := eventBody(request.Body)
	apiID := localPhysicalID("api", request.API.LogicalID)
	event := map[string]any{
		"type":                            "REQUEST",
		"methodArn":                       arn,
		"resource":                        request.Route.Path,
		"path":                            request.Path,
		"httpMethod":                      method,
		"headers":                         multiValueHeaderFlat(request.Header),
		"multiValueHeaders":               cloneHeaderMap(request.Header),
		"queryStringParameters":           nil,
		"multiValueQueryStringParameters": nil,
		"stageVariables":                  map[string]any{},
		"requestContext":                  restRequestContext(request, apiID),
		"body":                            body,
		"isBase64Encoded":                 encoded,
	}
	if query, multi := queryValues(request.RawQuery); len(query) > 0 {
		event["queryStringParameters"] = query
		event["multiValueQueryStringParameters"] = multi
	}
	if len(request.Params) > 0 {
		event["pathParameters"] = request.Params
	}
	return json.Marshal(event)
}

// buildHTTPAuthorizerEventV1 builds an HTTP API Lambda authorizer event with
// payload format 1.0. It carries methodArn and the REST-shaped request fields;
// format 2.0 uses the HTTP API v2 proxy event plus routeArn.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
func buildHTTPAuthorizerEventV1(request InvokeRequest, identitySources []string) ([]byte, error) {
	body, encoded := eventBody(request.Body)
	apiID := localPhysicalID("api", request.API.LogicalID)
	method := strings.ToUpper(request.Method)
	event := map[string]any{
		"type":                            "REQUEST",
		"methodArn":                       methodARN(request.API, method, request.Path),
		"resource":                        request.Route.Path,
		"path":                            request.Path,
		"httpMethod":                      method,
		"headers":                         multiValueHeaderFlat(request.Header),
		"multiValueHeaders":               cloneHeaderMap(request.Header),
		"queryStringParameters":           nil,
		"multiValueQueryStringParameters": nil,
		"stageVariables":                  map[string]any{},
		"requestContext":                  restRequestContext(request, apiID),
		"body":                            body,
		"isBase64Encoded":                 encoded,
		"identitySource":                  identitySources,
	}
	if query, multi := queryValues(request.RawQuery); len(query) > 0 {
		event["queryStringParameters"] = query
		event["multiValueQueryStringParameters"] = multi
	}
	if len(request.Params) > 0 {
		event["pathParameters"] = request.Params
	}
	return json.Marshal(event)
}

// authorizerContextValues applies the documented authorizer context rule: every
// value is a string and a nested object is not allowed. API Gateway answers 500
// when the authorizer returns a malformed context.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html
func authorizerContextValues(context map[string]any) (map[string]any, error) {
	if len(context) == 0 {
		return nil, nil
	}
	values := make(map[string]any, len(context))
	for _, key := range sortedKeys(context) {
		value := context[key]
		switch typed := value.(type) {
		case nil:
			values[key] = ""
		case string:
			values[key] = typed
		case bool:
			values[key] = fmt.Sprintf("%t", typed)
		case float64:
			values[key] = trimFloat(typed)
		case json.Number:
			values[key] = typed.String()
		default:
			return nil, fmt.Errorf("authorizer context value %q is not a scalar", key)
		}
	}
	return values, nil
}

func trimFloat(value float64) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(encoded)
}
