package main

import (
	"context"
	"io"
	"log"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

const testStreamARN = "arn:aws:kinesis:us-east-1:111122223333:stream/apptheory-example-cloudwatch-logs"

func TestBuildAppProcessesCloudWatchLogsSubscription(t *testing.T) {
	t.Setenv(streamNameEnv, "apptheory-example-cloudwatch-logs")

	var processed []apptheory.CloudWatchLogsSubscription
	app := buildApp(log.New(io.Discard, "", 0), func(_ context.Context, decoded apptheory.CloudWatchLogsSubscription) error {
		processed = append(processed, decoded)
		return nil
	})

	env := testkit.New()
	out := env.InvokeKinesis(context.Background(), app, testkit.KinesisEvent(testkit.KinesisEventOptions{
		StreamARN: testStreamARN,
		Records: []testkit.KinesisRecordOptions{
			testkit.KinesisCloudWatchLogsSubscriptionRecord(testkit.KinesisCloudWatchLogsSubscriptionRecordOptions{
				EventID: "kinesis-cwl-1",
				Subscription: testkit.CloudWatchLogsSubscriptionOptions{
					Owner:               "111122223333",
					LogGroup:            "/aws/apptheory/example/cloudwatch-logs-source",
					LogStream:           "2026/05/26/[$LATEST]example",
					SubscriptionFilters: []string{"apptheory-example-all-events"},
					LogEvents: []apptheory.CloudWatchLogsSubscriptionLogEvent{{
						ID:        "log-event-1",
						Timestamp: 1779806400000,
						Message:   "example customer log line available to app-specific processing",
					}},
				},
			}),
		},
	}))

	if len(out.BatchItemFailures) != 0 {
		t.Fatalf("unexpected batch failures: %#v", out.BatchItemFailures)
	}
	if len(processed) != 1 {
		t.Fatalf("expected one processed subscription, got %d", len(processed))
	}
	if processed[0].RecordID != "kinesis-cwl-1" || processed[0].Owner != "111122223333" {
		t.Fatalf("unexpected decoded identity: %#v", processed[0])
	}
	if len(processed[0].LogEvents) != 1 || processed[0].LogEvents[0].Message == "" {
		t.Fatalf("expected decoded log event message for app processing: %#v", processed[0].LogEvents)
	}
}

func TestBuildAppReportsDecodeFailuresByRecord(t *testing.T) {
	t.Setenv(streamNameEnv, "apptheory-example-cloudwatch-logs")

	app := buildApp(log.New(io.Discard, "", 0), nil)
	env := testkit.New()
	out := env.InvokeKinesis(context.Background(), app, testkit.KinesisEvent(testkit.KinesisEventOptions{
		StreamARN: testStreamARN,
		Records: []testkit.KinesisRecordOptions{{
			EventID: "bad-record",
			Data:    []byte("not a gzip cloudwatch logs subscription payload"),
		}},
	}))

	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "0" {
		t.Fatalf("expected malformed record to be reported as a partial batch failure, got %#v", out.BatchItemFailures)
	}
}

func TestBuildAppFailsClosedWhenStreamNameIsMissing(t *testing.T) {
	t.Setenv(streamNameEnv, "")

	app := buildApp(log.New(io.Discard, "", 0), nil)
	env := testkit.New()
	out := env.InvokeKinesis(context.Background(), app, testkit.KinesisEvent(testkit.KinesisEventOptions{
		StreamARN: testStreamARN,
		Records: []testkit.KinesisRecordOptions{
			testkit.KinesisCloudWatchLogsSubscriptionRecord(testkit.KinesisCloudWatchLogsSubscriptionRecordOptions{
				EventID: "unrouted-record",
			}),
		},
	}))

	if len(out.BatchItemFailures) != 1 || out.BatchItemFailures[0].ItemIdentifier != "0" {
		t.Fatalf("expected missing stream route to fail closed, got %#v", out.BatchItemFailures)
	}
}
