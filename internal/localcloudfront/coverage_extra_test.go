package localcloudfront

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestMatchPathPatternSemantics(t *testing.T) {
	cases := []struct {
		pattern string
		uri     string
		want    bool
	}{
		{pattern: "*", uri: "/anything", want: true},
		{pattern: "assets/*", uri: "/assets/app.js", want: true},
		{pattern: "assets/*", uri: "/assets", want: false},
		{pattern: "/assets/*", uri: "/assets/app.js", want: true},
		{pattern: "assets", uri: "/assets", want: true},
		{pattern: "Assets/*", uri: "/assets/x", want: false},
		{pattern: "assets/?", uri: "/assets/a", want: true},
		{pattern: "assets/?", uri: "/assets/ab", want: false},
		{pattern: "*.jpg", uri: "/a/b.jpg", want: true},
		{pattern: "a*b?c", uri: "/axxbxc", want: true},
	}
	for _, test := range cases {
		if got := MatchPathPattern(test.pattern, test.uri); got != test.want {
			t.Fatalf("MatchPathPattern(%q, %q) = %v, want %v", test.pattern, test.uri, got, test.want)
		}
	}
}

func TestOriginHelpers(t *testing.T) {
	if got := (OriginRequest{URI: "/x", OriginPath: "/prod"}).Path(); got != "/prod/x" {
		t.Fatalf("Path = %q", got)
	}
	if got := (OriginRequest{URI: "/x", OriginPath: "/prod/"}).Path(); got != "/prod/x" {
		t.Fatalf("Path with trailing slash = %q", got)
	}
	if got := (OriginRequest{URI: "/x"}).Path(); got != "/x" {
		t.Fatalf("Path without origin path = %q", got)
	}
	called := false
	origin := OriginFunc(func(_ context.Context, request OriginRequest) (OriginResponse, error) {
		called = request.URI == "/x"
		return OriginResponse{StatusCode: 200}, nil
	})
	if _, err := origin.Fetch(context.Background(), OriginRequest{URI: "/x"}); err != nil || !called {
		t.Fatalf("OriginFunc did not run: %v %v", called, err)
	}
	notWired := &OriginNotWiredError{OriginID: "O"}
	if !strings.Contains(notWired.Error(), "A5b") || !errors.Is(notWired, ErrOriginNotWired) {
		t.Fatalf("origin error = %v", notWired)
	}
}

func TestCookieAndQueryHelpers(t *testing.T) {
	pairs := parseCookiePairs([]string{"a=1; b=2", "", "=bad", "c"})
	if len(pairs) != 2 || pairs[0].Name != "a" || pairs[1].Name != "b" {
		t.Fatalf("pairs = %+v", pairs)
	}
	cookies := cookiesFromHeader(http.Header{"Cookie": {"a=1; a=2; b=3"}})
	if len(cookies["a"].MultiValue) != 2 || cookies["b"].Value != "3" {
		t.Fatalf("cookies = %+v", cookies)
	}
	headerValues := cookieHeaderValues(map[string]HeaderValue{
		"b": {Value: "2"},
		"a": {Value: "1", MultiValue: []HeaderValue{{Value: "1"}, {Value: "2"}}},
	})
	if strings.Join(headerValues, ",") != "a=1,a=2,b=2" {
		t.Fatalf("cookie header values = %v", headerValues)
	}
	values := valuesOf(HeaderValue{Value: "first", MultiValue: []HeaderValue{{Value: "first"}, {Value: "second"}}})
	if strings.Join(values, ",") != "first,second" {
		t.Fatalf("valuesOf = %v", values)
	}
	if got := serializeQuery(QueryString{Raw: "b=2&a=1"}); got != "b=2&a=1" {
		t.Fatalf("raw query = %q", got)
	}
	if got := serializeQuery(QueryString{Values: map[string]HeaderValue{
		"a": {Value: "1", MultiValue: []HeaderValue{{Value: "1"}, {Value: "2"}}},
	}}); got != "a=1&a=2" {
		t.Fatalf("object query = %q", got)
	}
	if got := serializeQuery(QueryString{}); got != "" {
		t.Fatalf("empty query = %q", got)
	}
	if got := queryFromRaw("a=1&a=2"); len(got.Values["a"].MultiValue) != 2 {
		t.Fatalf("queryFromRaw = %+v", got)
	}
	if got := queryFromRaw("%zz"); got.Raw != "%zz" {
		t.Fatalf("invalid query = %+v", got)
	}
	ip, address := viewerAddress("")
	if ip != "127.0.0.1" || address != "127.0.0.1" {
		t.Fatalf("viewerAddress empty = %q %q", ip, address)
	}
	ip, address = viewerAddress("203.0.113.9:1234")
	if ip != "203.0.113.9" || address != "203.0.113.9:1234" {
		t.Fatalf("viewerAddress = %q %q", ip, address)
	}
	ip, address = viewerAddress("203.0.113.9")
	if ip != "203.0.113.9" || address != "203.0.113.9" {
		t.Fatalf("viewerAddress bare = %q %q", ip, address)
	}
}

