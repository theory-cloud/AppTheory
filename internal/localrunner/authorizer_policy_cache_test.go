package localrunner

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A cached authorizer response is the POLICY, not the decision it produced for
// the request that filled the cache: "If you enable authorization caching, API
// Gateway caches the policy so that the Lambda authorizer function isn't
// invoked again. Ensure that your policy is applicable to all resources and
// methods across your API."
// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html

// TestCachedPolicyIsReevaluatedPerMethod proves that a policy cached from GET
// /a is matched against GET /b on the next request: the function allowed only
// the method ARN it received, so AWS returns 403 for /b without invoking it.
func TestCachedPolicyIsReevaluatedPerMethod(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(calls int, event map[string]any) []byte {
		return allowPolicyFor(authorizerStringField(t, event, "methodArn"), map[string]any{"invocation": fmt.Sprintf("%d", calls)})
	}}
	routeA := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	routeA.Path = "/a"
	routeB := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	routeB.Path = "/b"
	spec := APISpec{Class: APIRESTV1, LogicalID: "RestApi", Stage: "prod", Routes: []Route{routeA, routeB}}
	transport := NewTransport(spec, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	transport.Clock = clock
	transport.Now = clock.Now
	server := httptest.NewServer(transport)
	defer server.Close()

	statusA, _ := doRequest(t, server.URL+"/a", map[string]string{"Authorization": "t"})
	statusB, _ := doRequest(t, server.URL+"/b", map[string]string{"Authorization": "t"})
	if statusA != http.StatusOK {
		t.Fatalf("GET /a = %d", statusA)
	}
	if statusB != http.StatusForbidden {
		t.Fatalf("GET /b = %d; AWS evaluates the cached policy (Resource = .../GET/a) against .../GET/b and returns 403", statusB)
	}
	if calls := authorizer.callCount(); calls != 1 {
		t.Fatalf("authorizer calls = %d, want 1: the second method must reuse the cached policy", calls)
	}
}

// A Deny cached for /a must not poison /b when the same policy document also
// allows /b: the cached policy is re-evaluated against /b's ARN.
func TestCachedDenyDoesNotPoisonOtherMethods(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
		arn := authorizerStringField(t, event, "methodArn")
		base := arn[:len(arn)-1]
		return []byte(`{"principalId":"p","policyDocument":{"Version":"2012-10-17","Statement":[` +
			`{"Action":"execute-api:Invoke","Effect":"Deny","Resource":"` + base + `a"},` +
			`{"Action":"execute-api:Invoke","Effect":"Allow","Resource":"` + base + `b"}]}}`)
	}}
	routeA := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	routeA.Path = "/a"
	routeB := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	routeB.Path = "/b"
	spec := APISpec{Class: APIRESTV1, LogicalID: "RestApi", Stage: "prod", Routes: []Route{routeA, routeB}}
	transport := NewTransport(spec, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	transport.Clock = clock
	transport.Now = clock.Now
	server := httptest.NewServer(transport)
	defer server.Close()

	statusA, _ := doRequest(t, server.URL+"/a", map[string]string{"Authorization": "t"})
	statusB, _ := doRequest(t, server.URL+"/b", map[string]string{"Authorization": "t"})
	if statusA != http.StatusForbidden || statusB != http.StatusOK {
		t.Fatalf("want /a 403 and /b 200 from one cached policy, got %d and %d", statusA, statusB)
	}
	if calls := authorizer.callCount(); calls != 1 {
		t.Fatalf("authorizer calls = %d, want 1", calls)
	}
}

// The output page requires principalId: "must include the principal identifier
// (principalId) and a policy document (policyDocument)"; without it "the call
// fails". The transport maps an invalid policy response to 500.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-lambda-authorizer-output.html
func TestAuthorizerPolicyWithoutPrincipalIDFailsTheCall(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	authorizer := &countingAuthorizer{response: func(_ int, event map[string]any) []byte {
		arn := authorizerStringField(t, event, "methodArn")
		return []byte(`{"policyDocument":{"Version":"2012-10-17","Statement":[{"Action":"execute-api:Invoke","Effect":"Allow","Resource":"` + arn + `"}]}}`)
	}}
	route := restRouteWithAuthorizer("TOKEN", 60, "method.request.header.Authorization")
	transport := NewTransport(restAuthorizerSpec(route), map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil)
	transport.Clock = clock
	transport.Now = clock.Now
	server := httptest.NewServer(transport)
	defer server.Close()

	status, _ := doRequest(t, server.URL+"/items/1", map[string]string{"Authorization": "t"})
	if status != http.StatusInternalServerError {
		t.Fatalf("a policy without principalId answered %d; the output page says the call fails (500)", status)
	}
	// An invalid response is never cached: a second request invokes the
	// authorizer again.
	_, _ = doRequest(t, server.URL+"/items/1", map[string]string{"Authorization": "t"})
	if calls := authorizer.callCount(); calls != 2 {
		t.Fatalf("authorizer calls = %d, want 2: an invalid response must not be cached", calls)
	}
}

// The Authorizer API reference caps AuthorizerResultTtlInSeconds at 3600:
// "The maximum value is 3600, or 1 hour."
// https://docs.aws.amazon.com/apigateway/latest/api/API_Authorizer.html
func TestAuthorizerTTLAboveTheDocumentedMaximumIsRefused(t *testing.T) {
	value := 4000
	if _, err := authorizerTTL("probe/Authorizer", &value); err == nil {
		t.Fatal("AuthorizerResultTtlInSeconds 4000 was accepted; the maximum is 3600")
	}
	maximum := 3600
	if ttl, err := authorizerTTL("probe/Authorizer", &maximum); err != nil || ttl != 3600 {
		t.Fatalf("AuthorizerResultTtlInSeconds 3600 = %d, %v", ttl, err)
	}
}
