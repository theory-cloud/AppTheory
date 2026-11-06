package localcloudfront

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

type recordingOrigin struct {
	requests []OriginRequest
	response OriginResponse
	err      error
}

func (o *recordingOrigin) Fetch(_ context.Context, request OriginRequest) (OriginResponse, error) {
	o.requests = append(o.requests, request)
	if o.err != nil {
		return OriginResponse{}, o.err
	}
	return o.response, nil
}

func okOrigin(body string) *recordingOrigin {
	return &recordingOrigin{response: OriginResponse{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"text/html"}},
		Body:       []byte(body),
	}}
}

func testPolicy(kind PolicyKind, cache *CachePolicy, origin *OriginRequestPolicy, response *ResponseHeadersPolicy) *Policy {
	return &Policy{Kind: kind, ID: string(kind), Cache: cache, OriginRequest: origin, ResponseHeaders: response}
}

func testDistribution(defaultBehavior *Behavior, cacheBehaviors []*Behavior, origins ...*DistributionOrigin) *Distribution {
	return &Distribution{
		LogicalID:       "TestDistribution",
		Stack:           "TestStack",
		Enabled:         true,
		DefaultBehavior: defaultBehavior,
		CacheBehaviors:  cacheBehaviors,
		Origins:         origins,
	}
}

func testBehavior(pattern, originID string, methods []string) *Behavior {
	return &Behavior{
		PathPattern:    pattern,
		TargetOriginID: originID,
		AllowedMethods: methods,
		CachePolicy:    testPolicy(PolicyCache, &CachePolicy{}, nil, nil),
	}
}

func testOrigin(id, domain string) *DistributionOrigin {
	return &DistributionOrigin{ID: id, DomainName: domain, Kind: OriginCustom, S3: &S3Origin{}, Custom: &CustomOrigin{}}
}

func serveGateway(gateway *Gateway, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequestWithContext(context.Background(), method, target, strings.NewReader(body))
	request.Host = "viewer.example"
	request.RemoteAddr = "203.0.113.9:12345"
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	return recorder
}

func TestGatewayUsesCacheBehaviorListedOrder(t *testing.T) {
	first := okOrigin("first")
	second := okOrigin("second")
	fallback := okOrigin("default")
	distribution := testDistribution(
		testBehavior("*", "default", []string{"GET", "HEAD"}),
		[]*Behavior{
			testBehavior("assets/*", "first", []string{"GET", "HEAD"}),
			testBehavior("assets/special/*", "second", []string{"GET", "HEAD"}),
		},
		testOrigin("first", "first.example"),
		testOrigin("second", "second.example"),
		testOrigin("default", "default.example"),
	)
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{
		"first": first, "second": second, "default": fallback,
	}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/assets/special/x", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "first" {
		t.Fatalf("first listed behavior must win: status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if len(first.requests) != 1 || len(second.requests) != 0 || len(fallback.requests) != 0 {
		t.Fatalf("unexpected origin calls: first=%d second=%d default=%d", len(first.requests), len(second.requests), len(fallback.requests))
	}
}

func TestGatewayRefusesDisallowedMethod(t *testing.T) {
	origin := okOrigin("ok")
	distribution := testDistribution(testBehavior("*", "origin", []string{"GET", "HEAD"}), nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodPost, "http://viewer.example/x", "body", nil)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if len(origin.requests) != 0 {
		t.Fatal("a disallowed method must not reach the origin")
	}
	if !strings.Contains(recorder.Body.String(), "POST") {
		t.Fatalf("403 body does not name the method: %q", recorder.Body.String())
	}
}

