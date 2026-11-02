package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

const (
	// maxRequestBody is the body size the local transport accepts. API Gateway
	// caps payloads at 10 MB; the local transport refuses larger bodies instead
	// of buffering without a bound.
	maxRequestBody = 10 << 20
)

// Invoker sends one event to a function container and returns its raw response.
type Invoker interface {
	Invoke(ctx context.Context, payload []byte) ([]byte, error)
}

// Transport serves one API surface and invokes the app's real handlers.
type Transport struct {
	API       APISpec
	Invokers  map[string]Invoker
	Semaphore chan struct{}
	Now       func() time.Time
	Logf      func(format string, args ...any)
}

// NewTransport builds a transport for an API surface.
func NewTransport(api APISpec, invokers map[string]Invoker, semaphore chan struct{}, logf func(string, ...any)) *Transport {
	return &Transport{
		API:       api,
		Invokers:  invokers,
		Semaphore: semaphore,
		Now:       time.Now,
		Logf:      logf,
	}
}

func (t *Transport) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	requestID := NewRequestID()
	// Keep the exact casing API Gateway uses; Header.Set would canonicalize it.
	writer.Header()["x-amzn-RequestId"] = []string{requestID}

	body, err := readRequestBody(request)
	if err != nil {
		t.fail(writer, http.StatusRequestEntityTooLarge, "Request Too Large", requestID, err)
		return
	}
	path := RequestPath(request)
	var route Route
	var params map[string]string
	if t.API.Class == APIFunctionURL {
		route = t.API.Routes[0]
		params = map[string]string{}
	} else {
		matched, matchedParams, ok := MatchRoute(t.API, request.Method, path)
		if !ok {
			t.notFound(writer, request)
			return
		}
		route, params = matched, matchedParams
	}
	if route.Mock != nil {
		for name, value := range route.Mock.Headers {
			writer.Header().Set(name, value)
		}
		writer.WriteHeader(route.Mock.StatusCode)
		t.logf("%s %s -> %d (MOCK integration declared by the template)", request.Method, path, route.Mock.StatusCode)
		return
	}
	invoker, ok := t.Invokers[route.Function]
	if !ok {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID,
			fmt.Errorf("no running container for function %s", route.Function))
		return
	}
	if err = t.acquire(request.Context()); err != nil {
		t.fail(writer, http.StatusServiceUnavailable, "Service Unavailable", requestID, err)
		return
	}
	defer t.release()

	authorizerContext, err := t.authorize(request, route, params, path, body, requestID)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	if authorizerContext == nil && route.AuthorizerFunction != "" {
		t.unauthorized(writer, request, path, requestID)
		return
	}

	payload, err := BuildEvent(InvokeRequest{
		API:               t.API,
		Route:             route,
		Params:            params,
		Method:            request.Method,
		Path:              path,
		RawPath:           request.URL.EscapedPath(),
		RawQuery:          request.URL.RawQuery,
		Header:            request.Header,
		Body:              body,
		RemoteAddr:        request.RemoteAddr,
		RequestID:         requestID,
		Now:               t.Now(),
		AuthorizerContext: authorizerContext,
	})
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	raw, err := invoker.Invoke(request.Context(), payload)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	response, err := DecodeResponse(raw)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	writeResponse(writer, response)
	t.logf("%s %s -> %d%s", request.Method, path, response.StatusCode, streamedNote(response.Streamed))
}

