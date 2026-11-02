package localcloudfront

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

func testFunction(runtime, code string) *Function {
	return &Function{LogicalID: "TestFunction", Runtime: runtime, Code: code}
}

func testRequestEvent(eventType string) *Event {
	return &Event{
		Version: "1.0",
		Context: EventContext{
			DistributionDomainName: "d111111abcdef8.cloudfront.net",
			DistributionID:         "EDFDVBD6EXAMPLE",
			EventType:              eventType,
			RequestID:              "request-id-1",
		},
		Viewer: Viewer{IP: "203.0.113.9"},
		Request: &EventRequest{
			Method: "GET",
			URI:    "/hello",
			Querystring: QueryString{Values: map[string]HeaderValue{
				"a": {Value: "1"},
			}},
			Headers: map[string]HeaderValue{
				"host":    {Value: "d111111abcdef8.cloudfront.net"},
				"x-test":  {Value: "one"},
				"x-multi": {Value: "first", MultiValue: []HeaderValue{{Value: "first"}, {Value: "second"}}},
			},
			Cookies: map[string]HeaderValue{
				"session": {Value: "abc"},
			},
		},
	}
}

func TestExecutorRunsTheExactFunctionCode(t *testing.T) {
	executor := NewExecutor()
	function := testFunction(runtimeJS20, `
		function handler(event) {
			event.request.headers['x-run'] = { value: 'executed' };
			return event.request;
		}`)
	result, err := executor.Execute(context.Background(), function, testRequestEvent("viewer-request"))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Kind != ResultRequest || result.Request == nil {
		t.Fatalf("unexpected result: %+v", result)
	}
	if got := result.Request.Headers["x-run"].Value; got != "executed" {
		t.Fatalf("x-run = %q; a pass-through would not add it", got)
	}
}

func TestExecutorViewerRequestEventShape(t *testing.T) {
	code := `
		function handler(event) {
			var multi = event.request.headers['x-multi'] && event.request.headers['x-multi'].multiValue
				? event.request.headers['x-multi'].multiValue.length : 0;
			var shape = {
				distributionDomainName: event.context.distributionDomainName,
				distributionId: event.context.distributionId,
				eventType: event.context.eventType,
				requestId: event.context.requestId,
				viewerIp: event.viewer.ip,
				method: event.request.method,
				uri: event.request.uri,
				query: event.request.querystring.a.value,
				header: event.request.headers['x-test'].value,
				multiValueCount: multi,
				cookie: event.request.cookies.session.value,
				hasCookieHeader: Object.prototype.hasOwnProperty.call(event.request.headers, 'cookie')
			};
			return { statusCode: 200, headers: { 'x-shape': { value: JSON.stringify(shape) } }, body: 'ok' };
		}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	var shape map[string]any
	if err := json.Unmarshal([]byte(result.Response.Headers["x-shape"].Value), &shape); err != nil {
		t.Fatalf("decode shape: %v", err)
	}
	want := map[string]any{
		"distributionDomainName": "d111111abcdef8.cloudfront.net",
		"distributionId":         "EDFDVBD6EXAMPLE",
		"eventType":              "viewer-request",
		"requestId":              "request-id-1",
		"viewerIp":               "203.0.113.9",
		"method":                 "GET",
		"uri":                    "/hello",
		"query":                  "1",
		"header":                 "one",
		"multiValueCount":        float64(2),
		"cookie":                 "abc",
		"hasCookieHeader":        false,
	}
	for key, value := range want {
		if shape[key] != value {
			t.Fatalf("event shape %s = %#v, want %#v (all: %#v)", key, shape[key], value, shape)
		}
	}
}

func TestExecutorViewerResponse(t *testing.T) {
	event := testRequestEvent("viewer-response")
	event.Response = &EventResponse{
		StatusCode: 200,
		Headers:    map[string]HeaderValue{"content-type": {Value: "text/html"}},
		Cookies:    map[string]CookieValue{},
	}
	code := `
		function handler(event) {
			event.response.headers['x-added'] = { value: 'by-viewer-response' };
			return event.response;
		}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result.Kind != ResultResponse || result.Response == nil {
		t.Fatalf("unexpected result: %+v", result)
	}
	if got := result.Response.Headers["x-added"].Value; got != "by-viewer-response" {
		t.Fatalf("x-added = %q", got)
	}
}

