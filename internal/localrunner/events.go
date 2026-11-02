package localrunner

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// InvokeRequest is one HTTP request translated into a provider event.
type InvokeRequest struct {
	API         APISpec
	Route       Route
	FunctionURL *FunctionURLSpec
	Params      map[string]string
	Method      string
	Path        string
	RawPath     string
	RawQuery    string
	Header      http.Header
	Body        []byte
	RemoteAddr  string
	RequestID   string
	Now         time.Time
	// AuthorizerContext is the context a CUSTOM authorizer returned for this
	// request. It is carried as requestContext.authorizer.lambda, the same
	// place API Gateway v2 puts a simple-response authorizer context.
	AuthorizerContext map[string]any
}

// BuildEvent serializes the provider payload the handler receives: an HTTP API
// v2 event, a REST API v1 event or a Function URL event, matching the surface
// the request matched.
func BuildEvent(request InvokeRequest) ([]byte, error) {
	switch request.API.Class {
	case APIHTTPV2:
		return json.Marshal(httpV2Event(request))
	case APIRESTV1:
		return json.Marshal(restV1Event(request))
	case APIFunctionURL:
		return json.Marshal(functionURLEvent(request))
	default:
		return nil, fmt.Errorf("unsupported API class %q", request.API.Class)
	}
}

func httpV2Event(request InvokeRequest) map[string]any {
	body, encoded := eventBody(request.Body)
	routeKey := request.Route.RouteKey
	if routeKey == "" {
		routeKey = request.Method + " " + request.Route.Path
	}
	apiID := localPhysicalID("api", request.API.LogicalID)
	event := map[string]any{
		"version":        "2.0",
		"routeKey":       routeKey,
		"rawPath":        rawPath(request),
		"rawQueryString": request.RawQuery,
		"headers":        v2Headers(request.Header),
		"requestContext": map[string]any{
			"accountId":    LocalAccountID,
			"apiId":        apiID,
			"domainName":   apiID + ".execute-api." + LocalRegion + ".amazonaws.com",
			"domainPrefix": apiID,
			"http":         httpDescription(request),
			"requestId":    request.RequestID,
			"routeKey":     routeKey,
			"stage":        request.API.Stage,
			"time":         eventTime(request.Now),
			"timeEpoch":    request.Now.UnixMilli(),
		},
		"isBase64Encoded": encoded,
	}
	if body != "" {
		event["body"] = body
	}
	if query := singleQuery(request.RawQuery); len(query) > 0 {
		event["queryStringParameters"] = query
	}
	if len(request.Params) > 0 {
		event["pathParameters"] = request.Params
	}
	if cookies := requestCookies(request.Header); len(cookies) > 0 {
		event["cookies"] = cookies
	}
	if len(request.AuthorizerContext) > 0 {
		if context, ok := event["requestContext"].(map[string]any); ok {
			context["authorizer"] = map[string]any{"lambda": request.AuthorizerContext}
		}
	}
	return event
}

// BuildAuthorizerEvent serializes the API Gateway v2 REQUEST authorizer event.
// It carries the same request the route handler will receive, plus the identity
// source the authorizer declared.
func BuildAuthorizerEvent(request InvokeRequest) ([]byte, error) {
	event := httpV2Event(request)
	event["type"] = "REQUEST"
	apiID := localPhysicalID("api", request.API.LogicalID)
	routeKey := request.Route.RouteKey
	if routeKey == "" {
		routeKey = request.Method + " " + request.Route.Path
	}
	event["routeArn"] = "arn:" + LocalPartition + ":execute-api:" + LocalRegion + ":" + LocalAccountID +
		":" + apiID + "/" + request.API.Stage + "/" + strings.ToUpper(request.Method) + request.Path
	event["identitySource"] = identitySourceValue(request.Header, request.Route.AuthorizerIdentitySource)
	event["routeKey"] = routeKey
	return json.Marshal(event)
}

// identitySourceValue resolves a provider identity source such as
// $request.header.Authorization to the request's header value. An empty or
// unsupported source yields an empty string; the authorizer itself decides
// whether that is allowed.
func identitySourceValue(header http.Header, source string) string {
	const prefix = "$request.header."
	source = strings.TrimSpace(source)
	if !strings.HasPrefix(source, prefix) {
		return ""
	}
	return strings.TrimSpace(header.Get(strings.TrimPrefix(source, prefix)))
}

func restV1Event(request InvokeRequest) map[string]any {
	body, encoded := eventBody(request.Body)
	apiID := localPhysicalID("api", request.API.LogicalID)
	event := map[string]any{
		"resource":          request.Route.Path,
		"path":              request.Path,
		"httpMethod":        strings.ToUpper(request.Method),
		"headers":           multiValueHeaderFlat(request.Header),
		"multiValueHeaders": cloneHeaderMap(request.Header),
		"requestContext":    restRequestContext(request, apiID),
		"body":              body,
		"isBase64Encoded":   encoded,
	}
	if query, multi := queryValues(request.RawQuery); len(query) > 0 {
		event["queryStringParameters"] = query
		event["multiValueQueryStringParameters"] = multi
	}
	if len(request.Params) > 0 {
		event["pathParameters"] = request.Params
	}
	return event
}

