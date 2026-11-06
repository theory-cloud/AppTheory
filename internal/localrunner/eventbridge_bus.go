package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The runner-owned EventBridge bus. The pinned moto accepts PutEvents and
// matches simple patterns, but it ignores Input and InputPath (re-verified on
// moto 5.2.5), cannot reach the Runtime Interface Emulator or ElasticMQ, and
// has no schedule ticking or retry/DLQ semantics. The runner therefore serves
// the EventBridge PutEvents JSON protocol itself on a loopback endpoint and
// performs the pattern match, input shaping, target delivery and retries.
//
// The endpoint is injected into every function container as
// AWS_ENDPOINT_URL_EVENTS, so a handler's real SDK client reaches it. The
// harness and a developer reach the same endpoint with the AWS CLI.
//
// https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEvents.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html

const (
	eventBridgeTarget   = "AWSEvents.PutEvents"
	eventBridgeJSONType = "application/x-amz-json-1.1"
	eventBridgeMaxBatch = 10
)

// eventBridgeEntry is one PutEvents entry.
type eventBridgeEntry struct {
	Source       string   `json:"Source"`
	DetailType   string   `json:"DetailType"`
	Detail       string   `json:"Detail"`
	EventBusName string   `json:"EventBusName"`
	Resources    []string `json:"Resources"`
	Time         string   `json:"Time"`
}

// eventBridgeResult is one PutEvents result.
type eventBridgeResult struct {
	EventID      string `json:"EventId,omitempty"`
	ErrorCode    string `json:"ErrorCode,omitempty"`
	ErrorMessage string `json:"ErrorMessage,omitempty"`
}

// eventBridgeRuleRuntime is one pattern rule registered on the bus.
type eventBridgeRuleRuntime struct {
	rule   RuleSpec
	mu     sync.RWMutex
	active bool
	fire   func(ctx context.Context, event map[string]any)
}

func (r *eventBridgeRuleRuntime) setActive(active bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = active
}

func (r *eventBridgeRuleRuntime) isActive() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.active
}

// eventBridgeBus is the per-run bus registry.
type eventBridgeBus struct {
	clock Clock

	mu    sync.RWMutex
	rules map[string][]*eventBridgeRuleRuntime
}

func newEventBridgeBus(clock Clock) *eventBridgeBus {
	if clock == nil {
		clock = RealClock{}
	}
	return &eventBridgeBus{clock: clock, rules: map[string][]*eventBridgeRuleRuntime{}}
}

// register adds one rule runtime to its bus.
func (b *eventBridgeBus) register(runtime *eventBridgeRuleRuntime) {
	b.mu.Lock()
	defer b.mu.Unlock()
	busName := normalizedBusName(runtime.rule.BusName)
	b.rules[busName] = append(b.rules[busName], runtime)
}

// unregister removes one rule runtime.
func (b *eventBridgeBus) unregister(runtime *eventBridgeRuleRuntime) {
	b.mu.Lock()
	defer b.mu.Unlock()
	busName := normalizedBusName(runtime.rule.BusName)
	rules := b.rules[busName]
	for index, candidate := range rules {
		if candidate == runtime {
			b.rules[busName] = append(rules[:index], rules[index+1:]...)
			break
		}
	}
	if len(b.rules[busName]) == 0 {
		delete(b.rules, busName)
	}
}

func normalizedBusName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return defaultEventBus
	}
	return trimmed
}