func TestGatewayPassesCachedMethodsToOriginFailover(t *testing.T) {
	cases := []struct {
		name       string
		cached     []string
		wantStatus int
		wantBody   string
	}{
		{name: "options not cached", cached: []string{"GET", "HEAD"}, wantStatus: http.StatusNotFound, wantBody: "primary"},
		{name: "options cached", cached: []string{"GET", "HEAD", "OPTIONS"}, wantStatus: http.StatusOK, wantBody: "secondary"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			primary := &recordingOrigin{response: OriginResponse{StatusCode: http.StatusNotFound, Body: []byte("primary")}}
			secondary := &recordingOrigin{response: OriginResponse{StatusCode: http.StatusOK, Body: []byte("secondary")}}
			group := NewOriginGroupOrigin("group", []OriginGroupMember{
				{OriginID: "primary", Origin: primary},
				{OriginID: "secondary", Origin: secondary},
			}, []int{http.StatusNotFound})
			behavior := testBehavior("*", "group", []string{"GET", "HEAD", "OPTIONS"})
			behavior.CachedMethods = testCase.cached
			distribution := &Distribution{
				LogicalID:       "TestDistribution",
				Enabled:         true,
				DefaultBehavior: behavior,
				Origins: []*DistributionOrigin{
					testOrigin("primary", "primary.example"),
					testOrigin("secondary", "secondary.example"),
				},
				OriginGroups: []*OriginGroup{{ID: "group", Members: []string{"primary", "secondary"}}},
			}
			gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"group": group}, nil, nil)
			recorder := serveGateway(gateway, http.MethodOptions, "http://viewer.example/x", "", nil)
			if recorder.Code != testCase.wantStatus || recorder.Body.String() != testCase.wantBody {
				t.Fatalf("status = %d body = %q, want %d %q", recorder.Code, recorder.Body.String(), testCase.wantStatus, testCase.wantBody)
			}
			wantSecondary := 0
			if testCase.wantBody == "secondary" {
				wantSecondary = 1
			}
			if len(secondary.requests) != wantSecondary {
				t.Fatalf("secondary called %d times, want %d", len(secondary.requests), wantSecondary)
			}
			if len(primary.requests) != 1 {
				t.Fatalf("primary called %d times, want 1", len(primary.requests))
			}
		})
	}
}

func TestGatewayViewerRequestRunsBeforeAllowedMethods(t *testing.T) {
	origin := okOrigin("origin")
	code := `function handler(event) {
		return { statusCode: 204, headers: {}, cookies: {} };
	}`
	function := testFunction(runtimeJS20, code)
	function.LogicalID = "PreflightFunction"
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = function.LogicalID
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodOptions, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want the function's 204: the local gateway runs viewer-request before AllowedMethods", recorder.Code)
	}
	if len(origin.requests) != 0 {
		t.Fatal("the short-circuit must not reach the origin")
	}
}

func TestGatewayViewerRequestShortCircuitsTheOrigin(t *testing.T) {
	origin := okOrigin("origin")
	code := `function handler(event) {
		return { statusCode: 302, headers: { location: { value: '/elsewhere' } }, cookies: {} };
	}`
	function := testFunction(runtimeJS20, code)
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = function.LogicalID
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/elsewhere" {
		t.Fatalf("short-circuit response = %d %q", recorder.Code, recorder.Header().Get("Location"))
	}
	if len(origin.requests) != 0 {
		t.Fatal("a viewer-request response must not reach the origin")
	}
}

