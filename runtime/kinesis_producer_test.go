package apptheory

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestNewKinesisJSONRecord_EncodesDeterministicPayloadAndSummary(t *testing.T) {
	t.Parallel()

	record, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey:    " tenant#1 ",
		ExplicitHashKey: "0007",
		Payload: map[string]any{
			"b": 2,
			"a": map[string]any{
				"z": "<ok>&",
				"m": []any{true, nil},
			},
		},
	})
	if err != nil {
		t.Fatalf("NewKinesisJSONRecord returned error: %v", err)
	}

	want := `{"a":{"m":[true,null],"z":"<ok>&"},"b":2}`
	if string(record.Data) != want {
		t.Fatalf("unexpected deterministic JSON bytes:\nwant %s\n got %s", want, string(record.Data))
	}
	if record.PartitionKey != "tenant#1" || record.ExplicitHashKey != "7" {
		t.Fatalf("unexpected routing fields: %#v", record)
	}
	if record.SafeSummary.DataByteLength != len(record.Data) {
		t.Fatalf("unexpected data length summary: %#v", record.SafeSummary)
	}

	summaryJSON, err := json.Marshal(record.SafeSummary)
	if err != nil {
		t.Fatalf("marshal summary: %v", err)
	}
	for _, forbidden := range []string{"<ok>&", `"b":2`, "true"} {
		if strings.Contains(string(summaryJSON), forbidden) || strings.Contains(record.SafeSummary.SafeLog, forbidden) {
			t.Fatalf("safe summary leaked payload fragment %q: %s", forbidden, summaryJSON)
		}
	}
}

func TestNewKinesisJSONRecord_SanitizesUnsafePartitionKeyInSafeLog(t *testing.T) {
	t.Parallel()

	partitionKey := "tenant\nforged=true\rcontrol=\x1f key=value\tpercent%"
	record, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey: partitionKey,
		Payload:      map[string]any{"ok": true},
	})
	if err != nil {
		t.Fatalf("NewKinesisJSONRecord returned error: %v", err)
	}
	if record.PartitionKey != partitionKey {
		t.Fatalf("partition key should remain API-compatible, got %q", record.PartitionKey)
	}

	safeLog := record.SafeSummary.SafeLog
	assertKinesisSafeLogCannotForgeFields(t, safeLog)
	if !strings.Contains(
		safeLog,
		"partition_key=tenant%0Aforged%3Dtrue%0Dcontrol%3D%1F%20key%3Dvalue%09percent%25",
	) {
		t.Fatalf("unsafe partition key was not percent-encoded in safe log: %q", safeLog)
	}
}

func TestNewKinesisJSONRecord_FailsClosed(t *testing.T) {
	t.Parallel()

	if _, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{Payload: map[string]any{"ok": true}}); err == nil {
		t.Fatal("expected empty partition key to fail")
	}
	if _, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey:    "pk-1",
		ExplicitHashKey: "not-decimal",
		Payload:         map[string]any{"ok": true},
	}); err == nil {
		t.Fatal("expected invalid explicit hash key to fail")
	}
	if _, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey: "pk-1",
		Payload:      map[string]any{"bad": math.Inf(1)},
	}); err == nil {
		t.Fatal("expected non-json payload to fail")
	}
}

func TestReportKinesisPutRecordsFailures_AlignsByIndexAndOmitsPayloads(t *testing.T) {
	t.Parallel()

	first, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey: "pk-1",
		Payload:      map[string]any{"customer": "alpha"},
	})
	if err != nil {
		t.Fatalf("first record: %v", err)
	}
	second, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey:    "pk-2",
		ExplicitHashKey: "9",
		Payload:         map[string]any{"customer": "bravo"},
	})
	if err != nil {
		t.Fatalf("second record: %v", err)
	}

	report, err := ReportKinesisPutRecordsFailures(
		[]KinesisJSONRecord{first, second},
		[]KinesisPutRecordsResultRecord{
			{SequenceNumber: "1", ShardID: "shardId-000000000000"},
			{ErrorCode: "ProvisionedThroughputExceededException", ErrorMessage: `failed payload {"customer":"bravo"}`},
		},
	)
	if err != nil {
		t.Fatalf("ReportKinesisPutRecordsFailures returned error: %v", err)
	}
	if report.RecordCount != 2 || report.FailedRecordCount != 1 || len(report.Failures) != 1 {
		t.Fatalf("unexpected report counts: %#v", report)
	}
	failure := report.Failures[0]
	if failure.Index != 1 || failure.PartitionKey != "pk-2" || failure.ExplicitHashKey != "9" {
		t.Fatalf("unexpected failure alignment: %#v", failure)
	}
	if !failure.ErrorMessagePresent || failure.ErrorMessageByteLength == 0 {
		t.Fatalf("expected message presence metadata only: %#v", failure)
	}

	reportJSON, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	for _, forbidden := range []string{"alpha", "bravo", "customer", "failed payload"} {
		if strings.Contains(string(reportJSON), forbidden) {
			t.Fatalf("failure report leaked payload/message fragment %q: %s", forbidden, reportJSON)
		}
	}
	if !strings.Contains(report.SafeSummary.SafeLog, "failed_record_count=1") {
		t.Fatalf("unexpected aggregate safe log: %q", report.SafeSummary.SafeLog)
	}
}

func TestReportKinesisPutRecordsFailures_SanitizesPartitionKeyInFailureSafeLog(t *testing.T) {
	t.Parallel()

	record, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey: "tenant\nerror_code=ForgedException key=value",
		Payload:      map[string]any{"ok": true},
	})
	if err != nil {
		t.Fatalf("record: %v", err)
	}

	report, err := ReportKinesisPutRecordsFailures(
		[]KinesisJSONRecord{record},
		[]KinesisPutRecordsResultRecord{{ErrorCode: "ProvisionedThroughputExceededException"}},
	)
	if err != nil {
		t.Fatalf("ReportKinesisPutRecordsFailures returned error: %v", err)
	}
	if len(report.Failures) != 1 {
		t.Fatalf("expected one failure: %#v", report)
	}

	safeLog := report.Failures[0].SafeLog
	assertKinesisSafeLogCannotForgeFields(t, safeLog)
	if strings.Contains(safeLog, "error_code=ForgedException") || !strings.Contains(safeLog, "%0Aerror_code%3D") {
		t.Fatalf("unsafe partition key was not sanitized in failure safe log: %q", safeLog)
	}
}

func TestReportKinesisPutRecordsFailures_FailsClosedForShapeDrift(t *testing.T) {
	t.Parallel()

	record, err := NewKinesisJSONRecord(KinesisJSONRecordOptions{
		PartitionKey: "pk-1",
		Payload:      map[string]any{"ok": true},
	})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if _, err := ReportKinesisPutRecordsFailures([]KinesisJSONRecord{record}, nil); err == nil {
		t.Fatal("expected records/results length mismatch to fail")
	}
	if _, err := ReportKinesisPutRecordsFailures(
		[]KinesisJSONRecord{record},
		[]KinesisPutRecordsResultRecord{{ErrorMessage: "message without code"}},
	); err == nil {
		t.Fatal("expected error message without code to fail")
	}
}

func assertKinesisSafeLogCannotForgeFields(t *testing.T, safeLog string) {
	t.Helper()

	for _, forbidden := range []string{"\n", "\r", "\t", "\x1f", " forged=", " key=value"} {
		if strings.Contains(safeLog, forbidden) {
			t.Fatalf("safe log permits forged delimiter or field %q: %q", forbidden, safeLog)
		}
	}
}
