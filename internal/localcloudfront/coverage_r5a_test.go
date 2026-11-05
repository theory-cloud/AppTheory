package localcloudfront

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayRequestFailuresAreNamed(t *testing.T) {
	t.Run("no distribution", func(t *testing.T) {
		gateway := NewGateway(nil, &Topology{}, nil, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("no distribution = %d", recorder.Code)
		}
	})
	t.Run("no behavior", func(t *testing.T) {
		distribution := testDistribution(nil, nil, testOrigin("origin", "origin.example"))
		gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("no behavior = %d", recorder.Code)
		}
	})
	t.Run("missing viewer-request function", func(t *testing.T) {
		behavior := testBehavior("*", "origin", []string{"GET"})
		behavior.ViewerRequestFunction = "Missing"
		gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("missing viewer-request = %d", recorder.Code)
		}
	})
	t.Run("missing viewer-response function", func(t *testing.T) {
		behavior := testBehavior("*", "origin", []string{"GET"})
		behavior.ViewerResponseFunction = "Missing"
		gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("missing viewer-response = %d", recorder.Code)
		}
	})
	t.Run("missing origin implementation", func(t *testing.T) {
		gateway := NewGateway(testDistribution(testBehavior("*", "origin", []string{"GET"}), nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{}, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("missing origin = %d", recorder.Code)
		}
	})
	t.Run("body too large", func(t *testing.T) {
		gateway := NewGateway(testDistribution(testBehavior("*", "origin", []string{"POST"}), nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
		gateway.MaxBody = 4
		recorder := serveGateway(gateway, http.MethodPost, "http://viewer.example/x", "0123456789", nil)
		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("body limit = %d", recorder.Code)
		}
	})
	t.Run("empty origin status", func(t *testing.T) {
		origin := OriginFunc(func(context.Context, OriginRequest) (OriginResponse, error) {
			return OriginResponse{}, nil
		})
		gateway := NewGateway(testDistribution(testBehavior("*", "origin", []string{"GET"}), nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": origin}, nil, nil)
		recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
		if recorder.Code != http.StatusBadGateway {
			t.Fatalf("empty origin status = %d", recorder.Code)
		}
	})
	t.Run("default methods", func(t *testing.T) {
		behavior := testBehavior("*", "origin", nil)
		gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
			&Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
		if recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil); recorder.Code != 200 {
			t.Fatalf("default GET = %d", recorder.Code)
		}
		if recorder := serveGateway(gateway, http.MethodPost, "http://viewer.example/x", "", nil); recorder.Code != http.StatusForbidden {
			t.Fatalf("default POST = %d", recorder.Code)
		}
	})
}

func TestGatewayViewerFunctionFailuresAreRefused(t *testing.T) {
	requestFunction := testFunction(runtimeJS20, `function handler(event) { return { response: { statusCode: 999 } }; }`)
	behavior := testBehavior("*", "origin", []string{"GET"})
	behavior.ViewerRequestFunction = requestFunction.LogicalID
	topology := &Topology{Functions: []*Function{requestFunction}, functionsByID: map[string]*Function{requestFunction.LogicalID: requestFunction}}
	gateway := NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
		topology, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid viewer-request response = %d", recorder.Code)
	}

	responseFunction := testFunction(runtimeJS20, `function handler(event) { event.response.statusCode = 42; return event.response; }`)
	behavior = testBehavior("*", "origin", []string{"GET"})
	behavior.ViewerResponseFunction = responseFunction.LogicalID
	topology = &Topology{Functions: []*Function{responseFunction}, functionsByID: map[string]*Function{responseFunction.LogicalID: responseFunction}}
	gateway = NewGateway(testDistribution(behavior, nil, testOrigin("origin", "origin.example")),
		topology, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
	recorder = serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid viewer-response response = %d", recorder.Code)
	}
}

func TestGatewayStatsWithoutRequests(t *testing.T) {
	gateway := NewGateway(testDistribution(testBehavior("*", "origin", []string{"GET"}), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": okOrigin("x")}, nil, nil)
	if stats := gateway.Stats(); len(stats) != 0 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestInvalidationAPIDistributionWithoutInvalidations(t *testing.T) {
	api := NewInvalidationAPI(nil, nil)
	distributionID := api.Register("TestDistribution", NewCache())
	server := httptest.NewServer(api)
	defer server.Close()

	response, err := http.Get(server.URL + cloudFrontAPIPrefix + "/distribution/" + distributionID) //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("get distribution: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("distribution route = %d %s", response.StatusCode, body)
	}
	response, err = http.Get(server.URL + "/not-the-cloudfront-api") //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("get outside prefix: %v", err)
	}
	if body := readAll(t, response); response.StatusCode != http.StatusNotFound || !strings.Contains(body, "2020-05-31") {
		t.Fatalf("outside prefix = %d %s", response.StatusCode, body)
	}
	response, err = http.Get(server.URL + cloudFrontAPIPrefix + "/distribution/" + distributionID + "/invalidation") //nolint:bodyclose,noctx // readAll closes it; a test client needs no context
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if body := readAll(t, response); !strings.Contains(body, "<Quantity>0</Quantity>") {
		t.Fatalf("empty list = %s", body)
	}
}

func TestCacheInvalidationEdgeCases(t *testing.T) {
	cache := NewCache()
	now := time.Now()
	cache.Set("bad-escape", CacheEntry{Path: "/x", StoredAt: now, ExpiresAt: now.Add(time.Hour)})
	if removed := cache.Invalidate([]string{"/%zz"}); removed != 0 {
		t.Fatalf("a malformed escape must not match: %d", removed)
	}
	cache.Set("relative", CacheEntry{Path: "/x", StoredAt: now, ExpiresAt: now.Add(time.Hour)})
	if removed := cache.Invalidate([]string{"x"}); removed != 0 {
		t.Fatalf("a relative path must not match: %d", removed)
	}
	if entry := (CacheEntry{ExpiresAt: now}); entry.ServeStaleIfError(now.Add(time.Second), 0) {
		t.Fatal("an entry without stale-if-error must not serve stale")
	}
	if value := originHeaderValue(http.Header{}, "ETag"); value != "" {
		t.Fatalf("an empty header must not be found: %q", value)
	}
	_ = originHeaderValues(http.Header{"X-Test": nil}, "X-Test")
	if _, ok := parseHTTPDate("not a date"); ok {
		t.Fatal("a malformed date must not parse")
	}
	if key := selectedHeaderKey(http.Header{"X-Empty": {}}, newForwardingRule()); key != "" {
		t.Fatalf("empty header value key = %q", key)
	}
}

func TestOriginHeaderLookupIsCaseInsensitive(t *testing.T) {
	header := http.Header{"cache-control": []string{"max-age=10"}}
	if got := originHeaderValue(header, "Cache-Control"); got != "max-age=10" {
		t.Fatalf("case-insensitive lookup = %q", got)
	}
	ttl, _ := (CachePolicy{DefaultTTL: 60}).OriginTTL(OriginResponse{StatusCode: 200, Header: header}, time.Now())
	if int(ttl.Seconds()) != 10 {
		t.Fatalf("ttl = %ds", int(ttl.Seconds()))
	}
}

func TestCustomErrorResponseWithZeroResponseCode(t *testing.T) {
	origin := OriginFunc(func(_ context.Context, request OriginRequest) (OriginResponse, error) {
		if request.URI == "/page" {
			return OriginResponse{StatusCode: 200, Body: []byte("page")}, nil
		}
		return OriginResponse{StatusCode: 404}, nil
	})
	distribution := testDistribution(cachedBehavior(cachePolicy(60, 3600, 0)), nil, testOrigin("origin", "origin.example"))
	distribution.CustomErrorResponses = []CustomErrorResponse{{ErrorCode: 404, ResponsePagePath: "/page"}}
	gateway := NewGateway(distribution, &Topology{}, map[string]Origin{"origin": origin}, nil, nil)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "page" {
		t.Fatalf("zero response code = %d %q", recorder.Code, recorder.Body.String())
	}
}
