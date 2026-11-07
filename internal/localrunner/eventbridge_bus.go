package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
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

	// eventBridgeTimeFormat prints the envelope's time member. Every path is
	// whole-second except a caller-supplied numeric instant, which keeps the
	// fraction it names; RFC3339Nano prints a whole second byte-identically.
	// https://docs.aws.amazon.com/eventbridge/latest/ref/events-structure.html
	eventBridgeTimeFormat = time.RFC3339Nano
)

// The error members the AWS JSON 1.1 protocol carries in a response body. The
// SDKs resolve a typed error from __type and surface the message.
// https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#operation-error-serialization
// https://docs.aws.amazon.com/eventbridge/latest/APIReference/CommonErrors.html
const (
	eventBridgeMalformedRequest = "MalformedHttpRequestException"
	eventBridgeValidationError  = "ValidationError"
	eventBridgeUnknownOperation = "UnknownOperationException"
	eventBridgeInternalFailure  = "InternalFailure"

	// eventBridgeInvalidArgument and eventBridgeMalformedDetail are the
	// per-entry codes PutEventsResultEntry documents.
	// https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_PutEventsResultEntry.html
	eventBridgeInvalidArgument = "InvalidArgument"
	eventBridgeMalformedDetail = "MalformedDetail"
)

// eventBridgeEntry is one PutEvents entry.
type eventBridgeEntry struct {
	Source       string          `json:"Source"`
	DetailType   string          `json:"DetailType"`
	Detail       string          `json:"Detail"`
	EventBusName string          `json:"EventBusName"`
	Resources    []string        `json:"Resources"`
	Time         eventBridgeTime `json:"Time"`
}

// eventBridgeTime is the PutEvents Time member. AWS JSON 1.1 sends a timestamp
// as epoch seconds in a JSON number; v7.0.0 accepted an RFC3339 string, so both
// forms stay valid.
// https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#shape-serialization
type eventBridgeTime struct {
	raw json.RawMessage
}

// UnmarshalJSON keeps the member's wire value so a value the bus cannot use is
// reported against its entry instead of rejecting the whole request. A JSON
// type the protocol does not define fails the decode.
func (t *eventBridgeTime) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		t.raw = nil
		return nil
	}
	if trimmed[0] != '"' && trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return fmt.Errorf("time must be epoch seconds or an RFC3339 string")
	}
	t.raw = append(json.RawMessage(nil), trimmed...)
	return nil
}

// eventBridgeTimeOf builds the member from an instant the runner itself
// generated.
func eventBridgeTimeOf(when time.Time) eventBridgeTime {
	return eventBridgeTime{raw: json.RawMessage(strconv.Quote(when.UTC().Format(time.RFC3339Nano)))}
}

// instant resolves the member, falling back to the supplied clock instant when
// the caller omitted it. The clock fallback is truncated to the whole second
// v7.0.0 printed; only a caller-supplied numeric instant keeps its fraction.
func (t eventBridgeTime) instant(now time.Time) (time.Time, error) {
	trimmed := bytes.TrimSpace(t.raw)
	if len(trimmed) == 0 {
		return now.Truncate(time.Second), nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return time.Time{}, fmt.Errorf("time is not a string: %w", err)
		}
		if strings.TrimSpace(text) == "" {
			return now.Truncate(time.Second), nil
		}
		parsed, err := time.Parse(time.RFC3339, text)
		if err != nil {
			return time.Time{}, fmt.Errorf("time is not RFC3339: %w", err)
		}
		// v7.0.0 printed an RFC3339 string at whole-second precision; keep
		// that output byte-identical. The numeric form keeps its fraction.
		return parsed.UTC().Truncate(time.Second), nil
	}
	return parseEventBridgeEpochSeconds(string(trimmed))
}

