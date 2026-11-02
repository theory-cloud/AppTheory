package localrunner

import (
	"context"
	"encoding/json"
	"io"
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
			AuthorizerFunction: "Auth", AuthorizerIdentitySources: []string{"$request.header.Authorization"},
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
	values := authorizerIdentitySource(t, authorizer.payloads[0])
	if len(values) != 1 || values[0] != "Bearer good" {
		t.Fatalf("unexpected authorizer identity source: %+v", values)
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

func TestTransportCarriesEveryIdentitySourceInOrder(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`{"isAuthorized":true}`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth",
			AuthorizerIdentitySources: []string{
				"$request.header.X-Tenant",
				"$request.querystring.namespace",
			},
		}},
	}
	server := httptest.NewServer(NewTransport(api, map[string]Invoker{"Fn": handler, "Auth": authorizer}, nil, nil))
	defer server.Close()

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/hello?namespace=ns-b", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("X-Tenant", "tenant-a")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	if response.StatusCode != http.StatusOK {
		t.Fatalf("request with every identity source must reach the handler, got %d", response.StatusCode)
	}
	if len(authorizer.payloads) != 1 {
		t.Fatalf("want one authorizer call, got %d", len(authorizer.payloads))
	}
	values := authorizerIdentitySource(t, authorizer.payloads[0])
	if len(values) != 2 || values[0] != "tenant-a" || values[1] != "ns-b" {
		t.Fatalf("identity sources were not carried in configured order: %+v", values)
	}
}

func TestTransportRefusesMissingHeaderIdentitySourceWithoutInvokingTheAuthorizer(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`{"isAuthorized":true}`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"must not run"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth", AuthorizerIdentitySources: []string{"$request.header.Authorization"},
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
		t.Fatalf("a missing identity source must be 401, got %d", response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != `{"message":"Unauthorized"}` {
		t.Fatalf("unexpected refusal body: %s", body)
	}
	if len(authorizer.payloads) != 0 {
		t.Fatalf("the authorizer must not be invoked when an identity source is missing, got %d calls", len(authorizer.payloads))
	}
	if len(handler.payloads) != 0 {
		t.Fatalf("the route handler must not run when an identity source is missing")
	}
}

func TestTransportRefusesMissingQueryStringIdentitySourceWithoutInvokingTheAuthorizer(t *testing.T) {
	authorizer := &fakeInvoker{response: []byte(`{"isAuthorized":true}`)}
	handler := &fakeInvoker{response: []byte(`{"statusCode":200,"body":"must not run"}`)}
	api := APISpec{
		Class:     APIHTTPV2,
		LogicalID: "Api",
		Stage:     "$default",
		Routes: []Route{{
			Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn",
			AuthorizerFunction: "Auth", AuthorizerIdentitySources: []string{"$request.querystring.token"},
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
		t.Fatalf("a missing query string identity source must be 401, got %d", response.StatusCode)
	}
	if len(authorizer.payloads) != 0 || len(handler.payloads) != 0 {
		t.Fatalf("neither the authorizer nor the handler may run, got %d/%d", len(authorizer.payloads), len(handler.payloads))
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

func authorizerIdentitySource(t *testing.T, payload []byte) []any {
	t.Helper()
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatalf("authorizer event is not JSON: %v", err)
	}
	if event["type"] != "REQUEST" {
		t.Fatalf("authorizer event is not a REQUEST event: %+v", event)
	}
	values, ok := event["identitySource"].([]any)
	if !ok {
		t.Fatalf("authorizer event identitySource is not an array: %+v", event["identitySource"])
	}
	return values
}
