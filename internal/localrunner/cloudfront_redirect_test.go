package localrunner

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// CloudFront returns a custom origin's redirect to the viewer and never follows
// it, so the origin hop must hand back the 3xx with its Location and its other
// headers unchanged, over TLS and over plain http.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html

const redirectTestPath = "action=sso"

// redirectTestOrigin builds the origin one protocol mode fetches. The same
// handler answers every status under /status/<code>.
func redirectTestOrigin(t *testing.T, withTLS bool, handler http.HandlerFunc) *httpOrigin {
	t.Helper()
	if withTLS {
		state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
		if err != nil {
			t.Fatalf("create the run CA: %v", err)
		}
		leaf, err := state.issueCertificate([]string{"auth-api.localhost"}, nil)
		if err != nil {
			t.Fatalf("issue the origin leaf: %v", err)
		}
		server, _ := tlsOriginTestServer(t, leaf, handler)
		parsed := mustParseURL(t, server.URL)
		return mustTestHTTPOrigin(t, state, "https", parsed.Port())
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	parsed := mustParseURL(t, server.URL)
	return mustTestHTTPOrigin(t, nil, "http", parsed.Port())
}

func mustTestHTTPOrigin(t *testing.T, state *localTLS, scheme, port string) *httpOrigin {
	t.Helper()
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID:         "api",
		DomainName: "auth-api.localhost",
		Kind:       localcloudfront.OriginCustom,
		LocalURL:   scheme + "://127.0.0.1:" + port,
		Custom:     &localcloudfront.CustomOrigin{ProtocolPolicy: "https-only"},
	}, state)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	return origin
}

func TestHTTPOriginReturnsAnOriginRedirectInsteadOfFollowingIt(t *testing.T) {
	var targetHits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		writer.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	location := target.URL + "/landing?session=abc"

	for _, withTLS := range []bool{false, true} {
		name := "http"
		if withTLS {
			name = "tls"
		}
		t.Run(name, func(t *testing.T) {
			var originHits atomic.Int64
			handler := func(writer http.ResponseWriter, request *http.Request) {
				originHits.Add(1)
				var status int
				if _, err := fmt.Sscanf(strings.TrimPrefix(request.URL.Path, "/status/"), "%d", &status); err != nil {
					t.Errorf("origin path %q carries no status: %v", request.URL.Path, err)
					return
				}
				if request.Method == http.MethodPost {
					payload, readErr := io.ReadAll(request.Body)
					if readErr != nil {
						t.Errorf("read the origin request body: %v", readErr)
					}
					if string(payload) != redirectTestPath {
						t.Errorf("origin request body = %q, want %q", payload, redirectTestPath)
					}
				}
				writer.Header().Set("Location", location)
				writer.Header().Add("Set-Cookie", "session=one; Path=/; HttpOnly")
				writer.Header().Add("Set-Cookie", "session=two; Path=/; SameSite=Lax")
				writer.Header().Set("X-Origin-Marker", "kept")
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte("redirect body"))
			}
			origin := redirectTestOrigin(t, withTLS, handler)

			for _, status := range []int{301, 302, 303, 307, 308} {
				t.Run(fmt.Sprintf("%d", status), func(t *testing.T) {
					method, body := http.MethodGet, ""
					if status == 303 || status == 307 || status == 308 {
						method, body = http.MethodPost, redirectTestPath
					}
					response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
						Method: method,
						URI:    fmt.Sprintf("/status/%d", status),
						Body:   []byte(body),
					})
					if err != nil {
						t.Fatalf("fetch the origin redirect: %v", err)
					}
					if response.StatusCode != status {
						t.Fatalf("status = %d, want %d", response.StatusCode, status)
					}
					if got := response.Header.Get("Location"); got != location {
						t.Fatalf("Location = %q, want %q", got, location)
					}
					cookies := response.Header.Values("Set-Cookie")
					if len(cookies) != 2 || cookies[0] != "session=one; Path=/; HttpOnly" ||
						cookies[1] != "session=two; Path=/; SameSite=Lax" {
						t.Fatalf("Set-Cookie = %q, want both values in order", cookies)
					}
					if got := response.Header.Get("X-Origin-Marker"); got != "kept" {
						t.Fatalf("the other origin headers changed: X-Origin-Marker = %q", got)
					}
					if string(response.Body) != "redirect body" {
						t.Fatalf("body = %q, want the origin's body", response.Body)
					}
				})
			}
			if got := originHits.Load(); got != 5 {
				t.Fatalf("the origin answered %d requests, want one per redirect status", got)
			}
		})
	}
	if got := targetHits.Load(); got != 0 {
		t.Fatalf("the redirect target received %d requests; the hop must not follow a redirect", got)
	}
}

