package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// elasticMQRestoreFake models the two ElasticMQ 1.7.1 startup shapes the
// --data-dir path must survive: a queue created by the messages-storage restore
// (GetQueueUrl answers once it exists) and an empty backend where the restore
// has not created a newly declared queue yet.
type elasticMQRestoreFake struct {
	t  *testing.T
	mu sync.Mutex
	// queues holds each existing queue's attributes. A queue that is present is
	// visible to GetQueueUrl.
	queues map[string]map[string]string
	// pending makes GetQueueUrl report QueueDoesNotExist for the first n calls
	// per queue, so a test can model the restore still running.
	pending map[string]int
	// created records every CreateQueue the runner issued.
	created []string
	// reconciled records the last SetQueueAttributes payload per queue URL.
	reconciled map[string]map[string]string
	// failSet makes SetQueueAttributes answer with a service error.
	failSet bool
}

func newElasticMQRestoreFake(t *testing.T, queues map[string]map[string]string) (*elasticMQRestoreFake, *httptest.Server) {
	t.Helper()
	fake := &elasticMQRestoreFake{
		t:          t,
		queues:     queues,
		pending:    map[string]int{},
		reconciled: map[string]map[string]string{},
	}
	server := httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(server.Close)
	return fake, server
}

func (f *elasticMQRestoreFake) respond(writer http.ResponseWriter, format string, args ...any) {
	f.t.Helper()
	if _, err := fmt.Fprintf(writer, format, args...); err != nil {
		f.t.Errorf("write response: %v", err)
	}
}

func (f *elasticMQRestoreFake) handle(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("content-type", "application/x-amz-json-1.0")
	target := request.Header.Get("X-Amz-Target")
	body, _ := io.ReadAll(request.Body) //nolint:errcheck // the body is a test fixture
	switch {
	case strings.HasSuffix(target, "GetQueueUrl"):
		var payload struct {
			QueueName string `json:"QueueName"`
		}
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // the body is a test fixture
		f.mu.Lock()
		name := payload.QueueName
		if f.pending[name] > 0 {
			f.pending[name]--
			f.mu.Unlock()
			writer.Header().Set("x-amzn-errortype", "QueueDoesNotExist")
			writer.WriteHeader(http.StatusBadRequest)
			f.respond(writer, "%s", `{"__type":"com.amazonaws.sqs#QueueDoesNotExist","message":"queue does not exist"}`)
			return
		}
		_, exists := f.queues[name]
		f.mu.Unlock()
		if !exists {
			writer.Header().Set("x-amzn-errortype", "QueueDoesNotExist")
			writer.WriteHeader(http.StatusBadRequest)
			f.respond(writer, "%s", `{"__type":"com.amazonaws.sqs#QueueDoesNotExist","message":"queue does not exist"}`)
			return
		}
		f.respond(writer, `{"QueueUrl":"http://localhost:9324/000000000000/%s"}`, name)
	case strings.HasSuffix(target, "CreateQueue"):
		var payload struct {
			QueueName  string            `json:"QueueName"`
			Attributes map[string]string `json:"Attributes"`
		}
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // the body is a test fixture
		f.mu.Lock()
		f.created = append(f.created, payload.QueueName)
		if _, exists := f.queues[payload.QueueName]; exists {
			f.mu.Unlock()
			writer.Header().Set("x-amzn-errortype", "QueueAlreadyExists")
			writer.WriteHeader(http.StatusBadRequest)
			f.respond(writer, "%s", `{"__type":"com.amazonaws.sqs#QueueAlreadyExists","message":"queue exists"}`)
			return
		}
		attributes := map[string]string{
			"VisibilityTimeout":             "30",
			"DelaySeconds":                  "0",
			"ReceiveMessageWaitTimeSeconds": "0",
		}
		for name, value := range payload.Attributes {
			attributes[name] = value
		}
		f.queues[payload.QueueName] = attributes
		f.mu.Unlock()
		f.respond(writer, `{"QueueUrl":"http://localhost:9324/000000000000/%s"}`, payload.QueueName)
	case strings.HasSuffix(target, "GetQueueAttributes"):
		var payload struct {
			QueueUrl string `json:"QueueUrl"`
		}
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // the body is a test fixture
		name := payload.QueueUrl[strings.LastIndex(payload.QueueUrl, "/")+1:]
		f.mu.Lock()
		attributes, exists := f.queues[name]
		f.mu.Unlock()
		if !exists {
			writer.Header().Set("x-amzn-errortype", "QueueDoesNotExist")
			writer.WriteHeader(http.StatusBadRequest)
			f.respond(writer, "%s", `{"__type":"com.amazonaws.sqs#QueueDoesNotExist","message":"queue does not exist"}`)
			return
		}
		encoded, _ := json.Marshal(attributes) //nolint:errcheck // a map of strings always encodes
		f.respond(writer, `{"Attributes":%s}`, encoded)
	case strings.HasSuffix(target, "SetQueueAttributes"):
		if f.failSet {
			writer.Header().Set("x-amzn-errortype", "InternalError")
			writer.WriteHeader(http.StatusInternalServerError)
			f.respond(writer, "%s", `{"__type":"com.amazonaws.sqs#InternalError","message":"boom"}`)
			return
		}
		var payload struct {
			QueueUrl   string            `json:"QueueUrl"`
			Attributes map[string]string `json:"Attributes"`
		}
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // the body is a test fixture
		f.mu.Lock()
		f.reconciled[payload.QueueUrl] = payload.Attributes
		name := payload.QueueUrl[strings.LastIndex(payload.QueueUrl, "/")+1:]
		if attributes, exists := f.queues[name]; exists {
			for attribute, value := range payload.Attributes {
				attributes[attribute] = value
			}
		}
		f.mu.Unlock()
		f.respond(writer, "%s", `{}`)
	default:
		writer.WriteHeader(http.StatusBadRequest)
	}
}