func TestGatewayViewerResponseRunsOnTheOriginResponse(t *testing.T) {
	origin := okOrigin("origin body")
	origin.response.Header.Set("x-origin", "yes")
	requestCode := `function handler(event) {
		event.request.headers['x-request-id'] = { value: 'rid-1' };
		return event.request;
	}`
	responseCode := `function handler(event) {
		event.response.headers['x-viewer-response'] = { value: event.request.headers['x-request-id'].value };
		return event.response;
	}`
	requestFunction := testFunction(runtimeJS20, requestCode)
	responseFunction := &Function{LogicalID: "ResponseFunction", Runtime: runtimeJS20, Code: responseCode}
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = requestFunction.LogicalID
	behavior.ViewerResponseFunction = responseFunction.LogicalID
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{
		Functions: []*Function{requestFunction, responseFunction},
		functionsByID: map[string]*Function{
			requestFunction.LogicalID: requestFunction, responseFunction.LogicalID: responseFunction,
		},
	}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "origin body" {
		t.Fatalf("response = %d %q", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("x-viewer-response"); got != "rid-1" {
		t.Fatalf("viewer-response header = %q", got)
	}
	if got := recorder.Header().Get("x-origin"); got != "yes" {
		t.Fatalf("origin header lost: %q", got)
	}
	if len(origin.requests) != 1 {
		t.Fatal("expected one origin request")
	}
}

func TestGatewayOriginRequestPolicyFiltersHeadersCookiesAndQuery(t *testing.T) {
	origin := okOrigin("ok")
	policy := testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-keep", "cloudfront-viewer-address"}},
		Cookies:      CookieForwarding{Mode: ForwardWhitelist, Names: []string{"a"}},
		QueryStrings: QueryForwarding{Mode: ForwardWhitelist, Names: []string{"q"}},
	}, nil)
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = policy
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x?q=1&drop=2",
		"", map[string]string{"X-Keep": "yes", "X-Drop": "no", "Cookie": "a=1; b=2"})
	if recorder.Code != 200 {
		t.Fatalf("status = %d", recorder.Code)
	}
	if len(origin.requests) != 1 {
		t.Fatal("expected one origin request")
	}
	request := origin.requests[0]
	if request.Query != "q=1" {
		t.Fatalf("query = %q", request.Query)
	}
	if request.Header.Get("X-Keep") != "yes" || request.Header.Get("X-Drop") != "" {
		t.Fatalf("headers = %v", request.Header)
	}
	if request.Header.Get("CloudFront-Viewer-Address") != "203.0.113.9:12345" {
		t.Fatalf("viewer address = %q", request.Header.Get("CloudFront-Viewer-Address"))
	}
	if request.Header.Get("Cookie") != "a=1" {
		t.Fatalf("cookie = %q", request.Header.Get("Cookie"))
	}
	if request.Host != "origin.example" {
		t.Fatalf("host = %q, want the origin domain", request.Host)
	}
}

func TestGatewayAllViewerExceptHostHeaderUsesOriginHost(t *testing.T) {
	origin := okOrigin("ok")
	managed, _ := managedPolicy("b689b0a8-53d0-40ab-baf2-68738e2966ac", PolicyOriginRequest)
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, managed.OriginRequest, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x?a=1", "", map[string]string{
		"X-Extra": "kept", "Cookie": "a=1",
	})
	request := origin.requests[0]
	if request.Host != "origin.example" {
		t.Fatalf("AllViewerExceptHostHeader must use the origin domain, got %q", request.Host)
	}
	if request.Header.Get("X-Extra") != "kept" {
		t.Fatal("AllViewerExceptHostHeader must forward other headers")
	}
	if request.Header.Get("CloudFront-Forwarded-Proto") != "http" {
		t.Fatal("AllViewerExceptHostHeader must add CloudFront-Forwarded-Proto")
	}
	if request.Query != "a=1" || request.Header.Get("Cookie") != "a=1" {
		t.Fatalf("query/cookie not forwarded: %q %q", request.Query, request.Header.Get("Cookie"))
	}
}

func TestGatewayAllViewerForwardsViewerHost(t *testing.T) {
	origin := okOrigin("ok")
	managed, _ := managedPolicy("216adef6-5c7f-47e4-b989-5492eafa07d3", PolicyOriginRequest)
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, managed.OriginRequest, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if got := origin.requests[0].Host; got != "viewer.example" {
		t.Fatalf("AllViewer host = %q, want viewer.example", got)
	}
}

func TestGatewayCachePolicyForwardsWhenNoOriginPolicy(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.CachePolicy = testPolicy(PolicyCache, &CachePolicy{
		Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-keep"}},
		Cookies:      CookieForwarding{Mode: ForwardWhitelist, Names: []string{"a"}},
		QueryStrings: QueryForwarding{Mode: ForwardWhitelist, Names: []string{"q"}},
	}, nil, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x?q=1&drop=2", "", map[string]string{
		"X-Keep": "yes", "Cookie": "a=1; b=2",
	})
	request := origin.requests[0]
	if request.Query != "q=1" || request.Header.Get("X-Keep") != "yes" || request.Header.Get("Cookie") != "a=1" {
		t.Fatalf("cache policy forwarding = query %q header %q cookie %q", request.Query, request.Header.Get("X-Keep"), request.Header.Get("Cookie"))
	}
}

