package localrunner

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// CloudFront origin TLS: the hop from the local gateway to a mapped origin.
// CloudFront requires the origin certificate to name the origin's declared
// domain, so a run that serves the app over TLS must verify that name against
// its own CA and present it as SNI.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginProtocolPolicy

func tlsOriginTestServer(t *testing.T, certificate tls.Certificate, handler http.HandlerFunc) (*httptest.Server, func() string) {
	t.Helper()
	var (
		mu  sync.Mutex
		sni string
	)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{certificate},
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			mu.Lock()
			sni = hello.ServerName
			mu.Unlock()
			return nil, nil
		},
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, func() string {
		mu.Lock()
		defer mu.Unlock()
		return sni
	}
}

func TestHTTPOriginVerifiesTheRunCAForADeclaredOriginName(t *testing.T) {
	state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("create the run CA: %v", err)
	}
	leaf, err := state.issueCertificate([]string{"auth-api.localhost"}, nil)
	if err != nil {
		t.Fatalf("issue the origin leaf: %v", err)
	}
	server, writtenSNI := tlsOriginTestServer(t, leaf, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("x-origin-host", request.Host)
		if _, writeErr := writer.Write([]byte("origin ok")); writeErr != nil {
			t.Errorf("write the origin response: %v", writeErr)
		}
	})
	parsed := mustParseURL(t, server.URL)
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:         "api",
		DomainName: "auth-api.localhost",
		Kind:       localcloudfront.OriginCustom,
		LocalURL:   "https://127.0.0.1:" + parsed.Port(),
		Custom:     &localcloudfront.CustomOrigin{ProtocolPolicy: "https-only"},
	}, state)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method: http.MethodGet,
		URI:    "/.well-known/openid-configuration",
	})
	if err != nil {
		t.Fatalf("fetch through the run CA: %v", err)
	}
	if response.StatusCode != http.StatusOK || string(response.Body) != "origin ok" {
		t.Fatalf("origin response = %d %q", response.StatusCode, response.Body)
	}
	if got := response.Header.Get("x-origin-host"); got != "auth-api.localhost" {
		t.Fatalf("origin Host header = %q, want the declared origin domain", got)
	}
	if got := writtenSNI(); got != "auth-api.localhost" {
		t.Fatalf("origin SNI = %q, want the declared origin domain", got)
	}
}

func TestHTTPOriginVerifiesTheMappedHostForANonLocalOriginName(t *testing.T) {
	state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("create the run CA: %v", err)
	}
	leaf, err := state.issueCertificate([]string{"api.localhost"}, nil)
	if err != nil {
		t.Fatalf("issue the origin leaf: %v", err)
	}
	server, writtenSNI := tlsOriginTestServer(t, leaf, func(writer http.ResponseWriter, _ *http.Request) {
		if _, writeErr := writer.Write([]byte("ok")); writeErr != nil {
			t.Errorf("write the origin response: %v", writeErr)
		}
	})
	parsed := mustParseURL(t, server.URL)
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:         "api",
		DomainName: "api.example.com",
		Kind:       localcloudfront.OriginCustom,
		LocalURL:   "https://api.localhost:" + parsed.Port(),
		Custom:     &localcloudfront.CustomOrigin{ProtocolPolicy: "https-only"},
	}, state)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	if _, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/"}); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got := writtenSNI(); got != "api.localhost" {
		t.Fatalf("origin SNI = %q, want the mapped host", got)
	}
}

func TestHTTPOriginRefusesAnUntrustedOriginCertificate(t *testing.T) {
	state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
	if err != nil {
		t.Fatalf("create the run CA: %v", err)
	}
	other, err := newLocalTLS(filepath.Join(t.TempDir(), "other"), "app.localhost")
	if err != nil {
		t.Fatalf("create the second CA: %v", err)
	}
	leaf, err := other.issueCertificate([]string{"auth-api.localhost"}, nil)
	if err != nil {
		t.Fatalf("issue the origin leaf: %v", err)
	}
	server, _ := tlsOriginTestServer(t, leaf, func(writer http.ResponseWriter, _ *http.Request) {
		if _, writeErr := writer.Write([]byte("ok")); writeErr != nil {
			t.Errorf("write the origin response: %v", writeErr)
		}
	})
	parsed := mustParseURL(t, server.URL)
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:         "api",
		DomainName: "auth-api.localhost",
		Kind:       localcloudfront.OriginCustom,
		LocalURL:   "https://127.0.0.1:" + parsed.Port(),
	}, state)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	_, err = origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/"})
	var unavailable *localcloudfront.OriginUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("an origin certificate from another CA must be refused, got %v", err)
	}
	if !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("the refusal does not name the certificate: %v", err)
	}
}

