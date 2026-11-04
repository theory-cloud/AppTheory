package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
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
	// Clock is the run clock; a JWT's exp and nbf are checked against it.
	Clock Clock
	Logf  func(format string, args ...any)

	jwtMu        sync.Mutex
	jwtVerifiers map[string]*jwtVerifier
}

// authorizerResult carries what one authorizer produced. Status is 0 when the
// request may proceed, or the HTTP status that refuses it.
type authorizerResult struct {
	Status int
	Lambda map[string]any
	JWT    map[string]any
	Scopes []string
	Claims map[string]any
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

	authorizer, err := t.authorize(request, route, params, path, body, requestID)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	if authorizer.Status != 0 {
		t.refuse(writer, request, path, requestID, authorizer.Status)
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
		AuthorizerContext: authorizer.Lambda,
		AuthorizerJWT:     authorizer.JWT,
		AuthorizerScopes:  authorizer.Scopes,
		AuthorizerClaims:  authorizer.Claims,
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

// authorize runs the route's authorizer. It never bypasses one: a route with an
// authorizer kind the transport cannot run was refused at derive time.
func (t *Transport) authorize(
	request *http.Request,
	route Route,
	params map[string]string,
	path string,
	body []byte,
	requestID string,
) (authorizerResult, error) {
	switch route.AuthorizerKind {
	case AuthorizerKindJWT:
		return t.authorizeJWT(request, route)
	case AuthorizerKindCognito:
		return t.authorizeCognito(request, route)
	case AuthorizerKindSimpleRequest, AuthorizerKindLambdaRequest:
		if route.AuthorizerFunction == "" {
			return authorizerResult{}, nil
		}
		return t.authorizeRequest(request, route, params, path, body, requestID)
	default:
		if route.AuthorizerFunction == "" {
			return authorizerResult{}, nil
		}
		return t.authorizeRequest(request, route, params, path, body, requestID)
	}
}

// authorizeRequest runs a REQUEST Lambda authorizer with simple responses.
func (t *Transport) authorizeRequest(
	request *http.Request,
	route Route,
	params map[string]string,
	path string,
	body []byte,
	requestID string,
) (authorizerResult, error) {
	invoker, ok := t.Invokers[route.AuthorizerFunction]
	if !ok {
		return authorizerResult{}, fmt.Errorf("no running container for authorizer %s", route.AuthorizerFunction)
	}
	missing, err := missingIdentitySource(request.Header, request.URL.RawQuery, route.AuthorizerIdentitySources)
	if err != nil {
		return authorizerResult{}, fmt.Errorf("authorizer identity source: %w", err)
	}
	if missing != "" {
		t.logf("%s %s -> 401 (identity source %s is missing; authorizer %s was not invoked)",
			request.Method, path, missing, route.AuthorizerFunction)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
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
		return authorizerResult{}, fmt.Errorf("build authorizer event: %w", err)
	}
	raw, err := invoker.Invoke(request.Context(), payload)
	if err != nil {
		return authorizerResult{}, fmt.Errorf("invoke authorizer %s: %w", route.AuthorizerFunction, err)
	}
	var result struct {
		IsAuthorized bool           `json:"isAuthorized"`
		Context      map[string]any `json:"context"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return authorizerResult{}, fmt.Errorf("authorizer %s returned an invalid simple response: %w", route.AuthorizerFunction, err)
	}
	if !result.IsAuthorized {
		t.logf("%s %s -> 401 (authorizer %s denied)", request.Method, path, route.AuthorizerFunction)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	if result.Context == nil {
		result.Context = map[string]any{}
	}
	return authorizerResult{Lambda: result.Context}, nil
}

// authorizeJWT validates an HTTP API JWT authorizer's bearer token.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
func (t *Transport) authorizeJWT(request *http.Request, route Route) (authorizerResult, error) {
	header := ""
	for _, source := range route.AuthorizerIdentitySources {
		parsed, err := parseIdentitySource(source)
		if err != nil {
			return authorizerResult{}, err
		}
		header = parsed.value(request.Header, request.URL.RawQuery)
		if header != "" {
			break
		}
	}
	if strings.TrimSpace(header) == "" {
		t.logf("%s %s -> 401 (no JWT identity source)", request.Method, request.URL.Path)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	token, err := bearerToken(header)
	if err != nil {
		t.logf("%s %s -> 401 (%v)", request.Method, request.URL.Path, err)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	verifier, err := t.jwtVerifier(route)
	if err != nil {
		return authorizerResult{}, err
	}
	claims, err := verifier.verifyToken(request.Context(), token)
	if err != nil {
		t.logf("%s %s -> 401 (JWT refused: %v)", request.Method, request.URL.Path, err)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	if scope := missingScope(claims, route.AuthorizationScopes); scope != "" {
		t.logf("%s %s -> 403 (the token does not carry scope %s)", request.Method, request.URL.Path, scope)
		return authorizerResult{Status: http.StatusForbidden}, nil
	}
	return authorizerResult{JWT: claims, Scopes: tokenScopes(claims)}, nil
}

// authorizeCognito validates a REST API Cognito user-pool authorizer's token.
// A Cognito authorizer carries the token in a header; the "Bearer" prefix is
// accepted and optional.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html
func (t *Transport) authorizeCognito(request *http.Request, route Route) (authorizerResult, error) {
	source := "method.request.header.Authorization"
	if len(route.AuthorizerIdentitySources) > 0 && strings.TrimSpace(route.AuthorizerIdentitySources[0]) != "" {
		source = strings.TrimSpace(route.AuthorizerIdentitySources[0])
	}
	const prefix = "method.request.header."
	if !strings.HasPrefix(source, prefix) {
		return authorizerResult{}, fmt.Errorf("the Cognito authorizer identity source %q is not a request header", source)
	}
	header := strings.TrimSpace(request.Header.Get(strings.TrimPrefix(source, prefix)))
	if header == "" {
		t.logf("%s %s -> 401 (no Cognito identity source)", request.Method, request.URL.Path)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	token := header
	if candidate, err := bearerToken(header); err == nil {
		token = candidate
	}
	verifier, err := t.jwtVerifier(route)
	if err != nil {
		return authorizerResult{}, err
	}
	claims, err := verifier.verifyToken(request.Context(), token)
	if err != nil {
		t.logf("%s %s -> 401 (Cognito token refused: %v)", request.Method, request.URL.Path, err)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	if scope := missingScope(claims, route.AuthorizationScopes); scope != "" {
		t.logf("%s %s -> 403 (the token does not carry scope %s)", request.Method, request.URL.Path, scope)
		return authorizerResult{Status: http.StatusForbidden}, nil
	}
	return authorizerResult{Claims: claims, Scopes: tokenScopes(claims)}, nil
}

// jwtVerifier returns the route's verifier, cached by its JWKS endpoint.
func (t *Transport) jwtVerifier(route Route) (*jwtVerifier, error) {
	if route.JWKSURL == "" || len(route.AcceptedIssuers) == 0 {
		return nil, fmt.Errorf("the route's authorizer has no resolved issuer; the run must not serve it")
	}
	t.jwtMu.Lock()
	defer t.jwtMu.Unlock()
	if t.jwtVerifiers == nil {
		t.jwtVerifiers = map[string]*jwtVerifier{}
	}
	if verifier, ok := t.jwtVerifiers[route.JWKSURL]; ok {
		return verifier, nil
	}
	clock := t.Clock
	if clock == nil {
		clock = RealClock{}
	}
	verifier := newJWTVerifier(clock, jwtIssuer{
		Accepted: route.AcceptedIssuers,
		JWKSURL:  route.JWKSURL,
		Audience: route.JWTAudience,
	})
	t.jwtVerifiers[route.JWKSURL] = verifier
	return verifier, nil
}

// refuse writes the status an authorizer denied with.
func (t *Transport) refuse(writer http.ResponseWriter, request *http.Request, path, requestID string, status int) {
	message := "Unauthorized"
	if status == http.StatusForbidden {
		message = "Forbidden"
	}
	t.logf("%s %s -> %d (authorizer refused; request %s)", request.Method, path, status, requestID)
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(`{"message":"` + message + `"}`)) //nolint:errcheck // response already committed
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
			lines = append(lines, fmt.Sprintf("  %-6s %-24s -> %s%s%s",
				route.Method, route.Path, route.Function, streamingSuffix(route.Streaming),
				authorizerSuffix(route)))
		}
	}
	for _, url := range spec.FunctionURLs {
		lines = append(lines, fmt.Sprintf("api %-8s %-28s -> %s%s",
			APIFunctionURL, url.LogicalID, url.Function, streamingSuffix(url.Streaming)))
	}
	for _, api := range spec.WebSockets {
		lines = append(lines, fmt.Sprintf("api %-8s %-28s stage=%s selection=%s",
			api.Class, api.LogicalID, api.Stage, api.RouteSelectionExpression))
		for _, route := range api.Routes {
			lines = append(lines, fmt.Sprintf("  %-10s %-24s -> %s",
				route.RouteKey, twoWayLabel(route.TwoWay), route.Function))
		}
		if api.Authorizer != nil {
			lines = append(lines, fmt.Sprintf("  %-10s %-24s -> %s",
				"$connect", "authorizer", api.Authorizer.Function))
		}
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

// authorizerSuffix names the authorizer a route runs.
func authorizerSuffix(route Route) string {
	switch route.AuthorizerKind {
	case AuthorizerKindSimpleRequest:
		return " authorizer=" + route.AuthorizerFunction
	case AuthorizerKindJWT:
		issuer := route.JWTIssuer
		if issuer == "" {
			issuer = "resolved at run"
		}
		return " authorizer=jwt issuer=" + issuer
	case AuthorizerKindCognito:
		return " authorizer=cognito-user-pools"
	default:
		if route.AuthorizerFunction != "" {
			return " authorizer=" + route.AuthorizerFunction
		}
		return ""
	}
}

// twoWayLabel names the response direction of a WebSocket route.
func twoWayLabel(twoWay bool) string {
	if twoWay {
		return "two-way"
	}
	return "one-way"
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