func TestGatewayResponseHeadersPolicy(t *testing.T) {
	origin := okOrigin("ok")
	origin.response.Header.Set("X-Frame-Options", "SAMEORIGIN")
	origin.response.Header.Set("X-Remove-Me", "yes")
	origin.response.Header.Set("X-Origin-Keep", "origin")
	policy := testPolicy(PolicyResponseHeaders, nil, nil, &ResponseHeadersPolicy{
		Security: &SecurityHeaders{
			ContentTypeOptions:      &ContentTypeOptions{Override: true},
			FrameOptions:            &FrameOptions{Value: "DENY", Override: true},
			ReferrerPolicy:          &ReferrerPolicy{Value: "no-referrer", Override: false},
			StrictTransportSecurity: &StrictTransportSecurity{MaxAgeSeconds: 60, IncludeSubdomains: true, Preload: true, Override: true},
			XSSProtection:           &XSSProtection{Protection: true, ModeBlock: true, Override: true},
		},
		Custom: []CustomHeader{
			{Name: "Permissions-Policy", Value: "camera=()", Override: true},
			{Name: "X-Origin-Keep", Value: "policy", Override: false},
		},
		Remove: []string{"x-remove-me"},
	})
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ResponseHeadersPolicy = policy
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", map[string]string{"X-Origin-Keep": "origin"})
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := recorder.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if got := recorder.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", got)
	}
	if got := recorder.Header().Get("Strict-Transport-Security"); got != "max-age=60; includeSubDomains; preload" {
		t.Fatalf("HSTS = %q", got)
	}
	if got := recorder.Header().Get("X-XSS-Protection"); got != "1; mode=block" {
		t.Fatalf("X-XSS-Protection = %q", got)
	}
	if got := recorder.Header().Get("Permissions-Policy"); got != "camera=()" {
		t.Fatalf("Permissions-Policy = %q", got)
	}
	if got := recorder.Header().Get("X-Origin-Keep"); got != "origin" {
		t.Fatalf("override=false must keep the origin header, got %q", got)
	}
	if got := recorder.Header().Get("X-Remove-Me"); got != "" {
		t.Fatalf("X-Remove-Me = %q", got)
	}
}

func TestGatewayCORS(t *testing.T) {
	origin := okOrigin("ok")
	policy := testPolicy(PolicyResponseHeaders, nil, nil, &ResponseHeadersPolicy{
		CORS: &CORSConfig{
			AllowOrigins:     []string{"https://app.example"},
			AllowMethods:     []string{"GET", "POST"},
			AllowHeaders:     []string{"Content-Type"},
			AllowCredentials: true,
			MaxAgeSeconds:    intPointer(600),
			OriginOverride:   true,
		},
	})
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD", "OPTIONS"})
	behavior.ResponseHeadersPolicy = policy
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodOptions, "http://viewer.example/x", "", map[string]string{
		"Origin":                        "https://app.example",
		"Access-Control-Request-Method": "POST",
	})
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("allow origin = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow credentials = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST" {
		t.Fatalf("allow methods = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type" {
		t.Fatalf("allow headers = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Max-Age"); got != "600" {
		t.Fatalf("max age = %q", got)
	}
	noCORS := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if got := noCORS.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("a request without Origin must not get CORS headers, got %q", got)
	}
}

func TestGatewayOriginPathAndDefaultRootObject(t *testing.T) {
	origin := okOrigin("root")
	originConfig := testOrigin("origin", "origin.example")
	originConfig.OriginPath = "/prod"
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, originConfig)
	distribution.DefaultRootObject = "index.html"
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/", "", nil)
	request := origin.requests[0]
	if request.URI != "/index.html" || request.OriginPath != "/prod" || request.Path() != "/prod/index.html" {
		t.Fatalf("origin request = URI %q OriginPath %q Path %q", request.URI, request.OriginPath, request.Path())
	}
}

func TestGatewayUnwiredOriginIsNamed(t *testing.T) {
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, nil, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "registered no implementation") {
		t.Fatalf("body does not name the reason: %q", recorder.Body.String())
	}
}