func TestHTTPOriginReportsPlainHTTPToATLSListener(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if _, writeErr := writer.Write([]byte("ok")); writeErr != nil {
			t.Errorf("write the origin response: %v", writeErr)
		}
	}))
	defer server.Close()
	parsed := mustParseURL(t, server.URL)
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:         "api",
		DomainName: "auth-api.localhost",
		Kind:       localcloudfront.OriginCustom,
		LocalURL:   "http://127.0.0.1:" + parsed.Port(),
		Custom:     &localcloudfront.CustomOrigin{ProtocolPolicy: "http-only"},
	}, nil)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	_, err = origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/auth/session"})
	var unavailable *localcloudfront.OriginUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("a plain request to a TLS listener must be a named error, got %v", err)
	}
	for _, want := range []string{"https", "HTTPS_ONLY", "--origin auth-api.localhost="} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error %q does not mention %q", err, want)
		}
	}
}

func TestValidateOriginMappingRefusesPlainHTTPToARunListener(t *testing.T) {
	runner := &Runner{tls: &localTLS{host: "app.localhost"}, publicPorts: map[int]bool{8260: true}}
	origin := &localcloudfront.DistributionOrigin{
		ID: "api", DomainName: "auth-api.localhost", Kind: localcloudfront.OriginCustom,
		LocalURL: "http://127.0.0.1:8260",
		Custom:   &localcloudfront.CustomOrigin{ProtocolPolicy: "http-only"},
	}
	err := runner.validateOriginMapping(origin)
	if err == nil {
		t.Fatal("a plain mapping to a run TLS listener must be refused")
	}
	for _, want := range []string{"http-only", "HTTPS_ONLY", "https://app.localhost:"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the error %q does not mention %q", err, want)
		}
	}

	if err := (&Runner{publicPorts: map[int]bool{8260: true}}).validateOriginMapping(origin); err != nil {
		t.Fatalf("a run without TLS serves plain http: %v", err)
	}
	other := *origin
	other.LocalURL = "http://127.0.0.1:9000"
	if err := runner.validateOriginMapping(&other); err != nil {
		t.Fatalf("a mapping to another local service keeps working: %v", err)
	}
	secure := *origin
	secure.LocalURL = "https://app.localhost:8260"
	if err := runner.validateOriginMapping(&secure); err != nil {
		t.Fatalf("an https mapping to a run listener is the supported form: %v", err)
	}
}

func TestTLSOriginNamesNamesMappedLocalOriginsOnly(t *testing.T) {
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{
		{Origins: []*localcloudfront.DistributionOrigin{
			{ID: "a", DomainName: "Auth-API.localhost", Kind: localcloudfront.OriginCustom, LocalURL: "https://app.localhost:9000"},
			{ID: "b", DomainName: "api.example.com", Kind: localcloudfront.OriginCustom, LocalURL: "https://app.localhost:9001"},
			{ID: "c", DomainName: "unmapped.localhost", Kind: localcloudfront.OriginCustom},
			{ID: "d", DomainName: "bucket.s3.amazonaws.com", Kind: localcloudfront.OriginS3},
			{ID: "e", DomainName: "auth-api.localhost", Kind: localcloudfront.OriginCustom, LocalURL: "https://app.localhost:9000"},
		}},
	}}
	got := tlsOriginNames(spec)
	if strings.Join(got, ",") != "auth-api.localhost" {
		t.Fatalf("origin names = %v, want the one mapped local name", got)
	}
	if tlsOriginNames(nil) != nil {
		t.Fatal("a nil spec has no origin names")
	}
}

func TestInitTLSIssuesTheDeclaredOriginNames(t *testing.T) {
	runner := &Runner{
		options: Options{TLS: true, TLSHost: "app.localhost"},
		scratch: t.TempDir(),
	}
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{
		{Origins: []*localcloudfront.DistributionOrigin{
			{ID: "a", DomainName: "auth-api.localhost", Kind: localcloudfront.OriginCustom, LocalURL: "https://app.localhost:9000"},
			{ID: "b", DomainName: "api.example.com", Kind: localcloudfront.OriginCustom, LocalURL: "https://app.localhost:9001"},
		}},
	}}
	if err := runner.initTLS(spec); err != nil {
		t.Fatalf("initTLS: %v", err)
	}
	certificate, err := x509.ParseCertificate(runner.tls.publicLeaf.Certificate[0])
	if err != nil {
		t.Fatalf("parse the public leaf: %v", err)
	}
	names := strings.Join(certificate.DNSNames, ",")
	if !strings.Contains(names, "app.localhost") || !strings.Contains(names, "auth-api.localhost") {
		t.Fatalf("leaf DNS names = %q", names)
	}
	for _, name := range certificate.DNSNames {
		if name == "api.example.com" {
			t.Fatal("the leaf must not name a public origin domain")
		}
	}
	if got := originServerName(&localcloudfront.DistributionOrigin{DomainName: "auth-api.localhost"}, mustParseURL(t, "https://127.0.0.1:9000")); got != "auth-api.localhost" {
		t.Fatalf("originServerName = %q", got)
	}
	if got := originServerName(&localcloudfront.DistributionOrigin{DomainName: "api.example.com"}, mustParseURL(t, "https://app.localhost:9000")); got != "app.localhost" {
		t.Fatalf("originServerName fallback = %q", got)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed
}
