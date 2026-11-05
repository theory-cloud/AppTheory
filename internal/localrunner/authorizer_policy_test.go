package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingAuthorizer returns an IAM policy and records how many times the
// function itself ran, which is the proof a cached policy was reused without
// invoking the function.
type countingAuthorizer struct {
	mu       sync.Mutex
	calls    int
	response func(calls int, event map[string]any) []byte
	events   []map[string]any
}

func (a *countingAuthorizer) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		return nil, fmt.Errorf("authorizer event is not JSON: %w", err)
	}
	a.events = append(a.events, event)
	return a.response(a.calls, event), nil
}

func (a *countingAuthorizer) callCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.calls
}

func allowPolicyFor(arn string, context map[string]any) []byte {
	document := map[string]any{
		"principalId": "local",
		"policyDocument": map[string]any{
			"Version": "2012-10-17",
			"Statement": []any{map[string]any{
				"Action":   "execute-api:Invoke",
				"Effect":   "Allow",
				"Resource": arn,
			}},
		},
	}
	if len(context) > 0 {
		document["context"] = context
	}
	encoded, _ := json.Marshal(document) //nolint:errcheck // fixed test document
	return encoded
}

func denyPolicyFor(arn string) []byte {
	document := map[string]any{
		"principalId": "local",
		"policyDocument": map[string]any{
			"Version": "2012-10-17",
			"Statement": []any{map[string]any{
				"Action":   "execute-api:Invoke",
				"Effect":   "Deny",
				"Resource": arn,
			}},
		},
	}
	encoded, _ := json.Marshal(document) //nolint:errcheck // fixed test document
	return encoded
}

func restAuthorizerSpec(authorizerRoute Route) APISpec {
	return APISpec{
		Class:     APIRESTV1,
		LogicalID: "RestApi",
		Stage:     "prod",
		Routes:    []Route{authorizerRoute},
	}
}

func restRouteWithAuthorizer(restType string, ttl int, sources ...string) Route {
	return Route{
		Class:                     APIRESTV1,
		Method:                    "GET",
		Path:                      "/items/{id}",
		Function:                  "Fn",
		AuthorizerFunction:        "Auth",
		AuthorizerKind:            AuthorizerKindLambdaRequest,
		AuthorizerRESTType:        restType,
		AuthorizerIdentitySources: sources,
		AuthorizerCacheTTLSeconds: ttl,
	}
}

func doRequest(t *testing.T, url string, header map[string]string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	body, readErr := io.ReadAll(response.Body)
	if readErr != nil {
		t.Fatalf("read response: %v", readErr)
	}
	return response.StatusCode, body
}

// authorizerStringField returns a string field from a decoded event.
func authorizerStringField(t *testing.T, values map[string]any, key string) string {
	t.Helper()
	value, ok := values[key].(string)
	if !ok {
		t.Fatalf("event field %q is not a string: %+v", key, values)
	}
	return value
}

func handlerContext(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("handler event is not JSON: %v", err)
	}
	requestContext := mustMap(t, event["requestContext"])
	authorizer, ok := requestContext["authorizer"].(map[string]any)
	if !ok {
		return nil
	}
	return authorizer
}

func TestRESTTokenAuthorizerStatusesAndContext(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
		if event["type"] != "TOKEN" || event["authorizationToken"] != "good" {
			t.Fatalf("token authorizer event = %+v", event)
		}
		arn := authorizerStringField(t, event, "methodArn")
		return allowPolicyFor(arn, map[string]any{"subject": "s-1", "admin": true})
	}}
	api := restAuthorizerSpec(restRouteWithAuthorizer("TOKEN", 0, "method.request.header.Authorization"))
	transport := NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	server := httptest.NewServer(transport)
	defer server.Close()

	status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"Authorization": "good"})
	if status != http.StatusOK {
		t.Fatalf("allowed request = %d", status)
	}
	context := handlerContext(t, handler.payloads[0])
	if context["subject"] != "s-1" || context["admin"] != "true" {
		t.Fatalf("authorizer context did not reach the integration stringified: %+v", context)
	}
	if authorizer.calls != 1 {
		t.Fatalf("authorizer calls = %d", authorizer.calls)
	}
}