func TestExecutorAppliesValueEditToMultiValueFields(t *testing.T) {
	event := testRequestEvent("viewer-request")
	event.Request.Querystring.Values["q"] = HeaderValue{Value: "q1", MultiValue: []HeaderValue{{Value: "q1"}, {Value: "q2"}}}
	event.Request.Cookies["session"] = HeaderValue{Value: "v1", MultiValue: []HeaderValue{{Value: "v1"}, {Value: "v2"}}}
	code := `function handler(event) {
		event.request.headers['x-multi'].value = 'edited-header';
		event.request.cookies.session.value = 'edited-cookie';
		event.request.querystring.q.value = 'edited-query';
		return event.request;
	}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	header := result.Request.Headers["x-multi"]
	if header.Value != "edited-header" {
		t.Fatalf("header value = %q, want the edited value", header.Value)
	}
	if got := valuesOf(header); !slices.Equal(got, []string{"edited-header", "second"}) {
		t.Fatalf("header values = %v, want the edited first value and the unchanged second", got)
	}
	if got := cookieHeaderValues(result.Request.Cookies); !slices.Equal(got, []string{"session=edited-cookie", "session=v2"}) {
		t.Fatalf("cookie values = %v, want the edited first value and the unchanged second", got)
	}
	query, err := url.ParseQuery(serializeQuery(result.Request.Querystring))
	if err != nil {
		t.Fatalf("parse query: %v", err)
	}
	if got := query["q"]; !slices.Equal(got, []string{"edited-query", "q2"}) {
		t.Fatalf("query values = %v, want the edited first value and the unchanged second", got)
	}
}

func TestExecutorAppliesMultiValueEdit(t *testing.T) {
	event := testRequestEvent("viewer-request")
	event.Request.Querystring.Values["q"] = HeaderValue{Value: "q1", MultiValue: []HeaderValue{{Value: "q1"}, {Value: "q2"}}}
	event.Request.Cookies["session"] = HeaderValue{Value: "v1", MultiValue: []HeaderValue{{Value: "v1"}, {Value: "v2"}}}
	code := `function handler(event) {
		event.request.headers['x-multi'].value = 'ignored';
		event.request.headers['x-multi'].multiValue = [{ value: 'm1' }, { value: 'm2' }, { value: 'm3' }];
		event.request.cookies.session.value = 'ignored';
		event.request.cookies.session.multiValue = [{ value: 'c1' }, { value: 'c2' }];
		event.request.querystring.q.value = 'ignored';
		event.request.querystring.q.multiValue = [{ value: 'qq1' }, { value: 'qq2' }];
		return event.request;
	}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	header := result.Request.Headers["x-multi"]
	if got := valuesOf(header); !slices.Equal(got, []string{"m1", "m2", "m3"}) {
		t.Fatalf("header values = %v, want the edited multiValue", got)
	}
	if header.Value != "m1" {
		t.Fatalf("header value = %q, want the first edited multiValue entry", header.Value)
	}
	cookie := result.Request.Cookies["session"]
	if got := valuesOf(cookie); !slices.Equal(got, []string{"c1", "c2"}) {
		t.Fatalf("cookie values = %v, want the edited multiValue", got)
	}
	if cookie.Value != "c1" {
		t.Fatalf("cookie value = %q, want the first edited multiValue entry", cookie.Value)
	}
	query, err := url.ParseQuery(serializeQuery(result.Request.Querystring))
	if err != nil {
		t.Fatalf("parse query: %v", err)
	}
	if got := query["q"]; !slices.Equal(got, []string{"qq1", "qq2"}) {
		t.Fatalf("query values = %v, want the edited multiValue", got)
	}
	if got := result.Request.Querystring.Values["q"].Value; got != "qq1" {
		t.Fatalf("query value = %q, want the first edited multiValue entry", got)
	}
}

