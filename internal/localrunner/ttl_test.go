package localrunner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// TestTTLSweeperMarksBeforeDelete proves the ordering invariant: the marker is
// present when the delete reaches DynamoDB Local, so a poll that reads the
// resulting REMOVE can always attach the service userIdentity.
func TestTTLSweeperMarksBeforeDelete(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	runner := &Runner{clock: NewTestClock(start), ttl: newTTLTracker()}
	key := map[string]any{"pk": map[string]any{"S": "expired"}}

	var (
		mu   sync.Mutex
		seen bool
	)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.Header.Get("X-Amz-Target") {
		case "DynamoDB_20120810.Scan":
			writeTestJSON(t, writer, `{"Items":[{"pk":{"S":"expired"},"expiresAt":{"N":"100"}}],"Count":1}`)
		case "DynamoDB_20120810.DeleteItem":
			// The stream poller can take the marker as soon as the delete
			// lands, so the fake consumes it from inside DeleteItem.
			mu.Lock()
			seen = runner.ttl.take("probe", key, start.Add(time.Minute))
			mu.Unlock()
			writeTestJSON(t, writer, `{}`)
		default:
			t.Errorf("unexpected target %s", request.Header.Get("X-Amz-Target"))
		}
	}))
	defer server.Close()

	client := dynamodb.New(dynamodb.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(server.URL),
	})
	runner.sweepTTL(context.Background(), client, ttlTable{
		Name:      "probe",
		Attribute: "expiresAt",
		KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}},
	})

	mu.Lock()
	defer mu.Unlock()
	if !seen {
		t.Fatal("the TTL marker was absent when DeleteItem ran; it must be recorded first")
	}
}

// TestTTLSweeperUnmarksFailedDelete proves a delete that fails leaves no marker
// behind, so a later manual delete of the same key is not mislabelled.
func TestTTLSweeperUnmarksFailedDelete(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	runner := &Runner{clock: NewTestClock(start), ttl: newTTLTracker()}
	key := map[string]any{"pk": map[string]any{"S": "expired"}}

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.Header.Get("X-Amz-Target") {
		case "DynamoDB_20120810.Scan":
			writeTestJSON(t, writer, `{"Items":[{"pk":{"S":"expired"},"expiresAt":{"N":"100"}}],"Count":1}`)
		case "DynamoDB_20120810.DeleteItem":
			http.Error(writer, "delete failed", http.StatusBadRequest)
		default:
			t.Errorf("unexpected target %s", request.Header.Get("X-Amz-Target"))
		}
	}))
	defer server.Close()

	client := dynamodb.New(dynamodb.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(server.URL),
	})
	runner.sweepTTL(context.Background(), client, ttlTable{
		Name:      "probe",
		Attribute: "expiresAt",
		KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}},
	})

	if runner.ttl.take("probe", key, start.Add(time.Minute)) {
		t.Fatal("a failed delete left a TTL marker")
	}
}
