package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	listBucketsResponse = `<?xml version="1.0" encoding="UTF-8"?>` +
		`<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
		`<Owner><ID>dummy</ID><DisplayName>dummy</DisplayName></Owner><Buckets></Buckets>` +
		`</ListAllMyBucketsResult>`
	getCallerIdentityResponse = `<?xml version="1.0" encoding="UTF-8"?>` +
		`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">` +
		`<GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/dummy</Arn>` +
		`<UserId>AKIAIOSFODNN7EXAMPLE</UserId><Account>123456789012</Account>` +
		`</GetCallerIdentityResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId>` +
		`</ResponseMetadata></GetCallerIdentityResponse>`
)

type backendRequestLog struct {
	mu      sync.Mutex
	entries []string
}

func (l *backendRequestLog) add(method, path string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, method+" "+path)
}

func (l *backendRequestLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.entries...)
}

// s3ReadinessServer resets the first resets requests, then answers ListBuckets
// and CreateBucket like s3proxy. Resetting after accepting the connection is
// the failure mode the runner saw in CI.
func s3ReadinessServer(t *testing.T, resets int, log *backendRequestLog) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		log.add(request.Method, request.URL.Path)
		mu.Lock()
		reset := resets > 0
		if reset {
			resets--
		}
		mu.Unlock()
		if reset {
			resetHTTPConnection(writer)
			return
		}
		if request.Method == http.MethodGet && request.URL.Path == "/" {
			writer.Header().Set("content-type", "application/xml")
			if _, err := writer.Write([]byte(listBucketsResponse)); err != nil {
				t.Errorf("write ListBuckets response: %v", err)
			}
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	return server
}

func resetHTTPConnection(writer http.ResponseWriter) {
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		return
	}
	connection, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if tcp, ok := connection.(*net.TCPConn); ok {
		_ = tcp.SetLinger(0) //nolint:errcheck // best-effort RST for a readiness test
	}
	_ = connection.Close() //nolint:errcheck // the hijacked test connection is intentionally dropped
}

func loadBackendProfile(t *testing.T, base, container, service string) *Profile {
	t.Helper()
	document := map[string]any{
		"containers": map[string]any{
			container: map[string]any{
				"image":         "example/" + container + "@" + testDigest,
				"containerPort": 80,
			},
		},
		"endpoints": map[string]any{
			service: map[string]any{
				"container": container,
				"env":       []any{"AWS_ENDPOINT_URL_" + strings.ToUpper(service)},
			},
		},
	}
	encoded, err := json.Marshal(map[string]any{"profile": document})
	if err != nil {
		t.Fatalf("encode backend profile: %v", err)
	}
	path := filepath.Join(base, "readiness-profile.json")
	if writeErr := os.WriteFile(path, encoded, 0o600); writeErr != nil {
		t.Fatalf("write backend profile: %v", writeErr)
	}
	profile, err := LoadProfile(path)
	if err != nil {
		t.Fatalf("load backend profile: %v", err)
	}
	return profile
}

func newBackendRunner(t *testing.T, base, backend, container, service string, hostPort int, output *syncBuffer) *Runner {
	t.Helper()
	runner := &Runner{
		options:        Options{Stdout: output, Backends: []string{backend}},
		profile:        loadBackendProfile(t, base, container, service),
		backends:       map[string]backendProcess{},
		resourceValues: resourceValues{},
		namePrefix:     "test",
	}
	runner.docker = &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if len(argv) < 2 {
			return "", "", nil
		}
		switch argv[1] {
		case "run":
			return "container-id\n", "", nil
		case "inspect":
			return "172.18.0.2\n", "", nil
		case "port":
			return fmt.Sprintf("127.0.0.1:%d\n", hostPort), "", nil
		}
		return "", "", nil
	}}
	return runner
}

func TestStartBackendsWaitsForReadinessBeforeProvisioning(t *testing.T) {
	base := testBase(t)
	log := &backendRequestLog{}
	server := s3ReadinessServer(t, 2, log)
	output := &syncBuffer{}
	runner := newBackendRunner(t, base, "s3proxy", "s3proxy", "s3", serverPort(t, server.URL), output)

	if err := runner.startBackends(context.Background()); err != nil {
		t.Fatalf("start backends: %v", err)
	}
	requests := log.snapshot()
	if !containsRequest(requests, "GET /") {
		t.Fatalf("startBackends reported ready without a readiness call: %v", requests)
	}
	for _, request := range requests {
		if strings.HasPrefix(request, "PUT ") {
			t.Fatalf("bucket creation preceded readiness: %v", requests)
		}
	}
	if !strings.Contains(output.String(), "backend s3proxy") {
		t.Fatalf("readiness log missing:\n%s", output.String())
	}

	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket,
	}}}
	if err := runner.provisionResources(context.Background(), spec); err != nil {
		t.Fatalf("provision resources: %v", err)
	}
	requests = log.snapshot()
	lastReadiness, firstCreate := -1, -1
	for index, request := range requests {
		if request == "GET /" {
			lastReadiness = index
		}
		if strings.HasPrefix(request, "PUT ") && firstCreate < 0 {
			firstCreate = index
		}
	}
	if firstCreate < 0 {
		t.Fatalf("provisioning created no bucket: %v", requests)
	}
	if lastReadiness < 0 || lastReadiness > firstCreate {
		t.Fatalf("bucket creation did not follow the readiness call: %v", requests)
	}
	if value := runner.resourceValues["Stack/Bucket"]; value.Name == "" {
		t.Fatalf("provisioned bucket was not recorded: %+v", runner.resourceValues)
	}
}

