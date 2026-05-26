package apptheory

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	kinesisJSONRecordInvalidMessage = "apptheory: kinesis json record invalid"
	kinesisPutRecordsInvalidMessage = "apptheory: kinesis put-records result invalid"
	kinesisMaxPartitionKeyBytes     = 256
	kinesisMaxRecordDataBytes       = 1024 * 1024
	kinesisMaxPutRecordsRecords     = 500
	kinesisMaxExplicitHashKey       = "340282366920938463463374607431768211455"
	kinesisMaxErrorCodeBytes        = 128
	kinesisMaxErrorMessageBytes     = 4096
)

// KinesisJSONRecordOptions configures the bounded AppTheory producer record helper.
type KinesisJSONRecordOptions struct {
	PartitionKey    string
	Payload         any
	ExplicitHashKey string
}

// KinesisJSONRecord is a deterministic JSON payload plus bounded routing metadata for Kinesis producers.
//
// It is intentionally not an AWS SDK request type and does not send data. Callers that use AWS SDK clients must map
// the fields into their client call at the edge while keeping AppTheory as the single JSON encoding and safety path.
type KinesisJSONRecord struct {
	PartitionKey    string                   `json:"partition_key"`
	Data            []byte                   `json:"data"`
	ExplicitHashKey string                   `json:"explicit_hash_key,omitempty"`
	SafeSummary     KinesisJSONRecordSummary `json:"safe_summary"`
}

// KinesisJSONRecordSummary is the safe, non-payload summary for a JSON producer record.
type KinesisJSONRecordSummary struct {
	PartitionKey    string `json:"partition_key"`
	ExplicitHashKey string `json:"explicit_hash_key,omitempty"`
	DataByteLength  int    `json:"data_byte_length"`
	SafeLog         string `json:"safe_log"`
}

// KinesisPutRecordsResultRecord is the bounded per-record result shape for Kinesis PutRecords-style responses.
type KinesisPutRecordsResultRecord struct {
	SequenceNumber string `json:"sequence_number,omitempty"`
	ShardID        string `json:"shard_id,omitempty"`
	ErrorCode      string `json:"error_code,omitempty"`
	ErrorMessage   string `json:"error_message,omitempty"`
}

// KinesisPutRecordsFailure is a safe per-record failure summary aligned by input/result index.
type KinesisPutRecordsFailure struct {
	Index                  int    `json:"index"`
	PartitionKey           string `json:"partition_key"`
	ExplicitHashKey        string `json:"explicit_hash_key,omitempty"`
	DataByteLength         int    `json:"data_byte_length"`
	ErrorCode              string `json:"error_code"`
	ErrorMessagePresent    bool   `json:"error_message_present"`
	ErrorMessageByteLength int    `json:"error_message_byte_length"`
	SafeLog                string `json:"safe_log"`
}

// KinesisPutRecordsFailureReportSummary is the safe aggregate summary for a PutRecords-style result.
type KinesisPutRecordsFailureReportSummary struct {
	RecordCount       int    `json:"record_count"`
	FailedRecordCount int    `json:"failed_record_count"`
	SafeLog           string `json:"safe_log"`
}

// KinesisPutRecordsFailureReport reports per-record PutRecords-style failures without copying JSON payload bodies.
type KinesisPutRecordsFailureReport struct {
	RecordCount       int                                   `json:"record_count"`
	FailedRecordCount int                                   `json:"failed_record_count"`
	Failures          []KinesisPutRecordsFailure            `json:"failures"`
	SafeSummary       KinesisPutRecordsFailureReportSummary `json:"safe_summary"`
}

// NewKinesisJSONRecord returns one deterministic JSON record for Kinesis producer calls.
//
// The helper validates the partition key, canonicalizes the optional explicit hash key, JSON-encodes the payload with
// deterministic object-key ordering from encoding/json, disables HTML escaping, and enforces Kinesis record bounds. It
// does not send the record or wrap an AWS SDK client.
func NewKinesisJSONRecord(opts KinesisJSONRecordOptions) (KinesisJSONRecord, error) {
	partitionKey, err := normalizeKinesisPartitionKey(opts.PartitionKey)
	if err != nil {
		return KinesisJSONRecord{}, err
	}
	explicitHashKey, err := normalizeKinesisExplicitHashKey(opts.ExplicitHashKey)
	if err != nil {
		return KinesisJSONRecord{}, err
	}
	data, err := encodeKinesisJSONPayload(opts.Payload)
	if err != nil {
		return KinesisJSONRecord{}, err
	}

	record := KinesisJSONRecord{
		PartitionKey:    partitionKey,
		Data:            data,
		ExplicitHashKey: explicitHashKey,
	}
	record.SafeSummary = kinesisJSONRecordSafeSummary(record)
	return record, nil
}

