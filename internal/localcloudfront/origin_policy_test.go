package localcloudfront

import (
	"net/http"
	"testing"
)

func TestManagedOriginRequestPoliciesSuppressS3ResponseOverrides(t *testing.T) {
	suppressing := []string{
		"216adef6-5c7f-47e4-b989-5492eafa07d3",
		"33f36d7e-f396-46d9-90e0-52428a34d9dc",
		"b689b0a8-53d0-40ab-baf2-68738e2966ac",
		"775133bc-15f2-49f9-abea-afb2e0bf67d2",
	}
	for _, id := range suppressing {
		behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
		behavior.OriginRequestPolicy = &Policy{Kind: PolicyOriginRequest, ID: id, Managed: true}
		if !managedOriginRequestSuppressesS3ResponseOverrides(behavior) {
			t.Fatalf("managed origin request policy %s must suppress S3 response overrides", id)
		}
	}
	for _, id := range []string{
		"88a5eaf4-2fd4-4709-b370-b4c650ea3fcf", // CORS-S3Origin
		"bf0718e1-ba1e-49d1-88b1-f726733018ae", // HostHeaderOnly
	} {
		behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
		behavior.OriginRequestPolicy = &Policy{Kind: PolicyOriginRequest, ID: id, Managed: true}
		if managedOriginRequestSuppressesS3ResponseOverrides(behavior) {
			t.Fatalf("managed origin request policy %s must not suppress S3 response overrides", id)
		}
	}
	custom := testBehavior("*", "origin", []string{"GET", "HEAD"})
	custom.OriginRequestPolicy = &Policy{Kind: PolicyOriginRequest, ID: "Custom", OriginRequest: &OriginRequestPolicy{}}
	if managedOriginRequestSuppressesS3ResponseOverrides(custom) {
		t.Fatal("a custom origin request policy must not suppress S3 response overrides")
	}
	if managedOriginRequestSuppressesS3ResponseOverrides(nil) {
		t.Fatal("a nil behavior must not suppress S3 response overrides")
	}
}

func TestFilterS3ResponseOverridesKeepsOtherParameters(t *testing.T) {
	got := FilterS3ResponseOverrides("a=1&response-content-type=text/plain&response-content-disposition=inline&response-content-encoding=gzip&b=2")
	if got != "a=1&b=2" {
		t.Fatalf("filtered query = %q", got)
	}
	if got := FilterS3ResponseOverrides(""); got != "" {
		t.Fatalf("empty query = %q", got)
	}
}

func TestGatewaySetsTheS3SuppressionFlagAndRange(t *testing.T) {
	origin := okOrigin("origin")
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.OriginRequestPolicy = &Policy{
		Kind: PolicyOriginRequest, ID: "216adef6-5c7f-47e4-b989-5492eafa07d3", Managed: true,
		OriginRequest: &OriginRequestPolicy{QueryStrings: QueryForwarding{Mode: ForwardAll}},
	}
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x?response-content-type=text/plain&a=1", "", map[string]string{"Range": "bytes=0-3"})
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d", len(origin.requests))
	}
	request := origin.requests[0]
	if !request.SuppressS3ResponseOverrides {
		t.Fatal("the managed policy must set the S3 suppression flag")
	}
	if request.Range != "bytes=0-3" {
		t.Fatalf("Range = %q", request.Range)
	}
}
