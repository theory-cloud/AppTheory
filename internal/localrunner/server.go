package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
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
	// Clock is the run clock; a JWT's exp, nbf and iat are checked against it.
	Clock Clock
	Logf  func(format string, args ...any)

	jwtMu        sync.Mutex
	jwtVerifiers map[string]*jwtVerifier

	// authMu guards the authorizer result cache. The cache key is the
	// authorizer function plus the documented identity-source cache key, and an
	// entry expires on the run clock.
	authMu    sync.Mutex
	authCache map[string]authorizerCacheEntry

	// surfaceMu guards the live route table and invoker set a watch reload
	// swaps. The listener and the server stay; only these values change.
	surfaceMu sync.RWMutex
}

// currentAPI returns the route table the transport serves now.
func (t *Transport) currentAPI() APISpec {
	t.surfaceMu.RLock()
	defer t.surfaceMu.RUnlock()
	return t.API
}

// invoker returns the running process for one function.
func (t *Transport) invoker(id string) (Invoker, bool) {
	t.surfaceMu.RLock()
	defer t.surfaceMu.RUnlock()
	invoker, ok := t.Invokers[id]
	return invoker, ok
}

// SetSurface swaps the route table and invoker set after a watch reload. The
// net.Listener and its URL do not change.
func (t *Transport) SetSurface(api APISpec, invokers map[string]Invoker) {
	t.surfaceMu.Lock()
	defer t.surfaceMu.Unlock()
	t.API = api
	t.Invokers = invokers
}

// authorizerResult carries what one authorizer produced. Status is 0 when the
// request may proceed, or the HTTP status that refuses it.
type authorizerResult struct {
	Status int
	Lambda map[string]any
	JWT    map[string]any
	Scopes []string
	Claims map[string]any
	// PolicyContext is the stringified context a policy authorizer returned.
	PolicyContext map[string]any
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

//nolint:gocyclo // the documented request pipeline is pinned by tests
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
	if t.currentAPI().Class == APIFunctionURL {
		route = t.currentAPI().Routes[0]
		params = map[string]string{}
	} else {
		matched, matchedParams, ok := MatchRoute(t.currentAPI(), request.Method, path)
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
	invoker, ok := t.invoker(route.Function)
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
		API:                     t.currentAPI(),
		Route:                   route,
		Params:                  params,
		Method:                  request.Method,
		Path:                    path,
		RawPath:                 request.URL.EscapedPath(),
		RawQuery:                request.URL.RawQuery,
		Header:                  request.Header,
		Body:                    body,
		RemoteAddr:              request.RemoteAddr,
		RequestID:               requestID,
		Now:                     t.Now(),
		AuthorizerContext:       authorizer.Lambda,
		AuthorizerPolicyContext: authorizer.PolicyContext,
		AuthorizerJWT:           authorizer.JWT,
		AuthorizerScopes:        authorizer.Scopes,
		AuthorizerClaims:        authorizer.Claims,
	})
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	if route.Streaming {
		if streamer, ok := invoker.(streamInvoker); ok && streamer.StreamingIncremental() {
			t.serveStreaming(writer, request, streamer, payload, requestID, path)
			return
		}
	}
	raw, err := invoker.Invoke(request.Context(), payload)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	response, err := t.decodeBufferedResponse(raw)
	if err != nil {
		t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		return
	}
	writeResponse(writer, response)
	t.logf("%s %s -> %d%s", request.Method, path, response.StatusCode, streamedNote(response.Streamed))
}

// decodeBufferedResponse decodes a buffered invocation response with the rule
// for this API surface. A Function URL infers the return-value format exactly as
// the CloudFront Function URL origin does, so one body has one answer on every
// local Function URL surface; every other surface keeps the proxy-response
// decoder.
func (t *Transport) decodeBufferedResponse(raw []byte) (LambdaResponse, error) {
	if t.currentAPI().Class == APIFunctionURL {
		return decodeFunctionURLResponse(raw)
	}
	return DecodeResponse(raw)
}

