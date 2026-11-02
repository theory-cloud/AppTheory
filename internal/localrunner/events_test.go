package localrunner

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

func testInvokeRequest(class APIClass) InvokeRequest {
	api := APISpec{Class: class, LogicalID: "Api", Name: "test-api", Stage: "$default"}
	route := Route{Class: class, Method: "GET", Path: "/hello/{name}", RouteKey: "GET /hello/{name}", Function: "Fn"}
	header := http.Header{}
	header.Set("X-Request-Id", "abc")
	header.Add("Cookie", "a=b")
	header.Add("Cookie", "c=d")
	header.Set("User-Agent", "apptheory-local-test")
	return InvokeRequest{
		API:        api,
		Route:      route,
		Params:     map[string]string{"name": "AppTheory"},
		Method:     "GET",
		Path:       "/hello/AppTheory",
		RawQuery:   "x=1&x=2&y=two",
		Header:     header,
		Body:       []byte(`{"a":1}`),
		RemoteAddr: "127.0.0.1:5555",
		RequestID:  "req-1",
		Now:        time.Unix(1700000000, 0),
	}
}

func TestHTTPV2EventMatchesProviderShape(t *testing.T) {
	raw, err := BuildEvent(testInvokeRequest(APIHTTPV2))
	if err != nil {
		t.Fatalf("build event: %v", err)
	}
	var event events.APIGatewayV2HTTPRequest
	if err = json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode v2 event: %v\n%s", err, raw)
	}
	if event.Version != "2.0" || event.RouteKey != "GET /hello/{name}" {
		t.Fatalf("unexpected version/route key: %+v", event)
	}
	if event.RawPath != "/hello/AppTheory" || event.RawQueryString != "x=1&x=2&y=two" {
		t.Fatalf("unexpected path/query: %+v", event)
	}
	if event.QueryStringParameters["x"] != "1" || event.QueryStringParameters["y"] != "two" {
		t.Fatalf("unexpected query parameters: %+v", event.QueryStringParameters)
	}
	if event.PathParameters["name"] != "AppTheory" {
		t.Fatalf("unexpected path parameters: %+v", event.PathParameters)
	}
	if event.Headers["x-request-id"] != "abc" || event.Headers["user-agent"] != "apptheory-local-test" {
		t.Fatalf("headers must be lower-case: %+v", event.Headers)
	}
	if strings.Join(event.Cookies, ",") != "a=b,c=d" {
		t.Fatalf("unexpected cookies: %+v", event.Cookies)
	}
	if _, exists := event.Headers["cookie"]; exists {
		t.Fatalf("the cookie header must not duplicate the cookies array: %+v", event.Headers)
	}
	if event.Body != `{"a":1}` || event.IsBase64Encoded {
		t.Fatalf("unexpected body: %+v", event)
	}
	if event.RequestContext.HTTP.Method != "GET" || event.RequestContext.HTTP.Path != "/hello/AppTheory" {
		t.Fatalf("unexpected request context http: %+v", event.RequestContext.HTTP)
	}
	if event.RequestContext.HTTP.SourceIP != "127.0.0.1" || event.RequestContext.HTTP.UserAgent != "apptheory-local-test" {
		t.Fatalf("unexpected request context identity: %+v", event.RequestContext.HTTP)
	}
	if event.RequestContext.Stage != "$default" || event.RequestContext.RouteKey != "GET /hello/{name}" {
		t.Fatalf("unexpected request context: %+v", event.RequestContext)
	}
	if !strings.Contains(event.RequestContext.DomainName, ".execute-api.") {
		t.Fatalf("HTTP API events must not look like Function URLs: %q", event.RequestContext.DomainName)
	}
	if event.RequestContext.RequestID != "req-1" {
		t.Fatalf("unexpected request id: %+v", event.RequestContext)
	}
}