func dataDirQueueRunner(t *testing.T, serverURL string, startup map[string]bool) *Runner {
	t.Helper()
	return &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"sqs": {HostURL: serverURL, Endpoints: []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}}},
		},
		dataDir:          testSharedDir(t),
		resourceValues:   resourceValues{},
		sqsStartupQueues: startup,
	}
}

func TestElasticMQDataConfigDeclaresQueuesAndRedrive(t *testing.T) {
	runner := &Runner{scratch: t.TempDir()}
	plans, err := localQueuePlans(&Spec{Resources: []ResourceSpec{
		{
			Stack: "Stack", LogicalID: "EventsDlq", Type: typeSQSQueue,
			Properties: json.RawMessage(`{"QueueName":"events-dlq"}`),
		},
		{
			Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
			Properties: json.RawMessage(`{
				"QueueName":"events",
				"VisibilityTimeout":90,
				"DelaySeconds":5,
				"ReceiveMessageWaitTimeSeconds":10,
				"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["EventsDlq","Arn"]},"maxReceiveCount":4}
			}`),
		},
	}})
	if err != nil {
		t.Fatalf("plans: %v", err)
	}
	path, err := runner.elasticMQDataConfig(plans)
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	config := readTestFile(t, path)
	for _, want := range []string{
		`uri = "jdbc:h2:/data/elasticmq"`,
		`"events" {`,
		"defaultVisibilityTimeout = 90 seconds",
		"delay = 5 seconds",
		"receiveMessageWait = 10 seconds",
		"deadLettersQueue {",
		`name = "events-dlq"`,
		"maxReceiveCount = 4",
		`"events-dlq" {`,
	} {
		if !strings.Contains(config, want) {
			t.Fatalf("ElasticMQ config missing %q:\n%s", want, config)
		}
	}
	// An absent attribute stays absent so the pinned image applies its own
	// documented default.
	if strings.Contains(config, `"events-dlq" {`+"\n"+`    defaultVisibilityTimeout`) {
		t.Fatalf("an undeclared attribute was written:\n%s", config)
	}
}

