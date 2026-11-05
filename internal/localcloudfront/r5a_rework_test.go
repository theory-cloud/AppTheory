package localcloudfront

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The HTTPStatusCodes page's error caching rules:
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html

func TestErrorCachingFollowsTheStatusTable(t *testing.T) {
	for _, status := range []int{401, 403, 429} {
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		origin := &recordingOrigin{response: OriginResponse{StatusCode: status, Header: http.Header{}, Body: []byte("err")}}
		gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
		gateway.Now = func() time.Time { return now }
		serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		now = now.Add(2 * time.Second)
		second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if len(origin.requests) != 2 {
			t.Errorf("status %d without Cache-Control was cached (x-cache %q); the page does not cache it",
				status, second.Header().Get("x-cache"))
		}
	}
}

func TestErrorCachingStatusLists(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		header     http.Header
		within     time.Duration
		expired    time.Duration
		wantCached bool
	}{
		{name: "404 cached without Cache-Control", status: 404, header: http.Header{}, within: 5 * time.Second, expired: 11 * time.Second, wantCached: true},
		{name: "403 cached only with max-age", status: 403, header: http.Header{"cache-control": []string{"max-age=30"}}, within: 11 * time.Second, expired: 31 * time.Second, wantCached: true},
		{name: "403 max-age shorter than the error TTL", status: 403, header: http.Header{"cache-control": []string{"max-age=5"}}, within: 6 * time.Second, expired: 11 * time.Second, wantCached: true},
		{name: "401 never cached even with max-age", status: 401, header: http.Header{"cache-control": []string{"max-age=60"}}, wantCached: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			origin := &recordingOrigin{response: OriginResponse{StatusCode: testCase.status, Header: testCase.header, Body: []byte("err")}}
			gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
				&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
			gateway.Now = func() time.Time { return now }
			serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
			if !testCase.wantCached {
				now = now.Add(2 * time.Second)
				serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
				if len(origin.requests) != 2 {
					t.Fatalf("status %d was cached", testCase.status)
				}
				return
			}
			now = now.Add(testCase.within)
			if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Header().Get("x-cache") != cacheHitHeader {
				t.Fatalf("status %d within the TTL = %q", testCase.status, recorder.Header().Get("x-cache"))
			}
			now = now.Add(testCase.expired - testCase.within)
			if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Header().Get("x-cache") != cacheMissHeader {
				t.Fatalf("status %d after the TTL = %q", testCase.status, recorder.Header().Get("x-cache"))
			}
		})
	}
}

func TestErrorCachingUsesTheMaximumOfTheErrorTTLAndMaxAge(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := &recordingOrigin{response: OriginResponse{
		StatusCode: 404,
		Header:     http.Header{"Cache-Control": []string{"max-age=30"}},
		Body:       []byte("missing"),
	}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(11 * time.Second)
	if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("max-age=30 must outlast the 10 second error TTL: %q", recorder.Header().Get("x-cache"))
	}
	now = now.Add(20 * time.Second)
	if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("after max-age the error must expire: %q", recorder.Header().Get("x-cache"))
	}
}

func TestCachingDisabledNeverCachesErrorsOrCustomPages(t *testing.T) {
	policy := cachePolicy(60, 3600, 0)
	policy.CachingDisabled = true
	distribution := testDistribution(cachedBehavior(policy), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode: 404, ResponsePagePath: "/errors/404.html", ResponseCode: 200,
	}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": &pagesOrigin{}}, nil, nil)
	for index := 0; index < 2; index++ {
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Header().Get("x-cache") != cacheMissHeader || recorder.Body.String() != "page" {
			t.Fatalf("request %d = %q %q", index, recorder.Header().Get("x-cache"), recorder.Body.String())
		}
	}
	if gateway.Cache.Len() != 0 {
		t.Fatalf("CachingDisabled cached an error page: entries=%d", gateway.Cache.Len())
	}
}

