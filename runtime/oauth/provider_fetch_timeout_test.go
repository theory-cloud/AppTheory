package oauth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	oauthruntime "github.com/theory-cloud/apptheory/v7/runtime/oauth"
)

// theAdapterImplementsTheFetchTimeoutReporter pins that the adapter satisfies the
// optional reporter by interface, not by convention.
var _ oauthruntime.UpstreamFetchTimeoutReporter = (*oauthruntime.AutheoryProvider)(nil)

// theAdapterImplementsTheFetchTimeoutReporter pins that the adapter satisfies the
// optional reporter by interface, not by convention.
var _ oauthruntime.UpstreamFetchTimeoutReporter = (*oauthruntime.AutheoryProvider)(nil)

// theAdapterAnswersForItsTransportBound pins that the Autheory adapter reports
// the bound its own transport enforces, so a caller can tell whether the
// deadline it intends to impose is the deadline that will be enforced.
func TestAutheoryProviderReportsItsUpstreamFetchTimeout(t *testing.T) {
	// A default-configured adapter reports the framework's 10 s bound, which is
	// the value issue #1283 found silently capping an encoded 12 s budget.
	provider, err := oauthruntime.NewAutheoryProvider(oauthruntime.AutheoryProviderOptions{
		Issuer: "https://auth.example.test",
	})
	if err != nil {
		t.Fatalf("new autheory provider: %v", err)
	}
	if got := provider.UpstreamFetchTimeout(); got != 10*time.Second {
		t.Fatalf("default upstream fetch timeout = %s, want 10s", got)
	}

	// An explicit bound is reported as configured, and a caller-supplied client
	// timeout is the resolved bound when no override is given.
	for _, testCase := range []struct {
		name      string
		options   oauthruntime.AutheoryProviderOptions
		wantBound time.Duration
	}{
		{
			name:      "explicit override",
			options:   oauthruntime.AutheoryProviderOptions{Issuer: "https://auth.example.test", FetchTimeout: 12 * time.Second},
			wantBound: 12 * time.Second,
		},
		{
			name: "caller client timeout",
			options: oauthruntime.AutheoryProviderOptions{
				Issuer:     "https://auth.example.test",
				HTTPClient: &http.Client{Timeout: 3 * time.Second},
			},
			wantBound: 3 * time.Second,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			other, err := oauthruntime.NewAutheoryProvider(testCase.options)
			if err != nil {
				t.Fatalf("new autheory provider: %v", err)
			}
			if got := other.UpstreamFetchTimeout(); got != testCase.wantBound {
				t.Fatalf("upstream fetch timeout = %s, want %s", got, testCase.wantBound)
			}
		})
	}
}

// TestAutheoryProviderTransportBoundEndsTheCallBeforeALongerDeadline pins the
// mechanism behind issue #1283: the transport's own bound ends the refresh call,
// so a longer context deadline is never reached. An encoded budget above the
// bound would therefore be a claim the adapter quietly contradicts, which is
// why the facade refuses that combination at registration instead of accepting
// it.
func TestAutheoryProviderTransportBoundEndsTheCallBeforeALongerDeadline(t *testing.T) {
	holds := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-holds:
		case <-time.After(5 * time.Second):
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	defer close(holds)

	provider, err := oauthruntime.NewAutheoryProvider(oauthruntime.AutheoryProviderOptions{
		Issuer:            "https://auth.example.test",
		TokenEndpoint:     upstream.URL + "/token",
		HTTPClient:        upstream.Client(),
		AllowPrivateHosts: true,
		FetchTimeout:      150 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("new autheory provider: %v", err)
	}

	// The caller's deadline is longer than the transport bound; the transport
	// wins, exactly as it did for the 12 s budget in the soak.
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	started := time.Now()
	_, err = provider.Refresh(ctx, oauthruntime.RefreshRequest{
		RefreshMaterial:  "upstream-refresh-material",
		UpstreamClientID: "mcp_facade_client",
	})
	elapsed := time.Since(started)

	if err == nil {
		t.Fatalf("refresh against a hanging upstream = nil error, want a bounded failure")
	}
	if ctx.Err() != nil {
		t.Fatalf("the 12s deadline ended the call instead of the 150ms transport bound: %v", ctx.Err())
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("refresh took %s, want the 150ms transport bound to end it", elapsed)
	}
}