func (t *Transport) authorize(
	request *http.Request,
	route Route,
	params map[string]string,
	path string,
	body []byte,
	requestID string,
) (map[string]any, error) {
	if route.AuthorizerFunction == "" {
		return nil, nil
	}
	invoker, ok := t.Invokers[route.AuthorizerFunction]
	if !ok {
		return nil, fmt.Errorf("no running container for authorizer %s", route.AuthorizerFunction)
	}
	missing, err := missingIdentitySource(request.Header, request.URL.RawQuery, route.AuthorizerIdentitySources)
	if err != nil {
		return nil, fmt.Errorf("authorizer identity source: %w", err)
	}
	if missing != "" {
		t.logf("%s %s -> 401 (identity source %s is missing; authorizer %s was not invoked)",
			request.Method, path, missing, route.AuthorizerFunction)
		return nil, nil
	}
	payload, err := BuildAuthorizerEvent(InvokeRequest{
		API:        t.API,
		Route:      route,
		Params:     params,
		Method:     request.Method,
		Path:       path,
		RawPath:    request.URL.EscapedPath(),
		RawQuery:   request.URL.RawQuery,
		Header:     request.Header,
		Body:       body,
		RemoteAddr: request.RemoteAddr,
		RequestID:  requestID,
		Now:        t.Now(),
	})
	if err != nil {
		return nil, fmt.Errorf("build authorizer event: %w", err)
	}
	raw, err := invoker.Invoke(request.Context(), payload)
	if err != nil {
		return nil, fmt.Errorf("invoke authorizer %s: %w", route.AuthorizerFunction, err)
	}
	var result struct {
		IsAuthorized bool           `json:"isAuthorized"`
		Context      map[string]any `json:"context"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("authorizer %s returned an invalid simple response: %w", route.AuthorizerFunction, err)
	}
	if !result.IsAuthorized {
		t.logf("%s %s -> 401 (authorizer %s denied)", request.Method, path, route.AuthorizerFunction)
		return nil, nil
	}
	if result.Context == nil {
		result.Context = map[string]any{}
	}
	return result.Context, nil
}

func (t *Transport) unauthorized(writer http.ResponseWriter, request *http.Request, path, requestID string) {
	t.logf("%s %s -> 401 (authorizer denied; request %s)", request.Method, path, requestID)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusUnauthorized)
	_, _ = writer.Write([]byte(`{"message":"Unauthorized"}`)) //nolint:errcheck // response already committed
}

func readRequestBody(request *http.Request) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBody+1))
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if len(body) > maxRequestBody {
		return nil, fmt.Errorf("request body exceeds the %d byte local limit", maxRequestBody)
	}
	return body, nil
}

func (t *Transport) acquire(ctx context.Context) error {
	if t.Semaphore == nil {
		return nil
	}
	select {
	case t.Semaphore <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (t *Transport) release() {
	if t.Semaphore == nil {
		return
	}
	<-t.Semaphore
}

func (t *Transport) notFound(writer http.ResponseWriter, request *http.Request) {
	t.logf("%s %s -> 404 (no route in %s)", request.Method, RequestPath(request), t.API.LogicalID)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusNotFound)
	_, _ = writer.Write([]byte(`{"message":"Not Found"}`)) //nolint:errcheck // response already committed
}

func (t *Transport) fail(writer http.ResponseWriter, status int, message, requestID string, cause error) {
	t.logf("request %s failed: %v", requestID, cause)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	encoded, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		return
	}
	_, _ = writer.Write(encoded) //nolint:errcheck // response already committed
}

func (t *Transport) logf(format string, args ...any) {
	if t.Logf != nil {
		t.Logf(format, args...)
	}
}

func writeResponse(writer http.ResponseWriter, response LambdaResponse) {
	header := writer.Header()
	for name, values := range response.Headers {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	for _, cookie := range response.Cookies {
		header.Add("Set-Cookie", cookie)
	}
	writer.WriteHeader(response.StatusCode)
	if _, err := writer.Write(response.Body); err != nil && !errors.Is(err, http.ErrBodyNotAllowed) {
		return
	}
}

func isHopByHopHeader(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	case "Content-Length", "Transfer-Encoding", "Connection", "Keep-Alive", "Proxy-Authenticate", "Te", "Trailer", "Upgrade":
		return true
	default:
		return false
	}
}

func streamedNote(streamed bool) string {
	if !streamed {
		return ""
	}
	return " (buffered streaming response; the RIE does not stream incrementally)"
}

// RouteTable renders the derived surface for the CLI's plan output.
func RouteTable(spec *Spec) []string {
	var lines []string
	for _, api := range spec.APIs {
		lines = append(lines, fmt.Sprintf("api %-8s %-28s stage=%s", api.Class, api.LogicalID, api.Stage))
		for _, route := range api.Routes {
			if route.Mock != nil {
				lines = append(lines, fmt.Sprintf("  %-6s %-24s -> MOCK %d (declared by the template)",
					route.Method, route.Path, route.Mock.StatusCode))
				continue
			}
			lines = append(lines, fmt.Sprintf("  %-6s %-24s -> %s%s",
				route.Method, route.Path, route.Function, streamingSuffix(route.Streaming)))
		}
	}
	for _, url := range spec.FunctionURLs {
		lines = append(lines, fmt.Sprintf("api %-8s %-28s -> %s%s",
			APIFunctionURL, url.LogicalID, url.Function, streamingSuffix(url.Streaming)))
	}
	for _, distribution := range spec.CloudFront {
		state := "servable"
		if !distribution.Servable() {
			state = "refused"
		}
		lines = append(lines, fmt.Sprintf("cloudfront %-24s %s", distribution.LogicalID, state))
		if distribution.DefaultBehavior != nil {
			lines = append(lines, fmt.Sprintf("  %-8s %-24s -> %s%s",
				"DEFAULT", "*", distribution.DefaultBehavior.TargetOriginID,
				cloudFrontFunctionsSuffix(distribution.DefaultBehavior)))
		}
		for _, behavior := range distribution.CacheBehaviors {
			lines = append(lines, fmt.Sprintf("  %-8s %-24s -> %s%s",
				"BEHAVIOR", behavior.PathPattern, behavior.TargetOriginID,
				cloudFrontFunctionsSuffix(behavior)))
		}
		for _, refusal := range distribution.Refusals {
			lines = append(lines, "  refused: "+refusal)
		}
	}
	return lines
}

func cloudFrontFunctionsSuffix(behavior *localcloudfront.Behavior) string {
	var parts []string
	if behavior.ViewerRequestFunction != "" {
		parts = append(parts, "viewer-request="+behavior.ViewerRequestFunction)
	}
	if behavior.ViewerResponseFunction != "" {
		parts = append(parts, "viewer-response="+behavior.ViewerResponseFunction)
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, " ") + ")"
}

func streamingSuffix(streaming bool) string {
	if !streaming {
		return ""
	}
	return " (response streaming: buffered locally)"
}

// SummarizeEndpoints renders the endpoints the runner injects, sorted.
func SummarizeEndpoints(endpoints []Endpoint) string {
	parts := make([]string, 0, len(endpoints))
	for _, endpoint := range endpoints {
		parts = append(parts, strings.ToLower(endpoint.Service)+"="+endpoint.URL)
	}
	return strings.Join(parts, " ")
}