// F-R5a-2: the custom error page is fetched through the cache behavior whose
// path pattern matches the page path, from that behavior's origin.
func TestCustomErrorPageComesFromTheMatchingBehaviorOrigin(t *testing.T) {
	api := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		return OriginResponse{StatusCode: 500, Header: http.Header{}, Body: []byte("api failed")}
	}}
	pages := &captureOrigin{respond: func(request OriginRequest) OriginResponse {
		if request.URI == "/errors/500.html" {
			return OriginResponse{StatusCode: 200, Header: http.Header{"content-type": []string{"text/html"}}, Body: []byte("custom page")}
		}
		return OriginResponse{StatusCode: 404, Body: []byte("no such page")}
	}}
	errorsBehavior := testBehavior("/errors/*", "pages", []string{"GET", "HEAD"})
	errorsBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	defaultBehavior := testBehavior("*", "api", []string{"GET", "HEAD"})
	defaultBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	distribution := testDistribution(defaultBehavior, []*Behavior{errorsBehavior},
		testOrigin("api", "api.example"), testOrigin("pages", "pages.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 503, ErrorCachingMinTTL: intPointer(30)}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"api": api, "pages": pages}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if recorder.Code != 503 || recorder.Body.String() != "custom page" {
		t.Fatalf("custom page = %d %q", recorder.Code, recorder.Body.String())
	}
	if len(api.requests) != 1 || api.requests[0].URI != "/data" {
		t.Fatalf("API origin requests = %+v", api.requests)
	}
	if len(pages.requests) != 1 || pages.requests[0].URI != "/errors/500.html" {
		t.Fatalf("pages origin requests = %+v", pages.requests)
	}
	if pages.requests[0].OriginID != "pages" {
		t.Fatalf("page request origin = %q", pages.requests[0].OriginID)
	}
}

func TestCustomErrorPageFallsBackToTheDefaultBehaviorOrigin(t *testing.T) {
	origin := &captureOrigin{respond: func(request OriginRequest) OriginResponse {
		if request.URI == "/errors/500.html" {
			return OriginResponse{StatusCode: 200, Body: []byte("default page")}
		}
		return OriginResponse{StatusCode: 500, Body: []byte("failed")}
	}}
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 200}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "default page" {
		t.Fatalf("default behavior page = %d %q", recorder.Code, recorder.Body.String())
	}
}

// The media-cdn example's 403 page is not cached because the s3proxy 403 has
// no Cache-Control; this protocol-boundary test proves the ErrorCachingMinTTL
// rule for a 404 origin, which the status table caches unconditionally.
func TestCustomErrorPageForA404ExpiresAfterErrorCachingMinTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := &captureOrigin{respond: func(request OriginRequest) OriginResponse {
		if request.URI == "/errors/not-found.html" {
			return OriginResponse{StatusCode: 200, Header: http.Header{"content-type": []string{"text/html"}}, Body: []byte("page")}
		}
		return OriginResponse{StatusCode: 404, Body: []byte("missing")}
	}}
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode: 404, ResponsePagePath: "/errors/not-found.html", ResponseCode: 200, ErrorCachingMinTTL: intPointer(60),
	}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/missing", "", nil)
	if first.Code != 200 || first.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("first request = %d %q", first.Code, first.Header().Get("x-cache"))
	}
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/missing", "", nil)
	if second.Header().Get("x-cache") != cacheHitHeader || second.Body.String() != "page" {
		t.Fatalf("second request = %q %q", second.Header().Get("x-cache"), second.Body.String())
	}
	now = now.Add(61 * time.Second)
	third := serveGateway(gateway, http.MethodGet, "http://viewer.example/missing", "", nil)
	if third.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("the custom error page outlived ErrorCachingMinTTL: %q", third.Header().Get("x-cache"))
	}
	if len(origin.requests) != 4 {
		t.Fatalf("origin requests = %d, want 4 (two object misses and two page fetches)", len(origin.requests))
	}
}

func TestUnavailableCustomErrorPageReturnsThePagesOriginStatus(t *testing.T) {
	api := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		return OriginResponse{StatusCode: 500, Body: []byte("api failed")}
	}}
	pages := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		return OriginResponse{StatusCode: 404, Body: []byte("no such page")}
	}}
	errorsBehavior := testBehavior("/errors/*", "pages", []string{"GET", "HEAD"})
	errorsBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	defaultBehavior := testBehavior("*", "api", []string{"GET", "HEAD"})
	defaultBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	distribution := testDistribution(defaultBehavior, []*Behavior{errorsBehavior},
		testOrigin("api", "api.example"), testOrigin("pages", "pages.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 503}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"api": api, "pages": pages}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if recorder.Code != 404 || recorder.Body.String() != "no such page" {
		t.Fatalf("unavailable page = %d %q; the pages origin's status must be returned", recorder.Code, recorder.Body.String())
	}
}