// ReportKinesisPutRecordsFailures returns safe per-record failures aligned by input and result index.
//
// The input records must be KinesisJSONRecord values produced by NewKinesisJSONRecord or equivalent bounded data. The
// result records are the minimal PutRecords-style per-record results, not raw SDK client instances or responses. Raw
// JSON payload bytes and raw error messages are intentionally excluded from the returned safe summaries.
func ReportKinesisPutRecordsFailures(
	records []KinesisJSONRecord,
	results []KinesisPutRecordsResultRecord,
) (KinesisPutRecordsFailureReport, error) {
	report := KinesisPutRecordsFailureReport{RecordCount: len(records)}
	if len(records) != len(results) {
		return report, fmt.Errorf(
			"%s: records/results length mismatch records=%d results=%d",
			kinesisPutRecordsInvalidMessage,
			len(records),
			len(results),
		)
	}
	if len(records) > kinesisMaxPutRecordsRecords {
		return report, fmt.Errorf(
			"%s: record count %d exceeds %d",
			kinesisPutRecordsInvalidMessage,
			len(records),
			kinesisMaxPutRecordsRecords,
		)
	}

	failures := make([]KinesisPutRecordsFailure, 0)
	for i := range records {
		record, err := normalizeKinesisReportRecord(records[i], i)
		if err != nil {
			return report, err
		}
		result, err := normalizeKinesisPutRecordsResultRecord(results[i], i)
		if err != nil {
			return report, err
		}
		if result.ErrorCode == "" {
			continue
		}
		failures = append(failures, kinesisPutRecordsFailure(i, record, result))
	}

	report.Failures = failures
	report.FailedRecordCount = len(failures)
	report.SafeSummary = kinesisPutRecordsFailureReportSummary(report.RecordCount, report.FailedRecordCount)
	return report, nil
}

func encodeKinesisJSONPayload(payload any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return nil, fmt.Errorf("%s: json encode: %w", kinesisJSONRecordInvalidMessage, err)
	}
	data := bytes.TrimSuffix(buf.Bytes(), []byte{'\n'})
	if len(data) == 0 {
		return nil, errors.New(kinesisJSONRecordInvalidMessage + ": empty json payload")
	}
	if len(data) > kinesisMaxRecordDataBytes {
		return nil, fmt.Errorf(
			"%s: json payload size %d exceeds %d",
			kinesisJSONRecordInvalidMessage,
			len(data),
			kinesisMaxRecordDataBytes,
		)
	}
	return append([]byte(nil), data...), nil
}

func normalizeKinesisPartitionKey(value string) (string, error) {
	partitionKey := strings.TrimSpace(value)
	if partitionKey == "" {
		return "", errors.New(kinesisJSONRecordInvalidMessage + ": partition key is required")
	}
	if len([]byte(partitionKey)) > kinesisMaxPartitionKeyBytes {
		return "", fmt.Errorf(
			"%s: partition key length %d exceeds %d bytes",
			kinesisJSONRecordInvalidMessage,
			len([]byte(partitionKey)),
			kinesisMaxPartitionKeyBytes,
		)
	}
	return partitionKey, nil
}

func normalizeKinesisExplicitHashKey(value string) (string, error) {
	explicitHashKey := strings.TrimSpace(value)
	if explicitHashKey == "" {
		return "", nil
	}
	for _, r := range explicitHashKey {
		if r < '0' || r > '9' {
			return "", errors.New(kinesisJSONRecordInvalidMessage + ": explicit hash key must be decimal digits")
		}
	}
	explicitHashKey = strings.TrimLeft(explicitHashKey, "0")
	if explicitHashKey == "" {
		explicitHashKey = "0"
	}
	if len(explicitHashKey) > len(kinesisMaxExplicitHashKey) ||
		(len(explicitHashKey) == len(kinesisMaxExplicitHashKey) && explicitHashKey > kinesisMaxExplicitHashKey) {
		return "", errors.New(kinesisJSONRecordInvalidMessage + ": explicit hash key exceeds Kinesis hash key range")
	}
	return explicitHashKey, nil
}

func kinesisJSONRecordSafeSummary(record KinesisJSONRecord) KinesisJSONRecordSummary {
	dataByteLength := len(record.Data)
	safeLog := fmt.Sprintf("partition_key=%s data_bytes=%d", record.PartitionKey, dataByteLength)
	if record.ExplicitHashKey != "" {
		safeLog = fmt.Sprintf("partition_key=%s explicit_hash_key=%s data_bytes=%d", record.PartitionKey, record.ExplicitHashKey, dataByteLength)
	}
	return KinesisJSONRecordSummary{
		PartitionKey:    record.PartitionKey,
		ExplicitHashKey: record.ExplicitHashKey,
		DataByteLength:  dataByteLength,
		SafeLog:         safeLog,
	}
}

