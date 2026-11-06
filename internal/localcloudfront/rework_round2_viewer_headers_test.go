package localcloudfront

import (
	"net/http"
	"strings"
	"testing"
)

// Round-2 rework tests for the viewer-request CloudFront header rule.

// F-R5b-R1-1: "If the viewer request includes headers that have these names,
// and you configured CloudFront to add these headers using a cache policy or
// origin request policy, then CloudFront overwrites the header values that were
// in the viewer request. Viewer-facing functions see the header value from the
// viewer request, while origin-facing functions see the header value that
// CloudFront added."
func TestViewerSuppliedCloudFrontHeaderWithPassThroughFunctionIsServed(t *testing.T) {
	gateway, _, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeViewerRequest: {EventType: edgeViewerRequest, Version: "Version1"},
	}, nil)
	invoker.responder = echoEdgeFunction(t)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "",
		map[string]string{"CloudFront-Viewer-Country": "ZZ"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("a viewer-supplied CloudFront header passed through is a 200, got %d: %s",
			recorder.Code, recorder.Body.String())
	}
}

// F-R5b-R1-1: a CloudFront-* header absent from the received request is still
// an addition: "If a viewer request function adds the CloudFront-Viewer-Country
// header, it fails validation and CloudFront returns HTTP status code 502 (Bad
// Gateway) to the viewer."
func TestViewerRequestFunctionStillCannotAddAbsentCloudFrontHeader(t *testing.T) {
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
	if body := recorder.Body.String(); !strings.Contains(body, "CloudFront-Viewer-Country") || !strings.Contains(body, "cannot add") {
		t.Fatalf("the 502 does not name the added header: %s", body)
	}
}

// F-R5b-R1-1: with --viewer-country US, a policy that forwards the header, and
// a viewer that sent ZZ, the viewer-request function sees ZZ while the
// origin-request event and the origin see US.
func TestViewerCountryIsOverwrittenForOriginFacingFunctions(t *testing.T) {
	policy := &OriginRequestPolicy{Headers: HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"cloudfront-viewer-country"}}}
	gateway, origin, invoker := reworkGateway(t, map[string]*EdgeFunction{
		edgeViewerRequest: {EventType: edgeViewerRequest, Version: "ViewerVersion"},
		edgeOriginRequest: {EventType: edgeOriginRequest, Version: "OriginVersion"},
	}, policy)
	gateway.ViewerCountry = "US"
	seenByViewer, seenByOrigin := "", ""
	invoker.responder = func(version string, event map[string]any) any {
		switch version {
		case "ViewerVersion":
			seenByViewer = edgeHeaderValue(t, eventHeaders(eventRequest(t, event)), "cloudfront-viewer-country")
		case "OriginVersion":
			seenByOrigin = edgeHeaderValue(t, eventHeaders(eventRequest(t, event)), "cloudfront-viewer-country")
		}
		return echoEdgeFunction(t)("", event)
	}
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "",
		map[string]string{"CloudFront-Viewer-Country": "ZZ"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if seenByViewer != "ZZ" {
		t.Fatalf("the viewer-request event saw CloudFront-Viewer-Country %q, want the viewer's ZZ", seenByViewer)
	}
	if seenByOrigin != "US" {
		t.Fatalf("the origin-request event saw CloudFront-Viewer-Country %q, want the policy's US", seenByOrigin)
	}
	if got := origin.requests[0].Header.Get("CloudFront-Viewer-Country"); got != "US" {
		t.Fatalf("the origin received CloudFront-Viewer-Country %q, want US", got)
	}
}