func TestCustomErrorPageMatchingABehaviorUsesTheBehaviorTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	apiCalls := 0
	api := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		apiCalls++
		if apiCalls == 1 {
			return OriginResponse{StatusCode: 500, Body: []byte("failed")}
		}
		// After the cache expires the origin recovers, so the request is a
		// normal miss and the stale-on-5xx rule cannot mask the TTL check.
		return OriginResponse{StatusCode: 200, Body: []byte("fresh")}
	}}
	pages := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		return OriginResponse{StatusCode: 200, Header: http.Header{"content-type": []string{"text/html"}}, Body: []byte("page")}
	}}
	errorsBehavior := testBehavior("/errors/*", "pages", []string{"GET", "HEAD"})
	errorsBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(5, 3600, 0), nil, nil)
	defaultBehavior := testBehavior("*", "api", []string{"GET", "HEAD"})
	defaultBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 3600, 0), nil, nil)
	distribution := testDistribution(defaultBehavior, []*Behavior{errorsBehavior},
		testOrigin("api", "api.example"), testOrigin("pages", "pages.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 200, ErrorCachingMinTTL: intPointer(120)}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"api": api, "pages": pages}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	now = now.Add(6 * time.Second)
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if second.Header().Get("x-cache") != cacheMissHeader || second.Body.String() != "fresh" {
		t.Fatalf("the page behavior's 5 second TTL must win over the 120 second error TTL: %q %q",
			second.Header().Get("x-cache"), second.Body.String())
	}
	if len(api.requests) != 2 {
		t.Fatalf("API origin requests = %d, want 2", len(api.requests))
	}
}

// F-R5a-3: GET and HEAD share one cache key; a HEAD response is never stored.
func TestHeadIsServedFromTheGetObject(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(2 * time.Second)
	head := serveGateway(gateway, http.MethodHead, "http://viewer.example/x", "", nil)
	if head.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("HEAD after a cached GET = %q", head.Header().Get("x-cache"))
	}
	if head.Header().Get("age") != "2" || head.Body.Len() != 0 {
		t.Fatalf("HEAD age=%q body=%q", head.Header().Get("age"), head.Body.String())
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d, want 1", len(origin.requests))
	}
}

func TestHeadResponseIsNotStoredUnderTheSharedKey(t *testing.T) {
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	head := serveGateway(gateway, http.MethodHead, "http://viewer.example/x", "", nil)
	if head.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("HEAD miss = %q", head.Header().Get("x-cache"))
	}
	if gateway.Cache.Len() != 0 {
		t.Fatalf("a HEAD response was stored under the shared key: %d entries", gateway.Cache.Len())
	}
	get := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if get.Header().Get("x-cache") != cacheMissHeader || get.Body.String() != "cached" {
		t.Fatalf("GET after HEAD = %q %q", get.Header().Get("x-cache"), get.Body.String())
	}
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d, want 2", len(origin.requests))
	}
}

func TestCacheKeySharesGETAndHEADButNotOPTIONS(t *testing.T) {
	get := CacheKey("viewer.example", http.MethodGet, "/x", "", nil, nil)
	head := CacheKey("viewer.example", http.MethodHead, "/x", "", nil, nil)
	options := CacheKey("viewer.example", http.MethodOptions, "/x", "", nil, nil)
	if get != head {
		t.Fatalf("GET and HEAD keys differ:\n%s\n%s", get, head)
	}
	if get == options {
		t.Fatalf("OPTIONS must have its own key: %s", options)
	}
}