func TestQueryStringJSON(t *testing.T) {
	var object QueryString
	if err := json.Unmarshal([]byte(`{"a":{"value":"1"}}`), &object); err != nil || object.Values["a"].Value != "1" {
		t.Fatalf("object unmarshal = %+v %v", object, err)
	}
	encoded, err := json.Marshal(object)
	if err != nil || !strings.Contains(string(encoded), `"a"`) {
		t.Fatalf("object marshal = %s %v", encoded, err)
	}
	var text QueryString
	if err := json.Unmarshal([]byte(`"a=1"`), &text); err != nil || text.Raw != "a=1" {
		t.Fatalf("string unmarshal = %+v %v", text, err)
	}
	if encoded, err := json.Marshal(text); err != nil || string(encoded) != `"a=1"` {
		t.Fatalf("string marshal = %s %v", encoded, err)
	}
	if encoded, err := json.Marshal(QueryString{}); err != nil || string(encoded) != `{}` {
		t.Fatalf("empty marshal = %s %v", encoded, err)
	}
	var invalid QueryString
	if err := json.Unmarshal([]byte(`42`), &invalid); err == nil {
		t.Fatal("a number querystring must fail")
	}
}

func TestResponseBodyDecoding(t *testing.T) {
	if _, overridden, err := decodeResponseBody(nil, []byte("origin")); err != nil || overridden {
		t.Fatalf("nil body = %v %v", overridden, err)
	}
	if body, overridden, err := decodeResponseBody(&ResponseBody{Encoding: "text", Data: "text"}, nil); err != nil || !overridden || string(body) != "text" {
		t.Fatalf("text body = %q %v %v", body, overridden, err)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("bytes"))
	if body, _, err := decodeResponseBody(&ResponseBody{Encoding: "base64", Data: encoded}, nil); err != nil || string(body) != "bytes" {
		t.Fatalf("base64 body = %q %v", body, err)
	}
	if _, _, err := decodeResponseBody(&ResponseBody{Encoding: "base64", Data: "!!!"}, nil); err == nil {
		t.Fatal("invalid base64 must fail")
	}
	if _, _, err := decodeResponseBody(&ResponseBody{Encoding: "hex", Data: "00"}, nil); err == nil {
		t.Fatal("unknown encoding must fail")
	}
}