// serveStreaming forwards a response-streaming invocation to the client as the
// runtime writes it.
//
// A Function URL applies the prelude's status, headers and cookies and then
// forwards the payload chunk by chunk; a prelude-less stream is the raw body of
// a 200 response. A REST API proxy integration begins the payload stream only
// after valid metadata and the 8-null-byte delimiter, and answers 500 when the
// output does not adhere.
// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
func (t *Transport) serveStreaming(
	writer http.ResponseWriter,
	request *http.Request,
	streamer streamInvoker,
	payload []byte,
	requestID string,
	path string,
) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		t.fail(writer, http.StatusInternalServerError, "Internal Server Error", requestID,
			errors.New("the local listener cannot flush a streamed response"))
		return
	}
	if t.currentAPI().Class == APIFunctionURL {
		sink := &functionURLStream{writer: writer, flusher: flusher}
		result, err := streamer.InvokeStream(request.Context(), payload, sink)
		if err != nil {
			if !sink.started {
				t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
			}
			return
		}
		if !sink.started {
			// A RESPONSE_STREAM URL can still receive a buffered proxy
			// response; it is decoded exactly like the buffered path.
			response, decodeErr := t.decodeBufferedResponse(result.Body)
			if decodeErr != nil {
				t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, decodeErr)
				return
			}
			writeResponse(writer, response)
			t.logf("%s %s -> %d (buffered response on a streaming Function URL)", request.Method, path, response.StatusCode)
			return
		}
		t.logf("%s %s -> 200 (streamed to the client as the runtime wrote it)", request.Method, path)
		return
	}

	sink := &apiGatewayStream{writer: writer, flusher: flusher}
	result, err := streamer.InvokeStream(request.Context(), payload, sink)
	if err != nil {
		if !sink.started {
			t.fail(writer, http.StatusBadGateway, "Internal Server Error", requestID, err)
		}
		return
	}
	if endErr := sink.End("", nil); endErr != nil {
		t.fail(writer, http.StatusInternalServerError, "Internal Server Error", requestID, endErr)
		return
	}
	_ = result
	t.logf("%s %s -> streamed to the client as the runtime wrote it", request.Method, path)
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
	case AuthorizerKindSimpleRequest:
		if route.AuthorizerFunction == "" {
			return authorizerResult{}, fmt.Errorf("route declares a simple-response authorizer the runner did not derive")
		}
		return t.authorizeRequest(request, route, params, path, body, requestID)
	case AuthorizerKindLambdaRequest:
		if route.AuthorizerFunction == "" {
			return authorizerResult{}, fmt.Errorf("route declares a Lambda authorizer the runner did not derive")
		}
		if route.AuthorizerRESTType != "" {
			return t.authorizeRESTLambda(request, route, params, path, requestID)
		}
		return t.authorizeHTTPLambdaPolicy(request, route, params, path, body, requestID)
	default:
		if route.AuthorizerFunction == "" {
			return authorizerResult{}, nil
		}
		// A route built without an explicit kind keeps the historical contract:
		// the authorizer runs as a simple-response REQUEST authorizer.
		return t.authorizeRequest(request, route, params, path, body, requestID)
	}
}

