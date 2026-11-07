package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// decodeEventBridgeEntries runs the same decode the HTTP handler runs, so a
// test that checks the envelope also exercises the wire member.
func decodeEventBridgeEntries(t *testing.T, body string) []eventBridgeEntry {
	t.Helper()
	var input struct {
		Entries []eventBridgeEntry `json:"Entries"`
	}
	if err := json.Unmarshal([]byte(body), &input); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return input.Entries
}

func TestEventBridgePutEventsAcceptsTheAWSTimestampForms(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	bus := newEventBridgeBus(clock)
	cases := []struct{ name, member, want string }{
		{"omitted", "", "2026-01-01T00:00:00Z"},
		{"integer epoch seconds", `,"Time":1794068000`, "2026-11-07T16:13:20Z"},
		{"fractional epoch seconds", `,"Time":1794068000.125`, "2026-11-07T16:13:20.125Z"},
		{"fractional epoch seconds with microseconds", `,"Time":1794068000.125001`, "2026-11-07T16:13:20.125001Z"},
		{"exponent epoch seconds", `,"Time":1.794068e9`, "2026-11-07T16:13:20Z"},
		{"negative epoch seconds", `,"Time":-1`, "1969-12-31T23:59:59Z"},
		{"RFC3339 string", `,"Time":"2026-11-07T16:13:20Z"`, "2026-11-07T16:13:20Z"},
		{"RFC3339 string keeps the v7.0.0 second precision", `,"Time":"2026-11-07T16:13:20.25Z"`, "2026-11-07T16:13:20Z"},
		{"empty string", `,"Time":""`, "2026-01-01T00:00:00Z"},
		{"null", `,"Time":null`, "2026-01-01T00:00:00Z"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := `{"Entries":[{"Source":"app.test","DetailType":"Thing","Detail":"{}"` + testCase.member + `}]}`
			entries := decodeEventBridgeEntries(t, body)
			envelope, code, err := bus.envelope(entries[0])
			if err != nil || code != "" {
				t.Fatalf("envelope: %v (%s)", err, code)
			}
			if got := envelope["time"]; got != testCase.want {
				t.Fatalf("time = %v, want %s", got, testCase.want)
			}
		})
	}
}

func TestEventBridgePutEventsClockFallbackKeepsWholeSeconds(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC))
	bus := newEventBridgeBus(clock)
	cases := []struct{ name, member string }{
		{"omitted", ""},
		{"empty string", `,"Time":""`},
		{"null", `,"Time":null`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := `{"Entries":[{"Source":"app.test","DetailType":"Thing","Detail":"{}"` + testCase.member + `}]}`
			entries := decodeEventBridgeEntries(t, body)
			envelope, code, err := bus.envelope(entries[0])
			if err != nil || code != "" {
				t.Fatalf("envelope: %v (%s)", err, code)
			}
			if got := envelope["time"]; got != "2026-01-01T00:00:00Z" {
				t.Fatalf("clock fallback time = %v, want v7.0.0's whole second 2026-01-01T00:00:00Z", got)
			}
		})
	}
	numeric := decodeEventBridgeEntries(t, `{"Entries":[{"Source":"app.test","DetailType":"Thing","Detail":"{}","Time":1794068000.125}]}`)
	envelope, code, err := bus.envelope(numeric[0])
	if err != nil || code != "" {
		t.Fatalf("numeric envelope: %v (%s)", err, code)
	}
	if got := envelope["time"]; got != "2026-11-07T16:13:20.125Z" {
		t.Fatalf("numeric time = %v, want the supplied fraction kept", got)
	}
}

