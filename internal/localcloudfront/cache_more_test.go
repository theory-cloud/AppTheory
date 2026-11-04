package localcloudfront

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func cachedGatewayWithETag(t *testing.T, header http.Header) (*Gateway, *recordingOrigin) {
	t.Helper()
	origin := okOrigin("cached")
	origin.response.Header = header
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	return gateway, origin
}

func TestGatewayAnswersConditionalRequestsFromTheCache(t *testing.T) {
	gateway, origin := cachedGatewayWithETag(t, http.Header{
		"cache-control": []string{"max-age=60"},
		"etag":          []string{`"abc"`},
	})
	cases := []struct {
		header http.Header
		want   int
	}{
		{header: http.Header{"If-None-Match": []string{`"abc"`}}, want: http.StatusNotModified},
		{header: http.Header{"If-None-Match": []string{`W/"abc"`}}, want: http.StatusNotModified},
		{header: http.Header{"If-None-Match": []string{"*"}}, want: http.StatusNotModified},
		{header: http.Header{"If-None-Match": []string{`"other", "abc"`}}, want: http.StatusNotModified},
		{header: http.Header{"If-None-Match": []string{`"other"`}}, want: http.StatusOK},
	}
	for _, test := range cases {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x", nil)
		request.Host = "viewer.example"
		for name, values := range test.header {
			for _, value := range values {
				request.Header.Add(name, value)
			}
		}
		recorder := httptest.NewRecorder()
		gateway.ServeHTTP(recorder, request)
		if recorder.Code != test.want {
			t.Fatalf("conditional %v = %d, want %d", test.header, recorder.Code, test.want)
		}
		if test.want == http.StatusNotModified {
			if recorder.Body.Len() != 0 || recorder.Header().Get("etag") != `"abc"` {
				t.Fatalf("304 body %q etag %q", recorder.Body.String(), recorder.Header().Get("etag"))
			}
			if recorder.Header().Get("x-cache") != cacheHitHeader {
				t.Fatalf("304 x-cache = %q", recorder.Header().Get("x-cache"))
			}
		}
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d, want 1", len(origin.requests))
	}
}

func TestGatewayAnswersIfModifiedSinceFromTheCache(t *testing.T) {
	modified := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	gateway, origin := cachedGatewayWithETag(t, http.Header{
		"cache-control": []string{"max-age=60"},
		"last-modified": []string{modified.Format(http.TimeFormat)},
	})
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x", nil)
	request.Host = "viewer.example"
	request.Header.Set("If-Modified-Since", modified.Add(time.Hour).Format(http.TimeFormat))
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotModified || recorder.Header().Get("last-modified") == "" {
		t.Fatalf("If-Modified-Since = %d last-modified %q", recorder.Code, recorder.Header().Get("last-modified"))
	}
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x", nil)
	request.Host = "viewer.example"
	request.Header.Set("If-Modified-Since", "not a date")
	recorder = httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("unparseable If-Modified-Since = %d", recorder.Code)
	}
	if len(origin.requests) != 1 {
		t.Fatalf("origin calls = %d", len(origin.requests))
	}
}

func TestGatewayCustomErrorWithoutAPage(t *testing.T) {
	origin := OriginFunc(func(context.Context, OriginRequest) (OriginResponse, error) {
		return OriginResponse{StatusCode: 404, Body: []byte("missing")}, nil
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponseCode: 410, ErrorCachingMinTTL: 30}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 410 {
		t.Fatalf("custom error without a page = %d", recorder.Code)
	}
}

func TestGatewayCustomErrorPageFetchFailureKeepsTheOriginStatus(t *testing.T) {
	calls := 0
	origin := OriginFunc(func(context.Context, OriginRequest) (OriginResponse, error) {
		calls++
		if calls == 1 {
			return OriginResponse{StatusCode: 500, Body: []byte("boom")}, nil
		}
		return OriginResponse{}, context.DeadlineExceeded
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 500, ResponsePagePath: "/errors/500.html"}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != 500 || recorder.Body.String() != "boom" {
		t.Fatalf("failed page fetch = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestGatewayCachesOriginErrorsForTenSeconds(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	origin := OriginFunc(func(context.Context, OriginRequest) (OriginResponse, error) {
		return OriginResponse{StatusCode: 503, Body: []byte("down")}, nil
	})
	gateway := NewGateway(testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	gateway.Now = func() time.Time { return now }
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if gateway.Cache.Len() != 1 {
		t.Fatalf("cache entries = %d", gateway.Cache.Len())
	}
	now = now.Add(11 * time.Second)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Header().Get("x-cache") != cacheMissHeader {
		t.Fatalf("an origin error must expire after 10 seconds: %q", recorder.Header().Get("x-cache"))
	}
}

func TestCacheNilReceiverIsSafe(t *testing.T) {
	var cache *Cache
	if _, ok := cache.Get("k"); ok {
		t.Fatal("nil cache returned an entry")
	}
	cache.Set("k", CacheEntry{})
	cache.Delete("k")
	if cache.Len() != 0 || cache.Invalidate([]string{"/*"}) != 0 {
		t.Fatal("nil cache reported entries")
	}
}

func TestCacheHitHeaderAgeSemantics(t *testing.T) {
	response := OriginResponse{StatusCode: 200}
	setCacheHeaders(&response, cacheHitHeader, -1)
	if response.Header.Get("age") != "" {
		t.Fatalf("negative age must not be written: %q", response.Header.Get("age"))
	}
	setCacheHeaders(&response, cacheMissHeader, 0)
	if response.Header.Get("age") != "" {
		t.Fatalf("a miss must not carry age")
	}
}

func TestInvalidationAPIServesOnlyTheDocumentedRoutes(t *testing.T) {
	api := NewInvalidationAPI(nil, nil)
	server := httptest.NewServer(api)
	defer server.Close()

	response, err := http.Get(server.URL + cloudFrontAPIPrefix + "/distribution/EUNKNOWN/invalidation") //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusNotFound || !strings.Contains(body, "NoSuchDistribution") {
		t.Fatalf("unknown distribution = %d %s", response.StatusCode, body)
	}
	distributionID := api.Register("TestDistribution", NewCache())
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPut, server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", strings.NewReader(""))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	response, err = http.DefaultClient.Do(request) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported method = %d %s", response.StatusCode, body)
	}
	response, err = http.Post(server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", "text/xml", strings.NewReader("<not-xml")) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid XML = %d %s", response.StatusCode, body)
	}
	response, err = http.Get(server.URL + cloudFrontAPIPrefix + "/distribution/" + distributionID + "/invalidation/IMISSING") //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("get invalidation: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusNotFound || !strings.Contains(body, "NoSuchInvalidation") {
		t.Fatalf("missing invalidation = %d %s", response.StatusCode, body)
	}
}