func TestResponseConversion(t *testing.T) {
	headers, cookies := splitResponseHeaders(http.Header{
		"Set-Cookie": {"a=1; Path=/", "a=2; Path=/x", "bad", "=nope"},
		"X-Test":     {"one", "two"},
	})
	if len(cookies["a"].MultiValue) != 2 || cookies["a"].Attributes != "Path=/" {
		t.Fatalf("cookies = %+v", cookies)
	}
	if values := valuesOf(headers["x-test"]); len(values) != 2 {
		t.Fatalf("header values = %v", values)
	}
	response, err := responseFromEventResponse(&EventResponse{
		StatusCode: 201,
		Headers:    map[string]HeaderValue{"x-test": {Value: "one", MultiValue: []HeaderValue{{Value: "one"}, {Value: "two"}}}},
		Cookies: map[string]CookieValue{
			"a": {Value: "1", Attributes: "Path=/", MultiValue: []CookieValue{{Value: "1", Attributes: "Path=/"}, {Value: "2"}}},
		},
		Body: &ResponseBody{Encoding: "text", Data: "body"},
	}, nil)
	if err != nil || response.StatusCode != 201 || len(response.Header.Values("Set-Cookie")) != 2 || string(response.Body) != "body" {
		t.Fatalf("response = %+v %v", response, err)
	}
	if _, err := responseFromEventResponse(nil, nil); err == nil {
		t.Fatal("nil response must fail")
	}
	if _, err := responseFromEventResponse(&EventResponse{StatusCode: 42}, nil); err == nil {
		t.Fatal("invalid status must fail")
	}
	if _, err := responseFromEventResponse(&EventResponse{StatusCode: 200, Body: &ResponseBody{Encoding: "base64", Data: "!!!"}}, nil); err == nil {
		t.Fatal("invalid body must fail")
	}
}

func TestGatewayOriginCookieAndCORS(t *testing.T) {
	origin := okOrigin("ok")
	origin.response.Header.Add("Set-Cookie", "a=1; Path=/")
	origin.response.Header.Add("Set-Cookie", "b=2")
	policy := testPolicy(PolicyResponseHeaders, nil, nil, &ResponseHeadersPolicy{
		CORS: &CORSConfig{AllowOrigins: []string{"*.example.org"}, AllowMethods: []string{"GET"}},
	})
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD", "OPTIONS"})
	behavior.ResponseHeadersPolicy = policy
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", map[string]string{
		"Origin": "https://app.example.org",
	})
	if got := recorder.Header().Values("Set-Cookie"); len(got) != 2 {
		t.Fatalf("Set-Cookie = %v", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.org" {
		t.Fatalf("allow origin = %q", got)
	}
}

func TestGatewayCORSSuppressionAndMatching(t *testing.T) {
	origin := okOrigin("ok")
	origin.response.Header.Set("Access-Control-Allow-Origin", "https://origin.example")
	policy := testPolicy(PolicyResponseHeaders, nil, nil, &ResponseHeadersPolicy{
		CORS: &CORSConfig{
			AllowOrigins:   []string{"https://app.example"},
			AllowMethods:   []string{"GET"},
			OriginOverride: false,
		},
	})
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD", "OPTIONS"})
	behavior.ResponseHeadersPolicy = policy
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", map[string]string{"Origin": "https://app.example"})
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://origin.example" {
		t.Fatalf("OriginOverride=false must keep the origin CORS header, got %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Methods"); got != "" {
		t.Fatalf("suppressed CORS policy added methods: %q", got)
	}
	for pattern, originValue := range map[string]string{
		"*":                    "https://anything.example",
		"https://app.example":  "https://app.example",
		"http://*.example.org": "http://app.example.org",
		"*.example.org":        "https://app.example.org",
	} {
		if !corsOriginMatches(pattern, originValue) {
			t.Fatalf("corsOriginMatches(%q, %q) = false", pattern, originValue)
		}
	}
	if corsOriginMatches("https://app.example", "https://app.example:8443") {
		t.Fatal("an exact CORS origin must not match a different port")
	}
}

func TestGatewayLogsAndBodyLimit(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	var logs []string
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, func(format string, args ...any) {
		logs = append(logs, format)
	})
	gateway.MaxBody = 1
	recorder := serveGateway(gateway, http.MethodPost, "http://viewer.example/x", "too large", nil)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", recorder.Code)
	}
	gateway.MaxBody = maxGatewayBody
	recorder = serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 200 || len(logs) == 0 {
		t.Fatalf("status = %d logs = %v", recorder.Code, logs)
	}
}