func TestExecutorAppliesValueEditToViewerResponseMultiValueFields(t *testing.T) {
	event := testRequestEvent("viewer-response")
	event.Response = &EventResponse{
		StatusCode: 200,
		Headers: map[string]HeaderValue{
			"x-multi": {Value: "first", MultiValue: []HeaderValue{{Value: "first"}, {Value: "second"}}},
		},
		Cookies: map[string]CookieValue{
			"session": {
				Value:      "v1",
				Attributes: "Path=/",
				MultiValue: []CookieValue{
					{Value: "v1", Attributes: "Path=/"},
					{Value: "v2", Attributes: "Path=/cat"},
				},
			},
		},
	}
	code := `function handler(event) {
		event.response.headers['x-multi'].value = 'edited-header';
		event.response.cookies.session.value = 'edited-cookie';
		return event.response;
	}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got := valuesOf(result.Response.Headers["x-multi"]); !slices.Equal(got, []string{"edited-header", "second"}) {
		t.Fatalf("response header values = %v, want the edited first value and the unchanged second", got)
	}
	cookie := result.Response.Cookies["session"]
	if cookie.Value != "edited-cookie" || len(cookie.MultiValue) != 2 {
		t.Fatalf("response cookie = %#v", cookie)
	}
	if cookie.MultiValue[0].Value != "edited-cookie" || cookie.MultiValue[0].Attributes != "Path=/" {
		t.Fatalf("response cookie first multiValue = %#v", cookie.MultiValue[0])
	}
	if cookie.MultiValue[1].Value != "v2" || cookie.MultiValue[1].Attributes != "Path=/cat" {
		t.Fatalf("response cookie second multiValue = %#v", cookie.MultiValue[1])
	}
	converted, err := responseFromEventResponse(result.Response, nil)
	if err != nil {
		t.Fatalf("convert response: %v", err)
	}
	want := []string{"session=edited-cookie; Path=/", "session=v2; Path=/cat"}
	if got := converted.Header.Values("Set-Cookie"); !slices.Equal(got, want) {
		t.Fatalf("Set-Cookie = %v, want %v", got, want)
	}
}

func TestExecutorAppliesMultiValueEditToViewerResponseFields(t *testing.T) {
	event := testRequestEvent("viewer-response")
	event.Response = &EventResponse{
		StatusCode: 200,
		Headers: map[string]HeaderValue{
			"x-multi": {Value: "first", MultiValue: []HeaderValue{{Value: "first"}, {Value: "second"}}},
		},
		Cookies: map[string]CookieValue{
			"session": {
				Value:      "v1",
				Attributes: "Path=/",
				MultiValue: []CookieValue{
					{Value: "v1", Attributes: "Path=/"},
					{Value: "v2", Attributes: "Path=/cat"},
				},
			},
		},
	}
	code := `function handler(event) {
		event.response.headers['x-multi'].value = 'ignored';
		event.response.headers['x-multi'].multiValue = [{ value: 'm1' }, { value: 'm2' }];
		event.response.cookies.session.value = 'ignored';
		event.response.cookies.session.multiValue = [
			{ value: 'c1', attributes: 'Path=/one' },
			{ value: 'c2', attributes: 'Path=/two' }
		];
		return event.response;
	}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), event)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	header := result.Response.Headers["x-multi"]
	if got := valuesOf(header); !slices.Equal(got, []string{"m1", "m2"}) {
		t.Fatalf("response header values = %v, want the edited multiValue", got)
	}
	if header.Value != "m1" {
		t.Fatalf("response header value = %q, want the first edited multiValue entry", header.Value)
	}
	cookie := result.Response.Cookies["session"]
	if cookie.Value != "c1" || cookie.Attributes != "Path=/one" {
		t.Fatalf("response cookie = %#v, want the first edited multiValue entry", cookie)
	}
	converted, err := responseFromEventResponse(result.Response, nil)
	if err != nil {
		t.Fatalf("convert response: %v", err)
	}
	want := []string{"session=c1; Path=/one", "session=c2; Path=/two"}
	if got := converted.Header.Values("Set-Cookie"); !slices.Equal(got, want) {
		t.Fatalf("Set-Cookie = %v, want %v", got, want)
	}
}