// F-SAN-R5a-1: every managed cache policy's TTL triple matches the page.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
func TestManagedCachePolicyTTLTriplesMatchThePage(t *testing.T) {
	want := map[string][3]int{
		"658327ea-f89d-4fab-a63d-7e88639e58f6": {1, 86400, 31536000},
		"4135ea2d-6df8-44a3-9df3-4b5a84be39ad": {0, 0, 0},
		"b2884449-e4de-46a7-ac36-70bc7f1ddd6d": {1, 86400, 31536000},
		"2e54312d-136d-493c-8eb9-b001f22f67d2": {2, 2, 600},
		"08627262-05a9-4f76-9ded-b50ca2e3a84f": {0, 86400, 31536000},
		"83da9c7e-98b4-4e11-a168-04f0df8e2c65": {0, 0, 31536000},
		"4cc15a8a-d715-48a4-82b8-cc0b614638fe": {0, 0, 31536000},
	}
	for id, triple := range want {
		entry, ok := managedPolicyTable[PolicyCache][id]
		if !ok {
			t.Errorf("managed cache policy %s is missing", id)
			continue
		}
		got := entry.Cache
		if got.MinTTL != triple[0] || got.DefaultTTL != triple[1] || got.MaxTTL != triple[2] {
			t.Errorf("%s TTLs are %d/%d/%d; the page states %d/%d/%d",
				id, got.MinTTL, got.DefaultTTL, got.MaxTTL, triple[0], triple[1], triple[2])
		}
	}
	if len(managedPolicyTable[PolicyCache]) != len(want) {
		t.Errorf("the cache policy table has %d entries; the page defines %d",
			len(managedPolicyTable[PolicyCache]), len(want))
	}
}

func TestUseOriginCacheControlHeadersDoesNotCacheAHeaderlessResponse(t *testing.T) {
	managed := managedPolicyTable[PolicyCache]["83da9c7e-98b4-4e11-a168-04f0df8e2c65"]
	behavior := cachedBehavior(managed.Cache)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("no-cache-control-header")
	gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(2 * time.Second)
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(origin.requests) != 2 || second.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("a headerless response was cached under UseOriginCacheControlHeaders (%q, %d calls)",
			second.Header().Get("x-cache"), len(origin.requests))
	}
}

// m2: an explicit ErrorCachingMinTTL of 0 disables error caching for a custom
// origin and means one second for an S3 origin.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
func TestExplicitZeroErrorCachingMinimum(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newGateway := func(originKind OriginKind) (*Gateway, *recordingOrigin) {
		origin := &recordingOrigin{response: OriginResponse{StatusCode: 404, Header: http.Header{}, Body: []byte("missing")}}
		distributionOrigin := &DistributionOrigin{ID: "origin", DomainName: "origin.example", Kind: originKind, S3: &S3Origin{}, Custom: &CustomOrigin{}}
		distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, distributionOrigin)
		distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ErrorCachingMinTTL: intPointer(0)}}
		gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
		gateway.Now = func() time.Time { return now }
		return gateway, origin
	}

	gateway, origin := newGateway(OriginCustom)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(2 * time.Second)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(origin.requests) != 2 {
		t.Fatalf("an explicit ErrorCachingMinTTL of 0 cached a custom-origin 404: %d calls", len(origin.requests))
	}

	now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gateway, origin = newGateway(OriginS3)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(500 * time.Millisecond)
	if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("an S3 origin's zero error TTL is one second: %q", recorder.Header().Get("x-cache"))
	}
	now = now.Add(2 * time.Second)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(origin.requests) != 2 {
		t.Fatalf("an S3 origin's one second error cache did not expire: %d calls", len(origin.requests))
	}
}

// F-SAN-R5a-2: an origin 5xx for an expired object serves the stale object for
// the error caching minimum TTL, capped by the behavior's Maximum TTL; a 4xx
// returns the status instead.
func TestStaleObjectIsServedForA5xxOriginResponse(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(10, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	origin.response = OriginResponse{StatusCode: 503, Header: http.Header{}, Body: []byte("down")}
	now = now.Add(15 * time.Second)
	stale := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if stale.Code != 200 || stale.Body.String() != "cached" || stale.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("5xx with an expired object = %d %q %q", stale.Code, stale.Body.String(), stale.Header().Get("x-cache"))
	}
	now = now.Add(6 * time.Second)
	after := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if after.Code != 503 || after.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("past the error window = %d %q", after.Code, after.Header().Get("x-cache"))
	}
}

func TestStaleObjectIsNotServedBeyondTheBehaviorMaxTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(10, 12, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	origin.response = OriginResponse{StatusCode: 503, Body: []byte("down")}
	now = now.Add(13 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 503 || recorder.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("stale served beyond the behavior MaxTTL: %d %q", recorder.Code, recorder.Header().Get("x-cache"))
	}
}

