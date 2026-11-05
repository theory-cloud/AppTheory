package localcloudfront

import (
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// Round-2 rework tests for the stale-while-revalidate refresh.

// S-R1-res-1: a refresh follows a rewritten origin exactly like a miss; Host
// follows the target's domain unless the function changed Host.
func TestStaleWhileRevalidateRefreshFollowsRewrittenOriginHost(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	behavior := testBehavior("*", "origin", []string{http.MethodGet, http.MethodHead})
	behavior.CachePolicy = testPolicy(PolicyCache, &CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, nil, nil)
	behavior.EdgeLambdas = map[string]*EdgeFunction{
		edgeOriginRequest: {EventType: edgeOriginRequest, Version: "Version1"},
	}
	first := okOrigin("first body")
	first.response.Header = http.Header{"cache-control": []string{"max-age=10, stale-while-revalidate=60"}}
	second := okOrigin("second body")
	gateway := NewGateway(
		testDistribution(behavior, nil,
			testOrigin("origin", "origin.example"),
			testOrigin("second", "second.example")),
		&Topology{},
		map[string]Origin{"origin": first, "second": second},
		nil, nil)
	var calls atomic.Int64
	invoker := newRecordingInvoker()
	invoker.responder = func(_ string, event map[string]any) any {
		records, ok := event["Records"].([]any)
		if !ok || len(records) == 0 {
			return nil
		}
		record, ok := records[0].(map[string]any)
		if !ok {
			return nil
		}
		cf, ok := record["cf"].(map[string]any)
		if !ok {
			return nil
		}
		request, ok := cf["request"].(map[string]any)
		if !ok {
			return nil
		}
		if calls.Add(1) == 1 {
			// The miss forwards the declared origin unchanged.
			return request
		}
		// The refresh rewrites the origin and leaves Host untouched.
		request["origin"] = map[string]any{"custom": map[string]any{
			"domainName": "second.example", "path": "/", "port": 80, "protocol": "http",
		}}
		return request
	}
	gateway.EdgeInvoker = invoker
	gateway.Now = func() time.Time { return now }

	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(first.requests) != 1 || first.requests[0].Host != "origin.example" {
		t.Fatalf("the miss must fetch the declared origin: %+v", first.requests)
	}
	now = now.Add(20 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("the stale entry was not served: %q", recorder.Header().Get("x-cache"))
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(second.requests) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if len(second.requests) != 1 {
		t.Fatalf("the refresh must fetch the rewritten origin once, got %d", len(second.requests))
	}
	refreshed := second.requests[0]
	if refreshed.OriginID != "second" {
		t.Fatalf("the refresh sent origin %q, want second", refreshed.OriginID)
	}
	if refreshed.Host != "second.example" {
		t.Fatalf("the refresh sent Host %q, want the target domain second.example", refreshed.Host)
	}
}