func TestGatewayGroupTargetAndMissingFunction(t *testing.T) {
	groupOrigin := okOrigin("group")
	distribution := testDistribution(
		&Behavior{
			PathPattern:    "*",
			TargetOriginID: "Group",
			AllowedMethods: []string{"GET", "HEAD"},
			CachePolicy:    testPolicy(PolicyCache, &CachePolicy{}, nil, nil),
		},
		nil,
		testOrigin("Origin1", "origin1.example"),
	)
	distribution.OriginGroups = []*OriginGroup{{ID: "Group", Members: []string{"Origin1"}}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"Group": groupOrigin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	request := groupOrigin.requests[0]
	if request.OriginID != "Group" || request.Host != "" || request.OriginPath != "" {
		t.Fatalf("group request = %+v", request)
	}

	missingFunction := testBehavior("*", "Origin1", []string{"GET", "HEAD"})
	missingFunction.ViewerRequestFunction = "Missing"
	distribution = testDistribution(missingFunction, nil, testOrigin("Origin1", "origin1.example"))
	gateway = NewGateway(distribution, &Topology{}, map[string]Origin{"Origin1": okOrigin("ok")}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing function status = %d", recorder.Code)
	}
}

func TestGatewayOriginError(t *testing.T) {
	origin := &recordingOrigin{err: errors.New("origin failed")}
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
}

func TestGatewayViewerRequestQueryAndCookieMutation(t *testing.T) {
	origin := okOrigin("ok")
	code := `function handler(event) {
		event.request.querystring = 'a=1&b=2';
		event.request.cookies = { session: { value: 'changed' } };
		return event.request;
	}`
	function := testFunction(runtimeJS20, code)
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = function.LogicalID
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers: HeaderForwarding{Mode: ForwardNone}, Cookies: CookieForwarding{Mode: ForwardAll}, QueryStrings: QueryForwarding{Mode: ForwardAll},
	}, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x?drop=1", "", map[string]string{"Cookie": "session=old"})
	if request := origin.requests[0]; request.Query != "a=1&b=2" || request.Header.Get("Cookie") != "session=changed" {
		t.Fatalf("mutated request = query %q cookie %q", request.Query, request.Header.Get("Cookie"))
	}
}

func TestGatewayCookieAllExcept(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, &OriginRequestPolicy{
		Headers:      HeaderForwarding{Mode: ForwardNone},
		Cookies:      CookieForwarding{Mode: ForwardAllExcept, Names: []string{"drop"}},
		QueryStrings: QueryForwarding{Mode: ForwardAllExcept, Names: []string{"secret"}},
	}, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x?keep=1&secret=2", "", map[string]string{"Cookie": "keep=1; drop=2"})
	request := origin.requests[0]
	if request.Header.Get("Cookie") != "keep=1" || request.Query != "keep=1" {
		t.Fatalf("allExcept forwarding = cookie %q query %q", request.Header.Get("Cookie"), request.Query)
	}
}