func TestA4xxOriginResponseIsReturnedInsteadOfTheStaleObject(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(10, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	origin.response = OriginResponse{StatusCode: 404, Body: []byte("gone")}
	now = now.Add(15 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 404 || recorder.Body.String() != "gone" {
		t.Fatalf("4xx with an expired object = %d %q; the status must be returned", recorder.Code, recorder.Body.String())
	}
}

// F-SAN-R5a-3: the invalidation-path rules.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/invalidation-specifying-objects.html
func TestInvalidationWildcardAndCaseRules(t *testing.T) {
	if !invalidationPathMatches("/a.js*", "/a.js?v=1") {
		t.Fatal("a trailing * must match the query string")
	}
	if invalidationPathMatches("/a*b.js", "/axxb.js") {
		t.Fatal("an asterisk before the last character is literal, not a wildcard")
	}
	if !invalidationPathMatches("/a*b.js", "/a*b.js") {
		t.Fatal("a non-trailing asterisk must match itself literally")
	}
	if invalidationPathMatches("/A.js", "/a.js") {
		t.Fatal("invalidation paths are case sensitive")
	}
}

func TestInvalidationMatchesTheCachedQueryString(t *testing.T) {
	cache := NewCache()
	cache.Set("with-query", CacheEntry{Path: "/a.js", Query: "v=1"})
	cache.Set("plain", CacheEntry{Path: "/a.js"})
	cache.Set("other-case", CacheEntry{Path: "/A.js"})
	if removed := cache.Invalidate([]string{"/a.js"}); removed != 1 {
		t.Fatalf("invalidating /a.js removed %d entries; the query-string version must survive", removed)
	}
	if removed := cache.Invalidate([]string{"/a.js*"}); removed != 1 {
		t.Fatalf("invalidating /a.js* removed %d entries", removed)
	}
	if cache.Len() != 1 {
		t.Fatalf("cache entries = %d, want the case-different path only", cache.Len())
	}
}

func TestInvalidationPathValidation(t *testing.T) {
	longest := "/" + strings.Repeat("a", maxInvalidationPathLength-1)
	if err := ValidateInvalidationPaths([]string{longest}); err != nil {
		t.Fatalf("a %d character path was refused: %v", maxInvalidationPathLength, err)
	}
	if err := ValidateInvalidationPaths([]string{longest + "a"}); err == nil {
		t.Fatal("a path over 4000 characters was accepted")
	}
	if err := ValidateInvalidationPaths([]string{"/images/logo~1.png"}); err == nil {
		t.Fatal("a path containing ~ was accepted")
	}
}

// The CreateInvalidation reference: reusing a CallerReference returns the
// previous invalidation when the request is identical and
// InvalidationBatchAlreadyExists when a Path differs.
// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CreateInvalidation.html
func TestCallerReferenceReuse(t *testing.T) {
	api := NewInvalidationAPI(func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }, nil)
	distributionID := api.Register("TestDistribution", NewCache())
	server := httptest.NewServer(api)
	defer server.Close()

	post := func(path string) (int, string) {
		t.Helper()
		body := `<InvalidationBatch><CallerReference>same-ref</CallerReference><Paths><Quantity>1</Quantity><Items><Path>` + path + `</Path></Items></Paths></InvalidationBatch>`
		response, err := http.Post(server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", "text/xml", strings.NewReader(body)) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		return response.StatusCode, readAll(t, response)
	}
	if status, body := post("/x"); status != http.StatusCreated {
		t.Fatalf("first invalidation = %d %s", status, body)
	}
	status, body := post("/x")
	if status != http.StatusCreated {
		t.Fatalf("an identical CallerReference must return the previous invalidation: %d %s", status, body)
	}
	if invalidations := api.Invalidations(); len(invalidations) != 1 {
		t.Fatalf("identical requests created %d invalidations", len(invalidations))
	} else if !strings.Contains(body, invalidations[0].ID) {
		t.Fatalf("the repeated request did not return the previous invalidation: %s", body)
	}
	status, body = post("/y")
	if status != http.StatusBadRequest || !strings.Contains(body, "InvalidationBatchAlreadyExists") {
		t.Fatalf("a different path with the same CallerReference = %d %s", status, body)
	}
}

// captureOrigin records every request and answers from a function.
type captureOrigin struct {
	requests []OriginRequest
	respond  func(OriginRequest) OriginResponse
}

func (o *captureOrigin) Fetch(_ context.Context, request OriginRequest) (OriginResponse, error) {
	o.requests = append(o.requests, request)
	return o.respond(request), nil
}

// pagesOrigin answers a custom error page for any request, used by the
// CachingDisabled case where the page itself must never be cached.
type pagesOrigin struct{}

func (o *pagesOrigin) Fetch(_ context.Context, request OriginRequest) (OriginResponse, error) {
	if request.URI == "/errors/404.html" {
		return OriginResponse{StatusCode: 200, Body: []byte("page")}, nil
	}
	return OriginResponse{StatusCode: 404, Body: []byte("missing")}, nil
}

// A-R5a-R1-1: the error caching duration is capped by the Maximum TTL of the
// behavior the error page is fetched through, not only when an explicit page
// behavior matches. "The Cache-Control: max-age and Cache-Control: s-maxage
// values cannot be greater than the Maximum TTL value set for the cache
// behavior for which the error page is being fetched."
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
func TestCustomErrorPageThroughTheDefaultBehaviorIsCappedAtItsMaxTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	objectCalls := 0
	origin := &captureOrigin{respond: func(request OriginRequest) OriginResponse {
		if request.URI == "/errors/500.html" {
			return OriginResponse{StatusCode: 200, Header: http.Header{"content-type": []string{"text/html"}}, Body: []byte("page")}
		}
		objectCalls++
		if objectCalls == 1 {
			return OriginResponse{StatusCode: 500, Header: http.Header{"cache-control": []string{"max-age=3600"}}, Body: []byte("failed")}
		}
		// After the cached page expires the origin recovers, so the stale-on-5xx
		// rule cannot mask the TTL check.
		return OriginResponse{StatusCode: 200, Header: http.Header{"cache-control": []string{"max-age=60"}}, Body: []byte("fresh")}
	}}
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD"})
	behavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 60, 0), nil, nil)
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 200}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }

	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if first.Code != 200 || first.Body.String() != "page" || first.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("first request = %d %q %q", first.Code, first.Body.String(), first.Header().Get("x-cache"))
	}
	now = now.Add(59 * time.Second)
	if hit := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil); hit.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("at 59s the error page must still be cached: %q", hit.Header().Get("x-cache"))
	}
	now = now.Add(2 * time.Second)
	miss := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if miss.Header().Get("x-cache") != cacheMissHeader || miss.Body.String() != "fresh" {
		t.Fatalf("at 61s max-age=3600 must be capped at the default behavior's 60s Maximum TTL: %q %q",
			miss.Header().Get("x-cache"), miss.Body.String())
	}
	if len(origin.requests) != 3 {
		t.Fatalf("origin requests = %d, want 3 (the failed object fetch, its page, and the fresh object)", len(origin.requests))
	}
}

