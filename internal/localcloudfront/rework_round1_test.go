package localcloudfront

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Round-1 rework tests for the LOCAL-W2-R5b/R5c delta.

func reworkGateway(
	t *testing.T,
	associations map[string]*EdgeFunction,
	originPolicy *OriginRequestPolicy,
) (*Gateway, *recordingOrigin, *recordingInvoker) {
	t.Helper()
	behavior := testBehavior("*", "origin", []string{http.MethodGet, http.MethodHead, http.MethodPost})
	behavior.CachePolicy = testPolicy(PolicyCache, &CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, nil, nil)
	if originPolicy != nil {
		behavior.OriginRequestPolicy = testPolicy(PolicyOriginRequest, nil, originPolicy, nil)
	}
	behavior.EdgeLambdas = associations
	origin := okOrigin("origin body")
	gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	invoker := newRecordingInvoker()
	invoker.responder = func(string, map[string]any) any { return nil }
	gateway.EdgeInvoker = invoker
	return gateway, origin, invoker
}

func eventRequest(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	return mapField(t, cfOf(t, event)["request"], "request")
}

func mapField(t *testing.T, value any, name string) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object: %T", name, value)
	}
	return object
}

func eventConfig(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	return mapField(t, cfOf(t, event)["config"], "config")
}

func eventHeaders(request map[string]any) map[string]any {
	headers, ok := request["headers"].(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return headers
}

func edgeHeaderValue(t *testing.T, headers map[string]any, name string) string {
	t.Helper()
	entries, ok := headers[name].([]any)
	if !ok || len(entries) == 0 {
		return ""
	}
	return fmt.Sprint(mapField(t, entries[0], name)["value"])
}

func echoEdgeFunction(t *testing.T) func(string, map[string]any) any {
	return func(_ string, event map[string]any) any {
		cf := cfOf(t, event)
		eventType := fmt.Sprint(eventConfig(t, event)["eventType"])
		if eventType == edgeOriginResponse || eventType == edgeViewerResponse {
			return cf["response"]
		}
		return cf["request"]
	}
}

// F-R5b-R0-2: an origin request function may add CloudFront-Viewer-Country; a
// viewer request function that adds it is a 502.
func TestOriginRequestFunctionMayReturnViewerCountry(t *testing.T) {
	policy := &OriginRequestPolicy{Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"cloudfront-viewer-country"}}}
	gateway, origin, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeOriginRequest: {EventType: edgeOriginRequest, Version: "Version1"},
	}, policy)
	gateway.ViewerCountry = "US"
	seen := ""
	invoker.responder = func(_ string, event map[string]any) any {
		seen = edgeHeaderValue(t, eventHeaders(eventRequest(t, event)), "cloudfront-viewer-country")
		return echoEdgeFunction(t)("", event)
	}
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if seen != "US" {
		t.Fatalf("the origin event did not expose CloudFront-Viewer-Country: %q", seen)
	}
	if got := origin.requests[0].Header.Get("CloudFront-Viewer-Country"); got != "US" {
		t.Fatalf("the origin received CloudFront-Viewer-Country %q, want US", got)
	}
}

func TestViewerRequestFunctionCannotAddViewerCountry(t *testing.T) {
	gateway, _, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeViewerRequest: {EventType: edgeViewerRequest, Version: "Version1"},
	}, nil)
	invoker.responder = func(_ string, event map[string]any) any {
		request := eventRequest(t, event)
		eventHeaders(request)["cloudfront-viewer-country"] = []any{
			map[string]any{"key": "CloudFront-Viewer-Country", "value": "US"},
		}
		return request
	}
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "CloudFront-Viewer-Country") {
		t.Fatalf("the 502 does not name the header: %s", recorder.Body.String())
	}
}

