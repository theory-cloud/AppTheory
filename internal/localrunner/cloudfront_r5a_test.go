package localrunner

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

func TestValidateOriginOverridesRefusesNonLoopback(t *testing.T) {
	if err := validateOriginOverrides(map[string]string{"api.example.com": "https://example.com"}); err == nil {
		t.Fatal("a non-loopback origin override must be refused")
	}
	for _, raw := range []string{"http://127.0.0.1:9000", "http://localhost:9000", "http://[::1]:9000"} {
		if err := validateOriginOverrides(map[string]string{"api.example.com": raw}); err != nil {
			t.Fatalf("%s: %v", raw, err)
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
