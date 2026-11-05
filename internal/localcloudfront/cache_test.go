package localcloudfront

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func cachePolicy(defaultTTL, maxTTL, minTTL int) *CachePolicy {
	return &CachePolicy{DefaultTTL: defaultTTL, MaxTTL: maxTTL, MinTTL: minTTL}
}

func cachedBehavior(policy *CachePolicy) *Behavior {
	behavior := testBehavior("*", "origin", []string{"GET", "HEAD", "OPTIONS"})
	behavior.CachePolicy = testPolicy(PolicyCache, policy, nil, nil)
	return behavior
}

func TestGatewayCachesMissThenHit(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	behavior := cachedBehavior(cachePolicy(60, 3600, 0))
	distribution := testDistribution(behavior, nil, testOrigin("origin", "origin.example"))
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }

	first := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if first.Code != 200 || first.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("first request = %d x-cache %q", first.Code, first.Header().Get("x-cache"))
	}
	if first.Header().Get("age") != "" {
		t.Fatalf("a miss must not carry age: %q", first.Header().Get("age"))
	}
	now = now.Add(30 * time.Second)
	second := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if second.Header().Get("x-cache") != cacheHitHeader {
		t.Fatalf("second request x-cache = %q", second.Header().Get("x-cache"))
	}
	if second.Header().Get("age") != "30" {
		t.Fatalf("age = %q, want 30", second.Header().Get("age"))
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d, want 1", len(origin.requests))
	}
	if second.Body.String() != "cached" {
		t.Fatalf("cached body = %q", second.Body.String())
	}
}

func TestGatewayCacheExpiresOnTheGatewayClock(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(61 * time.Second)
	after := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if after.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("after the TTL x-cache = %q", after.Header().Get("x-cache"))
	}
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d, want 2", len(origin.requests))
	}
}

func TestGatewayCachingDisabledAlwaysMisses(t *testing.T) {
	origin := okOrigin("uncached")
	policy := cachePolicy(60, 3600, 0)
	policy.CachingDisabled = true
	gateway := NewGateway(testDistribution(cachedBehavior(policy), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	for index := 0; index < 2; index++ {
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Header().Get("x-cache") != cacheMissHeader {
			t.Fatalf("request %d x-cache = %q", index, recorder.Header().Get("x-cache"))
		}
	}
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d, want 2", len(origin.requests))
	}
}

func TestGatewayCachesOptionsSeparately(t *testing.T) {
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	serveGateway(gateway, http.MethodOptions, "http://viewer.example/x", "", nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if len(origin.requests) != 2 {
		t.Fatalf("origin calls = %d, want 2 (GET and OPTIONS have separate keys)", len(origin.requests))
	}
	stats := gateway.Stats()["*"]
	if stats.Hits != 1 || stats.Misses != 2 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestGatewayServesTheCustomErrorPage(t *testing.T) {
	origin := OriginFunc(func(_ context.Context, request OriginRequest) (OriginResponse, error) {
		if request.URI == "/errors/not-found.html" {
			return OriginResponse{StatusCode: 200, Header: http.Header{"content-type": []string{"text/html"}}, Body: []byte("custom page")}, nil
		}
		return OriginResponse{StatusCode: 404, Header: http.Header{"content-type": []string{"text/plain"}}, Body: []byte("origin missing")}, nil
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode:          404,
		ResponsePagePath:   "/errors/not-found.html",
		ResponseCode:       200,
		ErrorCachingMinTTL: intPointer(120),
	}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/missing", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "custom page" {
		t.Fatalf("custom error = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestGatewayKeepsTheOriginStatusWhenTheErrorPageIsUnavailable(t *testing.T) {
	origin := OriginFunc(func(_ context.Context, request OriginRequest) (OriginResponse, error) {
		return OriginResponse{StatusCode: 404, Body: []byte("origin missing")}, nil
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{
		ErrorCode:        404,
		ResponsePagePath: "/errors/not-found.html",
		ResponseCode:     200,
	}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/missing", "", nil)
	if recorder.Code != 404 || recorder.Body.String() != "origin missing" {
		t.Fatalf("unavailable page = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestGatewayInvalidationRemovesCachedObjects(t *testing.T) {
	origin := okOrigin("cached")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/assets/app.js", "", nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/assets/app.js", "", nil)
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d", len(origin.requests))
	}
	if removed := gateway.Cache.Invalidate([]string{"/assets/*"}); removed != 1 {
		t.Fatalf("invalidated %d entries", removed)
	}
	serveGateway(gateway, http.MethodGet, "http://viewer.example/assets/app.js", "", nil)
	if len(origin.requests) != 2 {
		t.Fatalf("the request after invalidation must reach the origin, calls = %d", len(origin.requests))
	}
}

func TestGatewayStaleWhileRevalidateServesStaleAndRefreshes(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("first")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10, stale-while-revalidate=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(10, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(20 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Header().Get("x-cache") != cacheHitHeader || recorder.Body.String() != "first" {
		t.Fatalf("stale response = %q %q", recorder.Header().Get("x-cache"), recorder.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(origin.requests) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(origin.requests) < 2 {
		t.Fatal("the stale-while-revalidate refresh did not reach the origin")
	}
}

func TestGatewayStaleIfErrorServesTheStaleObject(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := okOrigin("first")
	origin.response.Header = http.Header{"cache-control": []string{"max-age=10, stale-if-error=60"}}
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(10, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	now = now.Add(20 * time.Second)
	origin.err = context.DeadlineExceeded
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 200 || recorder.Body.String() != "first" {
		t.Fatalf("stale-if-error = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestCachePolicyTTLTable(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	expires := now.Add(120 * time.Second).Format(http.TimeFormat)
	cases := []struct {
		name        string
		policy      CachePolicy
		header      http.Header
		wantSeconds int
	}{
		{name: "default", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{}, wantSeconds: 60},
		{name: "max-age", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"max-age=30"}}, wantSeconds: 30},
		{name: "s-maxage wins", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"max-age=30, s-maxage=90"}}, wantSeconds: 90},
		{name: "max-age wins over expires", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"max-age=30"}, "expires": []string{expires}}, wantSeconds: 30},
		{name: "expires", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"expires": []string{expires}}, wantSeconds: 120},
		{name: "no-cache", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"no-cache"}}, wantSeconds: 0},
		{name: "no-store", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"no-store"}}, wantSeconds: 0},
		{name: "private", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"private"}}, wantSeconds: 0},
		{name: "minimum overrides no-cache", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600, MinTTL: 300}, header: http.Header{"cache-control": []string{"no-cache"}}, wantSeconds: 300},
		{name: "maximum bounds max-age", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 100}, header: http.Header{"cache-control": []string{"max-age=600"}}, wantSeconds: 100},
		{name: "minimum bounds max-age", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600, MinTTL: 120}, header: http.Header{"cache-control": []string{"max-age=30"}}, wantSeconds: 120},
		{name: "viewer cache-control ignored", policy: CachePolicy{DefaultTTL: 60, MaxTTL: 3600}, header: http.Header{"cache-control": []string{"max-age=30, private"}}, wantSeconds: 0},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			ttl, _ := test.policy.OriginTTL(OriginResponse{StatusCode: 200, Header: test.header}, now)
			if int(ttl.Seconds()) != test.wantSeconds {
				t.Fatalf("ttl = %ds, want %ds", int(ttl.Seconds()), test.wantSeconds)
			}
		})
	}
}