func TestHTTPOriginKeepsARelativeLocation(t *testing.T) {
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		writer.Header().Set("Location", "/login?next=%2Fhome")
		writer.WriteHeader(http.StatusFound)
	}))
	defer server.Close()
	origin := mustTestHTTPOrigin(t, nil, "http", mustParseURL(t, server.URL).Port())

	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/auth/authorize"})
	if err != nil {
		t.Fatalf("fetch the origin redirect: %v", err)
	}
	if response.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", response.StatusCode)
	}
	if got := response.Header.Get("Location"); got != "/login?next=%2Fhome" {
		t.Fatalf("Location = %q, want the origin's relative value unchanged", got)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("the origin answered %d requests, want exactly one", got)
	}
}

func TestHTTPOriginPassesAConditionalResponseThrough(t *testing.T) {
	for _, withTLS := range []bool{false, true} {
		name := "http"
		if withTLS {
			name = "tls"
		}
		t.Run(name, func(t *testing.T) {
			server := func(writer http.ResponseWriter, request *http.Request) {
				if got := request.Header.Get("If-None-Match"); got != `"v1"` {
					t.Errorf("origin If-None-Match = %q, want the viewer's validator", got)
				}
				writer.Header().Set("ETag", `"v1"`)
				writer.Header().Set("Last-Modified", "Wed, 01 Jan 2025 00:00:00 GMT")
				writer.WriteHeader(http.StatusNotModified)
			}
			var origin *httpOrigin
			if withTLS {
				state, err := newLocalTLS(filepath.Join(t.TempDir(), "tls"), "app.localhost")
				if err != nil {
					t.Fatalf("create the run CA: %v", err)
				}
				leaf, err := state.issueCertificate([]string{"auth-api.localhost"}, nil)
				if err != nil {
					t.Fatalf("issue the origin leaf: %v", err)
				}
				tlsServer, _ := tlsOriginTestServer(t, leaf, server)
				origin = mustTestHTTPOrigin(t, state, "https", mustParseURL(t, tlsServer.URL).Port())
			} else {
				plain := httptest.NewServer(http.HandlerFunc(server))
				defer plain.Close()
				origin = mustTestHTTPOrigin(t, nil, "http", mustParseURL(t, plain.URL).Port())
			}

			response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
				Method: http.MethodGet,
				URI:    "/asset.json",
				Header: http.Header{"If-None-Match": []string{`"v1"`}},
			})
			if err != nil {
				t.Fatalf("fetch the origin conditional response: %v", err)
			}
			if response.StatusCode != http.StatusNotModified {
				t.Fatalf("status = %d, want 304", response.StatusCode)
			}
			if got := response.Header.Get("ETag"); got != `"v1"` {
				t.Fatalf("ETag = %q, want the origin's validator", got)
			}
			if got := response.Header.Get("Last-Modified"); got != "Wed, 01 Jan 2025 00:00:00 GMT" {
				t.Fatalf("Last-Modified = %q, want the origin's validator", got)
			}
			if len(response.Body) != 0 {
				t.Fatalf("a 304 carries no body, got %q", response.Body)
			}
		})
	}
}
