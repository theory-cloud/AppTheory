package localrunner

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

func TestValidateOriginOverridesRefusesNonLoopback(t *testing.T) {
	if err := validateOriginOverrides(map[string]string{"api.example.com": "https://example.com"}); err == nil {
		t.Fatal("a non-loopback origin override must be refused")
	}
	for _, raw := range []string{"http://127.0.0.1:9000", "http://localhost:9000", "http://[::1]:9000", "https://app.localhost:9000", "https://auth-api.localhost"} {
		if err := validateOriginOverrides(map[string]string{"api.example.com": raw}); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://app.localhost.example.com:9000", "http://10.0.0.1:9000", "http://example.com"} {
		if err := validateOriginOverrides(map[string]string{"api.example.com": raw}); err == nil {
			t.Fatalf("%s: a non-loopback mapping must be refused", raw)
		}
	}
	if err := validateOriginOverrides(map[string]string{"": "http://127.0.0.1:9000"}); err == nil {
		t.Fatal("an empty domain must be refused")
	}
}

func TestApplyOriginOverridesMapsAndRefuses(t *testing.T) {
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{{
		LogicalID: "Distribution",
		Enabled:   true,
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern:    "*",
			TargetOriginID: "api",
			CachePolicy:    &localcloudfront.Policy{Kind: localcloudfront.PolicyCache, Cache: &localcloudfront.CachePolicy{DefaultTTL: 60}},
		},
		Origins: []*localcloudfront.DistributionOrigin{{
			ID: "api", DomainName: "api.example.com", Kind: localcloudfront.OriginCustom,
			Custom: &localcloudfront.CustomOrigin{},
		}},
	}}}
	runner := &Runner{options: Options{}}
	if err := runner.applyOriginOverrides(spec); err != nil {
		t.Fatalf("apply: %v", err)
	}
	distribution := spec.CloudFront[0]
	if distribution.Servable() {
		t.Fatal("an unmapped external origin must refuse the distribution")
	}
	if len(spec.Skipped) != 1 || !strings.Contains(spec.Skipped[0].Reason, "--origin api.example.com=") {
		t.Fatalf("skipped = %+v", spec.Skipped)
	}

	mapped := &Runner{options: Options{Origins: map[string]string{"api.example.com": "http://127.0.0.1:9000"}}}
	spec.CloudFront[0].Refusals = nil
	spec.Skipped = nil
	if err := mapped.applyOriginOverrides(spec); err != nil {
		t.Fatalf("apply mapped: %v", err)
	}
	if !spec.CloudFront[0].Servable() {
		t.Fatalf("a mapped origin must be servable: %+v", spec.CloudFront[0].Refusals)
	}
	if spec.CloudFront[0].Origins[0].LocalURL != "http://127.0.0.1:9000" {
		t.Fatalf("local URL = %q", spec.CloudFront[0].Origins[0].LocalURL)
	}
}

func TestApplyOriginOverridesLogsUndeclaredDomains(t *testing.T) {
	var output bytes.Buffer
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{{
		LogicalID: "Distribution",
		Enabled:   true,
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern:    "*",
			TargetOriginID: "api",
			CachePolicy:    &localcloudfront.Policy{Kind: localcloudfront.PolicyCache, Cache: &localcloudfront.CachePolicy{DefaultTTL: 60}},
		},
		Origins: []*localcloudfront.DistributionOrigin{{
			ID: "api", DomainName: "api.example.com", Kind: localcloudfront.OriginCustom,
			Custom: &localcloudfront.CustomOrigin{},
		}},
	}}}
	runner := &Runner{options: Options{
		Stdout: &output,
		Origins: map[string]string{
			"api.example.com":        "http://127.0.0.1:9000",
			"undeclared.example.com": "http://127.0.0.1:9001",
		},
	}}
	if err := runner.applyOriginOverrides(spec); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !strings.Contains(output.String(), "undeclared.example.com") {
		t.Fatalf("an --origin mapping for an undeclared domain was ignored silently: %q", output.String())
	}
}

func TestHTTPOriginSendsTheOriginRequest(t *testing.T) {
	observed := make(chan *http.Request, 1)
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			return
		}
		body = string(payload)
		observed <- request
		writer.Header().Set("x-origin", "yes")
		if _, err := writer.Write([]byte("origin body")); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()

	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:            "api",
		DomainName:    "api.example.com",
		Kind:          localcloudfront.OriginCustom,
		LocalURL:      server.URL,
		Custom:        &localcloudfront.CustomOrigin{},
		CustomHeaders: map[string]string{"x-origin-key": "local"},
	}, nil)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method:   http.MethodPost,
		URI:      "/orders/7",
		Query:    "q=1",
		Host:     "api.example.com",
		Header:   http.Header{"X-Tenant": []string{"t-1"}},
		Body:     []byte(`{"hello":"world"}`),
		OriginID: "api",
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != 200 || string(response.Body) != "origin body" || response.Header.Get("x-origin") != "yes" {
		t.Fatalf("response = %+v", response)
	}
	request := <-observed
	if request.Method != http.MethodPost || request.URL.Path != "/orders/7" || request.URL.RawQuery != "q=1" {
		t.Fatalf("origin request = %s %s?%s", request.Method, request.URL.Path, request.URL.RawQuery)
	}
	if request.Header.Get("X-Tenant") != "t-1" || request.Header.Get("x-origin-key") != "local" {
		t.Fatalf("origin headers = %+v", request.Header)
	}
	if request.Host != "api.example.com" {
		t.Fatalf("origin Host = %q", request.Host)
	}
	if body != `{"hello":"world"}` {
		t.Fatalf("origin body = %q", body)
	}
}