func TestCustomErrorPageThroughAnExplicitBehaviorKeepsItsOwnMaxTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	apiCalls := 0
	api := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		apiCalls++
		if apiCalls == 1 {
			return OriginResponse{StatusCode: 500, Header: http.Header{"cache-control": []string{"max-age=3600"}}, Body: []byte("failed")}
		}
		// After the cached page expires the origin recovers, so the stale-on-5xx
		// rule cannot mask the TTL check.
		return OriginResponse{StatusCode: 200, Header: http.Header{"cache-control": []string{"max-age=60"}}, Body: []byte("fresh")}
	}}
	pages := &captureOrigin{respond: func(OriginRequest) OriginResponse {
		return OriginResponse{StatusCode: 200, Header: http.Header{"cache-control": []string{"max-age=3600"}}, Body: []byte("page")}
	}}
	errorsBehavior := testBehavior("/errors/*", "pages", []string{"GET", "HEAD"})
	errorsBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(30, 30, 0), nil, nil)
	defaultBehavior := testBehavior("*", "api", []string{"GET", "HEAD"})
	defaultBehavior.CachePolicy = testPolicy(PolicyCache, cachePolicy(60, 60, 0), nil, nil)
	distribution := testDistribution(defaultBehavior, []*Behavior{errorsBehavior},
		testOrigin("api", "api.example"), testOrigin("pages", "pages.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html", ResponseCode: 200}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"api": api, "pages": pages}, nil, nil)
	gateway.Now = func() time.Time { return now }

	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if first.Code != 200 || first.Body.String() != "page" || first.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("first request = %d %q %q", first.Code, first.Body.String(), first.Header().Get("x-cache"))
	}
	now = now.Add(29 * time.Second)
	if hit := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil); hit.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("at 29s the page behavior's 30s Maximum TTL must still cache the page: %q", hit.Header().Get("x-cache"))
	}
	now = now.Add(2 * time.Second)
	miss := serveGateway(gateway, http.MethodGet, "http://viewer.example/data", "", nil)
	if miss.Header().Get("x-cache") != cacheMissHeader || miss.Body.String() != "fresh" {
		t.Fatalf("at 31s the explicit page behavior's Maximum TTL must still win: %q %q",
			miss.Header().Get("x-cache"), miss.Body.String())
	}
}