// F-R5b-R0-3: the origin event is the policy-filtered origin request, and a
// returned request never widens it back to the viewer headers.
func TestOriginRequestEventUsesThePolicyFilteredRequest(t *testing.T) {
	policy := &OriginRequestPolicy{Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-allowed"}}}
	gateway, origin, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeOriginRequest: {EventType: edgeOriginRequest, Version: "Version1"},
	}, policy)
	var seenHeaders map[string]any
	var seenQuery string
	invoker.responder = func(_ string, event map[string]any) any {
		request := eventRequest(t, event)
		seenHeaders = eventHeaders(request)
		if query, ok := request["querystring"].(string); ok {
			seenQuery = query
		}
		return echoEdgeFunction(t)("", event)
	}
	headers := map[string]string{"X-Allowed": "yes", "X-Viewer-Secret": "no"}
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x?secret=1", "", headers)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if _, ok := seenHeaders["x-allowed"]; !ok {
		t.Fatalf("the origin event lost the whitelisted header: %v", seenHeaders)
	}
	if _, ok := seenHeaders["x-viewer-secret"]; ok {
		t.Fatalf("the origin event exposed a header the policy does not forward: %v", seenHeaders)
	}
	if seenQuery != "" {
		t.Fatalf("the origin event querystring = %q, want empty under QueryStringBehavior none", seenQuery)
	}
	if got := origin.requests[0].Header.Get("X-Viewer-Secret"); got != "" {
		t.Fatalf("the origin received X-Viewer-Secret %q", got)
	}
	if got := origin.requests[0].Query; got != "" {
		t.Fatalf("the origin query = %q, want empty", got)
	}
}

func TestOriginRequestEventCarriesPolicyCloudFrontHeaders(t *testing.T) {
	policy := &OriginRequestPolicy{Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"cloudfront-forwarded-proto"}}}
	gateway, _, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeOriginRequest: {EventType: edgeOriginRequest, Version: "Version1"},
	}, policy)
	var seenHeaders map[string]any
	invoker.responder = func(_ string, event map[string]any) any {
		seenHeaders = eventHeaders(eventRequest(t, event))
		return echoEdgeFunction(t)("", event)
	}
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if got := edgeHeaderValue(t, seenHeaders, "cloudfront-forwarded-proto"); got != "http" {
		t.Fatalf("cloudfront-forwarded-proto = %q, want http", got)
	}
}

// S-R5b-R0-2: the origin object lives inside request.
func TestOriginEventNestsOriginInsideRequest(t *testing.T) {
	gateway, _ := edgeGateway(t, map[string]string{"origin-request": "Function"})
	association := &EdgeFunction{EventType: edgeOriginRequest, Version: "Version0"}
	s3Origin := &DistributionOrigin{
		ID: "Origin", DomainName: "bucket.s3.local", Kind: OriginS3, OriginPath: "/assets",
		S3: &S3Origin{OriginAccessIdentity: "OAI"},
	}
	event := gateway.edgeOriginEvent(association, OriginRequest{Method: http.MethodGet, URI: "/x"}, s3Origin, "r", "d", nil)
	if _, ok := cfOf(t, eventToMap(t, event))["origin"]; ok {
		t.Fatal("cf must not carry the origin object")
	}
	request := eventRequest(t, eventToMap(t, event))
	origin, ok := request["origin"].(map[string]any)
	if !ok {
		t.Fatalf("request has no origin object: %v", request)
	}
	s3, ok := origin["s3"].(map[string]any)
	if !ok {
		t.Fatalf("origin has no s3 object: %v", origin)
	}
	if s3["authMethod"] != "origin-access-identity" || s3["region"] != "us-east-1" ||
		s3["domainName"] != "bucket.s3.local" || s3["path"] != "/assets" {
		t.Fatalf("s3 origin = %v", s3)
	}

	customOrigin := &DistributionOrigin{
		ID: "Origin", DomainName: "api.example.com", Kind: OriginCustom, OriginPath: "/v1",
		Custom: &CustomOrigin{ProtocolPolicy: valueHTTPSOnly, ReadTimeout: intPointer(30), KeepaliveSeconds: intPointer(5)},
	}
	event = gateway.edgeOriginEvent(association, OriginRequest{Method: http.MethodGet, URI: "/x"}, customOrigin, "r", "d", nil)
	origin = mapField(t, eventRequest(t, eventToMap(t, event))["origin"], "origin")
	custom := mapField(t, origin["custom"], "custom")
	if custom["domainName"] != "api.example.com" || custom["path"] != "/v1" ||
		custom["port"] != float64(443) || custom["protocol"] != valueHTTPS ||
		custom["readTimeout"] != float64(30) || custom["keepaliveTimeout"] != float64(5) {
		t.Fatalf("custom origin = %v", custom)
	}
}

