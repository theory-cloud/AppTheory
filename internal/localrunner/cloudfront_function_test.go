package localrunner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

type recordingInvoker struct {
	payload  []byte
	response []byte
	err      error
	calls    int
}

func (i *recordingInvoker) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	i.calls++
	i.payload = append([]byte(nil), payload...)
	if i.err != nil {
		return nil, i.err
	}
	return i.response, nil
}

func requireEventMap(t *testing.T, value any, label string) map[string]any {
	t.Helper()
	typed, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s = %T, want an object", label, value)
	}
	return typed
}

func requireEventSlice(t *testing.T, value any, label string) []any {
	t.Helper()
	typed, ok := value.([]any)
	if !ok {
		t.Fatalf("%s = %T, want an array", label, value)
	}
	return typed
}

func requireEventString(t *testing.T, value any, label string) string {
	t.Helper()
	typed, ok := value.(string)
	if !ok {
		t.Fatalf("%s = %T, want a string", label, value)
	}
	return typed
}

func functionURLRequest() localcloudfront.OriginRequest {
	return localcloudfront.OriginRequest{
		OriginID:   "Origin1",
		Method:     http.MethodPost,
		URI:        "/actions/ping",
		OriginPath: "/prod",
		Query:      "a=1&a=2&b=3",
		Host:       "url.lambda-url.us-east-1.local",
		Header: http.Header{
			"Content-Type": {"application/json"},
			"Cookie":       {"a=1; b=2"},
			"User-Agent":   {"local-test"},
		},
		Body:      []byte(`{"ok":true}`),
		ViewerIP:  "203.0.113.9",
		RequestID: "request-id",
	}
}

func TestFunctionURLOriginBuildsTheVersionTwoEvent(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{
		"statusCode": 201,
		"headers": {"Content-Type": "application/json", "X-Test": "yes"},
		"cookies": ["session=abc; Path=/"],
		"body": "{\"ok\":true}",
		"isBase64Encoded": false
	}`)}
	origin := &functionURLOrigin{
		originID:   "Origin1",
		urlID:      "Url1",
		functionID: "Function1",
		authType:   noneAuthorization,
		domainName: "url.lambda-url.us-east-1.local",
		invoker:    invoker,
		now:        func() time.Time { return time.Unix(1700000000, 0) },
	}
	response, err := origin.Fetch(context.Background(), functionURLRequest())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if invoker.calls != 1 {
		t.Fatalf("invoker calls = %d", invoker.calls)
	}
	var event map[string]any
	if err := json.Unmarshal(invoker.payload, &event); err != nil {
		t.Fatalf("event is not JSON: %v", err)
	}
	if event["version"] != "2.0" || event["routeKey"] != "$default" {
		t.Fatalf("event = %+v", event)
	}
	if event["rawPath"] != "/prod/actions/ping" || event["rawQueryString"] != "a=1&a=2&b=3" {
		t.Fatalf("path/query = %v %v", event["rawPath"], event["rawQueryString"])
	}
	headers := requireEventMap(t, event["headers"], "headers")
	if headers["host"] != "url.lambda-url.us-east-1.local" {
		t.Fatalf("host = %v", headers["host"])
	}
	if _, ok := headers["cookie"]; ok {
		t.Fatal("cookies must move to the cookies array")
	}
	cookies := requireEventSlice(t, event["cookies"], "cookies")
	if len(cookies) != 2 || cookies[0] != "a=1" || cookies[1] != "b=2" {
		t.Fatalf("cookies = %v", cookies)
	}
	query := requireEventMap(t, event["queryStringParameters"], "queryStringParameters")
	if query["a"] != "1,2" || query["b"] != "3" {
		t.Fatalf("query = %v", query)
	}
	context := requireEventMap(t, event["requestContext"], "requestContext")
	httpContext := requireEventMap(t, context["http"], "requestContext.http")
	if httpContext["method"] != "POST" || httpContext["path"] != "/prod/actions/ping" || httpContext["sourceIp"] != "203.0.113.9" {
		t.Fatalf("http context = %v", httpContext)
	}
	if context["requestId"] != "request-id" {
		t.Fatalf("request id = %v", context["requestId"])
	}
	if _, ok := context["authorizer"]; ok {
		t.Fatal("a NONE Function URL must not report an IAM authorizer")
	}
	if response.StatusCode != 201 || string(response.Body) != `{"ok":true}` {
		t.Fatalf("response = %d %q", response.StatusCode, response.Body)
	}
	if response.Header.Get("X-Test") != "yes" || response.Header.Get("Set-Cookie") != "session=abc; Path=/" {
		t.Fatalf("response headers = %+v", response.Header)
	}
}

func TestFunctionURLOriginBuffersAResponseStream(t *testing.T) {
	metadata := []byte(`{"statusCode":200,"headers":{"Content-Type":"text/html"}}`)
	framed := append(append([]byte{}, metadata...), streamingFrameSeparator...)
	framed = append(framed, []byte("<h1>hello</h1>")...)
	invoker := &recordingInvoker{response: framed}
	origin := &functionURLOrigin{
		originID: "Origin1", urlID: "Url1", authType: noneAuthorization,
		domainName: "url.lambda-url.us-east-1.local", invoker: invoker,
	}
	response, err := origin.Fetch(context.Background(), functionURLRequest())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != 200 || string(response.Body) != "<h1>hello</h1>" {
		t.Fatalf("response = %d %q", response.StatusCode, response.Body)
	}
}

func TestFunctionURLOriginBase64EncodesBinaryBodies(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	origin := &functionURLOrigin{
		originID: "Origin1", urlID: "Url1", authType: noneAuthorization,
		domainName: "url.lambda-url.us-east-1.local", invoker: invoker,
	}
	request := functionURLRequest()
	request.Body = []byte{0xff, 0xfe, 0x00}
	if _, err := origin.Fetch(context.Background(), request); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(invoker.payload, &event); err != nil {
		t.Fatalf("event: %v", err)
	}
	if event["isBase64Encoded"] != true {
		t.Fatalf("isBase64Encoded = %v", event["isBase64Encoded"])
	}
	decoded, err := base64.StdEncoding.DecodeString(requireEventString(t, event["body"], "body"))
	if err != nil || len(decoded) != 3 || decoded[0] != 0xff {
		t.Fatalf("body = %v err = %v", event["body"], err)
	}
}

func TestFunctionURLOriginSignsAndReportsTheIAMAuthorizer(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	origin := &functionURLOrigin{
		originID: "Origin1", urlID: "Url1", authType: "AWS_IAM",
		domainName: "url.lambda-url.us-east-1.local",
		invoker:    invoker,
		signer:     newLocalOACSigner(),
		now:        func() time.Time { return time.Unix(1700000000, 0) },
	}
	if _, err := origin.Fetch(context.Background(), functionURLRequest()); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(invoker.payload, &event); err != nil {
		t.Fatalf("event: %v", err)
	}
	headers := requireEventMap(t, event["headers"], "headers")
	if _, ok := headers["authorization"]; ok {
		t.Fatal("the OAC Authorization header must be consumed by the Function URL, not passed to the handler")
	}
	context := requireEventMap(t, event["requestContext"], "requestContext")
	authorizer := requireEventMap(t, context["authorizer"], "requestContext.authorizer")
	iam := requireEventMap(t, authorizer["iam"], "requestContext.authorizer.iam")
	if iam["accessKey"] != localOACAccessKey {
		t.Fatalf("iam = %v", iam)
	}
}

func TestFunctionURLOriginRejectsAnUnverifiedSignatureWithoutInvoking(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200}`)}
	origin := &functionURLOrigin{
		originID: "Origin1", urlID: "Url1", authType: "AWS_IAM",
		domainName: "url.lambda-url.us-east-1.local",
		invoker:    invoker,
		signer:     newLocalOACSigner(),
		verifyFn:   func(*signedRequest) error { return errors.New("bad signature") },
	}
	response, err := origin.Fetch(context.Background(), functionURLRequest())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if invoker.calls != 0 {
		t.Fatalf("invoker calls = %d", invoker.calls)
	}
}