// A-R5a-R1-res1: both stale windows end at the behavior's Maximum TTL:
// "CloudFront will serve the stale content up to the value of the
// stale-while-revalidate directive or the value of the CloudFront maximum TTL,
// whichever is less. After the maximum TTL duration, the stale object won't be
// available from the edge cache, regardless of the stale-while-revalidate
// value."
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html
func TestStaleWhileRevalidateIsCappedAtTheBehaviorMaxTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("first")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60, stale-while-revalidate=3600"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 120, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)

	origin.err = context.DeadlineExceeded
	now = now.Add(90 * time.Second)
	stale := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if stale.Header().Get("x-cache") != cacheHitHeader || stale.Body.String() != "first" {
		t.Fatalf("at 90s the entry is inside the 120s Maximum TTL and is served stale: %q %q",
			stale.Header().Get("x-cache"), stale.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(origin.requests) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(origin.requests) < 2 {
		t.Fatal("the stale-while-revalidate refresh did not reach the origin")
	}
	origin.err = nil
	origin.response = OriginResponse{StatusCode: 200, Header: http.Header{"cache-control": []string{"max-age=60"}}, Body: []byte("fresh")}
	now = now.Add(40 * time.Second)
	fresh := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if fresh.Header().Get("x-cache") != cacheMissHeader || fresh.Body.String() != "fresh" {
		t.Fatalf("at 130s the Maximum TTL ended the stale window: %q %q",
			fresh.Header().Get("x-cache"), fresh.Body.String())
	}
}

func TestStaleIfErrorIsCappedAtTheBehaviorMaxTTL(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("first")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60, stale-if-error=3600"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 120, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)

	origin.err = context.DeadlineExceeded
	now = now.Add(90 * time.Second)
	stale := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if stale.Code != 200 || stale.Body.String() != "first" {
		t.Fatalf("at 90s stale-if-error = %d %q, want the stale object", stale.Code, stale.Body.String())
	}
	now = now.Add(40 * time.Second)
	after := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if after.Code != http.StatusBadGateway {
		t.Fatalf("at 130s the Maximum TTL must end the stale-if-error window: %d %q", after.Code, after.Body.String())
	}
	if len(origin.requests) != 3 {
		t.Fatalf("origin requests = %d, want 3 (store, 90s and 130s)", len(origin.requests))
	}
}

// A-R5a-R1-res4: "CloudFront doesn't support creating custom error pages for
// these HTTP status codes" (412 Precondition Failed and 415 Unsupported Media
// Type). A status-only rewrite stays accepted.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
func TestCustomErrorPagesRefuse412And415AtPlanTime(t *testing.T) {
	for _, status := range []int{http.StatusPreconditionFailed, http.StatusUnsupportedMediaType} {
		withPage := json.RawMessage(fmt.Sprintf(
			`[{"ErrorCode":%d,"ResponsePagePath":"/errors/%d.html","ResponseCode":200}]`, status, status))
		if _, err := parseCustomErrorResponses(withPage, "TestDistribution"); err == nil ||
			!strings.Contains(err.Error(), fmt.Sprintf("%d", status)) ||
			!strings.Contains(err.Error(), "HTTPStatusCodes.html") {
			t.Fatalf("ErrorCode %d with a ResponsePagePath = %v, want a named refusal with the page URL", status, err)
		}
		statusOnly := json.RawMessage(fmt.Sprintf(`[{"ErrorCode":%d,"ResponseCode":200}]`, status))
		if _, err := parseCustomErrorResponses(statusOnly, "TestDistribution"); err != nil {
			t.Fatalf("a status-only rewrite for ErrorCode %d was refused: %v", status, err)
		}
	}
	withPage := json.RawMessage(`[{"ErrorCode":404,"ResponsePagePath":"/errors/404.html","ResponseCode":200}]`)
	if _, err := parseCustomErrorResponses(withPage, "TestDistribution"); err != nil {
		t.Fatalf("a 404 custom error page was refused: %v", err)
	}
}
