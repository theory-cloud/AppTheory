package localrunner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func TestAttributeValueJSONCoversEveryShape(t *testing.T) {
	values := map[string]map[string]any{
		"string": {"S": "x"},
		"number": {"N": "2"},
		"binary": {"B": base64.StdEncoding.EncodeToString([]byte("x"))},
		"bool":   {"BOOL": true},
		"null":   {"NULL": true},
		"ss":     {"SS": []string{"a", "b"}},
		"ns":     {"NS": []string{"1", "2"}},
		"bs":     {"BS": []string{base64.StdEncoding.EncodeToString([]byte("a"))}},
		"list":   {"L": []any{map[string]any{"S": "a"}}},
		"map":    {"M": map[string]any{"k": map[string]any{"S": "v"}}},
	}
	typed := map[string]types.AttributeValue{
		"string": &types.AttributeValueMemberS{Value: "x"},
		"number": &types.AttributeValueMemberN{Value: "2"},
		"binary": &types.AttributeValueMemberB{Value: []byte("x")},
		"bool":   &types.AttributeValueMemberBOOL{Value: true},
		"null":   &types.AttributeValueMemberNULL{Value: true},
		"ss":     &types.AttributeValueMemberSS{Value: []string{"a", "b"}},
		"ns":     &types.AttributeValueMemberNS{Value: []string{"1", "2"}},
		"bs":     &types.AttributeValueMemberBS{Value: [][]byte{[]byte("a")}},
		"list":   &types.AttributeValueMemberL{Value: []types.AttributeValue{&types.AttributeValueMemberS{Value: "a"}}},
		"map":    &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{"k": &types.AttributeValueMemberS{Value: "v"}}},
	}
	converted := attributeMapJSON(typed)
	for name, expected := range values {
		encoded, err := json.Marshal(converted[name])
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want, err := json.Marshal(expected)
		if err != nil {
			t.Fatalf("%s want: %v", name, err)
		}
		if string(encoded) != string(want) {
			t.Fatalf("%s: got %s want %s", name, encoded, want)
		}
	}
}

func TestUnmarshalValueCoversEveryShape(t *testing.T) {
	values := []types.AttributeValue{
		&types.AttributeValueMemberS{Value: "x"},
		&types.AttributeValueMemberN{Value: "2"},
		&types.AttributeValueMemberB{Value: []byte("x")},
		&types.AttributeValueMemberBOOL{Value: true},
		&types.AttributeValueMemberNULL{Value: true},
		&types.AttributeValueMemberSS{Value: []string{"a"}},
		&types.AttributeValueMemberNS{Value: []string{"1"}},
		&types.AttributeValueMemberBS{Value: [][]byte{[]byte("a")}},
		&types.AttributeValueMemberL{Value: []types.AttributeValue{&types.AttributeValueMemberS{Value: "a"}}},
		&types.AttributeValueMemberM{Value: map[string]types.AttributeValue{"k": &types.AttributeValueMemberS{Value: "v"}}},
	}
	for _, value := range values {
		if _, err := unmarshalValue(value); err != nil {
			t.Fatalf("unmarshal %T: %v", value, err)
		}
	}
}

func TestBuildSQSEventIncludesMessageAttributes(t *testing.T) {
	encoded, err := BuildSQSEvent("arn:aws:sqs:us-east-1:123456789012:q", []sqstypes.Message{{
		MessageId: aws.String("m"),
		Body:      aws.String("body"),
		MessageAttributes: map[string]sqstypes.MessageAttributeValue{
			"k": {DataType: aws.String("String"), StringValue: aws.String("v")},
		},
	}})
	if err != nil {
		t.Fatalf("build sqs event: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode: %v", err)
	}
	record := mustMap(t, mustSlice(t, event["Records"])[0])
	attributes := mustMap(t, record["messageAttributes"])
	if mustString(t, mustMap(t, attributes["k"])["stringValue"]) != "v" {
		t.Fatalf("message attributes lost: %+v", attributes)
	}
}