func TestExecutorRejectsInvalidReturns(t *testing.T) {
	cases := map[string]string{
		"null": `function handler(event) { return null; }`,
		"request method change": `function handler(event) {
			event.request.method = 'POST'; return event.request;
		}`,
		"uri without slash": `function handler(event) {
			event.request.uri = 'relative'; return event.request;
		}`,
		"missing cookies": `function handler(event) {
			return { method: event.request.method, uri: '/x', querystring: {}, headers: {} };
		}`,
		"request set-cookie": `function handler(event) {
			event.request.headers['set-cookie'] = { value: 'a=b' }; return event.request;
		}`,
		"unknown request field": `function handler(event) {
			event.request.extra = 1; return event.request;
		}`,
		"bad status": `function handler(event) {
			return { statusCode: '200', headers: {}, cookies: {} };
		}`,
		"response set-cookie": `function handler(event) {
			return { statusCode: 200, headers: { 'set-cookie': { value: 'a=b' } }, cookies: {} };
		}`,
		"bad body encoding": `function handler(event) {
			return { statusCode: 200, headers: {}, cookies: {}, body: { encoding: 'hex', data: '00' } };
		}`,
		"promise": `async function handler(event) { return event.request; }`,
	}
	for name, code := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
			if err == nil {
				t.Fatal("an invalid return must fail")
			}
			var functionErr *FunctionError
			if !asFunctionError(err, &functionErr) {
				t.Fatalf("want FunctionError, got %T: %v", err, err)
			}
			if functionErr.Code == "" {
				t.Fatalf("function error has no code: %+v", functionErr)
			}
		})
	}
}

func TestExecutorRestrictedGlobalsAndModules(t *testing.T) {
	cases := map[string]string{
		"fs":          `function handler(event) { require('fs'); return event.request; }`,
		"process":     `function handler(event) { return { statusCode: 200, headers: { x: { value: String(process) } }, cookies: {} }; }`,
		"fetch":       `function handler(event) { return { statusCode: 200, headers: { x: { value: String(fetch) } }, cookies: {} }; }`,
		"setTimeout":  `function handler(event) { setTimeout(function () {}, 1); return event.request; }`,
		"eval":        `function handler(event) { eval('1'); return event.request; }`,
		"function":    `function handler(event) { new Function('return 1')(); return event.request; }`,
		"network":     `function handler(event) { var x = new XMLHttpRequest(); return event.request; }`,
		"strict mode": `function handler(event) { accidentalGlobal = 1; return event.request; }`,
	}
	for name, code := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
			if err == nil {
				t.Fatalf("%s must be rejected", name)
			}
		})
	}
}

func TestExecutorRuntime10SyntaxGate(t *testing.T) {
	executor := NewExecutor()
	if _, err := executor.Execute(context.Background(),
		testFunction(runtimeJS10, `function handler(event) { var x = 1; return event.request; }`),
		testRequestEvent("viewer-request")); err != nil {
		t.Fatalf("var-only runtime 1.0 function must run: %v", err)
	}
	for name, code := range map[string]string{
		"const": `function handler(event) { const x = 1; return event.request; }`,
		"let":   `function handler(event) { let x = 1; return event.request; }`,
		"async": `async function handler(event) { return event.request; }`,
		"await": `function handler(event) { await 0; return event.request; }`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := executor.Execute(context.Background(), testFunction(runtimeJS10, code), testRequestEvent("viewer-request"))
			var functionErr *FunctionError
			if !asFunctionError(err, &functionErr) || functionErr.Code != "runtime-mismatch" {
				t.Fatalf("want runtime-mismatch, got %v", err)
			}
		})
	}
	if _, err := executor.Execute(context.Background(),
		testFunction(runtimeJS10, `function handler(event) { return { statusCode: 200, headers: {}, cookies: {}, body: require('buffer').Buffer.from('x').toString() }; }`),
		testRequestEvent("viewer-request")); err == nil {
		t.Fatal("runtime 1.0 must not expose Buffer")
	}
}

func TestExecutorFunctionErrorIsAFailure(t *testing.T) {
	code := `function handler(event) { throw new Error('boom'); }`
	_, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
	var functionErr *FunctionError
	if !asFunctionError(err, &functionErr) {
		t.Fatalf("want FunctionError, got %T: %v", err, err)
	}
	if !strings.Contains(functionErr.Message, "boom") {
		t.Fatalf("error message does not name the thrown error: %+v", functionErr)
	}
}