func TestElasticMQDataConfigRefusesBareFIFOName(t *testing.T) {
	runner := &Runner{scratch: t.TempDir()}
	plans, err := localQueuePlans(&Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{"QueueName":"events","FifoQueue":true}`),
	}}})
	if err != nil {
		t.Fatalf("plans: %v", err)
	}
	if _, err := runner.elasticMQDataConfig(plans); err == nil {
		t.Fatal("a FIFO queue whose name lacks .fifo was accepted")
	} else if !strings.Contains(err.Error(), "events") || !strings.Contains(err.Error(), ".fifo") {
		t.Fatalf("error does not name the queue and the suffix: %v", err)
	}
}

func TestLocalQueuePlansRejectDanglingRedrive(t *testing.T) {
	_, err := localQueuePlans(&Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{
			"QueueName":"events",
			"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["Missing","Arn"]},"maxReceiveCount":4}
		}`),
	}}})
	if err == nil || !strings.Contains(err.Error(), "Missing") {
		t.Fatalf("a dangling redrive target = %v", err)
	}
	_, err = localQueuePlans(&Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Dlq", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"dlq"}`)},
		{
			Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
			Properties: json.RawMessage(`{
				"QueueName":"events",
				"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["Dlq","Arn"]},"maxReceiveCount":0}
			}`),
		},
	}})
	if err == nil || !strings.Contains(err.Error(), "maxReceiveCount") {
		t.Fatalf("an invalid maxReceiveCount = %v", err)
	}
}

func TestProvisionQueuesWaitsForStartupQueueInsteadOfCreatingIt(t *testing.T) {
	fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{
		"events": {"VisibilityTimeout": "60", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0"},
	})
	fake.pending["events"] = 2
	previousInterval, previousTimeout := sqsStartupQueuePollInterval, sqsStartupQueueTimeout
	sqsStartupQueuePollInterval, sqsStartupQueueTimeout = time.Millisecond, 5*time.Second
	t.Cleanup(func() {
		sqsStartupQueuePollInterval, sqsStartupQueueTimeout = previousInterval, previousTimeout
	})
	runner := dataDirQueueRunner(t, server.URL, map[string]bool{"events": true})

	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{"QueueName":"events","VisibilityTimeout":60}`),
	}}}
	if err := runner.provisionQueues(context.Background(), spec); err != nil {
		t.Fatalf("provision queues: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.created) != 0 {
		t.Fatalf("a startup-configured queue was created through the API: %v", fake.created)
	}
	if got := runner.resourceValues["Stack/Events"].URL; got != "http://sqs:9324/000000000000/events" {
		t.Fatalf("queue URL = %q", got)
	}
}

func TestProvisionQueuesReconcilesRestoredDefinition(t *testing.T) {
	fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{
		"events-dlq": {
			"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0",
		},
		"events": {
			"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0",
			"RedrivePolicy": `{"deadLetterTargetArn":"arn:aws:sqs:elasticmq:000000000000:events-dlq","maxReceiveCount":2}`,
		},
	})
	runner := dataDirQueueRunner(t, server.URL, map[string]bool{"events": true, "events-dlq": true})

	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "EventsDlq", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"events-dlq"}`)},
		{
			Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
			Properties: json.RawMessage(`{
				"QueueName":"events",
				"VisibilityTimeout":90,
				"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["EventsDlq","Arn"]},"maxReceiveCount":7}
			}`),
		},
	}}
	if err := runner.provisionQueues(context.Background(), spec); err != nil {
		t.Fatalf("provision queues: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.created) != 0 {
		t.Fatalf("a restored queue was created through the API: %v", fake.created)
	}
	reconciled := map[string]string(nil)
	for queueURL, attributes := range fake.reconciled {
		if strings.HasSuffix(queueURL, "/events") {
			reconciled = attributes
		}
	}
	if reconciled["VisibilityTimeout"] != "90" {
		t.Fatalf("visibility was not applied to the restored queue: %+v", fake.reconciled)
	}
	policy, ok := parseRedrivePolicyValue(reconciled["RedrivePolicy"])
	if !ok || policy.name != "events-dlq" || policy.maxReceiveCount != 7 {
		t.Fatalf("redrive was not applied to the restored queue: %+v", reconciled)
	}
}