func TestCacheKeyFollowsThePolicy(t *testing.T) {
	policy := &CachePolicy{
		QueryStrings: QueryForwarding{Mode: ForwardWhitelist, Names: []string{"q"}},
		Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"x-tenant"}},
		Cookies:      CookieForwarding{Mode: ForwardWhitelist, Names: []string{"session"}},
	}
	header := http.Header{"X-Tenant": []string{"t-1"}, "Cookie": []string{"session=abc; other=zzz"}}
	base := CacheKey("Viewer.Example", "GET", "/x", "q=1&other=2", header, policy)
	same := CacheKey("viewer.example", "GET", "/x", "other=2&q=1", header, policy)
	if base != same {
		t.Fatalf("the key must ignore parameter order and host case:\n%q\n%q", base, same)
	}
	if CacheKey("viewer.example", "OPTIONS", "/x", "q=1", header, policy) == base {
		t.Fatal("OPTIONS must have a separate key")
	}
	changedQuery := CacheKey("viewer.example", "GET", "/x", "q=2", header, policy)
	if changedQuery == base {
		t.Fatal("a selected query string must change the key")
	}
	unselected := CacheKey("viewer.example", "GET", "/x", "other=3", header, policy)
	if unselected != CacheKey("viewer.example", "GET", "/x", "other=4", header, policy) {
		t.Fatal("an unselected query string must not change the key")
	}
	otherCookie := http.Header{"Cookie": []string{"session=zzz"}}
	if CacheKey("viewer.example", "GET", "/x", "", otherCookie, policy) ==
		CacheKey("viewer.example", "GET", "/x", "", header, policy) {
		t.Fatal("a selected cookie must change the key")
	}
}