func TestHTTPV2EventBase64Body(t *testing.T) {
	request := testInvokeRequest(APIHTTPV2)
	request.Body = []byte{0xff, 0xfe, 0x00}
	raw, err := BuildEvent(request)
	if err != nil {
		t.Fatalf("build event: %v", err)
	}
	var event events.APIGatewayV2HTTPRequest
	if err = json.Unmarshal(raw, &event); err != nil {
		t.Fatal(err)
	}
	if !event.IsBase64Encoded {
		t.Fatalf("non-UTF-8 body must be base64 encoded: %+v", event)
	}
	decoded, err := base64.StdEncoding.DecodeString(event.Body)
	if err != nil || string(decoded) != string(request.Body) {
		t.Fatalf("unexpected encoded body: %q (%v)", event.Body, err)
	}
}

func TestRESTV1EventMatchesProviderShape(t *testing.T) {
	request := testInvokeRequest(APIRESTV1)
	request.API.Stage = "prod"
	request.Route.Path = "/{proxy+}"
	request.Route.RouteKey = ""
	raw, err := BuildEvent(request)
	if err != nil {
		t.Fatalf("build event: %v", err)
	}
	var event events.APIGatewayProxyRequest
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode v1 event: %v\n%s", err, raw)
	}
	if event.Resource != "/{proxy+}" || event.Path != "/hello/AppTheory" || event.HTTPMethod != "GET" {
		t.Fatalf("unexpected v1 shape: %+v", event)
	}
	if len(event.MultiValueHeaders["Cookie"]) != 2 {
		t.Fatalf("multi-value headers missing: %+v", event.MultiValueHeaders)
	}
	if event.QueryStringParameters["x"] != "1" || len(event.MultiValueQueryStringParameters["x"]) != 2 {
		t.Fatalf("unexpected query shape: %+v %+v", event.QueryStringParameters, event.MultiValueQueryStringParameters)
	}
	if event.RequestContext.Stage != "prod" || event.RequestContext.Identity.SourceIP != "127.0.0.1" {
		t.Fatalf("unexpected v1 request context: %+v", event.RequestContext)
	}
	if event.RequestContext.ResourcePath != "/{proxy+}" || event.RequestContext.HTTPMethod != "GET" {
		t.Fatalf("unexpected v1 request context resource: %+v", event.RequestContext)
	}
}

func TestFunctionURLEventMatchesProviderShape(t *testing.T) {
	request := testInvokeRequest(APIFunctionURL)
	raw, err := BuildEvent(request)
	if err != nil {
		t.Fatalf("build event: %v", err)
	}
	var event events.LambdaFunctionURLRequest
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode Function URL event: %v\n%s", err, raw)
	}
	if event.Version != "2.0" || event.RawPath != "/hello/AppTheory" {
		t.Fatalf("unexpected Function URL event: %+v", event)
	}
	if !strings.HasSuffix(event.RequestContext.DomainName, FunctionURLDomainSuffix) {
		t.Fatalf("Function URL domain must be recognizable: %q", event.RequestContext.DomainName)
	}
	if event.RequestContext.HTTP.Method != "GET" || event.RequestContext.HTTP.SourceIP != "127.0.0.1" {
		t.Fatalf("unexpected Function URL request context: %+v", event.RequestContext)
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["routeKey"] != "$default" {
		t.Fatalf("Function URL events carry the $default route key: %v", envelope["routeKey"])
	}
	requestContext := mustMap(t, envelope["requestContext"])
	if requestContext["routeKey"] != "$default" || requestContext["stage"] != "$default" {
		t.Fatalf("Function URL request context must report the $default route and stage: %v", requestContext)
	}
	if _, ok := envelope["pathParameters"]; ok {
		t.Fatalf("Function URL events carry no path parameters: %v", envelope)
	}
	if _, exists := event.Headers["cookie"]; exists {
		t.Fatalf("the cookie header must not duplicate the cookies array: %+v", event.Headers)
	}
}

func TestBuildEventRejectsUnknownClass(t *testing.T) {
	request := testInvokeRequest(APIHTTPV2)
	request.API.Class = APIClass("unknown")
	if _, err := BuildEvent(request); err == nil {
		t.Fatal("expected an unsupported API class error")
	}
}

func TestNewRequestIDIsStableShape(t *testing.T) {
	first := NewRequestID()
	second := NewRequestID()
	if len(first) != 32 || first == second {
		t.Fatalf("unexpected request ids: %q %q", first, second)
	}
}