func TestBuildDynamoDBStreamEventViewsAndErrors(t *testing.T) {
	keys := map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	newImage := map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	oldImage := map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	for _, view := range []string{"NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"} {
		encoded, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{
			EventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/t/stream/1",
			EventName:      "MODIFY", Keys: keys, NewImage: newImage, OldImage: oldImage, StreamViewType: view,
		})
		if err != nil {
			t.Fatalf("%s: %v", view, err)
		}
		var event map[string]any
		if err := json.Unmarshal(encoded, &event); err != nil {
			t.Fatalf("decode: %v", err)
		}
		dynamodb := mustMap(t, mustMap(t, mustSlice(t, event["Records"])[0])["dynamodb"])
		if view == "NEW_IMAGE" {
			if _, ok := dynamodb["OldImage"]; ok {
				t.Fatalf("NEW_IMAGE carried an old image: %+v", dynamodb)
			}
		}
		if view == "OLD_IMAGE" {
			if _, ok := dynamodb["NewImage"]; ok {
				t.Fatalf("OLD_IMAGE carried a new image: %+v", dynamodb)
			}
		}
	}
	if _, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{}); err == nil {
		t.Fatal("a stream event without an ARN must fail")
	}
	if _, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{EventSourceARN: "arn", EventName: "NOPE"}); err == nil {
		t.Fatal("an unknown stream event name must fail")
	}
	if _, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{EventSourceARN: "arn", EventName: "INSERT"}); err == nil {
		t.Fatal("a stream event without keys must fail")
	}
}

