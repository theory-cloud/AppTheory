package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// TestWaitForProfileRetriesAStartingContainer pins the readiness rule: a
// container that accepts a connection but answers 500 while it starts is
// retried until the deadline, not reported as a resolution failure.
func TestWaitForProfileRetriesAStartingContainer(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) <= 2 {
			writer.Header().Set("content-type", "application/x-amz-json-1.0")
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`{"__type":"InternalServerError"}`))
			return
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		_, _ = writer.Write([]byte(`{"TableNames":[]}`))
	}))
	defer server.Close()

	client := dynamodb.New(dynamodb.Options{
		Region:           "us-east-1",
		Credentials:      credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
		BaseEndpoint:     aws.String(server.URL),
		RetryMaxAttempts: 1,
	})
	start := time.Now()
	if err := waitForProfile(context.Background(), client, 5*time.Second); err != nil {
		t.Fatalf("waitForProfile: %v", err)
	}
	if time.Since(start) < time.Second {
		t.Fatalf("waitForProfile returned before retrying a starting backend")
	}
	if atomic.LoadInt32(&attempts) < 3 {
		t.Fatalf("waitForProfile made %d attempts, want at least 3", attempts)
	}
}
