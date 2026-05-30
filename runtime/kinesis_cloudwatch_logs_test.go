package apptheory

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestDecodeCloudWatchLogsSubscription_DecodesEnvelopeAndSafeSummary(t *testing.T) {
	t.Parallel()

	rawMessage := "contract log line alpha"
	record := events.KinesisEventRecord{
		EventID: "kin-cwl-1",
		Kinesis: events.KinesisRecord{Data: gzipCloudWatchLogsSubscriptionTestPayload(t, map[string]any{
			"messageType":         "DATA_MESSAGE",
			"owner":               "111122223333",
			"logGroup":            "/aws/lambda/apptheory-contract",
			"logStream":           "2026/05/26/[$LATEST]contract-a",
			"subscriptionFilters": []string{"apptheory-contract-filter"},
			"logEvents": []map[string]any{
				{"id": "cwl-event-a1", "timestamp": int64(1779806400000), "message": rawMessage},
				{"id": "cwl-event-a2", "timestamp": int64(1779806401000), "message": "contract log line beta"},
			},
		})},
	}

	decoded, err := DecodeCloudWatchLogsSubscription(record)
	if err != nil {
		t.Fatalf("DecodeCloudWatchLogsSubscription returned error: %v", err)
	}
	if decoded.RecordID != "kin-cwl-1" || decoded.MessageType != "DATA_MESSAGE" || decoded.Owner != "111122223333" {
		t.Fatalf("unexpected decoded identity: %#v", decoded)
	}
	if decoded.LogGroup != "/aws/lambda/apptheory-contract" || decoded.LogStream != "2026/05/26/[$LATEST]contract-a" {
		t.Fatalf("unexpected decoded stream fields: %#v", decoded)
	}
	if len(decoded.SubscriptionFilters) != 1 || decoded.SubscriptionFilters[0] != "apptheory-contract-filter" {
		t.Fatalf("unexpected subscription filters: %#v", decoded.SubscriptionFilters)
	}
	if len(decoded.LogEvents) != 2 || decoded.LogEvents[0].ID != "cwl-event-a1" || decoded.LogEvents[0].Message != rawMessage {
		t.Fatalf("unexpected log events: %#v", decoded.LogEvents)
	}
	if decoded.SafeSummary.LogEventCount != 2 || decoded.SafeSummary.SubscriptionFilterCount != 1 {
		t.Fatalf("unexpected safe summary counts: %#v", decoded.SafeSummary)
	}
	if !strings.Contains(decoded.SafeSummary.SafeLog, "record_id=kin-cwl-1") ||
		!strings.Contains(decoded.SafeSummary.SafeLog, "message_type=DATA_MESSAGE") {
		t.Fatalf("unexpected safe log: %q", decoded.SafeSummary.SafeLog)
	}

	safeSummaryJSON, err := json.Marshal(decoded.SafeSummary)
	if err != nil {
		t.Fatalf("marshal safe summary: %v", err)
	}
	for _, forbidden := range []string{rawMessage, "contract log line beta"} {
		if strings.Contains(string(safeSummaryJSON), forbidden) || strings.Contains(decoded.SafeSummary.SafeLog, forbidden) {
			t.Fatalf("safe summary leaked raw log message %q: %s", forbidden, safeSummaryJSON)
		}
	}
}

func TestDecodeCloudWatchLogsSubscription_SanitizesMetadataInSafeLog(t *testing.T) {
	t.Parallel()

	rawMessage := "raw log line must stay out owner=customer-secret"
	record := events.KinesisEventRecord{
		EventID: "kin-cwl\nowner=spoof",
		Kinesis: events.KinesisRecord{Data: gzipCloudWatchLogsSubscriptionTestPayload(t, map[string]any{
			"messageType":         "DATA_MESSAGE\rmessage_type=FORGED",
			"owner":               "111122223333\nlog_events=999",
			"logGroup":            "/aws/lambda/apptheory-contract owner=spoof",
			"logStream":           "2026/05/26/[$LATEST]contract-a\tcontrol=\x1fafter",
			"subscriptionFilters": []string{"apptheory-contract-filter"},
			"logEvents": []map[string]any{
				{"id": "cwl-event-a1", "timestamp": int64(1779806400000), "message": rawMessage},
			},
		})},
	}

	decoded, err := DecodeCloudWatchLogsSubscription(record)
	if err != nil {
		t.Fatalf("DecodeCloudWatchLogsSubscription returned error: %v", err)
	}
	if decoded.RecordID != "kin-cwl\nowner=spoof" || decoded.Owner != "111122223333\nlog_events=999" {
		t.Fatalf("decoded metadata should remain API-compatible: %#v", decoded)
	}

	safeLog := decoded.SafeSummary.SafeLog
	for _, forbidden := range []string{
		"\n",
		"\r",
		"\t",
		"\x1f",
		"owner=spoof",
		"log_events=999",
		"message_type=FORGED",
		rawMessage,
	} {
		if strings.Contains(safeLog, forbidden) {
			t.Fatalf("safe log permits forged metadata %q: %q", forbidden, safeLog)
		}
	}
	for _, want := range []string{
		"record_id=kin-cwl%0Aowner%3Dspoof",
		"owner=111122223333%0Alog_events%3D999",
		"log_group=/aws/lambda/apptheory-contract%20owner%3Dspoof",
		"log_stream=2026/05/26/[$LATEST]contract-a%09control%3D%1Fafter",
		"message_type=DATA_MESSAGE%0Dmessage_type%3DFORGED",
		"log_events=1",
	} {
		if !strings.Contains(safeLog, want) {
			t.Fatalf("safe log missing sanitized metadata %q: %q", want, safeLog)
		}
	}
}

func TestDecodeCloudWatchLogsSubscription_FailsClosedWithoutLeakingRawData(t *testing.T) {
	t.Parallel()

	rawMessageSentinel := "do-not-log-customer-message"
	_, err := DecodeCloudWatchLogsSubscription(events.KinesisEventRecord{
		EventID: "kin-cwl-bad",
		Kinesis: events.KinesisRecord{Data: []byte(`{"message":"` + rawMessageSentinel + `"}`)},
	})
	if err == nil {
		t.Fatal("expected invalid gzip to fail")
	}
	if strings.Contains(err.Error(), rawMessageSentinel) {
		t.Fatalf("decode error leaked raw payload: %v", err)
	}

	_, err = DecodeCloudWatchLogsSubscription(events.KinesisEventRecord{
		EventID: "kin-cwl-missing",
		Kinesis: events.KinesisRecord{Data: gzipCloudWatchLogsSubscriptionTestPayload(t, map[string]any{
			"messageType": "DATA_MESSAGE",
			"logEvents":   []map[string]any{{"id": "cwl-event-a1", "message": rawMessageSentinel}},
		})},
	})
	if err == nil {
		t.Fatal("expected missing required fields to fail")
	}
	if strings.Contains(err.Error(), rawMessageSentinel) {
		t.Fatalf("validation error leaked raw log message: %v", err)
	}
}

func gzipCloudWatchLogsSubscriptionTestPayload(t *testing.T, value any) []byte {
	t.Helper()

	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(raw); err != nil {
		t.Fatalf("gzip payload: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close gzip payload: %v", err)
	}
	return buf.Bytes()
}