func TestBuildEventBridgeAndCloudWatchErrors(t *testing.T) {
	if _, err := BuildEventBridgeEvent(RuleSpec{LogicalID: "R"}, nil, "", "", time.Now()); err == nil {
		t.Fatal("a rule with no schedule or pattern must not build an event")
	}
	if _, err := BuildEventBridgeEvent(RuleSpec{LogicalID: "R", Schedule: "rate(1 minute)"}, json.RawMessage(`not-json`), "", "", time.Now()); err == nil {
		t.Fatal("invalid detail must fail")
	}
	if _, err := BuildCloudWatchLogsKinesisEvent("arn", "/g", "s", nil, nil, time.Now()); err == nil {
		t.Fatal("a subscription payload with no log events must fail")
	}
	if _, err := BuildCloudWatchLogsKinesisEvent("arn", "", "s", nil, []CloudWatchLogEvent{{Message: "x"}}, time.Now()); err == nil {
		t.Fatal("a subscription payload without a log group must fail")
	}
	event, err := BuildKinesisEvent("arn:aws:kinesis:us-east-1:123456789012:stream/s", []KinesisRecordInput{{Data: []byte("x")}}, time.Now())
	if err != nil {
		t.Fatalf("kinesis defaults: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(event, &decoded); err != nil {
		t.Fatalf("decode kinesis: %v", err)
	}
	if len(mustSlice(t, decoded["Records"])) != 1 {
		t.Fatalf("kinesis records: %+v", decoded)
	}
}

func TestEnvironmentResourceValueBranches(t *testing.T) {
	runner := &Runner{options: Options{Stdout: nullWriter{}}, resourceValues: resourceValues{}}
	cases := []ResourceSpec{
		{Stack: "S", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"logs"}`)},
		{Stack: "S", LogicalID: "Secret", Type: typeSecretsSecret},
		{Stack: "S", LogicalID: "Role", Type: typeIAMRole},
		{Stack: "S", LogicalID: "Image", Type: typeMicrovmImage, Properties: json.RawMessage(`{"Name":"image"}`)},
		{Stack: "S", LogicalID: "Index", Type: typeS3VectorsIndex, Properties: json.RawMessage(`{"VectorBucketName":"b","IndexName":"i"}`)},
		{Stack: "S", LogicalID: "Api", Type: typeHTTPAPI, Properties: json.RawMessage(`{"Name":"api"}`)},
		{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)},
		{Stack: "S", LogicalID: "Rule", Type: typeEventsRule, Properties: json.RawMessage(`{"Name":"rule"}`)},
		{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"t"}`)},
		{Stack: "S", LogicalID: "Queue", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"q"}`)},
	}
	for _, resource := range cases {
		if _, err := runner.localResourceValue(resource, resourceValues{}); err != nil {
			t.Fatalf("%s: %v", resource.LogicalID, err)
		}
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Key", Type: typeKMSKey}, resourceValues{}); err == nil {
		t.Fatal("a KMS key without a backend must fail")
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Bucket", Type: typeS3Bucket}, resourceValues{}); err == nil {
		t.Fatal("an S3 bucket without a backend must fail")
	}
	if _, err := s3VectorsIndexARN(ResourceSpec{LogicalID: "Index"}); err == nil {
		t.Fatal("an S3 Vectors index without names must fail")
	}
	if stableHash("x", 8) == "" || len(stableHash("x", 8)) != 8 {
		t.Fatal("stableHash length is wrong")
	}
}

func TestProvisionHelpersAndQueueAttributes(t *testing.T) {
	if maxInt64(0, 5) != 5 || maxInt64(7, 5) != 7 {
		t.Fatal("maxInt64 failed")
	}
	for _, check := range []struct {
		name string
		ok   bool
	}{
		{"table", tableAlreadyExists(errString("ResourceInUseException"))},
		{"ttl", ttlAlreadyEnabled(errString("TimeToLiveAlreadyEnabled"))},
		{"queue", queueAlreadyExists(errString("QueueAlreadyExists"))},
	} {
		if !check.ok {
			t.Fatalf("%s helper did not recognize its error", check.name)
		}
	}
	if tableAlreadyExists(errString("AccessDenied")) || ttlAlreadyEnabled(errString("AccessDenied")) || queueAlreadyExists(errString("AccessDenied")) {
		t.Fatal("helpers recognized an unrelated error")
	}
	count, err := parseIntJSON(json.RawMessage(`"5"`))
	if err != nil || count != 5 {
		t.Fatalf("parseIntJSON string: %d %v", count, err)
	}
	attributes := queueAttributes(sqsQueueProperties{
		VisibilityTimeout: 10, MessageRetentionPeriod: 20, ReceiveMessageWaitTimeSeconds: 3,
		DelaySeconds: 4, FifoQueue: true, ContentBasedDeduplication: true,
	})
	if attributes[string(sqstypes.QueueAttributeNameVisibilityTimeout)] != "10" ||
		attributes[string(sqstypes.QueueAttributeNameFifoQueue)] != boolTrue {
		t.Fatalf("queue attributes: %+v", attributes)
	}
}

func TestSessionExecuteDispatchAndDynamicSecrets(t *testing.T) {
	fixture := newSessionFixture(t)
	for _, op := range []string{
		"shutdown", "describe", "invoke", "sqs.send", "sqs.receive", "sqs.event",
		"ddb.put", "ddb.get", "ddb.scan", "ddb.stream-event", "s3.put",
		"eventbridge.event", "kinesis.event", "kinesis.cloudwatch-event",
	} {
		_, _ = fixture.session.execute(context.Background(), sessionRequest{Op: op}) //nolint:errcheck // dispatch coverage; each op fails with its own error
	}
	runner := &Runner{options: Options{Stdout: nullWriter{}}}
	if value, err := runner.resolveDynamicSecret("Fn", "TOKEN", "plain"); err != nil || value != "plain" {
		t.Fatalf("plain secret: %q %v", value, err)
	}
	if _, err := runner.resolveDynamicSecret("Fn", "TOKEN", "{{resolve:ssm:parameter}}"); err == nil {
		t.Fatal("an unsupported dynamic reference must fail")
	}
	value, err := runner.resolveDynamicSecret("Fn", "TOKEN", "{{resolve:secretsmanager:arn:secret:SecretString:token::}}")
	if err != nil || value == "" || runner.localSecrets["TOKEN"] != value {
		t.Fatalf("local secret: %q %v", value, err)
	}
}

func TestRunnerRuntimeFunctionsExtraTargets(t *testing.T) {
	fixture := newSessionFixture(t)
	fixture.runner.options.ExtraFunctions = []string{"Fn"}
	targets, err := fixture.runner.runtimeFunctions(fixture.spec)
	if err != nil || len(targets) != 1 || targets[0] != "Fn" {
		t.Fatalf("extra target: %+v %v", targets, err)
	}
	fixture.runner.options.ExtraFunctions = []string{"Missing"}
	if _, err := fixture.runner.runtimeFunctions(fixture.spec); err == nil {
		t.Fatal("an unknown extra target must fail")
	}
	endpoints := []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}}
	if !containsEndpointService(endpoints, "sqs") || containsEndpointService(endpoints, "dynamodb") {
		t.Fatal("containsEndpointService failed")
	}
	runner := &Runner{endpoints: endpoints}
	if endpoint, ok := runner.backendEndpoint("sqs"); !ok || endpoint.URL != "http://sqs:9324" {
		t.Fatalf("backendEndpoint: %+v %v", endpoint, ok)
	}
	if _, ok := runner.backendEndpoint("dynamodb"); ok {
		t.Fatal("backendEndpoint found an unknown service")
	}
}

type nullWriter struct{}

func (nullWriter) Write(p []byte) (int, error) { return len(p), nil }

func TestSmallHelpersAndDefaults(t *testing.T) {
	if _, err := decodeString(json.RawMessage(`{"Ref":"x"}`)); err == nil {
		t.Fatal("a CloudFormation expression is not a literal string")
	}
	if value, err := decodeString(json.RawMessage(`"x"`)); err != nil || value != "x" {
		t.Fatalf("decodeString: %q %v", value, err)
	}
	if _, _, err := runCommand(context.Background(), []string{"true"}); err != nil {
		t.Fatalf("runCommand: %v", err)
	}
	if eventSourceBatchSize(backendSQS, 0) != 10 || eventSourceBatchSize(backendKinesis, 0) != 100 {
		t.Fatal("event source batch defaults are wrong")
	}
	if localSourceARN("other", "x") != "" {
		t.Fatal("an unknown source type must not build an ARN")
	}
	if source, detail := rulePatternIdentity(json.RawMessage(`not-json`)); source != "" || detail != "" {
		t.Fatal("a malformed pattern must not yield an identity")
	}
	if firstStringValue("x") != "x" || firstStringValue([]any{"y"}) != "y" {
		t.Fatal("firstStringValue failed")
	}
	if _, ok := attributeType(nil, "pk"); ok {
		t.Fatal("attributeType found a missing definition")
	}
	if _, err := parseIntJSON(json.RawMessage(`"x"`)); err == nil {
		t.Fatal("parseIntJSON accepted a non-number string")
	}
	if _, err := BuildKinesisEvent("", nil, time.Now()); err == nil {
		t.Fatal("a Kinesis event without a stream ARN must fail")
	}
	if _, err := BuildKinesisEvent("arn:aws:kinesis:us-east-1:123456789012:stream/s", nil, time.Now()); err != nil {
		t.Fatalf("an empty Kinesis batch: %v", err)
	}
	if _, err := BuildEventBridgeEvent(RuleSpec{
		LogicalID: "Pattern", ARN: "arn:aws:events:us-east-1:123456789012:rule/p",
		EventPattern: json.RawMessage(`{"source":["a"],"detail-type":["b"]}`), Enabled: true,
	}, nil, "explicit.source", "explicit.type", time.Now()); err != nil {
		t.Fatalf("explicit EventBridge identity: %v", err)
	}
	if _, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{
		EventSourceARN: "arn", EventName: "INSERT",
		Keys: map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}},
	}); err != nil {
		t.Fatalf("default stream view type: %v", err)
	}
	spec := &Spec{FunctionURLs: []FunctionURLSpec{{LogicalID: "U", Function: "Fn"}}}
	if len(spec.FunctionURLsFor("Fn")) != 1 || len(spec.FunctionURLsFor("Other")) != 0 {
		t.Fatal("FunctionURLsFor failed")
	}
}

func TestSessionDynamoDefaultEventNames(t *testing.T) {
	fixture := newSessionFixture(t)
	if _, err := fixture.session.ddbPut(context.Background(), sessionRequest{
		Table: "Table", Item: map[string]any{"pk": "a", "value": "one"},
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
	insert, err := fixture.session.ddbStreamEvent(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"},
	})
	if err != nil || mustString(t, mustMap(t, mustSlice(t, mustRawMap(t, insert)["Records"])[0])["eventName"]) != streamEventInsert {
		t.Fatalf("default INSERT: %v", err)
	}
	if _, putErr := fixture.session.ddbPut(context.Background(), sessionRequest{
		Table: "Table", Item: map[string]any{"pk": "a", "value": "two"},
	}); putErr != nil {
		t.Fatalf("put modify: %v", putErr)
	}
	modify, err := fixture.session.ddbStreamEvent(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"},
	})
	if err != nil || mustString(t, mustMap(t, mustSlice(t, mustRawMap(t, modify)["Records"])[0])["eventName"]) != streamEventModify {
		t.Fatalf("default MODIFY: %v", err)
	}
}

func TestRunInvokeStreamsAProxyResult(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/json")
		writeTestResponse(t, writer, `{"statusCode":200,"headers":{"content-type":"application/json"},"body":"{\"ok\":true}"}`)
	}))
	defer rie.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		writeTestResponse(t, writer, `{"TableNames":[]}`)
	}))
	defer backend.Close()
	var calls []string
	runner.docker = fakeRunnerDocker(t, serverPort(t, rie.URL), serverPort(t, backend.URL), &calls)
	runner.options.RIEMode = true
	var out bytes.Buffer
	if err := runner.RunInvoke(context.Background(), "Fn", strings.NewReader(`{"ok":true}`+"\n"), &out); err != nil {
		t.Fatalf("run invoke: %v", err)
	}
	if !strings.Contains(out.String(), `"proxy":true`) || !strings.Contains(out.String(), `"statusCode":200`) {
		t.Fatalf("unexpected invoke output: %s", out.String())
	}
}

func TestServeSessionCommandChannel(t *testing.T) {
	fixture := newSessionFixture(t)
	input := strings.NewReader(`{"op":"describe"}` + "\n" + `{"op":"shutdown"}` + "\n")
	var output bytes.Buffer
	if err := fixture.runner.serveSession(context.Background(), fixture.spec, input, &output); err != nil {
		t.Fatalf("serve session: %v", err)
	}
	if !strings.Contains(output.String(), `"ok":true`) || !strings.Contains(output.String(), `"shutdown":true`) {
		t.Fatalf("unexpected session output: %s", output.String())
	}
}

func TestSessionOperationBranches(t *testing.T) {
	fixture := newSessionFixture(t)
	if _, err := fixture.session.sqsSend(context.Background(), sessionRequest{
		Queue: "Queue", Body: "x", MessageAttributes: map[string]string{"k": "v"},
	}); err != nil {
		t.Fatalf("sqs send attributes: %v", err)
	}
	missing, err := fixture.session.ddbGet(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "missing"},
	})
	if err != nil || mustMap(t, missing)["item"] != nil {
		t.Fatalf("ddb get missing: %+v %v", missing, err)
	}
	if _, err := fixture.session.s3Put(context.Background(), sessionRequest{
		Bucket: "Bucket", ObjectKey: "x", Body: "x", ContentType: "application/json",
	}); err != nil {
		t.Fatalf("s3 put content type: %v", err)
	}
	if _, err := fixture.session.kinesisEvent(sessionRequest{Stream: "Stream", Data: []string{"not-base64"}}); err == nil {
		t.Fatal("invalid base64 Kinesis data must fail")
	}
	if _, err := fixture.session.kinesisCloudWatchEvent(sessionRequest{Stream: "Stream", LogEvents: nil}); err == nil {
		t.Fatal("a CloudWatch event without log events must fail")
	}
}

func TestBuildSQSEventMD5AndBinaryAttribute(t *testing.T) {
	encoded, err := BuildSQSEvent("arn:aws:sqs:us-east-1:123456789012:q", []sqstypes.Message{{
		MessageId: aws.String("m"),
		Body:      aws.String("body"),
		MD5OfBody: aws.String("md5"),
		MessageAttributes: map[string]sqstypes.MessageAttributeValue{
			"bin": {DataType: aws.String("Binary"), BinaryValue: []byte("x")},
		},
	}})
	if err != nil {
		t.Fatalf("build sqs event: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode: %v", err)
	}
	record := mustMap(t, mustSlice(t, event["Records"])[0])
	if mustString(t, record["md5OfBody"]) != "md5" {
		t.Fatalf("md5 lost: %+v", record)
	}
	if mustString(t, mustMap(t, mustMap(t, record["messageAttributes"])["bin"])["binaryValue"]) == "" {
		t.Fatalf("binary attribute lost: %+v", record["messageAttributes"])
	}
}