// parseEventBridgeEpochSeconds turns the JSON number the AWS SDKs send into the
// instant it names. The decimal digits are read exactly instead of through
// float64, so a millisecond Time keeps its millisecond.
func parseEventBridgeEpochSeconds(text string) (time.Time, error) {
	if strings.ContainsAny(text, "eE") {
		value, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("time is not epoch seconds: %w", err)
		}
		if math.IsNaN(value) || math.IsInf(value, 0) || value < math.MinInt64 || value >= math.MaxInt64 {
			return time.Time{}, fmt.Errorf("time is out of range: %q", text)
		}
		seconds, fraction := math.Modf(value)
		return time.Unix(int64(seconds), int64(math.Round(fraction*float64(time.Second)))).UTC(), nil
	}
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimPrefix(text, "-")
	whole, fraction, _ := strings.Cut(digits, ".")
	seconds, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("time is not epoch seconds: %w", err)
	}
	nanos := int64(0)
	if fraction != "" {
		if len(fraction) > 9 {
			fraction = fraction[:9]
		}
		nanos, err = strconv.ParseInt(fraction+strings.Repeat("0", 9-len(fraction)), 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("time is not epoch seconds: %w", err)
		}
	}
	if negative {
		seconds, nanos = -seconds, -nanos
	}
	return time.Unix(seconds, nanos).UTC(), nil
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
		envelope, code, err := b.envelope(entry)
		if err != nil {
			results[index] = eventBridgeResult{ErrorCode: code, ErrorMessage: err.Error()}
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

// envelope builds the documented EventBridge event. The returned code names
// the PutEventsResultEntry error when the entry is refused.
func (b *eventBridgeBus) envelope(entry eventBridgeEntry) (map[string]any, string, error) {
	source := strings.TrimSpace(entry.Source)
	if source == "" {
		return nil, eventBridgeInvalidArgument, fmt.Errorf("source is required")
	}
	detailType := strings.TrimSpace(entry.DetailType)
	if detailType == "" {
		return nil, eventBridgeInvalidArgument, fmt.Errorf("DetailType is required")
	}
	detail := strings.TrimSpace(entry.Detail)
	if detail == "" {
		detail = "{}"
	}
	decoded, err := decodePatternValue([]byte(detail))
	if err != nil {
		return nil, eventBridgeMalformedDetail, fmt.Errorf("detail is not valid JSON: %w", err)
	}
	instant, err := entry.Time.instant(b.clock.Now().UTC())
	if err != nil {
		return nil, eventBridgeInvalidArgument, err
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
		"time":        instant.UTC().Format(eventBridgeTimeFormat),
		"region":      LocalRegion,
		"resources":   resources,
		"detail":      decoded,
	}, "", nil
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
		writeEventBridgeError(writer, http.StatusBadRequest, eventBridgeMalformedRequest,
			"the local EventBridge endpoint serves the PutEvents JSON protocol with POST")
		return
	}
	if target := strings.TrimSpace(request.Header.Get("X-Amz-Target")); target != eventBridgeTarget {
		writeEventBridgeError(writer, http.StatusNotFound, eventBridgeUnknownOperation,
			"the local EventBridge endpoint serves "+eventBridgeTarget)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 10<<20))
	if err != nil {
		writeEventBridgeError(writer, http.StatusBadRequest, eventBridgeMalformedRequest, "read the request body: "+err.Error())
		return
	}
	var input struct {
		Entries []eventBridgeEntry `json:"Entries"`
	}
	if decodeErr := json.Unmarshal(body, &input); decodeErr != nil {
		code := eventBridgeValidationError
		var syntax *json.SyntaxError
		if errors.As(decodeErr, &syntax) {
			code = eventBridgeMalformedRequest
		}
		writeEventBridgeError(writer, http.StatusBadRequest, code, decodeErr.Error())
		return
	}
	if len(input.Entries) == 0 || len(input.Entries) > eventBridgeMaxBatch {
		writeEventBridgeError(writer, http.StatusBadRequest, eventBridgeValidationError,
			fmt.Sprintf("Entries must contain between 1 and %d items", eventBridgeMaxBatch))
		return
	}
	results, failed := b.putEvents(ctx, input.Entries)
	response := map[string]any{"FailedEntryCount": failed, "Entries": results}
	writer.Header().Set("Content-Type", eventBridgeJSONType)
	encoded, err := json.Marshal(response)
	if err != nil {
		writeEventBridgeError(writer, http.StatusInternalServerError, eventBridgeInternalFailure, "encode the PutEvents response: "+err.Error())
		return
	}
	_, _ = writer.Write(encoded) //nolint:errcheck // the HTTP server reports a write failure
}

// writeEventBridgeError answers with the AWS JSON 1.1 error document the SDKs
// decode: a __type member naming the error shape and a message.
// https://smithy.io/2.0/aws/protocols/aws-json-1_1-protocol.html#operation-error-serialization
func writeEventBridgeError(writer http.ResponseWriter, status int, code, message string) {
	payload, _ := json.Marshal(map[string]string{"__type": code, "message": message}) //nolint:errcheck // a fixed shape
	writer.Header().Set("Content-Type", eventBridgeJSONType)
	writer.WriteHeader(status)
	_, _ = writer.Write(payload) //nolint:errcheck // the response is already committed
}