func TestInvalidationPathRules(t *testing.T) {
	cache := NewCache()
	now := time.Now()
	for _, path := range []string{"/index.html", "/assets/app.js", "/assets/nested/x.css", "/space%20file.txt", "/space file.txt"} {
		cache.Set(CacheKey("viewer.example", "GET", path, "", nil, nil), CacheEntry{Response: OriginResponse{StatusCode: 200}, Path: path, StoredAt: now, ExpiresAt: now.Add(time.Hour)})
	}
	if removed := cache.Invalidate([]string{"/index.html"}); removed != 1 {
		t.Fatalf("exact invalidation removed %d", removed)
	}
	if removed := cache.Invalidate([]string{"/assets/*"}); removed != 2 {
		t.Fatalf("wildcard invalidation removed %d", removed)
	}
	if removed := cache.Invalidate([]string{"/space%20file.txt"}); removed != 1 {
		t.Fatalf("URL-decoded invalidation removed %d, want the decoded path only", removed)
	}
	if err := ValidateInvalidationPaths([]string{"index.html"}); err == nil {
		t.Fatal("a path without a leading slash must be refused")
	}
	if err := ValidateInvalidationPaths(nil); err == nil {
		t.Fatal("an empty batch must be refused")
	}
	tooMany := make([]string, maxInvalidationPaths+1)
	for index := range tooMany {
		tooMany[index] = "/x" + strconv.Itoa(index)
	}
	if err := ValidateInvalidationPaths(tooMany); err == nil || !strings.Contains(err.Error(), "3000") {
		t.Fatalf("over-quota batch = %v", err)
	}
}

func TestInvalidationAPICreateGetList(t *testing.T) {
	api := NewInvalidationAPI(func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }, nil)
	cache := NewCache()
	now := time.Now()
	cache.Set(CacheKey("viewer.example", "GET", "/index.html", "", nil, nil), CacheEntry{Response: OriginResponse{StatusCode: 200}, Path: "/index.html", StoredAt: now, ExpiresAt: now.Add(time.Hour)})
	distributionID := api.Register("TestDistribution", cache)
	server := httptest.NewServer(api)
	defer server.Close()

	body := `<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Paths><Quantity>1</Quantity><Items><Path>/index.html</Path></Items></Paths><CallerReference>local-1</CallerReference></InvalidationBatch>`
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build create request: %v", err)
	}
	request.Header.Set("Content-Type", "text/xml")
	response, err := http.DefaultClient.Do(request) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	payload := readAll(t, response)
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d: %s", response.StatusCode, payload)
	}
	location := response.Header.Get("Location")
	if !strings.Contains(location, "/invalidation/I") {
		t.Fatalf("Location = %q", location)
	}
	if !strings.Contains(payload, "<Status>Completed</Status>") || !strings.Contains(payload, "<Path>/index.html</Path>") {
		t.Fatalf("create body = %s", payload)
	}
	if cache.Len() != 0 {
		t.Fatalf("the invalidation did not remove the cached object")
	}
	getRequest, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+location, nil)
	if err != nil {
		t.Fatalf("build get request: %v", err)
	}
	getResponse, err := http.DefaultClient.Do(getRequest) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if getResponse.StatusCode != http.StatusOK {
		t.Fatalf("get = %d", getResponse.StatusCode)
	}
	getBody := readAll(t, getResponse)
	if !strings.Contains(getBody, "<Status>Completed</Status>") {
		t.Fatalf("get body = %s", getBody)
	}
	listRequest, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", nil)
	if err != nil {
		t.Fatalf("build list request: %v", err)
	}
	listResponse, err := http.DefaultClient.Do(listRequest) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	listBody := readAll(t, listResponse)
	if !strings.Contains(listBody, "<InvalidationList") || !strings.Contains(listBody, "<Quantity>1</Quantity>") {
		t.Fatalf("list body = %s", listBody)
	}
}

func TestInvalidationAPIRejectsAnInvalidPath(t *testing.T) {
	api := NewInvalidationAPI(nil, nil)
	distributionID := api.Register("TestDistribution", NewCache())
	server := httptest.NewServer(api)
	defer server.Close()
	body := `<InvalidationBatch><Paths><Quantity>1</Quantity><Items><Path>index.html</Path></Items></Paths><CallerReference>x</CallerReference></InvalidationBatch>`
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build create request: %v", err)
	}
	request.Header.Set("Content-Type", "text/xml")
	response, err := http.DefaultClient.Do(request) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	payload := readAll(t, response)
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(payload, "InvalidArgument") {
		t.Fatalf("invalid path = %d: %s", response.StatusCode, payload)
	}
}

func readAll(t *testing.T, response *http.Response) string {
	t.Helper()
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test response
	var builder strings.Builder
	buffer := make([]byte, 4096)
	for {
		read, err := response.Body.Read(buffer)
		builder.Write(buffer[:read])
		if err != nil {
			break
		}
	}
	return builder.String()
}