func eventToMap(t *testing.T, event *EdgeEvent) map[string]any {
	t.Helper()
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("encode event: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	return decoded
}

// S-R5b-R0-1: the status is documented as a string and the event carries it as
// one; a numeric status is still accepted from a handler.
func TestEdgeResponseStatusStringAndNumber(t *testing.T) {
	association := &EdgeFunction{Version: "v", EventType: edgeViewerRequest}
	for name, raw := range map[string]string{
		"string": `{"status":"201","headers":{}}`,
		"number": `{"status":201,"headers":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			outcome, err := decodeEdgeResponse(association, nil, []byte(raw))
			if err != nil || outcome.Response == nil || int(outcome.Response.Status) != 201 {
				t.Fatalf("%s status = %+v (%v)", name, outcome, err)
			}
		})
	}
	if _, err := decodeEdgeResponse(association, nil, []byte(`{"status":"not-a-status","headers":{}}`)); err == nil {
		t.Fatal("a non-numeric status string must be refused")
	}
	gateway, _ := edgeGateway(t, nil)
	state := newRequestState(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://d111.cloudfront.local/x", nil), nil)
	event := gateway.edgeEvent(&EdgeFunction{EventType: edgeViewerResponse}, state, "r", "d", &OriginResponse{
		StatusCode: 200, StatusDescription: "OK", Header: http.Header{}, Body: []byte("body"),
	})
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !strings.Contains(string(encoded), `"status":"200"`) {
		t.Fatalf("the response event must carry the string status: %s", encoded)
	}
}

// A-R5b-1: a flat bodyEncoding beside a string body selects text or base64.
func TestEdgeGeneratedResponseBodyEncoding(t *testing.T) {
	gateway := &Gateway{}
	association := &EdgeFunction{Version: "v", EventType: edgeViewerRequest}
	outcome, err := decodeEdgeResponse(association, nil, []byte(`{"status":"200","body":"aGVsbG8=","bodyEncoding":"base64"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	response, err := gateway.edgeGeneratedResponse(association, outcome.Response, nil)
	if err != nil {
		t.Fatalf("generated response: %v", err)
	}
	if string(response.Body) != "hello" {
		t.Fatalf("body = %q, want hello", response.Body)
	}

	outcome, err = decodeEdgeResponse(association, nil, []byte(`{"status":"200","body":"not base64!","bodyEncoding":"base64"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, err := gateway.edgeGeneratedResponse(association, outcome.Response, nil); err == nil ||
		!strings.Contains(err.Error(), "not valid base64") {
		t.Fatalf("an invalid base64 body must be a 502: %v", err)
	}
	if _, err := decodeEdgeResponse(association, nil, []byte(`{"status":"200","body":"x","bodyEncoding":"gzip"}`)); err == nil {
		t.Fatal("an unknown bodyEncoding must be refused")
	}
}

// F-R5b-R0-6: per-event read-only headers and disallowed headers are a named
// 502.
func TestEdgeDisallowedAndReadOnlyHeaders(t *testing.T) {
	requestEvent := func(eventType string) *EdgeEvent {
		return &EdgeEvent{Records: []EdgeRecord{{CF: EdgeCF{
			Config: EdgeConfig{EventType: eventType},
			Request: &EdgeRequest{Method: http.MethodGet, URI: "/x", Headers: map[string][]EdgeHeader{
				"host": {{Key: "Host", Value: "origin.example"}},
			}},
		}}}}
	}
	responseEvent := func(eventType string) *EdgeEvent {
		return &EdgeEvent{Records: []EdgeRecord{{CF: EdgeCF{
			Config: EdgeConfig{EventType: eventType},
			Response: &EdgeResponse{Status: 200, Headers: map[string][]EdgeHeader{
				"via": {{Key: "Via", Value: "1.1 local"}},
			}},
		}}}}
	}
	cases := []struct {
		eventType  string
		readOnly   string
		disallowed string
	}{
		{edgeViewerRequest, "via", "x-cache"},
		{edgeOriginRequest, "accept-encoding", "x-amzn-requestid"},
		{edgeOriginResponse, "via", "x-cache"},
		{edgeViewerResponse, "warning", "connection"},
	}
	for _, test := range cases {
		t.Run(test.eventType+" read-only", func(t *testing.T) {
			association := &EdgeFunction{Version: "v", EventType: test.eventType}
			var err error
			if test.eventType == edgeViewerRequest || test.eventType == edgeOriginRequest {
				event := requestEvent(test.eventType)
				request := &EdgeRequest{Method: http.MethodGet, URI: "/x", Headers: map[string][]EdgeHeader{
					"host":        {{Key: "Host", Value: "origin.example"}},
					test.readOnly: {{Key: http.CanonicalHeaderKey(test.readOnly), Value: "changed"}},
				}}
				_, err = validateEdgeRequestObject(association, event, request)
			} else {
				event := responseEvent(test.eventType)
				response := &EdgeResponse{Status: 200, Headers: map[string][]EdgeHeader{
					"via":         {{Key: "Via", Value: "1.1 local"}},
					test.readOnly: {{Key: http.CanonicalHeaderKey(test.readOnly), Value: "changed"}},
				}}
				err = validateEdgeResponseObject(association, event, response)
			}
			if err == nil || !strings.Contains(err.Error(), http.CanonicalHeaderKey(test.readOnly)) ||
				!strings.Contains(err.Error(), "edge-function-restrictions-all.html") {
				t.Fatalf("read-only %s = %v", test.readOnly, err)
			}
		})
		t.Run(test.eventType+" disallowed", func(t *testing.T) {
			association := &EdgeFunction{Version: "v", EventType: test.eventType}
			var err error
			if test.eventType == edgeViewerRequest || test.eventType == edgeOriginRequest {
				request := &EdgeRequest{Method: http.MethodGet, URI: "/x", Headers: map[string][]EdgeHeader{
					test.disallowed: {{Key: http.CanonicalHeaderKey(test.disallowed), Value: "x"}},
				}}
				_, err = validateEdgeRequestObject(association, requestEvent(test.eventType), request)
			} else {
				response := &EdgeResponse{Status: 200, Headers: map[string][]EdgeHeader{
					test.disallowed: {{Key: http.CanonicalHeaderKey(test.disallowed), Value: "x"}},
				}}
				err = validateEdgeResponseObject(association, responseEvent(test.eventType), response)
			}
			if err == nil || !strings.Contains(err.Error(), http.CanonicalHeaderKey(test.disallowed)) ||
				!strings.Contains(err.Error(), "edge-function-restrictions-all.html") {
				t.Fatalf("disallowed %s = %v", test.disallowed, err)
			}
		})
	}

	// Host is writable in an origin request and read-only in a viewer request.
	viewerEvent := requestEvent(edgeViewerRequest)
	viewer := &EdgeRequest{Method: http.MethodGet, URI: "/x", Headers: map[string][]EdgeHeader{
		"host": {{Key: "Host", Value: "other.example"}},
	}}
	if _, err := validateEdgeRequestObject(&EdgeFunction{Version: "v", EventType: edgeViewerRequest}, viewerEvent, viewer); err == nil ||
		!strings.Contains(err.Error(), "Host") {
		t.Fatalf("a viewer request changing Host = %v", err)
	}
	originEvent := requestEvent(edgeOriginRequest)
	origin := &EdgeRequest{Method: http.MethodGet, URI: "/x", Headers: map[string][]EdgeHeader{
		"host": {{Key: "Host", Value: "other.example"}},
	}}
	if _, err := validateEdgeRequestObject(&EdgeFunction{Version: "v", EventType: edgeOriginRequest}, originEvent, origin); err != nil {
		t.Fatalf("an origin request may change Host: %v", err)
	}
}

// F-R5b-R0-5: a CloudFront Function and a Lambda@Edge function cannot share a
// viewer event.
func TestCloudFrontFunctionAndLambdaEdgeViewerEventIsRefused(t *testing.T) {
	distributionConfig := func(functionEvent, lambdaEvent string) map[string]any {
		return map[string]any{"DistributionConfig": map[string]any{
			"Enabled": true,
			"DefaultCacheBehavior": map[string]any{
				"PathPattern":    "*",
				"TargetOriginId": "Origin",
				"CachePolicyId":  "658327ea-f89d-4fab-a63d-7e88639e58f6",
				"FunctionAssociations": []any{map[string]any{
					"EventType": functionEvent, "FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}},
				}},
				"LambdaFunctionAssociations": []any{map[string]any{
					"EventType": lambdaEvent, "LambdaFunctionARN": map[string]any{"Ref": "Version"},
				}},
			},
			"Origins": []any{map[string]any{
				"Id": "Origin", "DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
			}},
		}}
	}
	resources := func(functionEvent, lambdaEvent string) map[string]Resource {
		return map[string]Resource{
			"Function": {Type: typeLambdaFunction, Properties: mustJSON2(map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"})},
			"Version":  {Type: typeLambdaVersion, Properties: mustJSON2(map[string]any{"FunctionName": map[string]any{"Ref": "Function"}})},
			"ViewerFn": {Type: typeCloudFrontFunction, Properties: mustJSON2(map[string]any{
				"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20},
			})},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distributionConfig(functionEvent, lambdaEvent))},
		}
	}
	topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: resources("viewer-request", "viewer-request")}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	refusals := strings.Join(topology.Distributions[0].Refusals, "\n")
	for _, needle := range []string{
		"You can't combine CloudFront Functions and Lambda@Edge in viewer events",
		"viewer-request", "ViewerFn", "Version",
		"https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html",
	} {
		if !strings.Contains(refusals, needle) {
			t.Fatalf("refusals do not contain %q: %v", needle, refusals)
		}
	}
	if topology.Distributions[0].Servable() {
		t.Fatal("the distribution must be refused")
	}

	// The page's allowed table: a CloudFront Function viewer request plus a
	// Lambda@Edge origin request.
	topology, err = ParseTemplates([]Template{{Stack: "TestStack", Resources: resources("viewer-request", "origin-request")}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !topology.Distributions[0].Servable() {
		t.Fatalf("the allowed combination must be served: %v", topology.Distributions[0].Refusals)
	}
}

// A-R5b-res: the remaining Lambda-feature restrictions are refused by name.
func TestLambdaEdgeFeatureRestrictions(t *testing.T) {
	version := map[string]any{"FunctionName": map[string]any{"Ref": "Function"}}
	associations := []any{map[string]any{"EventType": "viewer-request", "LambdaFunctionARN": map[string]any{"Ref": "Version"}}}
	cases := []struct {
		name   string
		props  map[string]any
		needle string
	}{
		{"runtime management", map[string]any{"Runtime": "nodejs24.x", "RuntimeManagementConfig": map[string]any{
			"UpdateRuntimeOn": "Manual", "RuntimeVersionArn": "arn:aws:lambda:us-east-1:1:runtime:1",
		}}, "Auto"},
		{"x-ray", map[string]any{"Runtime": "nodejs24.x", "TracingConfig": map[string]any{"Mode": "Active"}}, "X-Ray"},
		{"customer key", map[string]any{"Runtime": "nodejs24.x", "KmsKeyArn": "arn:aws:kms:us-east-1:1:key/1"}, "KmsKeyArn"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates(edgeTemplate(test.props, version, associations))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if topology.Distributions[0].Servable() {
				t.Fatalf("%s must be refused", test.name)
			}
			if !strings.Contains(strings.Join(topology.Distributions[0].Refusals, "\n"), test.needle) {
				t.Fatalf("%s: refusals %v do not name %q", test.name, topology.Distributions[0].Refusals, test.needle)
			}
		})
	}
}

// A-R5b-res: the base64 limit applies to the encoded body.
func TestBase64BodyLimitUsesEncodedLength(t *testing.T) {
	decoded := make([]byte, 40_000)
	encoded := base64.StdEncoding.EncodeToString(decoded)
	if len(encoded) <= edgeViewerB64Limit {
		t.Fatalf("the fixture must exceed the encoded limit: %d", len(encoded))
	}
	association := &EdgeFunction{Version: "v", EventType: edgeViewerRequest}
	gateway := &Gateway{}
	_, err := gateway.edgeGeneratedResponse(association, &EdgeResponse{
		Status: 200,
		Body:   &EdgeBody{Action: valueReplace, Encoding: valueBase64, Data: encoded},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "encoded bytes") {
		t.Fatalf("an encoded body over 53,200 bytes must be a 502: %v", err)
	}
}

// S-R5b-R0-res4: a stale-while-revalidate refresh runs the origin-request and
// origin-response functions like a miss.
func TestStaleWhileRevalidateRunsOriginEdgeFunctions(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gateway, _, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeOriginRequest:  {EventType: edgeOriginRequest, Version: "Version1"},
		edgeOriginResponse: {EventType: edgeOriginResponse, Version: "Version2"},
	}, nil)
	origin, ok := gateway.Origins["origin"].(*recordingOrigin)
	if !ok {
		t.Fatalf("the gateway origin is %T", gateway.Origins["origin"])
	}
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10, stale-while-revalidate=60"}}
	invoker.responder = echoEdgeFunction(t)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if invoker.calls["Version1"] != 1 || invoker.calls["Version2"] != 1 {
		t.Fatalf("the miss must run each function once: %v", invoker.calls)
	}
	now = now.Add(20 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Header().Get("x-cache") != cacheHitHeader || recorder.Body.String() != "origin body" {
		t.Fatalf("stale response = %q %q", recorder.Header().Get("x-cache"), recorder.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if invoker.calls["Version1"] >= 2 && invoker.calls["Version2"] >= 2 && len(origin.requests) >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if invoker.calls["Version1"] != 2 || invoker.calls["Version2"] != 2 {
		t.Fatalf("the refresh must run each function once: %v", invoker.calls)
	}
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d", len(origin.requests))
	}
}

// A-R5b-res: a fle-profile argument without a QueryArgProfileConfig is reported
// by name in the request log, and the distribution report names it too.
func TestFLEProfileArgumentWithoutQueryArgProfileConfigIsReported(t *testing.T) {
	_, pemText := testRSAKey(t)
	distribution := map[string]any{"DistributionConfig": map[string]any{
		"Enabled": true,
		"DefaultCacheBehavior": map[string]any{
			"PathPattern":            "*",
			"TargetOriginId":         "Origin",
			"CachePolicyId":          "658327ea-f89d-4fab-a63d-7e88639e58f6",
			"AllowedMethods":         []any{"GET", "HEAD", "POST"},
			"FieldLevelEncryptionId": map[string]any{"Ref": "FLE"},
		},
		"Origins": []any{map[string]any{
			"Id": "Origin", "DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
		}},
	}}
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Key": {Type: typePublicKey, Properties: mustJSON2(map[string]any{"PublicKeyConfig": map[string]any{
				"CallerReference": "r", "Name": "key", "EncodedKey": pemText,
			}})},
			"Profile": {Type: typeFLEProfile, Properties: mustJSON2(map[string]any{"FieldLevelEncryptionProfileConfig": map[string]any{
				"Name": "p", "CallerReference": "r",
				"EncryptionEntities": []any{map[string]any{
					"PublicKeyId": map[string]any{"Ref": "Key"}, "ProviderId": "DEMO", "FieldPatterns": []any{"card"},
				}},
			}})},
			"FLE": {Type: typeFLEConfig, Properties: mustJSON2(map[string]any{
				"CallerReference": "r",
				"ContentTypeProfileConfig": map[string]any{
					"ContentTypeProfiles": []any{map[string]any{
						"ContentType": formContentType, "Format": "URLEncoded", "ProfileId": map[string]any{"Ref": "Profile"},
					}},
				},
			})},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distribution)},
		},
	}})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !strings.Contains(strings.Join(topology.Distributions[0].Reported, "\n"), "has no QueryArgProfileConfig") {
		t.Fatalf("the plan does not report the ignored fle-profile argument: %v", topology.Distributions[0].Reported)
	}

	var logs []string
	origin := okOrigin("ok")
	gateway := NewGateway(topology.Distributions[0], topology, map[string]Origin{"Origin": origin}, nil, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"http://d111.cloudfront.local/pay?fle-profile=alt", strings.NewReader("card=4111111111111111"))
	request.Header.Set("Content-Type", formContentType)
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(strings.Join(logs, "\n"), "fle-profile \"alt\" is ignored") {
		t.Fatalf("the request log does not report the ignored argument: %v", logs)
	}
}