func TestStartBackendsFailsClosedWhenBackendNeverAnswers(t *testing.T) {
	base := testBase(t)
	log := &backendRequestLog{}
	server := s3ReadinessServer(t, 1<<30, log)
	runner := newBackendRunner(t, base, "s3proxy", "s3proxy", "s3", serverPort(t, server.URL), &syncBuffer{})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	err := runner.startBackends(ctx)
	if err == nil {
		t.Fatal("a backend that never answers must fail the run")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("readiness failure was not bounded: %s", elapsed)
	}
	for _, fragment := range []string{"s3proxy", "example/s3proxy@" + testDigest, "did not become ready"} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("readiness error %q missing %q", err, fragment)
		}
	}
	for _, request := range log.snapshot() {
		if strings.HasPrefix(request, "PUT ") {
			t.Fatalf("provisioning was attempted against an unready backend: %v", log.snapshot())
		}
	}
}

func TestStartBackendsStopsWaitingWhenCanceled(t *testing.T) {
	base := testBase(t)
	started := make(chan struct{}, 1)
	stop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-request.Context().Done():
		case <-stop:
		}
	}))
	t.Cleanup(func() {
		close(stop)
		server.CloseClientConnections()
		server.Close()
	})
	runner := newBackendRunner(t, base, "s3proxy", "s3proxy", "s3", serverPort(t, server.URL), &syncBuffer{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runner.startBackends(ctx) }()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("startBackends returned before a readiness request: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("no readiness request was sent")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation must surface as context.Canceled: %v", err)
		}
		if !strings.Contains(err.Error(), "s3proxy") {
			t.Fatalf("cancellation error must name the backend: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("startBackends did not stop after cancellation")
	}
}

func TestStartBackendsProbesEachServiceNatively(t *testing.T) {
	cases := []struct {
		service     string
		target      string
		contentType string
		body        string
	}{
		{"dynamodb", "DynamoDB_20120810.ListTables", "application/x-amz-json-1.0", `{"TableNames":[]}`},
		{"kms", "TrentService.ListKeys", "application/x-amz-json-1.1", `{"Keys":[]}`},
		{"sqs", "AmazonSQS.ListQueues", "application/x-amz-json-1.0", `{}`},
		{"sts", "", "text/xml", getCallerIdentityResponse},
		{"s3", "", "application/xml", listBucketsResponse},
		{"custom", "", "text/plain", "ok"},
	}
	for _, testCase := range cases {
		t.Run(testCase.service, func(t *testing.T) {
			log := &backendRequestLog{}
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				log.add(request.Method, request.URL.Path)
				if testCase.target != "" && request.Header.Get("X-Amz-Target") != testCase.target {
					t.Errorf("X-Amz-Target = %q, want %q", request.Header.Get("X-Amz-Target"), testCase.target)
				}
				if testCase.service == "sts" {
					body, _ := io.ReadAll(request.Body) //nolint:errcheck // the body is diagnostic
					if !strings.Contains(string(body), "Action=GetCallerIdentity") {
						t.Errorf("STS probe body does not call GetCallerIdentity: %s", body)
					}
				}
				if testCase.service == "s3" && request.Method != http.MethodGet {
					t.Errorf("S3 probe method = %s, want GET", request.Method)
				}
				writer.Header().Set("content-type", testCase.contentType)
				if _, err := writer.Write([]byte(testCase.body)); err != nil {
					t.Errorf("write %s response: %v", testCase.service, err)
				}
			}))
			defer server.Close()
			backend := testCase.service
			if testCase.service == "dynamodb" {
				backend = "dynamodb-local"
			}
			runner := newBackendRunner(t, testBase(t), backend, backend, testCase.service, serverPort(t, server.URL), &syncBuffer{})
			if err := runner.startBackends(context.Background()); err != nil {
				t.Fatalf("start %s backend: %v", testCase.service, err)
			}
			if len(log.snapshot()) == 0 {
				t.Fatalf("startBackends reported %s ready without a protocol call", testCase.service)
			}
		})
	}
}

func containsRequest(requests []string, want string) bool {
	for _, request := range requests {
		if request == want {
			return true
		}
	}
	return false
}