func TestParsingHelpersAndTwoDistributions(t *testing.T) {
	config := baseDistributionConfig()
	config["Comment"] = "one"
	template := Template{Stack: "TestStack", Resources: map[string]Resource{
		"ZDistribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": config})},
		"ADistribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": baseDistributionConfig()})},
	}}
	topology, err := ParseTemplates([]Template{template})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(topology.Distributions) != 2 || topology.Distributions[0].LogicalID != "ADistribution" {
		t.Fatalf("distributions = %+v", topology.Distributions)
	}
	if _, ok := topology.Distribution("ADistribution"); !ok {
		t.Fatal("Distribution lookup failed")
	}
	if _, ok := topology.Distribution("Missing"); ok {
		t.Fatal("missing distribution lookup succeeded")
	}
	if _, ok := topology.Function("Missing"); ok {
		t.Fatal("missing function lookup succeeded")
	}
	if id, attr, ok := getAtt(json.RawMessage(`"Bucket.RegionalDomainName"`)); !ok || id != "Bucket" || attr != "RegionalDomainName" {
		t.Fatalf("dotted GetAtt = %q %q %v", id, attr, ok)
	}
	if _, _, ok := getAtt(json.RawMessage(`"nodot"`)); ok {
		t.Fatal("GetAtt without a dot must fail")
	}
	if got := compactJSON(json.RawMessage(`{"a":1}`)); got != `{"a":1}` {
		t.Fatalf("compactJSON = %q", got)
	}
	if got := compactJSON(json.RawMessage(`{`)); got != `{` {
		t.Fatalf("compactJSON invalid = %q", got)
	}
	if !isEmptyValue(nil) || !isEmptyValue(json.RawMessage(`""`)) || !isEmptyValue(json.RawMessage(`[]`)) || !isEmptyValue(json.RawMessage(`{}`)) {
		t.Fatal("empty values were not detected")
	}
	if isEmptyValue(json.RawMessage(`1`)) {
		t.Fatal("a number is not empty")
	}
	if value, err := decodeIntPointer(json.RawMessage(`3`)); err != nil || *value != 3 {
		t.Fatalf("decodeIntPointer = %v %v", value, err)
	}
}

func TestParseCustomOriginAllFields(t *testing.T) {
	config := baseDistributionConfig()
	origin := mustMap(t, mustSlice(t, config["Origins"], "Origins")[0], "Origin")
	origin["CustomOriginConfig"] = map[string]any{
		"OriginProtocolPolicy":   "https-only",
		"OriginSSLProtocols":     []any{"TLSv1.2"},
		"HTTPPort":               80,
		"HTTPSPort":              443,
		"OriginKeepaliveTimeout": 5,
		"OriginReadTimeout":      30,
	}
	origin["OriginCustomHeaders"] = []any{map[string]any{"HeaderName": "X-Origin", "HeaderValue": "yes"}}
	origin["OriginPath"] = "/prod"
	distribution := parseDistributionConfig(t, config)
	parsed := distribution.Origins[0]
	if parsed.Custom == nil || *parsed.Custom.HTTPPort != 80 || *parsed.Custom.HTTPSPort != 443 ||
		*parsed.Custom.KeepaliveSeconds != 5 || *parsed.Custom.ReadTimeout != 30 || parsed.CustomHeaders["X-Origin"] != "yes" {
		t.Fatalf("custom origin = %+v", parsed.Custom)
	}
}

func TestOriginGroupMalformedShapes(t *testing.T) {
	cases := map[string]map[string]any{
		"missing id":       {"Members": []any{map[string]any{"OriginId": "Origin1"}}},
		"missing members":  {"Id": "Group"},
		"bad members":      {"Id": "Group", "Members": "not-a-list"},
		"bad failover":     {"Id": "Group", "Members": []any{map[string]any{"OriginId": "Origin1"}}, "FailoverCriteria": "bad"},
		"unknown property": {"Id": "Group", "Members": []any{map[string]any{"OriginId": "Origin1"}}, "SomethingNew": true},
	}
	for name, group := range cases {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			config["OriginGroups"] = map[string]any{"Items": []any{group}, "Quantity": 1}
			distribution := parseDistributionConfig(t, config)
			if distribution.Servable() {
				t.Fatalf("malformed group must refuse the distribution: %+v", distribution)
			}
		})
	}
}

func TestFunctionAssociationFailures(t *testing.T) {
	viewerAssociation := map[string]any{"EventType": "viewer-request", "FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}}}
	cases := map[string][]any{
		"missing ARN":      {map[string]any{"EventType": "viewer-request"}},
		"missing event":    {map[string]any{"FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}}}},
		"unknown event":    {map[string]any{"EventType": "origin-request", "FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}}}},
		"unknown property": {map[string]any{"EventType": "viewer-request", "FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}}, "Extra": 1}},
		"duplicate":        {viewerAssociation, viewerAssociation},
	}
	for name, associations := range cases {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			mustMap(t, config["DefaultCacheBehavior"], "DefaultCacheBehavior")["FunctionAssociations"] = associations
			resources := map[string]Resource{
				"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": config})},
				"ViewerFn":     {Type: typeCloudFrontFunction, Properties: mustJSON(t, map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}})},
			}
			topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: resources}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if topology.Distributions[0].Servable() {
				t.Fatalf("association must be refused: %+v", topology.Distributions[0])
			}
		})
	}
}