// putEvents builds the documented envelope for every entry and dispatches it to
// every active matching rule. Delivery is asynchronous: PutEvents returns as
// soon as the events are accepted, as AWS does.
func (b *eventBridgeBus) putEvents(ctx context.Context, entries []eventBridgeEntry) ([]eventBridgeResult, int) {
	results := make([]eventBridgeResult, len(entries))
	failed := 0
	for index, entry := range entries {
		envelope, err := b.envelope(entry)
		if err != nil {
			results[index] = eventBridgeResult{ErrorCode: "MalformedDetail", ErrorMessage: err.Error()}
			failed++
			continue
		}
		results[index] = eventBridgeResult{EventID: fmt.Sprint(envelope["id"])}
		b.mu.RLock()
		rules := append([]*eventBridgeRuleRuntime(nil), b.rules[normalizedBusName(entry.EventBusName)]...)
		b.mu.RUnlock()
		for _, runtime := range rules {
			if !runtime.isActive() {
				continue
			}
			if len(runtime.rule.EventPattern) > 0 {
				var pattern map[string]any
				decoded, decodeErr := decodePatternValue(runtime.rule.EventPattern)
				if decodeErr != nil {
					continue
				}
				pattern, ok := decoded.(map[string]any)
				if !ok {
					continue
				}
				if !eventPatternMatches(pattern, envelope) {
					continue
				}
			}
			event := envelope
			go runtime.fire(ctx, event)
		}
	}
	return results, failed
}

// envelope builds the documented EventBridge event.
func (b *eventBridgeBus) envelope(entry eventBridgeEntry) (map[string]any, error) {
	source := strings.TrimSpace(entry.Source)
	if source == "" {
		return nil, fmt.Errorf("source is required")
	}
	detailType := strings.TrimSpace(entry.DetailType)
	if detailType == "" {
		return nil, fmt.Errorf("DetailType is required")
	}
	detail := strings.TrimSpace(entry.Detail)
	if detail == "" {
		detail = "{}"
	}
	decoded, err := decodePatternValue([]byte(detail))
	if err != nil {
		return nil, fmt.Errorf("detail is not valid JSON: %w", err)
	}
	instant := b.clock.Now().UTC()
	if strings.TrimSpace(entry.Time) != "" {
		parsed, err := time.Parse(time.RFC3339, entry.Time)
		if err != nil {
			return nil, fmt.Errorf("time is not RFC3339: %w", err)
		}
		instant = parsed.UTC()
	}
	resources := entry.Resources
	if resources == nil {
		resources = []string{}
	}
	return map[string]any{
		"version":     "0",
		"id":          NewRequestID(),
		"detail-type": detailType,
		"source":      source,
		"account":     LocalAccountID,
		"time":        instant.Format(time.RFC3339),
		"region":      LocalRegion,
		"resources":   resources,
		"detail":      decoded,
	}, nil
}

// serveEventBridgeHTTP serves the EventBridge PutEvents JSON protocol. A GET
// answers the preflight and a human probe; anything else is a protocol error.
func (b *eventBridgeBus) serveEventBridgeHTTP(ctx context.Context, writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"ok":true}`)) //nolint:errcheck // a preflight response
		return
	}
	if request.Method != http.MethodPost {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if target := strings.TrimSpace(request.Header.Get("X-Amz-Target")); target != eventBridgeTarget {
		http.Error(writer, "unsupported EventBridge operation "+target, http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 10<<20))
	if err != nil {
		http.Error(writer, "read request", http.StatusBadRequest)
		return
	}
	var input struct {
		Entries []eventBridgeEntry `json:"Entries"`
	}
	if decodeErr := json.Unmarshal(body, &input); decodeErr != nil {
		http.Error(writer, "request is not valid JSON", http.StatusBadRequest)
		return
	}
	if len(input.Entries) == 0 {
		http.Error(writer, "Entries must not be empty", http.StatusBadRequest)
		return
	}
	if len(input.Entries) > eventBridgeMaxBatch {
		http.Error(writer, "Entries exceeds the PutEvents limit of 10", http.StatusBadRequest)
		return
	}
	results, failed := b.putEvents(ctx, input.Entries)
	response := map[string]any{"FailedEntryCount": failed, "Entries": results}
	writer.Header().Set("Content-Type", eventBridgeJSONType)
	encoded, err := json.Marshal(response)
	if err != nil {
		http.Error(writer, "encode response", http.StatusInternalServerError)
		return
	}
	_, _ = writer.Write(encoded) //nolint:errcheck // the HTTP server reports a write failure
}
