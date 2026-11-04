package localrunner

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func s3NotificationAssembly(properties map[string]any) map[string]any {
	return map[string]any{
		"Fn":       withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Bucket":   map[string]any{"Type": typeS3Bucket, "Properties": properties},
		"Queue":    map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "ingest"}},
		"Topic":    map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "ingest-topic"}},
		"Consumer": withAsset(lambdaFunction(nil), "asset.cafebabe"),
	}
}

func TestDeriveS3NotificationConfigurations(t *testing.T) {
	resources := s3NotificationAssembly(map[string]any{
		"BucketName": "ingest-bucket",
		"NotificationConfiguration": map[string]any{
			"LambdaConfigurations": []any{
				map[string]any{
					"Event":    "s3:ObjectCreated:*",
					"Function": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"Filter": map[string]any{
						"S3Key": map[string]any{
							"Rules": []any{
								map[string]any{"Name": "prefix", "Value": "incoming/"},
								map[string]any{"Name": "suffix", "Value": ".json"},
							},
						},
					},
				},
			},
			"QueueConfigurations": []any{
				map[string]any{
					"Event": "s3:ObjectRemoved:*",
					"Queue": map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
				},
			},
			"TopicConfigurations": []any{
				map[string]any{
					"Event": "s3:ObjectCreated:Put",
					"Topic": map[string]any{"Ref": "Topic"},
				},
			},
			"EventBridgeConfiguration": map[string]any{},
		},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Notifications) != 4 {
		t.Fatalf("notifications = %+v", spec.Notifications)
	}
	byType := map[string]NotificationSpec{}
	for _, notification := range spec.Notifications {
		byType[notification.DestinationType] = notification
	}
	function := byType[notificationDestinationFunction]
	if function.Destination != "Fn" || function.BucketName != "ingest-bucket" {
		t.Fatalf("function notification = %+v", function)
	}
	if len(function.FilterRules) != 2 || function.FilterRules[0].Name != "prefix" || function.FilterRules[1].Value != ".json" {
		t.Fatalf("filter rules = %+v", function.FilterRules)
	}
	if byType[notificationDestinationQueue].Destination != "Queue" {
		t.Fatalf("queue notification = %+v", byType[notificationDestinationQueue])
	}
	if byType[notificationDestinationTopic].Destination != "Topic" {
		t.Fatalf("topic notification = %+v", byType[notificationDestinationTopic])
	}
	if !byType[notificationDestinationEventBridge].EventBridge {
		t.Fatalf("eventbridge notification = %+v", byType[notificationDestinationEventBridge])
	}
	if !strings.Contains(function.LogicalID, "Bucket/notification/") {
		t.Fatalf("notification id = %q", function.LogicalID)
	}
	// The function destination must be started with the run, exactly like a
	// rule target.
	running := spec.RuntimeFunctions()
	if !containsStringList(running, "Fn") {
		t.Fatalf("the Lambda notification destination is not started: %v", running)
	}
	// Plan reports every configuration as registered once the deliverer exists.
	engine := NewDeliveryEngine(RealClock{}, 1, nil, nil, nil)
	engine.RegisterDeliverer(DeliveryKindS3Notification, func(DeliverySource) (Deliverer, error) {
		return &s3NotificationNoopDeliverer{}, nil
	})
	planned := engine.Planned(spec)
	registered := 0
	for _, state := range planned {
		if state.Kind != DeliveryKindS3Notification {
			continue
		}
		if state.State != DeliveryPhaseRegistered {
			t.Fatalf("plan state %+v", state)
		}
		registered++
	}
	if registered != len(spec.Notifications) {
		t.Fatalf("plan registered %d of %d notifications", registered, len(spec.Notifications))
	}
}

// s3NotificationNoopDeliverer lets the plan test register the kind without
// starting a watcher.
type s3NotificationNoopDeliverer struct{}

func (*s3NotificationNoopDeliverer) Start(ctx context.Context, _ DelivererEnv) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestDeriveS3NotificationsFromCDKCustomResource(t *testing.T) {
	resources := map[string]any{
		"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Bucket": map[string]any{"Type": typeS3Bucket},
		"Notifications": map[string]any{
			"Type": typeBucketNotifications,
			"Properties": map[string]any{ //nolint:gosec // a test fixture, not a credential
				"ServiceToken": "arn:aws:lambda:us-east-1:123456789012:function:cdk-handler",
				"BucketName":   map[string]any{"Ref": "Bucket"},
				"NotificationConfiguration": map[string]any{
					"LambdaFunctionConfigurations": []any{
						map[string]any{
							"Events":            []any{"s3:ObjectCreated:*"},
							"LambdaFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
							"Filter": map[string]any{
								"Key": map[string]any{
									"FilterRules": []any{
										map[string]any{"Name": "prefix", "Value": "incoming/"},
									},
								},
							},
						},
					},
				},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Notifications) != 1 {
		t.Fatalf("notifications = %+v", spec.Notifications)
	}
	notification := spec.Notifications[0]
	if notification.DestinationType != notificationDestinationFunction || notification.Destination != "Fn" {
		t.Fatalf("notification = %+v", notification)
	}
	if len(notification.Events) != 1 || notification.Events[0] != "s3:ObjectCreated:*" {
		t.Fatalf("events = %+v", notification.Events)
	}
	if len(notification.FilterRules) != 1 || notification.FilterRules[0].Value != "incoming/" {
		t.Fatalf("filters = %+v", notification.FilterRules)
	}
}

func TestDeriveS3NotificationRefusesUnknownDestination(t *testing.T) {
	resources := s3NotificationAssembly(map[string]any{
		"BucketName": "ingest-bucket",
		"NotificationConfiguration": map[string]any{
			"LambdaConfigurations": []any{
				map[string]any{
					"Event":    "s3:ObjectCreated:*",
					"Function": "arn:aws:lambda:us-east-1:123456789012:function:not-in-the-stack",
				},
			},
		},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "not a AWS::Lambda::Function") {
		t.Fatalf("derive error = %v", err)
	}
}

func TestDeriveS3NotificationRefusesBadFilter(t *testing.T) {
	resources := s3NotificationAssembly(map[string]any{
		"BucketName": "ingest-bucket",
		"NotificationConfiguration": map[string]any{
			"QueueConfigurations": []any{
				map[string]any{
					"Event": "s3:ObjectCreated:*",
					"Queue": map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
					"Filter": map[string]any{
						"S3Key": map[string]any{
							"Rules": []any{
								map[string]any{"Name": "regex", "Value": ".*"},
							},
						},
					},
				},
			},
		},
	})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "not prefix or suffix") {
		t.Fatalf("derive error = %v", err)
	}
}

func TestS3EventNameMatching(t *testing.T) {
	cases := []struct {
		declared string
		record   string
		want     bool
	}{
		{"s3:ObjectCreated:*", s3RecordObjectCreatedPut, true},
		{"s3:ObjectCreated:*", s3RecordObjectCreatedCompleteMultipart, true},
		{"s3:ObjectCreated:Put", s3RecordObjectCreatedPut, true},
		{"s3:ObjectCreated:Put", s3RecordObjectCreatedCopy, false},
		{"s3:ObjectRemoved:*", s3RecordObjectRemovedDelete, true},
		{"s3:ObjectRemoved:Delete", s3RecordObjectRemovedDelete, true},
		{"s3:ObjectCreated:*", s3RecordObjectRemovedDelete, false},
	}
	for _, testCase := range cases {
		if got := s3EventNameMatches(testCase.declared, testCase.record); got != testCase.want {
			t.Fatalf("%s vs %s = %t, want %t", testCase.declared, testCase.record, got, testCase.want)
		}
	}
}

func TestNotificationMatchesFilters(t *testing.T) {
	notification := NotificationSpec{
		Events: []string{"s3:ObjectCreated:*"},
		FilterRules: []NotificationFilterRule{
			{Name: "prefix", Value: "incoming/"},
			{Name: "suffix", Value: ".json"},
		},
	}
	cases := map[string]bool{
		"incoming/a.json":   true,
		"outgoing/a.json":   false,
		"incoming/a.txt":    false,
		"incoming/a/b.json": true,
	}
	for key, want := range cases {
		if got := notificationMatches(notification, s3RecordObjectCreatedPut, key); got != want {
			t.Fatalf("%s = %t, want %t", key, got, want)
		}
	}
}

func TestS3NotificationRecordShape(t *testing.T) {
	event := S3ObjectEvent{
		Bucket:          "ingest-bucket",
		BucketARN:       "arn:aws:s3:::ingest-bucket",
		Key:             "incoming/report 1.json",
		EventName:       s3RecordObjectCreatedPut,
		ConfigurationID: "local-abc",
		Size:            42,
		ETag:            "\"d41d8cd98f00b204e9800998ecf8427e\"",
		Sequencer:       "0055AED6DCD90281E5",
		Time:            time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		RequestID:       "C3D13FE58DE4C810",
		SourceIP:        "127.0.0.1",
	}
	encoded, err := BuildS3NotificationRecord(event)
	if err != nil {
		t.Fatalf("build record: %v", err)
	}
	var document struct {
		Records []struct {
			EventVersion string `json:"eventVersion"`
			EventSource  string `json:"eventSource"`
			EventName    string `json:"eventName"`
			S3           struct {
				ConfigurationID string `json:"configurationId"`
				Bucket          struct {
					Name string `json:"name"`
					ARN  string `json:"arn"`
				} `json:"bucket"`
				Object struct {
					Key  string `json:"key"`
					Size int64  `json:"size"`
					ETag string `json:"eTag"`
				} `json:"object"`
			} `json:"s3"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("decode record: %v", err)
	}
	if len(document.Records) != 1 {
		t.Fatalf("records = %+v", document.Records)
	}
	record := document.Records[0]
	if record.EventVersion != "2.6" || record.EventSource != "aws:s3" || record.EventName != "ObjectCreated:Put" {
		t.Fatalf("record = %+v", record)
	}
	if record.S3.ConfigurationID != "local-abc" || record.S3.Bucket.Name != "ingest-bucket" {
		t.Fatalf("s3 block = %+v", record.S3)
	}
	if record.S3.Object.Key != "incoming/report+1.json" {
		t.Fatalf("key = %q", record.S3.Object.Key)
	}
	if record.S3.Object.ETag != "d41d8cd98f00b204e9800998ecf8427e" {
		t.Fatalf("etag = %q", record.S3.Object.ETag)
	}
}

func TestS3TestEventShape(t *testing.T) {
	encoded, err := BuildS3TestEvent("ingest-bucket", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("build test event: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if document["Service"] != "Amazon S3" || document["Event"] != "s3:TestEvent" ||
		document["Bucket"] != "ingest-bucket" || document["Time"] != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("test event = %v", document)
	}
	if _, ok := document["Records"]; ok {
		t.Fatalf("the test event must not use the Records envelope: %v", document)
	}
}

func TestS3EventBridgeEntryShape(t *testing.T) {
	entry := s3EventBridgeEntry(S3ObjectEvent{
		Bucket: "ingest-bucket", BucketARN: "arn:aws:s3:::ingest-bucket", Key: "incoming/a.json",
		EventName: s3RecordObjectCreatedPut, Size: 5, ETag: "\"etag\"", Sequencer: "01",
		Time: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), RequestID: "req", SourceIP: "127.0.0.1",
		Reason: s3ReasonPutObject,
	})
	if entry.Source != "aws.s3" || entry.DetailType != "Object Created" {
		t.Fatalf("entry = %+v", entry)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(entry.Detail), &detail); err != nil {
		t.Fatalf("detail: %v", err)
	}
	if detail["reason"] != "PutObject" || detail["version"] != "0" {
		t.Fatalf("detail = %v", detail)
	}
	object, ok := detail["object"].(map[string]any)
	if !ok {
		t.Fatalf("object detail = %v", detail)
	}
	if object["key"] != "incoming/a.json" || object["etag"] != "etag" {
		t.Fatalf("object = %v", object)
	}
}

func TestApplySnapshotDispatchesObservedChanges(t *testing.T) {
	var delivered []S3ObjectEvent
	supervisor := newS3NotificationSupervisor(
		NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		nil,
		nil,
		nil,
		func(_ context.Context, _ string, event []byte) (InvokeResult, error) {
			var document struct {
				Records []struct {
					EventName string `json:"eventName"`
					S3        struct {
						Object struct {
							Key string `json:"key"`
						} `json:"object"`
					} `json:"s3"`
				} `json:"Records"`
			}
			if err := json.Unmarshal(event, &document); err != nil {
				return InvokeResult{}, err
			}
			delivered = append(delivered, S3ObjectEvent{
				EventName: document.Records[0].EventName,
				Key:       document.Records[0].S3.Object.Key,
			})
			return InvokeResult{}, nil
		},
		nil, nil, nil,
	)
	watcher := &s3BucketWatcher{bucket: "Bucket", name: "ingest-bucket", known: map[string]s3ObjectState{}}
	reporter := &recordingDeliveryReporter{}
	removals := &recordingDeliveryReporter{}
	watcher.destinations = []*s3Destination{
		{
			spec: NotificationSpec{
				Events:          []string{"s3:ObjectCreated:*"},
				DestinationType: notificationDestinationFunction,
				Destination:     "Fn",
			},
			state: reporter,
		},
		{
			spec: NotificationSpec{
				Events:          []string{"s3:ObjectRemoved:*"},
				DestinationType: notificationDestinationFunction,
				Destination:     "Fn",
			},
			state: removals,
		},
	}

	baseline := map[string]s3ObjectState{
		"old.txt":   {ETag: "a", Size: 1, LastModified: time.Unix(1, 0).UTC()},
		"gone.json": {ETag: "d", Size: 4, LastModified: time.Unix(4, 0).UTC()},
	}
	supervisor.applySnapshot(context.Background(), watcher, baseline)
	if len(delivered) != 0 {
		t.Fatalf("the baseline must not deliver: %+v", delivered)
	}

	next := map[string]s3ObjectState{
		"old.txt":  {ETag: "b", Size: 2, LastModified: time.Unix(2, 0).UTC()},
		"new.json": {ETag: "c", Size: 3, LastModified: time.Unix(3, 0).UTC()},
	}
	supervisor.applySnapshot(context.Background(), watcher, next)
	if len(delivered) != 3 {
		t.Fatalf("delivered = %+v", delivered)
	}
	byKey := map[string]string{}
	for _, event := range delivered {
		byKey[event.Key] = event.EventName
	}
	if byKey["old.txt"] != s3RecordObjectCreatedPut || byKey["new.json"] != s3RecordObjectCreatedPut {
		t.Fatalf("created events = %+v", byKey)
	}
	if byKey["gone.json"] != s3RecordObjectRemovedDelete {
		t.Fatalf("removed event = %+v", byKey)
	}
}