func TestRESTTokenAuthorizerDenyUnauthorizedAndInvalid(t *testing.T) {
	for name, response := range map[string]func(int, map[string]any) []byte{
		"deny": func(_ int, event map[string]any) []byte {
			return denyPolicyFor(authorizerStringField(t, event, "methodArn"))
		},
		"unauthorized": func(int, map[string]any) []byte {
			return []byte(`{"errorMessage":"Unauthorized"}`)
		},
		"invalid": func(int, map[string]any) []byte {
			return []byte(`{"principalId":"local"}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
			authorizer := &countingAuthorizer{response: response}
			api := restAuthorizerSpec(restRouteWithAuthorizer("TOKEN", 0, "method.request.header.Authorization"))
			server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
			defer server.Close()
			status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"Authorization": "bad"})
			want := map[string]int{"deny": http.StatusForbidden, "unauthorized": http.StatusUnauthorized, "invalid": http.StatusInternalServerError}[name]
			if status != want {
				t.Fatalf("%s = %d, want %d", name, status, want)
			}
			if len(handler.payloads) != 0 {
				t.Fatalf("%s reached the handler", name)
			}
		})
	}
}

func TestRESTTokenAuthorizerRefusesAMissingTokenWithoutInvoking(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(int, map[string]any) []byte { return []byte(`{}`) }}
	api := restAuthorizerSpec(restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization"))
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()
	status, _ := doRequest(t, server.URL+"/items/7", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("missing token = %d", status)
	}
	if authorizer.calls != 0 || len(handler.payloads) != 0 {
		t.Fatalf("missing token invoked %d authorizer and %d handler calls", authorizer.calls, len(handler.payloads))
	}
}

func TestRESTTokenAuthorizerAppliesTheValidationExpression(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(int, map[string]any) []byte { return []byte(`{}`) }}
	route := restRouteWithAuthorizer("TOKEN", 0, "method.request.header.Authorization")
	route.AuthorizerValidationExpression = `^Bearer [a-z]+$`
	server := httptest.NewServer(NewTransport(restAuthorizerSpec(route), map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()
	status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"Authorization": "not-a-bearer-token"})
	if status != http.StatusUnauthorized {
		t.Fatalf("invalid token = %d", status)
	}
	if authorizer.calls != 0 {
		t.Fatalf("an invalid token invoked the authorizer %d times", authorizer.calls)
	}
}

func TestRESTRequestAuthorizerCarriesEveryIdentitySourceInOrder(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
		if event["type"] != "REQUEST" {
			t.Fatalf("request authorizer event = %+v", event)
		}
		if _, ok := event["methodArn"].(string); !ok {
			t.Fatalf("request authorizer event has no methodArn: %+v", event)
		}
		headers := mustMap(t, event["headers"])
		if headers["X-Tenant"] != "t-1" {
			t.Fatalf("authorizer headers = %+v", headers)
		}
		query := mustMap(t, event["queryStringParameters"])
		if query["scope"] != "read" {
			t.Fatalf("authorizer query = %+v", query)
		}
		pathParameters := mustMap(t, event["pathParameters"])
		if pathParameters["id"] != "7" {
			t.Fatalf("authorizer path = %+v", pathParameters)
		}
		return allowPolicyFor(authorizerStringField(t, event, "methodArn"), map[string]any{"tenant": "t-1"})
	}}
	api := restAuthorizerSpec(restRouteWithAuthorizer("REQUEST", 0,
		"method.request.header.X-Tenant", "method.request.querystring.scope", "method.request.path.id"))
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()
	status, _ := doRequest(t, server.URL+"/items/7?scope=read", map[string]string{"X-Tenant": "t-1"})
	if status != http.StatusOK {
		t.Fatalf("allowed request = %d", status)
	}
	context := handlerContext(t, handler.payloads[0])
	if context["tenant"] != "t-1" {
		t.Fatalf("authorizer context = %+v", context)
	}
}

func TestRESTRequestAuthorizerRefusesAMissingIdentitySource(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(int, map[string]any) []byte { return []byte(`{}`) }}
	api := restAuthorizerSpec(restRouteWithAuthorizer("REQUEST", 60,
		"method.request.header.X-Tenant", "method.request.querystring.scope"))
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()
	status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"X-Tenant": "t-1"})
	if status != http.StatusUnauthorized {
		t.Fatalf("missing query source = %d", status)
	}
	if authorizer.calls != 0 {
		t.Fatalf("a missing identity source invoked the authorizer")
	}
}

func TestRESTAuthorizerCacheExpiresOnTheRunClock(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(calls int, event map[string]any) []byte {
		return allowPolicyFor(authorizerStringField(t, event, "methodArn"), map[string]any{"invocation": fmt.Sprintf("%d", calls)})
	}}
	route := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	transport := NewTransport(restAuthorizerSpec(route), map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	transport.Clock = clock
	transport.Now = clock.Now
	server := httptest.NewServer(transport)
	defer server.Close()

	invocation := func() string {
		status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"Authorization": "good"})
		if status != http.StatusOK {
			t.Fatalf("request = %d", status)
		}
		return authorizerStringField(t, handlerContext(t, handler.payloads[len(handler.payloads)-1]), "invocation")
	}
	if got := invocation(); got != "1" {
		t.Fatalf("first invocation = %s", got)
	}
	if got := invocation(); got != "1" {
		t.Fatalf("a cached policy must not invoke the authorizer again, got invocation %s", got)
	}
	if _, err := clock.Advance(61 * time.Second); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if got := invocation(); got != "2" {
		t.Fatalf("the policy after the TTL must be a new invocation, got %s", got)
	}
	if authorizer.callCount() != 2 {
		t.Fatalf("authorizer calls = %d", authorizer.callCount())
	}
}

func TestHTTPPolicyAuthorizerPayloadFormats(t *testing.T) {
	for _, format := range []string{"1.0", "2.0"} {
		t.Run(format, func(t *testing.T) {
			handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
			authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
				arnKey := "routeArn"
				if format == "1.0" {
					arnKey = "methodArn"
				}
				arn, ok := event[arnKey].(string)
				if !ok || !strings.Contains(arn, "execute-api") {
					t.Fatalf("authorizer event has no %s: %+v", arnKey, event)
				}
				return allowPolicyFor(arn, map[string]any{"tier": "gold"})
			}}
			api := APISpec{
				Class:     APIHTTPV2,
				LogicalID: "HttpApi",
				Stage:     "$default",
				Routes: []Route{{
					Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello",
					Function:                  "Fn",
					AuthorizerFunction:        "Auth",
					AuthorizerKind:            AuthorizerKindLambdaRequest,
					AuthorizerIdentitySources: []string{"$request.header.Authorization"},
					AuthorizerCacheTTLSeconds: 0,
					AuthorizerPayloadFormat:   format,
				}},
			}
			server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
			defer server.Close()
			status, _ := doRequest(t, server.URL+"/hello", map[string]string{"Authorization": "Bearer token"})
			if status != http.StatusOK {
				t.Fatalf("allowed request = %d", status)
			}
			context := handlerContext(t, handler.payloads[0])
			if context["tier"] != "gold" {
				t.Fatalf("authorizer context = %+v", context)
			}
		})
	}
}

func TestHTTPPolicyAuthorizerCachesPerRouteKeyWhenListed(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(calls int, event map[string]any) []byte {
		return allowPolicyFor(authorizerStringField(t, event, "routeArn"), map[string]any{"invocation": fmt.Sprintf("%d", calls)})
	}}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "HttpApi",
		Stage:     "$default",
		Routes: []Route{
			{Class: APIHTTPV2, Method: "GET", Path: "/a", RouteKey: "GET /a", Function: "Fn",
				AuthorizerFunction: "Auth", AuthorizerKind: AuthorizerKindLambdaRequest,
				AuthorizerIdentitySources: []string{"$request.header.Authorization", "$context.routeKey"},
				AuthorizerCacheTTLSeconds: 60},
			{Class: APIHTTPV2, Method: "GET", Path: "/b", RouteKey: "GET /b", Function: "Fn",
				AuthorizerFunction: "Auth", AuthorizerKind: AuthorizerKindLambdaRequest,
				AuthorizerIdentitySources: []string{"$request.header.Authorization", "$context.routeKey"},
				AuthorizerCacheTTLSeconds: 60},
		},
	}
	transport := NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	transport.Clock = clock
	server := httptest.NewServer(transport)
	defer server.Close()

	for _, path := range []string{"/a", "/a", "/b"} {
		status, _ := doRequest(t, server.URL+path, map[string]string{"Authorization": "Bearer token"})
		if status != http.StatusOK {
			t.Fatalf("%s = %d", path, status)
		}
	}
	if authorizer.callCount() != 2 {
		t.Fatalf("per-route cache key must invoke the authorizer once per route, got %d", authorizer.callCount())
	}
}

func TestHTTPPolicyAuthorizerRefusesMissingSourceAndInvalidResponse(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(int, map[string]any) []byte { return []byte(`{"nope":true}`) }}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "HttpApi",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello",
			Function: "Fn", AuthorizerFunction: "Auth", AuthorizerKind: AuthorizerKindLambdaRequest,
			AuthorizerIdentitySources: []string{"$request.header.Authorization"},
		}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()

	status, _ := doRequest(t, server.URL+"/hello", nil)
	if status != http.StatusUnauthorized || authorizer.calls != 0 {
		t.Fatalf("missing identity source = %d (%d calls)", status, authorizer.calls)
	}
	status, _ = doRequest(t, server.URL+"/hello", map[string]string{"Authorization": "Bearer token"})
	if status != http.StatusInternalServerError {
		t.Fatalf("invalid response = %d", status)
	}
}

func TestEvaluateAuthorizerPolicyDenyWinsAndWildcards(t *testing.T) {
	arn := "arn:aws:execute-api:us-east-1:123456789012:api/prod/GET/items"
	policy := `{"principalId":"user","policyDocument":{"Statement":[
		{"Action":"execute-api:Invoke","Effect":"Allow","Resource":"` + arn + `"},
		{"Action":"execute-api:*","Effect":"Deny","Resource":"arn:aws:execute-api:us-east-1:123456789012:api/prod/GET/*"}]}}`
	allowed, _, err := evaluateAuthorizerPolicy([]byte(policy), arn)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if allowed {
		t.Fatalf("Deny must win over Allow")
	}
	policy = `{"principalId":"user","policyDocument":{"Statement":[{"Action":"*","Effect":"Allow","Resource":"arn:aws:execute-api:us-east-1:123456789012:api/prod/GET/item?"}]}}`
	allowed, _, err = evaluateAuthorizerPolicy([]byte(policy), arn)
	if err != nil || !allowed {
		t.Fatalf("wildcard resource = %v %v", allowed, err)
	}
}

func TestAuthorizerContextValuesRejectsNestedObjects(t *testing.T) {
	if _, err := authorizerContextValues(map[string]any{"nested": map[string]any{"a": "b"}}); err == nil {
		t.Fatalf("a nested context value must be refused")
	}
	values, err := authorizerContextValues(map[string]any{"count": float64(2), "ok": true})
	if err != nil {
		t.Fatalf("scalar context: %v", err)
	}
	if values["count"] != "2" || values["ok"] != "true" {
		t.Fatalf("context values = %+v", values)
	}
}

func TestRESTAuthorizerWithoutCachingPassesMissingSourcesToTheFunction(t *testing.T) {
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
		query := event["queryStringParameters"]
		if query != nil {
			t.Fatalf("a request without the query source must not invent one: %+v", query)
		}
		return allowPolicyFor(authorizerStringField(t, event, "methodArn"), map[string]any{"ok": "yes"})
	}}
	api := restAuthorizerSpec(restRouteWithAuthorizer("REQUEST", 0,
		"method.request.header.X-Tenant", "method.request.querystring.scope"))
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()
	status, _ := doRequest(t, server.URL+"/items/7", map[string]string{"X-Tenant": "t-1"})
	if status != http.StatusOK {
		t.Fatalf("caching off must invoke the authorizer with the sources present, got %d", status)
	}
	if authorizer.callCount() != 1 {
		t.Fatalf("authorizer calls = %d", authorizer.callCount())
	}
}
