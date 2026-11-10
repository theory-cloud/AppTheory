package mcp

import (
	"context"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/refusal"
)

// TestTransportRefusalsAreObservable pins the transport half of the refusal
// contract: every 400, 403, 404, and 405 the MCP endpoint renders produces one
// structured event naming the reason, and an admitted request produces none.
func TestTransportRefusalsAreObservable(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		headers    map[string][]string
		body       string
		wantStatus int
		wantReason string
	}{
		{
			name:       "method_not_allowed",
			method:     "PUT",
			wantStatus: 405,
			wantReason: refusal.ReasonMethodNotAllowed,
		},
		{
			name:       "missing_content_type",
			method:     "POST",
			wantStatus: 400,
			wantReason: refusal.ReasonMissingContentType,
		},
		{
			name:   "missing_accept",
			method: "POST",
			headers: map[string][]string{
				"content-type": {"application/json"},
			},
			wantStatus: 400,
			wantReason: refusal.ReasonMissingAccept,
		},
		{
			name:   "missing_session_id",
			method: "GET",
			headers: map[string][]string{
				"accept": {"text/event-stream"},
			},
			wantStatus: 400,
			wantReason: refusal.ReasonMissingSessionID,
		},
		{
			name:   "unknown_session",
			method: "GET",
			headers: map[string][]string{
				"accept":         {"text/event-stream"},
				"mcp-session-id": {"not-a-session"},
			},
			wantStatus: 404,
			wantReason: refusal.ReasonUnknownSession,
		},
		{
			name:   "origin_refused",
			method: "POST",
			headers: map[string][]string{
				"content-type": {"application/json"},
				"accept":       {"application/json, text/event-stream"},
				"origin":       {"https://evil.example"},
			},
			body:       `{"jsonrpc":"2.0","id":1,"method":"server/discover"}`,
			wantStatus: 403,
			wantReason: refusal.ReasonOriginRefused,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var events []refusal.Event
			server := NewServer("test", "dev", WithRefusalHook(func(_ context.Context, event refusal.Event) {
				events = append(events, event)
			}))
			response, err := server.Handler()(&apptheory.Context{
				Request: apptheory.Request{
					Method:  tc.method,
					Path:    "/mcp",
					Headers: tc.headers,
					Body:    []byte(tc.body),
				},
			})
			if err != nil {
				t.Fatalf("handler error: %v", err)
			}
			if response.Status != tc.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", response.Status, tc.wantStatus, response.Body)
			}
			if len(events) != 1 {
				t.Fatalf("events = %+v, want exactly one", events)
			}
			event := events[0]
			if event.Class != refusal.ClassTransport {
				t.Fatalf("class = %q", event.Class)
			}
			if event.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", event.Reason, tc.wantReason)
			}
			if event.Status != tc.wantStatus || event.Method != tc.method || event.Path != "/mcp" {
				t.Fatalf("event = %+v", event)
			}
		})
	}

	t.Run("admitted_request_emits_nothing", func(t *testing.T) {
		var events []refusal.Event
		server := NewServer("test", "dev", WithRefusalHook(func(_ context.Context, event refusal.Event) {
			events = append(events, event)
		}))
		response, err := server.Handler()(&apptheory.Context{
			Request: apptheory.Request{
				Method: "POST",
				Path:   "/mcp",
				Headers: map[string][]string{
					"content-type":         {"application/json"},
					"accept":               {"application/json, text/event-stream"},
					"mcp-protocol-version": {"2025-03-26"},
				},
				Body: []byte(`{"jsonrpc":"2.0","id":1,"method":"server/discover"}`),
			},
		})
		if err != nil {
			t.Fatalf("handler error: %v", err)
		}
		if response.Status != 200 {
			t.Fatalf("status = %d (%s)", response.Status, response.Body)
		}
		if len(events) != 0 {
			t.Fatalf("events = %+v, want none", events)
		}
	})
}