// authorizeRESTLambda runs a REST API TOKEN or REQUEST Lambda authorizer that
// returns an IAM policy, and matches the policy against the method ARN.
//
// A missing identity source is refused with 401 before the authorizer runs; with
// caching enabled the identity sources (or the token) are the cache key on the
// run clock. A Deny policy is 403 outside the test environment, the documented
// Unauthorized error is 401 and an invalid response is 500.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html
func (t *Transport) authorizeRESTLambda(
	request *http.Request,
	route Route,
	params map[string]string,
	path string,
	requestID string,
) (authorizerResult, error) {
	invoker, ok := t.invoker(route.AuthorizerFunction)
	if !ok {
		return authorizerResult{}, fmt.Errorf("no running container for authorizer %s", route.AuthorizerFunction)
	}
	token, cacheKey, refusal, err := t.restAuthorizerKey(request, route, params, path)
	if err != nil {
		return authorizerResult{}, err
	}
	if refusal != 0 {
		return authorizerResult{Status: refusal}, nil
	}
	arn := methodARN(t.currentAPI(), request.Method, path)
	// The cache holds the authorizer's POLICY, not this request's decision:
	// "If you enable authorization caching, API Gateway caches the policy so
	// that the Lambda authorizer function isn't invoked again. Ensure that your
	// policy is applicable to all resources and methods across your API." A
	// cache hit is therefore re-evaluated against the CURRENT request's method
	// ARN and classified exactly like a fresh response.
	// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
	if cached, ok := t.cachedAuthorizerPolicy(route.AuthorizerFunction, route.AuthorizerCacheTTLSeconds, cacheKey); ok {
		result, classifyErr := t.classifyAuthorizerPolicy(cached, arn, request.Method, path, route.AuthorizerFunction)
		if classifyErr != nil {
			return authorizerResult{}, classifyErr
		}
		t.logf("%s %s -> %d (cached authorizer policy for %s)", request.Method, path, statusOrOK(result.Status), route.AuthorizerFunction)
		return result, nil
	}
	event, err := buildRESTAuthorizerEvent(InvokeRequest{
		API:        t.currentAPI(),
		Route:      route,
		Params:     params,
		Method:     request.Method,
		Path:       path,
		RawPath:    request.URL.EscapedPath(),
		RawQuery:   request.URL.RawQuery,
		Header:     request.Header,
		RequestID:  requestID,
		Now:        t.Now(),
		RemoteAddr: request.RemoteAddr,
	}, route.AuthorizerRESTType, token)
	if err != nil {
		return authorizerResult{}, fmt.Errorf("build the REST authorizer event: %w", err)
	}
	raw, err := invoker.Invoke(request.Context(), event)
	if err != nil {
		return authorizerResult{}, fmt.Errorf("invoke authorizer %s: %w", route.AuthorizerFunction, err)
	}
	result, err := t.classifyAuthorizerPolicy(raw, arn, request.Method, path, route.AuthorizerFunction)
	if err != nil {
		return authorizerResult{}, err
	}
	t.cacheAuthorizerPolicy(route.AuthorizerFunction, route.AuthorizerCacheTTLSeconds, cacheKey, raw, result)
	return result, nil
}

// restAuthorizerKey resolves the token or identity-source values that are the
// authorizer's cache key. A missing or invalid token is the documented 401 that
// is returned without invoking the authorizer.
func (t *Transport) restAuthorizerKey(request *http.Request, route Route, params map[string]string, path string) (token, cacheKey string, refusal int, err error) {
	if route.AuthorizerRESTType == authorizerTypeToken {
		if len(route.AuthorizerIdentitySources) != 1 {
			return "", "", 0, fmt.Errorf("TOKEN authorizer has %d identity sources", len(route.AuthorizerIdentitySources))
		}
		source, parseErr := parseRESTIdentitySource(route.AuthorizerIdentitySources[0])
		if parseErr != nil {
			return "", "", 0, parseErr
		}
		value := source.value(request.Header, request.URL.RawQuery, params)
		if expression := strings.TrimSpace(route.AuthorizerValidationExpression); expression != "" {
			matched, matchErr := regexp.MatchString(expression, value)
			if matchErr != nil {
				return "", "", 0, fmt.Errorf("the authorizer IdentityValidationExpression is not a regular expression: %w", matchErr)
			}
			if !matched {
				t.logf("%s %s -> 401 (the token does not match IdentityValidationExpression)", request.Method, path)
				return "", "", http.StatusUnauthorized, nil
			}
		}
		// With caching enabled API Gateway verifies the identity source before
		// invoking the authorizer; with caching off it passes the request
		// through and lets the function decide.
		if value == "" && route.AuthorizerCacheTTLSeconds > 0 {
			t.logf("%s %s -> 401 (token header %s is missing; authorizer %s was not invoked)",
				request.Method, path, source.name, route.AuthorizerFunction)
			return "", "", http.StatusUnauthorized, nil
		}
		return value, value, 0, nil
	}
	missing, err := missingRESTIdentitySource(request.Header, request.URL.RawQuery, params, route.AuthorizerIdentitySources)
	if err != nil {
		return "", "", 0, err
	}
	if missing != "" && route.AuthorizerCacheTTLSeconds > 0 {
		t.logf("%s %s -> 401 (identity source %s is missing; authorizer %s was not invoked)",
			request.Method, path, missing, route.AuthorizerFunction)
		return "", "", http.StatusUnauthorized, nil
	}
	values, err := restIdentitySourceValues(request.Header, request.URL.RawQuery, params, route.AuthorizerIdentitySources)
	if err != nil {
		return "", "", 0, err
	}
	return "", strings.Join(values, "\x1f"), 0, nil
}

