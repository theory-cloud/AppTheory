package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestProvisionTablesCreatesSchemaGSIsStreamsAndTTL(t *testing.T) {
	var mu sync.Mutex
	var created map[string]any
	var ttl map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		target := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(target, "CreateTable"):
			mu.Lock()
			if decodeErr := json.Unmarshal(body, &created); decodeErr != nil {
				t.Errorf("decode create table: %v", decodeErr)
			}
			mu.Unlock()
			writeTestResponse(t, writer, `{"TableDescription":{"TableName":"jobs","TableStatus":"ACTIVE",`+
				`"TableArn":"arn:aws:dynamodb:us-east-1:123456789012:table/jobs",`+
				`"LatestStreamArn":"arn:aws:dynamodb:us-east-1:123456789012:table/jobs/stream/1"}}`)
		case strings.HasSuffix(target, "DescribeTable"):
			writeTestResponse(t, writer, `{"Table":{"TableName":"jobs","TableStatus":"ACTIVE",`+
				`"TableArn":"arn:aws:dynamodb:us-east-1:123456789012:table/jobs",`+
				`"LatestStreamArn":"arn:aws:dynamodb:us-east-1:123456789012:table/jobs/stream/1"}}`)
		case strings.HasSuffix(target, "UpdateTimeToLive"):
			mu.Lock()
			if decodeErr := json.Unmarshal(body, &ttl); decodeErr != nil {
				t.Errorf("decode TTL: %v", decodeErr)
			}
			mu.Unlock()
			writeTestResponse(t, writer, `{"TimeToLiveSpecification":{"Enabled":true,"AttributeName":"ttl"}}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"dynamodb": {
				HostURL:   server.URL,
				Endpoints: []Endpoint{{Service: "dynamodb", URL: "http://dynamodb-local:8000"}},
			},
		},
		resourceValues: resourceValues{},
		tables:         map[string]tableInfo{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Jobs", Type: typeDynamoTable,
		Properties: json.RawMessage(`{
			"TableName":"jobs",
			"BillingMode":"PAY_PER_REQUEST",
			"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"},{"AttributeName":"status","AttributeType":"S"}],
			"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],
			"GlobalSecondaryIndexes":[{"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}],
			"StreamSpecification":{"StreamViewType":"NEW_AND_OLD_IMAGES"},
			"TimeToLiveSpecification":{"AttributeName":"ttl","Enabled":true}
		}`),
	}}}
	if err := runner.provisionTables(context.Background(), spec); err != nil {
		t.Fatalf("provision tables: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if created["TableName"] != "jobs" {
		t.Fatalf("table name not sent: %+v", created)
	}
	keySchema := mustSlice(t, created["KeySchema"])
	if mustString(t, mustMap(t, keySchema[0])["AttributeName"]) != "pk" {
		t.Fatalf("key schema not sent: %+v", keySchema)
	}
	indexes := mustSlice(t, created["GlobalSecondaryIndexes"])
	if mustString(t, mustMap(t, indexes[0])["IndexName"]) != "status-index" {
		t.Fatalf("GSI not sent: %+v", indexes)
	}
	stream := mustMap(t, created["StreamSpecification"])
	if stream["StreamViewType"] != "NEW_AND_OLD_IMAGES" || stream["StreamEnabled"] != true {
		t.Fatalf("stream not enabled: %+v", stream)
	}
	if ttl["TableName"] != "jobs" {
		t.Fatalf("TTL update not sent: %+v", ttl)
	}
	value := runner.resourceValues["Stack/Jobs"]
	if value.StreamARN != "arn:aws:dynamodb:us-east-1:123456789012:table/jobs/stream/1" {
		t.Fatalf("stream ARN not recorded: %+v", value)
	}
	info := runner.tables["Stack/Jobs"]
	if info.Name != "jobs" || len(info.KeySchema) != 1 || info.StreamViewType != "NEW_AND_OLD_IMAGES" {
		t.Fatalf("table info not recorded: %+v", info)
	}
}

func TestProvisionQueuesCreatesQueuesAndRedrivePolicy(t *testing.T) {
	var mu sync.Mutex
	attributes := map[string]map[string]string{}
	var redrive map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var payload map[string]any
		if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
			t.Errorf("decode payload: %v", decodeErr)
			return
		}
		action := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		switch {
		case strings.Contains(action, "CreateQueue"):
			name := mustString(t, payload["QueueName"])
			attrs := map[string]string{}
			if raw, ok := payload["Attributes"].(map[string]any); ok {
				for key, value := range raw {
					attrs[key] = fmt.Sprint(value)
				}
			}
			mu.Lock()
			attributes[name] = attrs
			mu.Unlock()
			if _, err := fmt.Fprintf(writer, `{"QueueUrl":"http://localhost:9324/000000000000/%s"}`, name); err != nil {
				t.Errorf("write queue URL: %v", err)
			}
		case strings.Contains(action, "SetQueueAttributes"):
			raw, _ := payload["Attributes"].(map[string]any) //nolint:errcheck // optional fixture field
			mu.Lock()
			redrive = map[string]string{
				"queue": fmt.Sprint(payload["QueueUrl"]),
				"value": fmt.Sprint(raw["RedrivePolicy"]),
			}
			mu.Unlock()
			writeTestResponse(t, writer, `{}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"sqs": {
				HostURL:   server.URL,
				Endpoints: []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}},
			},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{
			Stack: "Stack", LogicalID: "Dead", Type: typeSQSQueue,
			Properties: json.RawMessage(`{"QueueName":"events-dlq"}`),
		},
		{
			Stack: "Stack", LogicalID: "Main", Type: typeSQSQueue,
			Properties: json.RawMessage(`{
				"QueueName":"events",
				"VisibilityTimeout":60,
				"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["Dead","Arn"]},"maxReceiveCount":5}
			}`),
		},
	}}
	if err := runner.provisionQueues(context.Background(), spec); err != nil {
		t.Fatalf("provision queues: %v", err)
	}
	main := runner.resourceValues["Stack/Main"]
	if main.URL != "http://sqs:9324/000000000000/events" {
		t.Fatalf("queue URL was not rewritten for the run network: %+v", main)
	}
	if main.ARN != "arn:aws:sqs:us-east-1:123456789012:events" {
		t.Fatalf("queue ARN not recorded: %+v", main)
	}
	mu.Lock()
	defer mu.Unlock()
	if attributes["events"]["VisibilityTimeout"] != "60" {
		t.Fatalf("visibility timeout not sent: %+v", attributes)
	}
	if redrive == nil || !strings.Contains(redrive["queue"], "events") {
		t.Fatalf("redrive policy not set: %+v", redrive)
	}
	var policy map[string]any
	if err := json.Unmarshal([]byte(redrive["value"]), &policy); err != nil {
		t.Fatalf("decode redrive policy: %v", err)
	}
	if policy["deadLetterTargetArn"] != "arn:aws:sqs:us-east-1:123456789012:events-dlq" {
		t.Fatalf("redrive target lost: %+v", policy)
	}
	if fmt.Sprint(policy["maxReceiveCount"]) != "5" {
		t.Fatalf("maxReceiveCount lost: %+v", policy)
	}
}

func writeTestResponse(t *testing.T, writer http.ResponseWriter, body string) {
	t.Helper()
	if _, err := writer.Write([]byte(body)); err != nil {
		t.Errorf("write test response: %v", err)
	}
}