func TestInvalidationBatchQuantityMustMatchTheList(t *testing.T) {
	api := NewInvalidationAPI(nil, nil)
	distributionID := api.Register("TestDistribution", NewCache())
	server := httptest.NewServer(api)
	defer server.Close()
	body := `<InvalidationBatch><Paths><Quantity>2</Quantity><Items><Path>/x</Path></Items></Paths><CallerReference>x</CallerReference></InvalidationBatch>`
	response, err := http.Post(server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", "text/xml", strings.NewReader(body)) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if payload := readAll(t, response); response.StatusCode != http.StatusBadRequest || !strings.Contains(payload, "declares Quantity 2 but lists 1 paths") {
		t.Fatalf("quantity mismatch = %d %s", response.StatusCode, payload)
	}
}

func TestInvalidationsReturnsNewestFirst(t *testing.T) {
	api := NewInvalidationAPI(func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }, nil)
	distributionID := api.Register("TestDistribution", NewCache())
	server := httptest.NewServer(api)
	defer server.Close()
	for index := 0; index < 2; index++ {
		body := `<InvalidationBatch><Paths><Quantity>1</Quantity><Items><Path>/x</Path></Items></Paths><CallerReference>x</CallerReference></InvalidationBatch>`
		response, err := http.Post(server.URL+cloudFrontAPIPrefix+"/distribution/"+distributionID+"/invalidation", "text/xml", strings.NewReader(body)) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		_ = readAll(t, response)
	}
	invalidations := api.Invalidations()
	if len(invalidations) != 2 || invalidations[0].CreateTime.Before(invalidations[1].CreateTime) {
		t.Fatalf("invalidations = %+v", invalidations)
	}
}

func TestCacheDeleteAndCacheControlEdgeDirectives(t *testing.T) {
	cache := NewCache()
	cache.Set("k", CacheEntry{Path: "/x"})
	cache.Delete("k")
	if cache.Len() != 0 {
		t.Fatal("Delete did not remove the entry")
	}
	control := ParseCacheControl([]string{"stale-if-error=0, stale-while-revalidate=abc, max-age=not-a-number, s-maxage=-1"})
	if control.StaleIfError != 0 || control.StaleWhileRevalidate != 0 || control.MaxAge != nil || control.SMaxAge != nil {
		t.Fatalf("malformed directives = %+v", control)
	}
	if ParseCacheControl([]string{"max-age=30"}).MaxAge == nil || *ParseCacheControl([]string{"max-age=30"}).MaxAge != 30*time.Second {
		t.Fatal("max-age was not parsed")
	}
}

func TestGatewayCustomErrorPageDropsConditionalHeaders(t *testing.T) {
	var pageHeaders http.Header
	origin := OriginFunc(func(_ context.Context, request OriginRequest) (OriginResponse, error) {
		if request.URI == "/errors/404.html" {
			pageHeaders = request.Header.Clone()
			return OriginResponse{StatusCode: 200, Body: []byte("page")}, nil
		}
		return OriginResponse{StatusCode: 404, Body: []byte("missing")}, nil
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponsePagePath: "/errors/404.html", ResponseCode: 200}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://viewer.example/x", nil)
	request.Host = "viewer.example"
	request.Header.Set("If-None-Match", `"etag"`)
	request.Header.Set("X-Tenant", "t-1")
	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, request)
	if recorder.Code != 200 || recorder.Body.String() != "page" {
		t.Fatalf("custom page = %d %q", recorder.Code, recorder.Body.String())
	}
	if pageHeaders.Get("If-None-Match") != "" {
		t.Fatal("the conditional header reached the custom error page request")
	}
}