// authorizeHTTPLambdaPolicy runs an HTTP API REQUEST Lambda authorizer that
// returns an IAM policy. Payload format 1.0 carries methodArn and 2.0 carries
// routeArn; either way the returned policy is matched against the route ARN.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
func (t *Transport) authorizeHTTPLambdaPolicy(
	request *http.Request,
	route Route,
	params map[string]string,
	path string,
	body []byte,
	requestID string,
) (authorizerResult, error) {
	invoker, ok := t.invoker(route.AuthorizerFunction)
	if !ok {
		return authorizerResult{}, fmt.Errorf("no running container for authorizer %s", route.AuthorizerFunction)
	}
	invoke := InvokeRequest{
		API:        t.currentAPI(),
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
	}
	missing, err := missingIdentitySourceWithContext(request.Header, request.URL.RawQuery, route, params, route.AuthorizerIdentitySources)
	if err != nil {
		return authorizerResult{}, err
	}
	if missing != "" {
		t.logf("%s %s -> 401 (identity source %s is missing; authorizer %s was not invoked)",
			request.Method, path, missing, route.AuthorizerFunction)
		return authorizerResult{Status: http.StatusUnauthorized}, nil
	}
	values, err := identitySourceValuesWithContext(request.Header, request.URL.RawQuery, route, params, route.AuthorizerIdentitySources)
	if err != nil {
		return authorizerResult{}, err
	}
	cacheKey := strings.Join(values, "\x1f")
	arn := methodARN(t.currentAPI(), request.Method, path)
	// HTTP API caching has the same shape as REST: "By default, API Gateway
	// uses the cached authorizer response for all routes of an API that use the
	// authorizer. To cache responses per route, add $context.routeKey to your
	// authorizer's identity sources." The cached response is the POLICY, so it
	// is re-evaluated against this route's ARN on every hit.
	// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
	if cached, ok := t.cachedAuthorizerPolicy(route.AuthorizerFunction, route.AuthorizerCacheTTLSeconds, cacheKey); ok {
		result, classifyErr := t.classifyAuthorizerPolicy(cached, arn, request.Method, path, route.AuthorizerFunction)
		if classifyErr != nil {
			return authorizerResult{}, classifyErr
		}
		t.logf("%s %s -> %d (cached authorizer policy for %s)", request.Method, path, statusOrOK(result.Status), route.AuthorizerFunction)
		return result, nil
	}
	var event []byte
	if route.AuthorizerPayloadFormat == "1.0" {
		event, err = buildHTTPAuthorizerEventV1(invoke, values)
	} else {
		event, err = BuildAuthorizerEvent(invoke)
	}
	if err != nil {
		return authorizerResult{}, fmt.Errorf("build the HTTP API authorizer event: %w", err)
	}
	raw, err := invoker.Invoke(request.Context(), event)
	if err != nil {
		return authorizerResult{}, fmt.Errorf("invoke authorizer %s: %w", route.AuthorizerFunction, err)
	}
	result, err := t.classifyAuthorizerPolicy(raw, arn, request.Method, path, route.AuthorizerFunction)
	if err != nil {
		return authorizerResult{}, err
	}
	t.cacheAuthorizerPolicy(route.AuthorizerFunction, route.AuthorizerCacheTTLSeconds, cacheKey, raw, result)
	return result, nil
}

// classifyAuthorizerPolicy maps a Lambda authorizer's raw response to the
// documented status: an Allow policy proceeds, a Deny policy is 403, the
// Unauthorized error is 401 and an invalid response is 500. The returned context
// is stringified because API Gateway does not accept nested context values.
func (t *Transport) classifyAuthorizerPolicy(raw []byte, arn, method, path, authorizerFunction string) (authorizerResult, error) {
	allowed, context, err := evaluateAuthorizerPolicy(raw, arn)
	if err != nil {
		if authorizerUnauthorizedResponse(raw) {
			t.logf("%s %s -> 401 (authorizer %s returned Unauthorized)", method, path, authorizerFunction)
			return authorizerResult{Status: http.StatusUnauthorized}, nil
		}
		t.logf("%s %s -> 500 (authorizer %s returned an invalid response: %v)", method, path, authorizerFunction, err)
		return authorizerResult{Status: http.StatusInternalServerError}, nil
	}
	if !allowed {
		t.logf("%s %s -> 403 (authorizer %s returned a Deny policy for %s)", method, path, authorizerFunction, arn)
		return authorizerResult{Status: http.StatusForbidden}, nil
	}
	values, err := authorizerContextValues(context)
	if err != nil {
		t.logf("%s %s -> 500 (authorizer %s returned an invalid context: %v)", method, path, authorizerFunction, err)
		return authorizerResult{Status: http.StatusInternalServerError}, nil
	}
	return authorizerResult{PolicyContext: values}, nil
}

