package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTransportRunsTheAuthorizerBeforeTheRoute(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`{"isAuthorized":true,"context":{"subject":"s-1"}}`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth", AuthorizerIdentitySource: "$request.header.Authorization",
		}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/hello", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer good")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authorized request must reach the handler, got %d", response.StatusCode)
	}
	if len(authorizer.payloads) != 1 || len(handler.payloads) != 1 {
		t.Fatalf("want one authorizer and one handler call, got %d/%d", len(authorizer.payloads), len(handler.payloads))
	}
	var authorizerEvent map[string]any
	if err := json.Unmarshal(authorizer.payloads[0], &authorizerEvent); err != nil {
		t.Fatalf("authorizer event is not JSON: %v", err)
	}
	if authorizerEvent["type"] != "REQUEST" || authorizerEvent["identitySource"] != "Bearer good" {
		t.Fatalf("unexpected authorizer event: %+v", authorizerEvent)
	}
	var handlerEvent map[string]any
	if err := json.Unmarshal(handler.payloads[0], &handlerEvent); err != nil {
		t.Fatalf("handler event is not JSON: %v", err)
	}
	requestContext := mustMap(t, handlerEvent["requestContext"])
	lambda := mustMap(t, mustMap(t, requestContext["authorizer"])["lambda"])
	if lambda["subject"] != "s-1" {
		t.Fatalf("authorizer context was not carried to the handler: %+v", requestContext)
	}
}

func TestTransportAuthorizerDenialIsUnauthorized(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`{"isAuthorized":false}`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"must not run"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth",
		}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()

	response, err := http.Get(server.URL + "/hello") //nolint:gosec,noctx // test request
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("authorizer denial must be 401, got %d", response.StatusCode)
	}
	if len(handler.payloads) != 0 {
		t.Fatalf("the route handler must not run after a denial")
	}
}

func TestTransportAuthorizerMalformedResponseFailsClosed(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`not-json`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"must not run"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth",
		}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()

	response, err := http.Get(server.URL + "/hello") //nolint:gosec,noctx // test request
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("a malformed authorizer response must fail closed with 502, got %d", response.StatusCode)
	}
	if len(handler.payloads) != 0 {
		t.Fatalf("the route handler must not run after a malformed authorizer response")
	}
}