func TestExecutorMissingHandlerAndSyntaxError(t *testing.T) {
	executor := NewExecutor()
	for name, code := range map[string]string{
		"missing handler": `var x = 1;`,
		"syntax error":    `function handler(event) {`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := executor.Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
			if err == nil {
				t.Fatal("expected a failure")
			}
		})
	}
}

func TestExecutorFixedDate(t *testing.T) {
	code := `
		function handler(event) {
			var first = Date.now();
			var second = Date.now();
			var fromDate = new Date().getTime();
			return { statusCode: 200, headers: {
				'x-first': { value: String(first) },
				'x-second': { value: String(second) },
				'x-date': { value: String(fromDate) }
			}, cookies: {} };
		}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	first := result.Response.Headers["x-first"].Value
	if first != result.Response.Headers["x-second"].Value || first != result.Response.Headers["x-date"].Value {
		t.Fatalf("Date is not fixed for the run: %v", result.Response.Headers)
	}
}

func TestExecutorCryptoQuerystringAndBuffer(t *testing.T) {
	code := `
		var crypto = require('crypto');
		var querystring = require('querystring');
		function handler(event) {
			var digest = crypto.createHash('sha256').update('abc').digest('hex');
			var query = querystring.stringify({ a: ['1', '2'], b: 'x y' });
			var buffer = Buffer.from('hello');
			return { statusCode: 200, headers: {
				'x-digest': { value: digest },
				'x-query': { value: query },
				'x-buffer': { value: buffer.toString('hex') },
				'x-buffer-length': { value: String(buffer.length) }
			}, cookies: {} };
		}`
	result, err := NewExecutor().Execute(context.Background(), testFunction(runtimeJS20, code), testRequestEvent("viewer-request"))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got := result.Response.Headers["x-digest"].Value; got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("sha256 = %q", got)
	}
	if got := result.Response.Headers["x-query"].Value; got != "a=1&a=2&b=x%20y" {
		t.Fatalf("querystring = %q", got)
	}
	if got := result.Response.Headers["x-buffer"].Value; got != "68656c6c6f" {
		t.Fatalf("buffer hex = %q", got)
	}
	if got := result.Response.Headers["x-buffer-length"].Value; got != "5" {
		t.Fatalf("buffer length = %q", got)
	}
}

func TestExecutorLogsAndConsoleRestriction(t *testing.T) {
	result, err := NewExecutor().Execute(context.Background(),
		testFunction(runtimeJS20, `function handler(event) { console.log('hello'); return event.request; }`),
		testRequestEvent("viewer-request"))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(result.Logs) != 1 || result.Logs[0] != "hello" {
		t.Fatalf("logs = %v", result.Logs)
	}
	_, err = NewExecutor().Execute(context.Background(),
		testFunction(runtimeJS20, `function handler(event) { console.log('a', 'b'); return event.request; }`),
		testRequestEvent("viewer-request"))
	if err == nil {
		t.Fatal("console.log with two arguments must fail, as CloudFront documents")
	}
}

func TestExecutorTimeout(t *testing.T) {
	executor := &Executor{NodePath: "node", Timeout: 150 * time.Millisecond}
	_, err := executor.Execute(context.Background(),
		testFunction(runtimeJS20, `function handler(event) { while (true) {} }`),
		testRequestEvent("viewer-request"))
	if err == nil {
		t.Fatal("an endless function must time out")
	}
}

func TestExecutorMissingNode(t *testing.T) {
	executor := &Executor{NodePath: "apptheory-no-such-node-binary"}
	_, err := executor.Execute(context.Background(), testFunction(runtimeJS20, `function handler(event) { return event.request; }`), testRequestEvent("viewer-request"))
	if err == nil || !strings.Contains(err.Error(), "Node.js on PATH") {
		t.Fatalf("want a clear missing-Node error, got %v", err)
	}
}

func asFunctionError(err error, target **FunctionError) bool {
	if typed, ok := err.(*FunctionError); ok {
		*target = typed
		return true
	}
	return false
}