// authorizerCacheEntry is one cached authorizer POLICY response. The raw
// function response is kept, not the decision it produced for the request that
// filled the cache, because API Gateway re-evaluates a cached policy against
// each method or route ARN.
type authorizerCacheEntry struct {
	expiresAt time.Time
	raw       []byte
}

func statusOrOK(status int) int {
	if status == 0 {
		return http.StatusOK
	}
	return status
}

// cachedAuthorizerPolicy returns a cached policy response for the authorizer
// while it is inside its AuthorizerResultTtlInSeconds window on the run clock.
// A TTL of zero disables the cache, which is the documented way to turn caching
// off.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
func (t *Transport) cachedAuthorizerPolicy(function string, ttlSeconds int, key string) ([]byte, bool) {
	if ttlSeconds <= 0 || key == "" {
		return nil, false
	}
	t.authMu.Lock()
	defer t.authMu.Unlock()
	entry, ok := t.authCache[authorizerCacheKey(function, key)]
	if !ok {
		return nil, false
	}
	if !t.now().Before(entry.expiresAt) {
		delete(t.authCache, authorizerCacheKey(function, key))
		return nil, false
	}
	return entry.raw, true
}

// cacheAuthorizerPolicy stores the authorizer's raw policy response. API
// Gateway caches the policy, not a per-request decision: the same cached policy
// is matched against every later request's method or route ARN. An Unauthorized
// error (401) and an invalid response (500) are invocation failures, not a
// policy, so they are never cached.
func (t *Transport) cacheAuthorizerPolicy(function string, ttlSeconds int, key string, raw []byte, result authorizerResult) {
	if ttlSeconds <= 0 || key == "" {
		return
	}
	if result.Status != 0 && result.Status != http.StatusForbidden {
		return
	}
	t.authMu.Lock()
	defer t.authMu.Unlock()
	if t.authCache == nil {
		t.authCache = map[string]authorizerCacheEntry{}
	}
	t.authCache[authorizerCacheKey(function, key)] = authorizerCacheEntry{
		expiresAt: t.now().Add(time.Duration(ttlSeconds) * time.Second),
		raw:       append([]byte(nil), raw...),
	}
}

func authorizerCacheKey(function, key string) string {
	return function + "\x00" + key
}

func (t *Transport) now() time.Time {
	if t.Clock != nil {
		return t.Clock.Now()
	}
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
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
	invoker, ok := t.invoker(route.AuthorizerFunction)
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
		API:        t.currentAPI(),
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
	if refusal := missingScope(claims, route.AuthorizationScopes); refusal != "" {
		t.logf("%s %s -> 403 (the token carries none of the route's scopes: %s)", request.Method, request.URL.Path, refusal)
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
	if refusal := missingScope(claims, route.AuthorizationScopes); refusal != "" {
		t.logf("%s %s -> 403 (the token carries none of the route's scopes: %s)", request.Method, request.URL.Path, refusal)
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
	t.logf("%s %s -> 404 (no route in %s)", request.Method, RequestPath(request), t.currentAPI().LogicalID)
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
	return " (streamed response delivered as one body on this path)"
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
	return " (response streaming: streams in the default mode; buffered under --rie)"
}

// SummarizeEndpoints renders the endpoints the runner injects, sorted.
func SummarizeEndpoints(endpoints []Endpoint) string {
	parts := make([]string, 0, len(endpoints))
	for _, endpoint := range endpoints {
		parts = append(parts, strings.ToLower(endpoint.Service)+"="+endpoint.URL)
	}
	return strings.Join(parts, " ")
}