func TestGatewayFunctionErrorIsNotAPassThrough(t *testing.T) {
	origin := okOrigin("origin")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = "Broken"
	function := testFunction(runtimeJS20, `function handler(event) { throw new Error('boom'); }`)
	function.LogicalID = "Broken"
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if len(origin.requests) != 0 {
		t.Fatal("a function error must not pass the request through")
	}
	if !strings.Contains(recorder.Body.String(), "not passed through") {
		t.Fatalf("body does not state the failure: %q", recorder.Body.String())
	}
}

func TestGatewayViewerRequestRewriteKeepsTheOriginalBehavior(t *testing.T) {
	assets := okOrigin("assets")
	fallback := okOrigin("default")
	code := `function handler(event) {
		event.request.uri = '/other';
		event.request.headers['x-rewritten'] = { value: 'yes' };
		return event.request;
	}`
	function := testFunction(runtimeJS20, code)
	assetsBehavior := testBehavior("assets/*", "assets", []string{"GET", "HEAD"})
	assetsBehavior.ViewerRequestFunction = function.LogicalID
	assetsBehavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-rewritten"}},
	}, nil)
	distribution := testDistribution(testBehavior("*", "default", []string{"GET", "HEAD"}), []*Behavior{assetsBehavior},
		testOrigin("assets", "assets.example"), testOrigin("default", "default.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"assets": assets, "default": fallback}, NewExecutor(), nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/assets/app.js", "", nil)
	if len(assets.requests) != 1 || len(fallback.requests) != 0 {
		t.Fatalf("behavior must stay on the original URI: assets=%d default=%d", len(assets.requests), len(fallback.requests))
	}
	if assets.requests[0].URI != "/other" {
		t.Fatalf("origin URI = %q", assets.requests[0].URI)
	}
	if assets.requests[0].Header.Get("X-Rewritten") != "yes" {
		t.Fatal("viewer-request header mutation did not reach the origin")
	}
}

func TestGatewayHEADHasNoBody(t *testing.T) {
	origin := okOrigin("body")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodHead, "http://viewer.example/x", "", nil)
	if recorder.Code != 200 || recorder.Body.Len() != 0 {
		t.Fatalf("HEAD = %d body %q", recorder.Code, recorder.Body.String())
	}
	if len(origin.requests) != 1 {
		t.Fatal("HEAD must still reach the origin")
	}
}

func TestGatewayDoesNotCacheWithoutACachePolicy(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d, want 2 (a behavior with no cache policy must not cache)", len(origin.requests))
	}
}

func TestGatewayRefusedDistribution(t *testing.T) {
	origin := okOrigin("ok")
	distribution := testDistribution(testBehavior("*", "origin", []string{"GET", "HEAD"}), nil, testOrigin("origin", "origin.example"))
	distribution.Refusals = []string{"distribution: WebACLId (a WAF web ACL is not emulated)"}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable || len(origin.requests) != 0 {
		t.Fatalf("refused distribution = %d, origin calls %d", recorder.Code, len(origin.requests))
	}
}

func TestGatewayViewerResponseCookie(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = "CookieFunction"
	function := testFunction(runtimeJS20, `function handler(event) {
		return { statusCode: 200, headers: {}, cookies: { session: { value: 'abc', attributes: 'Path=/; HttpOnly' } } };
	}`)
	function.LogicalID = "CookieFunction"
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if got := recorder.Header().Get("Set-Cookie"); got != "session=abc; Path=/; HttpOnly" {
		t.Fatalf("Set-Cookie = %q", got)
	}
	if len(origin.requests) != 0 {
		t.Fatal("the short-circuit must not reach the origin")
	}
}