func TestFunctionURLOriginHandlerErrorIsAnError(t *testing.T) {
	invoker := &recordingInvoker{err: errors.New("runtime interface emulator returned HTTP 500")}
	origin := &functionURLOrigin{
		originID: "Origin1", urlID: "Url1", authType: noneAuthorization,
		domainName: "url.lambda-url.us-east-1.local", invoker: invoker,
	}
	if _, err := origin.Fetch(context.Background(), functionURLRequest()); err == nil {
		t.Fatal("a failed invocation must be an error")
	}
}

func TestLocalOACSignerRoundTripsAndRejectsTampering(t *testing.T) {
	signer := newLocalOACSigner()
	now := time.Unix(1700000000, 0).UTC()
	newRequest := func() *signedRequest {
		return &signedRequest{
			Method: http.MethodGet, Path: "/actions/ping", Query: "a=1&b=2",
			Host: "url.lambda-url.us-east-1.local", Body: []byte("hello"),
			Now: now, Header: http.Header{},
		}
	}
	signed := newRequest()
	if err := signer.sign(signed); err != nil {
		t.Fatalf("sign: %v", err)
	}
	if err := signer.verify(signed); err != nil {
		t.Fatalf("verify: %v", err)
	}
	cases := map[string]func(*signedRequest){
		"path":   func(r *signedRequest) { r.Path = "/other" },
		"query":  func(r *signedRequest) { r.Query = "a=1" },
		"body":   func(r *signedRequest) { r.Body = []byte("other") },
		"host":   func(r *signedRequest) { r.Host = "other.example" },
		"method": func(r *signedRequest) { r.Method = http.MethodPost },
		"date":   func(r *signedRequest) { r.Now = now.Add(time.Hour) },
		"access key": func(r *signedRequest) {
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), localOACAccessKey, "OTHER", 1))
		},
		"signature": func(r *signedRequest) {
			r.Header.Set("Authorization", r.Header.Get("Authorization")+"00")
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			tampered := newRequest()
			if err := signer.sign(tampered); err != nil {
				t.Fatalf("sign: %v", err)
			}
			mutate(tampered)
			if err := signer.verify(tampered); err == nil {
				t.Fatal("tampered request verified")
			}
		})
	}
	unsigned := newRequest()
	if err := signer.verify(unsigned); err == nil {
		t.Fatal("an unsigned request verified")
	}
}