func normalizeKinesisReportRecord(record KinesisJSONRecord, index int) (KinesisJSONRecord, error) {
	partitionKey, err := normalizeKinesisPartitionKey(record.PartitionKey)
	if err != nil {
		return KinesisJSONRecord{}, fmt.Errorf("%s at index %d", err.Error(), index)
	}
	explicitHashKey, err := normalizeKinesisExplicitHashKey(record.ExplicitHashKey)
	if err != nil {
		return KinesisJSONRecord{}, fmt.Errorf("%s at index %d", err.Error(), index)
	}
	if len(record.Data) == 0 {
		return KinesisJSONRecord{}, fmt.Errorf("%s: empty record data at index %d", kinesisPutRecordsInvalidMessage, index)
	}
	if len(record.Data) > kinesisMaxRecordDataBytes {
		return KinesisJSONRecord{}, fmt.Errorf(
			"%s: record data size %d exceeds %d at index %d",
			kinesisPutRecordsInvalidMessage,
			len(record.Data),
			kinesisMaxRecordDataBytes,
			index,
		)
	}
	record.PartitionKey = partitionKey
	record.ExplicitHashKey = explicitHashKey
	return record, nil
}

func normalizeKinesisPutRecordsResultRecord(
	result KinesisPutRecordsResultRecord,
	index int,
) (KinesisPutRecordsResultRecord, error) {
	result.SequenceNumber = strings.TrimSpace(result.SequenceNumber)
	result.ShardID = strings.TrimSpace(result.ShardID)
	result.ErrorCode = strings.TrimSpace(result.ErrorCode)
	result.ErrorMessage = strings.TrimSpace(result.ErrorMessage)
	if result.ErrorCode == "" && result.ErrorMessage != "" {
		return result, fmt.Errorf("%s: error message without error code at index %d", kinesisPutRecordsInvalidMessage, index)
	}
	if len([]byte(result.ErrorCode)) > kinesisMaxErrorCodeBytes {
		return result, fmt.Errorf("%s: error code too long at index %d", kinesisPutRecordsInvalidMessage, index)
	}
	for _, r := range result.ErrorCode {
		if r <= ' ' || r == 0x7f {
			return result, fmt.Errorf("%s: unsafe error code at index %d", kinesisPutRecordsInvalidMessage, index)
		}
	}
	if len([]byte(result.ErrorMessage)) > kinesisMaxErrorMessageBytes {
		return result, fmt.Errorf("%s: error message too long at index %d", kinesisPutRecordsInvalidMessage, index)
	}
	return result, nil
}

func kinesisPutRecordsFailure(
	index int,
	record KinesisJSONRecord,
	result KinesisPutRecordsResultRecord,
) KinesisPutRecordsFailure {
	errorMessageByteLength := len([]byte(result.ErrorMessage))
	failure := KinesisPutRecordsFailure{
		Index:                  index,
		PartitionKey:           record.PartitionKey,
		ExplicitHashKey:        record.ExplicitHashKey,
		DataByteLength:         len(record.Data),
		ErrorCode:              result.ErrorCode,
		ErrorMessagePresent:    result.ErrorMessage != "",
		ErrorMessageByteLength: errorMessageByteLength,
	}
	failure.SafeLog = kinesisPutRecordsFailureSafeLog(failure)
	return failure
}

func kinesisPutRecordsFailureSafeLog(failure KinesisPutRecordsFailure) string {
	base := fmt.Sprintf(
		"kinesis_put_records_failure index=%d partition_key=%s data_bytes=%d error_code=%s error_message_present=%t error_message_bytes=%d",
		failure.Index,
		failure.PartitionKey,
		failure.DataByteLength,
		failure.ErrorCode,
		failure.ErrorMessagePresent,
		failure.ErrorMessageByteLength,
	)
	if failure.ExplicitHashKey == "" {
		return base
	}
	return fmt.Sprintf(
		"kinesis_put_records_failure index=%d partition_key=%s explicit_hash_key=%s data_bytes=%d error_code=%s error_message_present=%t error_message_bytes=%d",
		failure.Index,
		failure.PartitionKey,
		failure.ExplicitHashKey,
		failure.DataByteLength,
		failure.ErrorCode,
		failure.ErrorMessagePresent,
		failure.ErrorMessageByteLength,
	)
}

func kinesisPutRecordsFailureReportSummary(recordCount int, failedRecordCount int) KinesisPutRecordsFailureReportSummary {
	return KinesisPutRecordsFailureReportSummary{
		RecordCount:       recordCount,
		FailedRecordCount: failedRecordCount,
		SafeLog: fmt.Sprintf(
			"kinesis_put_records record_count=%d failed_record_count=%d",
			recordCount,
			failedRecordCount,
		),
	}
}