func TestGatewayViewerResponseBodyOverride(t *testing.T) {
	origin := okOrigin("origin body")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerResponseFunction = "BodyFunction"
	function := testFunction(runtimeJS20, `function handler(event) {
		event.response.body = 'replaced';
		return event.response;
	}`)
	function.LogicalID = "BodyFunction"
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Body.String() != "replaced" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestGatewayBuildsTheDocumentedEventShape(t *testing.T) {
	origin := okOrigin("ok")
	code := `function handler(event) {
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
	function := testFunction(runtimeJS20, code)
	function.LogicalID = "ShapeFunction"
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = function.LogicalID
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	gateway.RequestID = func() string { return "rid-1" }
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/hello?a=1", nil)
	request.Host = "viewer.example"
	request.RemoteAddr = "203.0.113.9:12345"
	request.Header.Set("X-Test", "one")
	request.Header.Add("X-Multi", "first")
	request.Header.Add("X-Multi", "second")
	request.Header.Set("Cookie", "session=abc")
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("status = %d body %q", recorder.Code, recorder.Body.String())
	}
	var shape map[string]any
	if err := json.Unmarshal([]byte(recorder.Header().Get("x-shape")), &shape); err != nil {
		t.Fatalf("decode shape: %v", err)
	}
	want := map[string]any{
		"distributionDomainName": "viewer.example",
		"eventType":              "viewer-request",
		"requestId":              "rid-1",
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
	if distributionID, ok := shape["distributionId"].(string); !ok || !strings.HasPrefix(distributionID, "LOCAL") {
		t.Fatalf("distributionId = %#v, want a local placeholder", shape["distributionId"])
	}
}

func TestGatewayAppliesValueEditOnMultiValueFieldsBeforeOrigin(t *testing.T) {
	origin := okOrigin("ok")
	code := `function handler(event) {
		event.request.headers['x-multi'].value = 'edited-header';
		event.request.cookies.session.value = 'edited-cookie';
		event.request.querystring.q.value = 'edited-query';
		return event.request;
	}`
	function := testFunction(runtimeJS20, code)
	function.LogicalID = "MultiValueFunction"
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = function.LogicalID
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-multi"}},
		Cookies:      CookieForwarding{Mode: ForwardWhitelist, Names: []string{"session"}},
		QueryStrings: QueryForwarding{Mode: ForwardWhitelist, Names: []string{"q"}},
	}, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x?q=q1&q=q2", nil)
	request.Host = "viewer.example"
	request.RemoteAddr = "203.0.113.9:12345"
	request.Header.Add("X-Multi", "first")
	request.Header.Add("X-Multi", "second")
	request.Header.Add("Cookie", "session=v1; session=v2")
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body %q", recorder.Code, recorder.Body.String())
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d, want 1", len(origin.requests))
	}
	sent := origin.requests[0]
	if got := sent.Header.Values("X-Multi"); !slices.Equal(got, []string{"edited-header", "second"}) {
		t.Fatalf("origin X-Multi = %v, want the edited first value and the unchanged second", got)
	}
	if got := sent.Header.Get("Cookie"); got != "session=edited-cookie; session=v2" {
		t.Fatalf("origin Cookie = %q, want the edited first value and the unchanged second", got)
	}
	query, err := url.ParseQuery(sent.Query)
	if err != nil {
		t.Fatalf("parse origin query: %v", err)
	}
	if got := query["q"]; !slices.Equal(got, []string{"edited-query", "q2"}) {
		t.Fatalf("origin q = %v, want the edited first value and the unchanged second", got)
	}
}

// TestGatewayForwardsConditionalHeadersToTheOrigin pins the AWS behavior the
// S3 origin relies on: CloudFront forwards If-Match, If-None-Match,
// If-Modified-Since and If-Unmodified-Since to the origin, which evaluates
// them; a header whitelist that does not name them must not drop them.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
func TestGatewayForwardsConditionalHeadersToTheOrigin(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"origin"}},
	}, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	header := map[string]string{
		"If-Match":            `"abc123"`,
		"If-None-Match":       `"abc123"`,
		"If-Modified-Since":   "Wed, 21 Oct 2015 07:28:00 GMT",
		"If-Unmodified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
		"X-Not-Forwarded":     "dropped",
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			origin.requests = nil
			serveGateway(gateway, method, "http://viewer.example/hello.txt", "", header)
			if len(origin.requests) != 1 {
				t.Fatalf("origin calls = %d, want 1", len(origin.requests))
			}
			sent := origin.requests[0].Header
			for name, want := range header {
				if name == "X-Not-Forwarded" {
					if got := sent.Get(name); got != "" {
						t.Fatalf("%s = %q, want the policy to drop it", name, got)
					}
					continue
				}
				if got := sent.Get(name); got != want {
					t.Fatalf("%s = %q, want %q", name, got, want)
				}
			}
		})
	}
}

func intPointer(value int) *int { return &value }