func TestDistributionMissingParts(t *testing.T) {
	config := baseDistributionConfig()
	delete(config, "DefaultCacheBehavior")
	if _, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: map[string]Resource{
		"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": config})},
	}}}); err == nil {
		t.Fatal("a distribution without a default behavior must fail")
	}
	config = baseDistributionConfig()
	config["Origins"] = []any{}
	distribution := parseDistributionConfig(t, config)
	if distribution.Servable() {
		t.Fatal("a distribution without origins must be refused")
	}
	config = baseDistributionConfig()
	delete(mustMap(t, config["DefaultCacheBehavior"], "DefaultCacheBehavior"), "CachePolicyId")
	distribution = parseDistributionConfig(t, config)
	if distribution.Servable() {
		t.Fatal("a behavior without a cache policy must be refused")
	}
}

func TestRuntime10Scanner(t *testing.T) {
	allowed := []string{
		`// const x = 1`,
		`/* let x = 1 */`,
		`function handler(event) { var s = "const"; return event.request; }`,
		`function handler(event) { var s = 'let'; return event.request; }`,
		`function handler(event) { var s = ` + "`async`" + `; return event.request; }`,
		`function handler(event) { var o = { constant: 1 }; return event.request; }`,
		`function handler(event) { var o = {}; o.const = 1; return event.request; }`,
	}
	for _, code := range allowed {
		if err := checkRuntime10Syntax(code); err != nil {
			t.Fatalf("false positive for %q: %v", code, err)
		}
	}
	for _, keyword := range []string{"const", "let", "async", "await"} {
		if err := checkRuntime10Syntax("function handler(event) { " + keyword + " x = 1; return event.request; }"); err == nil {
			t.Fatalf("%s was not rejected", keyword)
		}
	}
}

func TestExecutorAvailableAndManagedIDs(t *testing.T) {
	if err := NewExecutor().Available(); err != nil {
		t.Fatalf("node must be available in this test environment: %v", err)
	}
	bad := &Executor{NodePath: "apptheory-missing-node"}
	if err := bad.Available(); err == nil {
		t.Fatal("a missing node path must fail")
	}
	for _, kind := range []PolicyKind{PolicyCache, PolicyOriginRequest, PolicyResponseHeaders} {
		if len(ManagedPolicyIDs(kind)) == 0 {
			t.Fatalf("no managed %s policies", kind)
		}
	}
	if _, ok := managedPolicy("missing", PolicyCache); ok {
		t.Fatal("an unknown managed policy must fail")
	}
	if _, ok := managedPolicy("missing", "unknown"); ok {
		t.Fatal("an unknown kind must fail")
	}
}

func TestGatewayFunctionLogsAndMissingTopology(t *testing.T) {
	origin := okOrigin("ok")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.ViewerRequestFunction = "Logging"
	function := testFunction(runtimeJS20, `function handler(event) { console.log('before failure'); throw new Error('boom'); }`)
	function.LogicalID = "Logging"
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	var logs []string
	topology := &Topology{Functions: []*Function{function}, functionsByID: map[string]*Function{function.LogicalID: function}}
	gateway := NewGateway(distribution, topology, map[string]Origin{"origin": origin}, NewExecutor(), func(format string, _ ...any) {
		logs = append(logs, format)
	})
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable || len(logs) == 0 {
		t.Fatalf("status = %d logs = %v", recorder.Code, logs)
	}
	gateway = NewGateway(distribution, nil, nil, nil, nil)
	recorder = serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing topology status = %d", recorder.Code)
	}
}