func TestEventBridgeInternalProducersKeepTheV700WholeSecondTime(t *testing.T) {
	nanos := time.Date(2026, 11, 7, 16, 13, 20, 123456789, time.UTC)
	bus := newEventBridgeBus(NewTestClock(nanos))
	cases := []struct {
		name  string
		entry eventBridgeEntry
	}{
		{
			name: "CodeBuild state change publish",
			entry: eventBridgeEntry{
				Source:     "aws.codebuild",
				DetailType: "CodeBuild Build State Change",
				Detail:     "{}",
				Time:       eventBridgeTimeOf(nanos),
			},
		},
		{
			name: "S3 notification",
			entry: s3EventBridgeEntry(S3ObjectEvent{
				BucketARN: "arn:aws:s3:::bucket",
				Key:       "key",
				EventName: "ObjectCreated:Put",
				Time:      nanos,
			}),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			envelope, code, err := bus.envelope(testCase.entry)
			if err != nil || code != "" {
				t.Fatalf("envelope: %v (%s)", err, code)
			}
			if got := envelope["time"]; got != "2026-11-07T16:13:20Z" {
				t.Fatalf("producer time = %v, want v7.0.0's whole second", got)
			}
		})
	}
	scheduled, err := BuildEventBridgeEvent(
		RuleSpec{LogicalID: "Rule", Schedule: "rate(5 minutes)", ARN: "arn:aws:events:us-east-1:123456789012:rule/Rule"},
		json.RawMessage(`{}`), "", "", nanos,
	)
	if err != nil {
		t.Fatalf("scheduled event: %v", err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(scheduled, &envelope); err != nil {
		t.Fatalf("decode the scheduled event: %v", err)
	}
	if got := envelope["time"]; got != "2026-11-07T16:13:20Z" {
		t.Fatalf("scheduled time = %v, want v7.0.0's whole second", got)
	}
}

func TestEventBridgePutEventsDeliversTheSuppliedInstant(t *testing.T) {
	bus := newEventBridgeBus(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	fired := make(chan map[string]any, 1)
	runtime := &eventBridgeRuleRuntime{
		rule: RuleSpec{LogicalID: "Rule", BusName: "default", EventPattern: json.RawMessage(`{"source":["app.test"]}`)},
		fire: func(_ context.Context, event map[string]any) { fired <- event },
	}
	runtime.setActive(true)
	bus.register(runtime)

	recorder := postEventBridge(t, bus, `{"Entries":[{"Source":"app.test","DetailType":"Thing","Detail":"{}","Time":1794068000.125}]}`)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"FailedEntryCount":0`) {
		t.Fatalf("numeric Time over HTTP: %d %s", recorder.Code, recorder.Body.String())
	}
	select {
	case event := <-fired:
		if got := event["time"]; got != "2026-11-07T16:13:20.125Z" {
			t.Fatalf("delivered time = %v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the matching rule never received the event")
	}
}

func TestEventBridgePutEventsReportsPerEntryTimeFailures(t *testing.T) {
	bus := newEventBridgeBus(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	body := `{"Entries":[` +
		`{"Source":"app.test","DetailType":"Thing","Detail":"{}","Time":"not-a-time"},` +
		`{"Source":"app.test","DetailType":"Thing","Detail":"{}","Time":1e30},` +
		`{"Source":"app.test","DetailType":"Thing","Detail":"{bad"}` +
		`]}`
	recorder := postEventBridge(t, bus, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("per-entry failures must keep the documented 200: %d %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		FailedEntryCount int `json:"FailedEntryCount"`
		Entries          []struct {
			ErrorCode    string `json:"ErrorCode"`
			ErrorMessage string `json:"ErrorMessage"`
			EventID      string `json:"EventId"`
		} `json:"Entries"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	if response.FailedEntryCount != 3 || len(response.Entries) != 3 {
		t.Fatalf("response = %s", recorder.Body.String())
	}
	if response.Entries[0].ErrorCode != eventBridgeInvalidArgument || response.Entries[0].ErrorMessage == "" {
		t.Fatalf("invalid Time entry = %+v", response.Entries[0])
	}
	if response.Entries[1].ErrorCode != eventBridgeInvalidArgument {
		t.Fatalf("out-of-range Time entry = %+v", response.Entries[1])
	}
	if response.Entries[2].ErrorCode != eventBridgeMalformedDetail {
		t.Fatalf("malformed detail entry = %+v", response.Entries[2])
	}
}

func TestEventBridgePutEventsErrorsUseTheAWSJSONShape(t *testing.T) {
	bus := newEventBridgeBus(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	eleven := make([]map[string]any, 11)
	for index := range eleven {
		eleven[index] = map[string]any{"Source": "app.test", "DetailType": "Thing", "Detail": "{}"}
	}
	tooMany, err := json.Marshal(map[string]any{"Entries": eleven})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		method string
		target string
		body   string
		status int
		code   string
	}{
		{"wrong method", http.MethodPut, eventBridgeTarget, `{}`, http.StatusBadRequest, eventBridgeMalformedRequest},
		{"wrong target", http.MethodPost, "Wrong.Target", `{}`, http.StatusNotFound, eventBridgeUnknownOperation},
		{"invalid JSON", http.MethodPost, eventBridgeTarget, `request is not valid JSON`, http.StatusBadRequest, eventBridgeMalformedRequest},
		{"wrong Time type", http.MethodPost, eventBridgeTarget, `{"Entries":[{"Source":"a","DetailType":"b","Time":true}]}`, http.StatusBadRequest, eventBridgeValidationError},
		{"empty Entries", http.MethodPost, eventBridgeTarget, `{"Entries":[]}`, http.StatusBadRequest, eventBridgeValidationError},
		{"too many Entries", http.MethodPost, eventBridgeTarget, string(tooMany), http.StatusBadRequest, eventBridgeValidationError},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(context.Background(), testCase.method, "/", strings.NewReader(testCase.body))
			request.Header.Set("X-Amz-Target", testCase.target)
			recorder := httptest.NewRecorder()
			bus.serveEventBridgeHTTP(context.Background(), recorder, request)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, testCase.status, recorder.Body.String())
			}
			if contentType := recorder.Header().Get("Content-Type"); contentType != eventBridgeJSONType {
				t.Fatalf("Content-Type = %q", contentType)
			}
			var payload struct {
				Type    string `json:"__type"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("the body is not an AWS JSON error document: %v: %s", err, recorder.Body.String())
			}
			if payload.Type != testCase.code || payload.Message == "" {
				t.Fatalf("error document = %+v", payload)
			}
		})
	}
}

func postEventBridge(t *testing.T, bus *eventBridgeBus, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(body))
	request.Header.Set("X-Amz-Target", eventBridgeTarget)
	request.Header.Set("Content-Type", eventBridgeJSONType)
	recorder := httptest.NewRecorder()
	bus.serveEventBridgeHTTP(context.Background(), recorder, request)
	return recorder
}