func restRequestContext(request InvokeRequest, apiID string) map[string]any {
	return map[string]any{
		"accountId":         LocalAccountID,
		"apiId":             apiID,
		"domainName":        apiID + ".execute-api." + LocalRegion + ".amazonaws.com",
		"domainPrefix":      apiID,
		"extendedRequestId": request.RequestID,
		"httpMethod":        strings.ToUpper(request.Method),
		"identity": map[string]any{
			"accountId": "",
			"sourceIp":  sourceIP(request.RemoteAddr),
			"userAgent": request.Header.Get("User-Agent"),
			"userArn":   "",
			"requestId": request.RequestID,
		},
		"path":         request.Path,
		"protocol":     "HTTP/1.1",
		"requestId":    request.RequestID,
		"resourceId":   request.API.LogicalID,
		"resourcePath": request.Route.Path,
		"stage":        request.API.Stage,
	}
}

func functionURLEvent(request InvokeRequest) map[string]any {
	body, encoded := eventBody(request.Body)
	urlID := localPhysicalID("url", request.API.LogicalID)
	event := map[string]any{
		"version":        "2.0",
		"routeKey":       "$default",
		"rawPath":        rawPath(request),
		"rawQueryString": request.RawQuery,
		"headers":        v2Headers(request.Header),
		"requestContext": map[string]any{
			"accountId":    LocalAccountID,
			"requestId":    request.RequestID,
			"apiId":        urlID,
			"domainName":   urlID + FunctionURLDomainSuffix,
			"domainPrefix": urlID,
			"http":         httpDescription(request),
			"routeKey":     LocalStageName,
			"stage":        LocalStageName,
			"time":         eventTime(request.Now),
			"timeEpoch":    request.Now.UnixMilli(),
		},
		"isBase64Encoded": encoded,
	}
	if body != "" {
		event["body"] = body
	}
	if query := singleQuery(request.RawQuery); len(query) > 0 {
		event["queryStringParameters"] = query
	}
	if cookies := requestCookies(request.Header); len(cookies) > 0 {
		event["cookies"] = cookies
	}
	return event
}

// rawPath is the request target as the client sent it, which is what API
// Gateway reports in rawPath; the decoded path is used for matching.
func rawPath(request InvokeRequest) string {
	if request.RawPath != "" {
		return request.RawPath
	}
	return request.Path
}

func httpDescription(request InvokeRequest) map[string]any {
	return map[string]any{
		"method":    strings.ToUpper(request.Method),
		"path":      request.Path,
		"protocol":  "HTTP/1.1",
		"sourceIp":  sourceIP(request.RemoteAddr),
		"userAgent": request.Header.Get("User-Agent"),
	}
}

// eventBody returns the body string and whether it is base64 encoded. The
// provider payload carries strings, so a body that is not valid UTF-8 is
// base64-encoded; that is the same rule API Gateway applies to binary payloads.
func eventBody(body []byte) (string, bool) {
	if len(body) == 0 {
		return "", false
	}
	if utf8.Valid(body) {
		return string(body), false
	}
	return base64.StdEncoding.EncodeToString(body), true
}

func singleHeaders(header http.Header) map[string]string {
	out := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) == 0 {
			continue
		}
		out[strings.ToLower(name)] = strings.Join(values, ",")
	}
	return out
}

// v2Headers is the headers map of a v2-shaped event. API Gateway removes the
// Cookie header when it populates the cookies array, so a handler cannot read
// the same cookies twice in different forms.
func v2Headers(header http.Header) map[string]string {
	out := singleHeaders(header)
	if len(requestCookies(header)) > 0 {
		delete(out, "cookie")
	}
	return out
}

func multiValueHeaderFlat(header http.Header) map[string]string {
	out := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) == 0 {
			continue
		}
		out[name] = values[0]
	}
	return out
}

func cloneHeaderMap(header http.Header) map[string][]string {
	out := make(map[string][]string, len(header))
	for name, values := range header {
		out[name] = append([]string(nil), values...)
	}
	return out
}

// requestCookies splits Cookie headers into the cookies array API Gateway v2
// and Function URL events carry.
func requestCookies(header http.Header) []string {
	var cookies []string
	for _, value := range header.Values("Cookie") {
		for _, cookie := range strings.Split(value, ";") {
			if trimmed := strings.TrimSpace(cookie); trimmed != "" {
				cookies = append(cookies, trimmed)
			}
		}
	}
	return cookies
}

func singleQuery(rawQuery string) map[string]string {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil
	}
	out := make(map[string]string, len(values))
	for name, items := range values {
		if len(items) > 0 {
			out[name] = items[0]
		}
	}
	return out
}

func queryValues(rawQuery string) (map[string]string, map[string][]string) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil, nil
	}
	single := make(map[string]string, len(values))
	multi := make(map[string][]string, len(values))
	for name, items := range values {
		if len(items) == 0 {
			continue
		}
		single[name] = items[0]
		multi[name] = append([]string(nil), items...)
	}
	return single, multi
}

func sourceIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		if remoteAddr == "" {
			return "127.0.0.1"
		}
		return remoteAddr
	}
	if host == "" {
		return "127.0.0.1"
	}
	return host
}

func eventTime(now time.Time) string {
	return now.UTC().Format("02/Jan/2006:15:04:05 -0700")
}

// NewRequestID returns a request id in the shape API Gateway uses.
func NewRequestID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))[:32]
	}
	return hex.EncodeToString(raw[:])
}

// localPhysicalID derives a stable id for a logical resource, so events carry
// the same apiId/domain across invocations.
func localPhysicalID(kind, logicalID string) string {
	sum := sha256.Sum256([]byte(kind + "/" + logicalID))
	return hex.EncodeToString(sum[:])[:10]
}
