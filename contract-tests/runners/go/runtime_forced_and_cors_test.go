package main

import (
	"encoding/json"
	"testing"
)

func TestFixtureApp_HandleP1_CORSPreflight_Returns204(t *testing.T) {
	t.Parallel()

	app, err := newFixtureApp(FixtureSetup{
		Routes: []FixtureRoute{
			{Method: "GET", Path: "/ping", Handler: "static_pong"},
		},
	}, "p1")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	resp := app.handle(CanonicalRequest{
		Method: "OPTIONS",
		Path:   "/ping",
		Headers: map[string][]string{
			"origin":                        {"https://example.com"},
			"access-control-request-method": {"GET"},
		},
	})
	if resp.Status != 204 {
		t.Fatalf("expected 204, got %d (%s)", resp.Status, string(resp.Body))
	}
	if got := resp.Headers["access-control-allow-methods"]; len(got) != 1 || got[0] != "GET" {
		t.Fatalf("unexpected allow methods header: %#v", resp.Headers)
	}
}

func TestFixtureApp_HandleP2_ForcedRateLimitAndShed(t *testing.T) {
	t.Parallel()

	app, err := newFixtureApp(FixtureSetup{}, "p2")
	if err != nil {
		t.Fatalf("newFixtureApp: %v", err)
	}

	for _, tc := range []struct {
		name       string
		headerKey  string
		wantStatus int
		wantCode   string
	}{
		{name: "rate_limit", headerKey: "x-force-rate-limit", wantStatus: 429, wantCode: appErrorRateLimited},
		{name: "shed", headerKey: "x-force-shed", wantStatus: 503, wantCode: appErrorOverloaded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := app.handle(CanonicalRequest{
				Method: "GET",
				Path:   "/",
				Headers: map[string][]string{
					tc.headerKey: {"1"},
				},
			})
			if resp.Status != tc.wantStatus {
				t.Fatalf("expected %d, got %d (%s)", tc.wantStatus, resp.Status, string(resp.Body))
			}
			if got := resp.Headers["retry-after"]; len(got) != 1 || got[0] != "1" {
				t.Fatalf("expected retry-after=1, got %#v", resp.Headers)
			}

			var parsed map[string]any
			if err := json.Unmarshal(resp.Body, &parsed); err != nil {
				t.Fatalf("unmarshal body: %v", err)
			}
			errObj, ok := parsed["error"].(map[string]any)
			if !ok || errObj["code"] != tc.wantCode {
				t.Fatalf("unexpected error body: %#v", parsed)
			}
		})
	}
}