func TestProvisionQueuesRefusesUnrepresentableChange(t *testing.T) {
	cases := map[string]struct {
		restored map[string]string
		declared string
		want     string
	}{
		"fifo": {
			restored: map[string]string{
				"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0",
				"FifoQueue": "true",
			},
			declared: `{"QueueName":"events","FifoQueue":false}`,
			want:     "FifoQueue",
		},
		"content-based-deduplication": {
			restored: map[string]string{
				"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0",
				"FifoQueue": "true", "ContentBasedDeduplication": "true",
			},
			declared: `{"QueueName":"events","FifoQueue":true,"ContentBasedDeduplication":false}`,
			want:     "ContentBasedDeduplication",
		},
		"stale-redrive": {
			restored: map[string]string{
				"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0",
				"RedrivePolicy": `{"deadLetterTargetArn":"arn:aws:sqs:elasticmq:000000000000:events-dlq","maxReceiveCount":2}`,
			},
			declared: `{"QueueName":"events"}`,
			want:     "RedrivePolicy",
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{"events": testCase.restored})
			runner := dataDirQueueRunner(t, server.URL, map[string]bool{"events": true})
			spec := &Spec{Resources: []ResourceSpec{{
				Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
				Properties: json.RawMessage(testCase.declared),
			}}}
			err := runner.provisionQueues(context.Background(), spec)
			if err == nil {
				t.Fatal("an attribute the pinned image cannot apply was accepted")
			}
			if !strings.Contains(err.Error(), "events") || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error does not name the queue and %s: %v", testCase.want, err)
			}
			if len(fake.reconciled) != 0 {
				t.Fatalf("a refused change was partially applied: %+v", fake.reconciled)
			}
		})
	}
}

func TestProvisionQueuesCreatesQueueAddedAfterBackendStart(t *testing.T) {
	fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{
		"existing": {"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0"},
	})
	runner := dataDirQueueRunner(t, server.URL, map[string]bool{"existing": true})
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Existing", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"existing"}`)},
		{Stack: "Stack", LogicalID: "Added", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"added"}`)},
	}}
	if err := runner.provisionQueues(context.Background(), spec); err != nil {
		t.Fatalf("provision queues: %v", err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.created) != 1 || fake.created[0] != "added" {
		t.Fatalf("a queue added after the backend start was not created: %v", fake.created)
	}
}

func TestPrepareElasticMQStartupQueuesOnlyForDataDirSQSRuns(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"events"}`),
	}}}
	ephemeral := &Runner{options: Options{Backends: []string{backendSQS}}}
	if err := ephemeral.prepareElasticMQStartupQueues(spec); err != nil || ephemeral.sqsStartupQueues != nil {
		t.Fatalf("an ephemeral run declared startup queues: %v, %v", ephemeral.sqsStartupQueues, err)
	}
	withoutSQS := &Runner{options: Options{Backends: []string{backendDynamoDB}}, dataDir: testSharedDir(t)}
	if err := withoutSQS.prepareElasticMQStartupQueues(spec); err != nil || withoutSQS.sqsStartupQueues != nil {
		t.Fatalf("a run without the sqs backend declared startup queues: %v, %v", withoutSQS.sqsStartupQueues, err)
	}
	configured := &Runner{options: Options{Backends: []string{backendSQS}}, dataDir: testSharedDir(t)}
	if err := configured.prepareElasticMQStartupQueues(spec); err != nil {
		t.Fatalf("prepare startup queues: %v", err)
	}
	if !configured.sqsStartupQueues["events"] || len(configured.sqsStartupPlans) != 1 {
		t.Fatalf("startup queues = %v, plans = %+v", configured.sqsStartupQueues, configured.sqsStartupPlans)
	}
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path) //nolint:gosec // the path is a t.TempDir file this test wrote
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}

func TestHoconStringEscapesValues(t *testing.T) {
	if got := hoconString(`a"b\c` + "\n"); got != `"a\"b\\c\n"` {
		t.Fatalf("hoconString = %s", got)
	}
}

func TestParseRedrivePolicyValueRejectsMalformed(t *testing.T) {
	for _, value := range []string{"", "not-json", `{"deadLetterTargetArn":"","maxReceiveCount":1}`, `{"maxReceiveCount":1}`} {
		if _, ok := parseRedrivePolicyValue(value); ok {
			t.Fatalf("accepted malformed redrive policy %q", value)
		}
	}
	policy, ok := parseRedrivePolicyValue(`{"deadLetterTargetArn":"arn:aws:sqs:elasticmq:000000000000:dlq","maxReceiveCount":3}`)
	if !ok || policy.name != "dlq" || policy.maxReceiveCount != 3 {
		t.Fatalf("parsed redrive policy = %+v, %v", policy, ok)
	}
}