func TestStartCloudFrontControlInjectsLoopbackEndpoints(t *testing.T) {
	runner := &Runner{
		options:            Options{Stdout: io.Discard},
		endpoints:          nil,
		cloudFrontAPI:      localcloudfront.NewInvalidationAPI(nil, nil),
		cloudFrontGateways: map[string]*localcloudfront.Gateway{},
		cloudFrontIDs:      map[string]string{},
	}
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{servableTestDistribution()}}
	if err := runner.startCloudFrontControl(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	if runner.cloudFrontAPIURL == "" || !strings.HasPrefix(runner.cloudFrontAPIURL, "http://127.0.0.1:") {
		t.Fatalf("control URL = %q", runner.cloudFrontAPIURL)
	}
	if len(runner.endpoints) != 1 || runner.endpoints[0].Service != "cloudfront" {
		t.Fatalf("endpoints = %+v", runner.endpoints)
	}
	if !strings.HasPrefix(runner.endpoints[0].URL, "http://host.docker.internal:") {
		t.Fatalf("container endpoint = %q", runner.endpoints[0].URL)
	}
	if !containsAddHost(runner.options.AddHosts, "host.docker.internal:host-gateway") {
		t.Fatalf("add-host missing: %+v", runner.options.AddHosts)
	}
	for _, server := range runner.servers {
		_ = server.Close() //nolint:errcheck // test teardown
	}
	for _, listener := range runner.listeners {
		_ = listener.Close() //nolint:errcheck // test teardown
	}
	empty := &Runner{options: Options{Stdout: io.Discard}, cloudFrontAPI: localcloudfront.NewInvalidationAPI(nil, nil)}
	if err := empty.startCloudFrontControl(context.Background(), &Spec{}); err != nil {
		t.Fatalf("no distribution: %v", err)
	}
	if empty.cloudFrontAPIURL != "" {
		t.Fatal("a run with no distribution must not start the control API")
	}
}

func servableTestDistribution() *localcloudfront.Distribution {
	return &localcloudfront.Distribution{
		LogicalID: "Distribution",
		Enabled:   true,
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern:    "*",
			TargetOriginID: "origin",
			CachePolicy:    &localcloudfront.Policy{Kind: localcloudfront.PolicyCache, Cache: &localcloudfront.CachePolicy{DefaultTTL: 60}},
		},
		Origins: []*localcloudfront.DistributionOrigin{{ID: "origin", DomainName: "origin.example", Kind: localcloudfront.OriginCustom, Custom: &localcloudfront.CustomOrigin{}}},
	}
}

func TestJoinOriginPath(t *testing.T) {
	cases := map[[2]string]string{
		{"", "/x"}:       "/x",
		{"/", "/x"}:      "/x",
		{"/", "x"}:       "/x",
		{"/prod", "/x"}:  "/prod/x",
		{"/prod/", "/x"}: "/prod/x",
		{"/prod", "x"}:   "/prod/x",
	}
	for input, want := range cases {
		if got := joinOriginPath(input[0], input[1]); got != want {
			t.Fatalf("joinOriginPath(%q, %q) = %q, want %q", input[0], input[1], got, want)
		}
	}
}

func TestNewHTTPOriginRefusesAnUnusableURL(t *testing.T) {
	for _, origin := range []*localcloudfront.DistributionOrigin{
		{ID: "a", LocalURL: ""},
		{ID: "b", LocalURL: "ftp://127.0.0.1:9000"},
		{ID: "c", LocalURL: "not a url"},
	} {
		if _, err := newHTTPOrigin(origin, nil); err == nil {
			t.Fatalf("origin %+v must be refused", origin)
		}
	}
}

func TestSessionDescribeReportsCloudFrontCacheAndInvalidations(t *testing.T) {
	distribution := servableTestDistribution()
	api := localcloudfront.NewInvalidationAPI(nil, nil)
	gateway := localcloudfront.NewGateway(distribution, &localcloudfront.Topology{}, map[string]localcloudfront.Origin{
		"origin": localcloudfront.OriginFunc(func(context.Context, localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
			return localcloudfront.OriginResponse{StatusCode: 200, Body: []byte("ok")}, nil
		}),
	}, nil, nil)
	distributionID := api.Register(distribution.LogicalID, gateway.Cache)
	runner := &Runner{
		apiURLs:            map[string]string{"Distribution": "http://127.0.0.1:1234"},
		cloudFrontAPI:      api,
		cloudFrontAPIURL:   "http://127.0.0.1:9999",
		cloudFrontGateways: map[string]*localcloudfront.Gateway{"Distribution": gateway},
		cloudFrontIDs:      map[string]string{"Distribution": distributionID},
	}
	session := &localSession{runner: runner, spec: &Spec{CloudFront: []*localcloudfront.Distribution{distribution}}}
	described, err := session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	entries, ok := described["cloudFront"].([]map[string]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("cloudFront = %+v", described["cloudFront"])
	}
	entry := entries[0]
	if entry["distributionId"] != distributionID {
		t.Fatalf("distributionId = %v", entry["distributionId"])
	}
	if entry["invalidationEndpoint"] != "http://127.0.0.1:9999" {
		t.Fatalf("invalidationEndpoint = %v", entry["invalidationEndpoint"])
	}
	if _, ok := entry["cache"]; !ok {
		t.Fatalf("cache stats missing: %+v", entry)
	}
	if _, ok := entry["invalidations"]; ok {
		t.Fatalf("an empty invalidation list must be omitted: %+v", entry)
	}
}