func TestPrepareElasticMQStartupQueuesPropagatesPlanErrors(t *testing.T) {
	runner := &Runner{options: Options{Backends: []string{backendSQS}}, dataDir: testSharedDir(t)}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{
			"QueueName":"events",
			"RedrivePolicy":{"deadLetterTargetArn":{"Fn::GetAtt":["Missing","Arn"]},"maxReceiveCount":1}
		}`),
	}}}
	if err := runner.prepareElasticMQStartupQueues(spec); err == nil {
		t.Fatal("a dangling redrive target was accepted at backend start")
	}
}

func TestEnsureLocalQueueReportsCreateFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		writer.Header().Set("x-amzn-errortype", "AccessDenied")
		writer.WriteHeader(http.StatusForbidden)
		writeTestResponse(t, writer, `{"__type":"com.amazonaws.sqs#AccessDenied","message":"denied"}`)
	}))
	defer server.Close()
	runner := dataDirQueueRunner(t, server.URL, nil)
	plans, err := localQueuePlans(&Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"events"}`),
	}}})
	if err != nil {
		t.Fatalf("plans: %v", err)
	}
	err = runner.ensureLocalQueue(context.Background(), newSQSClient(server.URL), Endpoint{Service: backendSQS, URL: "http://sqs:9324"}, plans[0])
	if err == nil || !strings.Contains(err.Error(), "create local SQS queue events") {
		t.Fatalf("create failure = %v", err)
	}
}

func TestWaitForStartupQueueTimesOutAndHonoursCancellation(t *testing.T) {
	fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{})
	client := newSQSClient(server.URL)
	previousInterval, previousTimeout := sqsStartupQueuePollInterval, sqsStartupQueueTimeout
	sqsStartupQueuePollInterval, sqsStartupQueueTimeout = time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() {
		sqsStartupQueuePollInterval, sqsStartupQueueTimeout = previousInterval, previousTimeout
	})
	runner := dataDirQueueRunner(t, server.URL, nil)
	if _, err := runner.waitForStartupQueue(context.Background(), client, "events"); err == nil ||
		!strings.Contains(err.Error(), "events") || !strings.Contains(err.Error(), "startup configuration") {
		t.Fatalf("timeout error = %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runner.waitForStartupQueue(canceled, client, "events"); err == nil {
		t.Fatal("a canceled wait returned no error")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.created) != 0 {
		t.Fatalf("the wait created a queue: %v", fake.created)
	}
}

func TestReconcileLocalQueueReportsServiceFailures(t *testing.T) {
	plans, err := localQueuePlans(&Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Events", Type: typeSQSQueue,
		Properties: json.RawMessage(`{"QueueName":"events","VisibilityTimeout":90}`),
	}}})
	if err != nil {
		t.Fatalf("plans: %v", err)
	}
	readFailure := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		writer.Header().Set("x-amzn-errortype", "InvalidParameterValue")
		writer.WriteHeader(http.StatusBadRequest)
		writeTestResponse(t, writer, `{"__type":"com.amazonaws.sqs#InvalidParameterValue","message":"boom"}`)
	}))
	defer readFailure.Close()
	runner := dataDirQueueRunner(t, readFailure.URL, nil)
	if err := runner.reconcileLocalQueue(context.Background(), newSQSClient(readFailure.URL), plans[0], readFailure.URL); err == nil {
		t.Fatal("a failed attribute read was accepted")
	}

	fake, server := newElasticMQRestoreFake(t, map[string]map[string]string{
		"events": {"VisibilityTimeout": "30", "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0"},
	})
	fake.failSet = true
	runner = dataDirQueueRunner(t, server.URL, nil)
	if err := runner.reconcileLocalQueue(context.Background(), newSQSClient(server.URL), plans[0], server.URL+"/000000000000/events"); err == nil {
		t.Fatal("a failed attribute write was accepted")
	}
}
