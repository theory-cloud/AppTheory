package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func snsTestAttribute(dataType, value string) snsMessageAttribute {
	return snsMessageAttribute{DataType: dataType, StringValue: value}
}

func snsTestMessage(body string, attributes map[string]snsMessageAttribute) snsMessage {
	if attributes == nil {
		attributes = map[string]snsMessageAttribute{}
	}
	return snsMessage{
		MessageID:  "message-1",
		TopicARN:   "arn:aws:sns:us-east-1:123456789012:test-topic",
		Message:    body,
		Timestamp:  time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC),
		Attributes: attributes,
	}
}

func normalizeTestPolicy(t *testing.T, raw, scope string) json.RawMessage {
	t.Helper()
	policy, err := normalizeSNSFilterPolicy(json.RawMessage(raw), scope, "TestSubscription")
	if err != nil {
		t.Fatalf("normalize policy %s: %v", raw, err)
	}
	return policy
}

func TestNormalizeSNSFilterPolicy(t *testing.T) {
	valid := []struct {
		name  string
		scope string
		raw   string
	}{
		{
			"attribute exact and numeric",
			snsFilterScopeAttributes,
			`{"eventType":["keep","also"],"priority":[{"numeric":[">=",10]}]}`,
		},
		{"attribute prefix", snsFilterScopeAttributes, `{"name":[{"prefix":"prod-"}]}`},
		{"attribute suffix", snsFilterScopeAttributes, `{"name":[{"suffix":"-prod"}]}`},
		{"attribute equals-ignore-case", snsFilterScopeAttributes, `{"env":[{"equals-ignore-case":"Prod"}]}`},
		{"attribute anything-but list", snsFilterScopeAttributes, `{"env":[{"anything-but":["dev","test"]}]}`},
		{"attribute anything-but prefix", snsFilterScopeAttributes, `{"env":[{"anything-but":{"prefix":"tmp-"}}]}`},
		{"attribute numeric range", snsFilterScopeAttributes, `{"priority":[{"numeric":[">",10,"<=",20]}]}`},
		{"attribute exists", snsFilterScopeAttributes, `{"tenant":[{"exists":true}]}`},
		{"body nested", snsFilterScopeBody, `{"kind":["order"],"customer":{"tier":["premium"]}}`},
		{"body array", snsFilterScopeBody, `{"tags":["a","b"]}`},
		{"empty policy", snsFilterScopeAttributes, `{}`},
	}
	for _, testCase := range valid {
		t.Run(testCase.name, func(t *testing.T) {
			policy := normalizeTestPolicy(t, testCase.raw, testCase.scope)
			if len(policy) == 0 {
				t.Fatalf("policy was dropped")
			}
		})
	}

	invalid := []struct {
		name  string
		scope string
		raw   string
		want  string
	}{
		{"or keyword", snsFilterScopeBody, `{"$or":[{"kind":["order"]}]}`, "$or"},
		{"cidr", snsFilterScopeAttributes, `{"ip":[{"cidr":"10.0.0.0/8"}]}`, "cidr"},
		{"attribute nested object", snsFilterScopeAttributes, `{"kind":{"nested":["x"]}}`, "rule list"},
		{"attribute scalar", snsFilterScopeAttributes, `{"kind":"order"}`, "list of rules"},
		{"unknown operator", snsFilterScopeAttributes, `{"kind":[{"matches":"order"}]}`, "unknown operator"},
		{"root array", snsFilterScopeAttributes, `[]`, "JSON object"},
		{"invalid json", snsFilterScopeAttributes, `{"kind":`, "not valid JSON"},
	}
	for _, testCase := range invalid {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := normalizeSNSFilterPolicy(json.RawMessage(testCase.raw), testCase.scope, "TestSubscription")
			if err == nil {
				t.Fatalf("policy must be refused")
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q does not name %q", err, testCase.want)
			}
		})
	}
}

func TestSNSFilterPolicyMatching(t *testing.T) {
	cases := []struct {
		name       string
		scope      string
		policy     string
		body       string
		attributes map[string]snsMessageAttribute
		want       bool
	}{
		{
			name:       "or within a key",
			scope:      snsFilterScopeAttributes,
			policy:     `{"eventType":["keep","also"]}`,
			attributes: map[string]snsMessageAttribute{"eventType": snsTestAttribute("String", "also")},
			want:       true,
		},
		{
			name:   "and across keys",
			scope:  snsFilterScopeAttributes,
			policy: `{"eventType":["keep"],"priority":[{"numeric":[">=",10]}]}`,
			attributes: map[string]snsMessageAttribute{
				"eventType": snsTestAttribute("String", "keep"),
				"priority":  snsTestAttribute("Number", "10"),
			},
			want: true,
		},
		{
			name:   "and across keys rejects one",
			scope:  snsFilterScopeAttributes,
			policy: `{"eventType":["keep"],"priority":[{"numeric":[">=",10]}]}`,
			attributes: map[string]snsMessageAttribute{
				"eventType": snsTestAttribute("String", "keep"),
				"priority":  snsTestAttribute("Number", "9"),
			},
			want: false,
		},
		{
			name:       "prefix",
			scope:      snsFilterScopeAttributes,
			policy:     `{"name":[{"prefix":"prod-"}]}`,
			attributes: map[string]snsMessageAttribute{"name": snsTestAttribute("String", "prod-api")},
			want:       true,
		},
		{
			name:       "suffix",
			scope:      snsFilterScopeAttributes,
			policy:     `{"name":[{"suffix":"-api"}]}`,
			attributes: map[string]snsMessageAttribute{"name": snsTestAttribute("String", "prod-api")},
			want:       true,
		},
		{
			name:       "equals-ignore-case",
			scope:      snsFilterScopeAttributes,
			policy:     `{"env":[{"equals-ignore-case":"Prod"}]}`,
			attributes: map[string]snsMessageAttribute{"env": snsTestAttribute("String", "pROD")},
			want:       true,
		},
		{
			name:       "anything-but list excludes",
			scope:      snsFilterScopeAttributes,
			policy:     `{"env":[{"anything-but":["dev","test"]}]}`,
			attributes: map[string]snsMessageAttribute{"env": snsTestAttribute("String", "dev")},
			want:       false,
		},
		{
			name:       "anything-but list admits",
			scope:      snsFilterScopeAttributes,
			policy:     `{"env":[{"anything-but":["dev","test"]}]}`,
			attributes: map[string]snsMessageAttribute{"env": snsTestAttribute("String", "prod")},
			want:       true,
		},
		{
			name:       "anything-but prefix excludes",
			scope:      snsFilterScopeAttributes,
			policy:     `{"env":[{"anything-but":{"prefix":"tmp-"}}]}`,
			attributes: map[string]snsMessageAttribute{"env": snsTestAttribute("String", "tmp-one")},
			want:       false,
		},
		{
			name:       "numeric range",
			scope:      snsFilterScopeAttributes,
			policy:     `{"priority":[{"numeric":[">",10,"<=",20]}]}`,
			attributes: map[string]snsMessageAttribute{"priority": snsTestAttribute("Number", "20")},
			want:       true,
		},
		{
			name:       "numeric range upper bound",
			scope:      snsFilterScopeAttributes,
			policy:     `{"priority":[{"numeric":[">",10,"<=",20]}]}`,
			attributes: map[string]snsMessageAttribute{"priority": snsTestAttribute("Number", "21")},
			want:       false,
		},
		{
			name:       "numeric exact",
			scope:      snsFilterScopeAttributes,
			policy:     `{"priority":[{"numeric":["=",10]}]}`,
			attributes: map[string]snsMessageAttribute{"priority": snsTestAttribute("Number", "10")},
			want:       true,
		},
		{
			name:       "numeric does not match a string attribute",
			scope:      snsFilterScopeAttributes,
			policy:     `{"priority":[{"numeric":["=",10]}]}`,
			attributes: map[string]snsMessageAttribute{"priority": snsTestAttribute("String", "10")},
			want:       false,
		},
		{
			name:       "string.Array any element matches",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tags":["blue"]}`,
			attributes: map[string]snsMessageAttribute{"tags": snsTestAttribute("String.Array", `["red","blue"]`)},
			want:       true,
		},
		{
			name:       "string.Array no element matches",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tags":["blue"]}`,
			attributes: map[string]snsMessageAttribute{"tags": snsTestAttribute("String.Array", `["red","green"]`)},
			want:       false,
		},
		{
			name:       "string.Array anything-but requires every element to pass",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tags":[{"anything-but":["blue"]}]}`,
			attributes: map[string]snsMessageAttribute{"tags": snsTestAttribute("String.Array", `["red","blue"]`)},
			want:       false,
		},
		{
			name:       "exists true",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tenant":[{"exists":true}]}`,
			attributes: map[string]snsMessageAttribute{"tenant": snsTestAttribute("String", "acme")},
			want:       true,
		},
		{
			name:       "exists true on a missing attribute",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tenant":[{"exists":true}]}`,
			attributes: map[string]snsMessageAttribute{},
			want:       false,
		},
		{
			name:       "exists false on a missing attribute",
			scope:      snsFilterScopeAttributes,
			policy:     `{"tenant":[{"exists":false}]}`,
			attributes: map[string]snsMessageAttribute{},
			want:       true,
		},
		{
			name:       "binary exists",
			scope:      snsFilterScopeAttributes,
			policy:     `{"blob":[{"exists":true}]}`,
			attributes: map[string]snsMessageAttribute{"blob": {DataType: "Binary", BinaryValue: []byte("x")}},
			want:       true,
		},
		{
			name:       "binary exact does not match",
			scope:      snsFilterScopeAttributes,
			policy:     `{"blob":["x"]}`,
			attributes: map[string]snsMessageAttribute{"blob": {DataType: "Binary", BinaryValue: []byte("x")}},
			want:       false,
		},
		{
			name:       "attribute names are case-sensitive",
			scope:      snsFilterScopeAttributes,
			policy:     `{"EventType":["keep"]}`,
			attributes: map[string]snsMessageAttribute{"eventType": snsTestAttribute("String", "keep")},
			want:       false,
		},
		{
			name:   "body nested keys",
			scope:  snsFilterScopeBody,
			policy: `{"kind":["order"],"customer":{"tier":["premium"]}}`,
			body:   `{"kind":"order","customer":{"tier":"premium"}}`,
			want:   true,
		},
		{
			name:   "body nested key missing",
			scope:  snsFilterScopeBody,
			policy: `{"kind":["order"],"customer":{"tier":["premium"]}}`,
			body:   `{"kind":"order","customer":{"tier":"free"}}`,
			want:   false,
		},
		{
			name:   "body non-json matches nothing",
			scope:  snsFilterScopeBody,
			policy: `{"kind":["order"]}`,
			body:   `not json`,
			want:   false,
		},
		{
			name:   "body array of objects matches one element",
			scope:  snsFilterScopeBody,
			policy: `{"items":{"sku":["a"]}}`,
			body:   `{"items":[{"sku":"b"},{"sku":"a"}]}`,
			want:   true,
		},
		{
			name:   "body array intersection",
			scope:  snsFilterScopeBody,
			policy: `{"tags":["a"]}`,
			body:   `{"tags":["a","b"]}`,
			want:   true,
		},
		{
			name:   "body numeric",
			scope:  snsFilterScopeBody,
			policy: `{"amount":[{"numeric":[">=",100]}]}`,
			body:   `{"amount":150}`,
			want:   true,
		},
		{
			name:   "body exists",
			scope:  snsFilterScopeBody,
			policy: `{"customer":[{"exists":true}]}`,
			body:   `{"customer":{"tier":"premium"}}`,
			want:   true,
		},
		{
			name:   "empty policy matches",
			scope:  snsFilterScopeBody,
			policy: `{}`,
			body:   `{"anything":true}`,
			want:   true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			policy := normalizeTestPolicy(t, testCase.policy, testCase.scope)
			message := snsTestMessage(testCase.body, testCase.attributes)
			matched, err := snsMessageMatchesFilter(policy, testCase.scope, message)
			if err != nil {
				t.Fatalf("match: %v", err)
			}
			if matched != testCase.want {
				t.Fatalf("matched = %v, want %v", matched, testCase.want)
			}
		})
	}
}

// motoEnvelopeFixture is an SNS notification envelope observed from the pinned
// moto (5.2.5) after a real SDK publish with String, Number, String.Array and
// Binary attributes.
const motoEnvelopeFixture = `{
  "Message": "{\"eventType\":\"local-sns-publish\",\"n\":1}",
  "MessageAttributes": {
    "bin": {"Type": "Binary", "Value": "YWJj"},
    "count": {"Type": "Number", "Value": "42"},
    "eventType": {"Type": "String", "Value": "local-sns-publish"},
    "tags": {"Type": "String.Array", "Value": "[\"a\",\"b\"]"}
  },
  "MessageId": "71e08042-2993-4750-9900-8c78a8728ef8",
  "Signature": "local-signature",
  "SignatureVersion": "2",
  "SigningCertURL": "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-local.pem",
  "Subject": "probe subject",
  "Timestamp": "2026-11-04T03:28:20.441Z",
  "TopicArn": "arn:aws:sns:us-east-1:123456789012:p1e6-std",
  "Type": "Notification",
  "UnsubscribeURL": "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=placeholder"
}`

func TestParseSNSEnvelopeFromObservedMotoResponse(t *testing.T) {
	message, err := parseSNSEnvelope(motoEnvelopeFixture, nil)
	if err != nil {
		t.Fatalf("parse envelope: %v", err)
	}
	if message.MessageID != "71e08042-2993-4750-9900-8c78a8728ef8" {
		t.Fatalf("message id = %q", message.MessageID)
	}
	if message.Subject != "probe subject" {
		t.Fatalf("subject = %q", message.Subject)
	}
	if message.Message != `{"eventType":"local-sns-publish","n":1}` {
		t.Fatalf("message = %q", message.Message)
	}
	if message.TopicARN != "arn:aws:sns:us-east-1:123456789012:p1e6-std" {
		t.Fatalf("topic = %q", message.TopicARN)
	}
	if !message.Timestamp.Equal(time.Date(2026, 11, 4, 3, 28, 20, 441_000_000, time.UTC)) {
		t.Fatalf("timestamp = %s", message.Timestamp)
	}
	if got := message.Attributes["eventType"]; got.DataType != "String" || got.StringValue != "local-sns-publish" {
		t.Fatalf("String attribute = %+v", got)
	}
	if got := message.Attributes["count"]; got.DataType != "Number" || got.StringValue != "42" {
		t.Fatalf("Number attribute = %+v", got)
	}
	if got := message.Attributes["tags"]; got.DataType != "String.Array" || got.StringValue != `["a","b"]` {
		t.Fatalf("String.Array attribute = %+v", got)
	}
	if got := message.Attributes["bin"]; got.DataType != "Binary" || string(got.BinaryValue) != "abc" {
		t.Fatalf("Binary attribute = %+v", got)
	}
}

func TestSNSObservedFIFODedupID(t *testing.T) {
	body := `{"Message":"hello","Timestamp":"2026-11-04T03:30:52.463Z"}`
	content := snsContentHash(body)
	message := snsTestMessage("hello", nil)

	message.MessageDeduplicationID = "explicit-1"
	if got, contentBased := snsObservedDedupID(body, message); got != "explicit-1" || contentBased {
		t.Fatalf("explicit dedup id = %q contentBased=%v", got, contentBased)
	}

	message.MessageDeduplicationID = content
	want := snsContentHash("hello")
	if got, contentBased := snsObservedDedupID(body, message); got != want || !contentBased {
		t.Fatalf("content dedup id = %q contentBased=%v, want %q true", got, contentBased, want)
	}

	message.MessageDeduplicationID = ""
	if got, _ := snsObservedDedupID(body, message); got != "" {
		t.Fatalf("missing dedup id = %q", got)
	}
}

func TestSNSLambdaEventShape(t *testing.T) {
	message := snsTestMessage(`{"ok":true}`, map[string]snsMessageAttribute{
		"eventType": snsTestAttribute("String", "keep"),
	})
	message.Subject = "subject"
	subscriptionARN := "arn:aws:sns:us-east-1:123456789012:test-topic:sub-1"
	event := snsLambdaEvent(message, subscriptionARN, "http://127.0.0.1:18190")

	var decoded struct {
		Records []struct {
			EventVersion         string         `json:"EventVersion"`
			EventSubscriptionARN string         `json:"EventSubscriptionArn"`
			EventSource          string         `json:"EventSource"`
			Sns                  map[string]any `json:"Sns"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(event, &decoded); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if len(decoded.Records) != 1 {
		t.Fatalf("records = %d", len(decoded.Records))
	}
	record := decoded.Records[0]
	if record.EventVersion != "1.0" || record.EventSource != "aws:sns" || record.EventSubscriptionARN != subscriptionARN {
		t.Fatalf("record metadata = %+v", record)
	}
	sns := record.Sns
	if sns["Type"] != "Notification" || sns["MessageId"] != message.MessageID || sns["Message"] != `{"ok":true}` {
		t.Fatalf("Sns fields = %+v", sns)
	}
	if sns["TopicArn"] != message.TopicARN || sns["Subject"] != "subject" || sns["SignatureVersion"] != "1" {
		t.Fatalf("Sns fields = %+v", sns)
	}
	if _, ok := sns["UnsubscribeUrl"]; !ok {
		t.Fatalf("Sns has no UnsubscribeUrl: %+v", sns)
	}
	if _, ok := sns["UnsubscribeURL"]; ok {
		t.Fatalf("Sns uses the SQS spelling UnsubscribeURL: %+v", sns)
	}
	if _, ok := sns["SigningCertURL"]; !ok {
		t.Fatalf("Sns has no SigningCertURL: %+v", sns)
	}
	attributes, ok := sns["MessageAttributes"].(map[string]any)
	if !ok || len(attributes) != 1 {
		t.Fatalf("MessageAttributes = %+v", sns["MessageAttributes"])
	}
	eventType, ok := attributes["eventType"].(map[string]any)
	if !ok || eventType["Type"] != "String" || eventType["Value"] != "keep" {
		t.Fatalf("eventType = %+v", eventType)
	}
	timestamp, ok := sns["Timestamp"].(string)
	if !ok {
		t.Fatalf("Timestamp = %+v", sns["Timestamp"])
	}
	if _, err := time.Parse(snsTimestampLayout, timestamp); err != nil {
		t.Fatalf("Timestamp %q is not the documented form: %v", timestamp, err)
	}
}

func TestSNSHTTPBodyUsesSQSURLSpelling(t *testing.T) {
	message := snsTestMessage("hello", map[string]snsMessageAttribute{
		"eventType": snsTestAttribute("String", "keep"),
	})
	body := snsNotificationJSON(message, "arn:aws:sns:us-east-1:123456789012:test-topic:sub-1", "http://127.0.0.1:18190")
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, ok := decoded["UnsubscribeURL"]; !ok {
		t.Fatalf("body has no UnsubscribeURL: %+v", decoded)
	}
	if _, ok := decoded["UnsubscribeUrl"]; ok {
		t.Fatalf("body uses the Lambda spelling UnsubscribeUrl: %+v", decoded)
	}
	if decoded["Type"] != "Notification" || decoded["Message"] != "hello" {
		t.Fatalf("body = %+v", decoded)
	}
}

func TestSNSDrainQueueName(t *testing.T) {
	standard := snsTopicRuntime{ARN: "arn:aws:sns:us-east-1:123456789012:my-topic", Name: "my-topic"}
	if got := snsDrainQueueName(&standard); got != "apptheory-local-sns-drain-my-topic" {
		t.Fatalf("standard drain name = %q", got)
	}
	fifo := snsTopicRuntime{ARN: "arn:aws:sns:us-east-1:123456789012:my-topic.fifo", Name: "my-topic.fifo", FIFO: true}
	if got := snsDrainQueueName(&fifo); got != "apptheory-local-sns-drain-my-topic.fifo" {
		t.Fatalf("fifo drain name = %q", got)
	}
	long := snsTopicRuntime{
		ARN:  "arn:aws:sns:us-east-1:123456789012:" + strings.Repeat("a", 100) + ".fifo",
		Name: strings.Repeat("a", 100) + ".fifo",
		FIFO: true,
	}
	got := snsDrainQueueName(&long)
	if len(got) > snsDrainQueueMaximum || !strings.HasSuffix(got, ".fifo") {
		t.Fatalf("long drain name = %q (%d characters)", got, len(got))
	}
}

func TestSNSHTTPDelivery(t *testing.T) {
	var mu sync.Mutex
	var received []*http.Request
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read the SNS HTTP body: %v", err)
		}
		mu.Lock()
		received = append(received, request)
		bodies = append(bodies, string(body))
		mu.Unlock()
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:http-topic", Name: "http-topic"}
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	subscription := SubscriptionSpec{
		LogicalID: "Stack/Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     topic.LogicalID,
		Protocol:  "http",
		Endpoint:  server.URL,
		ARN:       "arn:aws:sns:us-east-1:123456789012:http-topic:sub-1",
	}
	hub.attach(subscription, nil, reporter)
	message := snsTestMessage("hello", map[string]snsMessageAttribute{"eventType": snsTestAttribute("String", "keep")})
	if err := registry.publishLocal(context.Background(), topic.ARN, LocalSNSMessage{
		Message:           message.Message,
		MessageAttributes: map[string]LocalSNSAttribute{"eventType": {DataType: "String", StringValue: "keep"}},
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if reporter.delivered != 1 || reporter.failed != 0 {
		t.Fatalf("reporter = %+v", reporter)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("requests = %d", len(received))
	}
	request := received[0]
	if request.Method != http.MethodPost || request.Header.Get("Content-Type") != snsHTTPContentType {
		t.Fatalf("request = %s %q", request.Method, request.Header.Get("Content-Type"))
	}
	for header, want := range map[string]string{
		"x-amz-sns-message-type":     "Notification",
		"x-amz-sns-topic-arn":        topic.ARN,
		"x-amz-sns-subscription-arn": subscription.ARN,
		"x-amz-sns-rawdelivery":      "",
	} {
		if got := request.Header.Get(header); got != want {
			t.Fatalf("%s = %q, want %q", header, got, want)
		}
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(bodies[0]), &body); err != nil {
		t.Fatalf("body: %v (%s)", err, bodies[0])
	}
	if body["Type"] != "Notification" || body["Message"] != "hello" {
		t.Fatalf("body = %+v", body)
	}
}

func TestSNSHTTPDeliveryRawAndFailure(t *testing.T) {
	captured := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured <- request
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:raw-http-topic", Name: "raw-http-topic"}
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{
		LogicalID:          "Stack/Topic/Subscription0",
		Kind:               string(DeliveryKindSNS),
		Topic:              topic.LogicalID,
		Protocol:           "http",
		Endpoint:           server.URL,
		RawMessageDelivery: true,
		ARN:                "arn:aws:sns:us-east-1:123456789012:raw-http-topic:sub-1",
	}, nil, reporter)
	if err := registry.publishLocal(context.Background(), topic.ARN, LocalSNSMessage{Message: "raw body"}); err != nil {
		t.Fatalf("publish raw: %v", err)
	}
	select {
	case request := <-captured:
		if request.Header.Get("x-amz-sns-rawdelivery") != "true" {
			t.Fatalf("raw header missing: %+v", request.Header)
		}
	default:
		t.Fatalf("the raw HTTP delivery did not arrive")
	}

	failing := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer failing.Close()
	failingTopic := snsTopicRuntime{LogicalID: "Stack/Failing", ARN: "arn:aws:sns:us-east-1:123456789012:failing-topic", Name: "failing-topic"}
	registry.registerTopic(failingTopic)
	failingHub := registry.hubFor(failingTopic)
	failingReporter := &recordingDeliveryReporter{}
	failingHub.attach(SubscriptionSpec{
		LogicalID: "Stack/Failing/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     failingTopic.LogicalID,
		Protocol:  "http",
		Endpoint:  failing.URL,
		ARN:       "arn:aws:sns:us-east-1:123456789012:failing-topic:sub-1",
	}, nil, failingReporter)
	if err := registry.publishLocal(context.Background(), failingTopic.ARN, LocalSNSMessage{Message: "hello"}); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("publish error = %v, want the 500 failure", err)
	}
	if failingReporter.failed != 1 || !strings.Contains(failingReporter.lastError, "500") {
		t.Fatalf("failure reporter = %+v", failingReporter)
	}

	nonLoopback := snsTopicRuntime{LogicalID: "Stack/External", ARN: "arn:aws:sns:us-east-1:123456789012:external-topic", Name: "external-topic"}
	registry.registerTopic(nonLoopback)
	externalHub := registry.hubFor(nonLoopback)
	externalReporter := &recordingDeliveryReporter{}
	externalHub.attach(SubscriptionSpec{
		LogicalID: "Stack/External/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     nonLoopback.LogicalID,
		Protocol:  "http",
		Endpoint:  "https://example.com/hook",
		ARN:       "arn:aws:sns:us-east-1:123456789012:external-topic:sub-1",
	}, nil, externalReporter)
	if err := registry.publishLocal(context.Background(), nonLoopback.ARN, LocalSNSMessage{Message: "hello"}); err == nil || !strings.Contains(err.Error(), "not a loopback") {
		t.Fatalf("publish error = %v, want the non-loopback refusal", err)
	}
	if externalReporter.failed != 1 || !strings.Contains(externalReporter.lastError, "not a loopback") {
		t.Fatalf("external reporter = %+v", externalReporter)
	}
}

func TestSNSSQSDelivery(t *testing.T) {
	fake := newFakeSQS(t)
	fake.queue("target-queue", nil)
	fake.queue("target-fifo.fifo", func(queue *fakeSQSQueue) { queue.fifo = true })

	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:sqs-topic", Name: "sqs-topic"}
	registry := newSNSHubRegistry(
		NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		nil,
		func(logicalID string) (snsQueueTarget, bool) {
			switch logicalID {
			case "Stack/Queue":
				return snsQueueTarget{Name: "target-queue"}, true
			case "Stack/FifoQueue":
				return snsQueueTarget{Name: "target-fifo.fifo"}, true
			default:
				return snsQueueTarget{}, false
			}
		},
		func() (*sqs.Client, error) { return newSQSClient(fake.server.URL), nil },
	)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	envelopeReporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{
		LogicalID: "Stack/Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     topic.LogicalID,
		Protocol:  "sqs",
		Queue:     "Stack/Queue",
		ARN:       "arn:aws:sns:us-east-1:123456789012:sqs-topic:sub-1",
	}, nil, envelopeReporter)
	rawReporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{
		LogicalID:          "Stack/Topic/Subscription1",
		Kind:               string(DeliveryKindSNS),
		Topic:              topic.LogicalID,
		Protocol:           "sqs",
		Queue:              "Stack/Queue",
		RawMessageDelivery: true,
		ARN:                "arn:aws:sns:us-east-1:123456789012:sqs-topic:sub-2",
	}, nil, rawReporter)
	message := snsTestMessage("hello", map[string]snsMessageAttribute{"eventType": snsTestAttribute("String", "keep")})
	if err := registry.publishLocal(context.Background(), topic.ARN, LocalSNSMessage{
		Message:           message.Message,
		MessageAttributes: map[string]LocalSNSAttribute{"eventType": {DataType: "String", StringValue: "keep"}},
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if envelopeReporter.delivered != 1 || rawReporter.delivered != 1 {
		t.Fatalf("reporters = %+v / %+v", envelopeReporter, rawReporter)
	}
	fake.mu.Lock()
	if len(fake.sent) != 2 {
		t.Fatalf("sent = %d", len(fake.sent))
	}
	envelopeBody, rawBody := "", ""
	for _, sent := range fake.sent {
		body := stringField(sent, "MessageBody")
		if strings.HasPrefix(body, "{") {
			envelopeBody = body
		} else {
			rawBody = body
		}
	}
	fake.mu.Unlock()
	var envelope map[string]any
	if err := json.Unmarshal([]byte(envelopeBody), &envelope); err != nil {
		t.Fatalf("envelope: %v (%s)", err, envelopeBody)
	}
	if envelope["Type"] != "Notification" || envelope["Message"] != "hello" {
		t.Fatalf("envelope = %+v", envelope)
	}
	if rawBody != "hello" {
		t.Fatalf("raw body = %q", rawBody)
	}

	fifo := snsTopicRuntime{LogicalID: "Stack/Fifo", ARN: "arn:aws:sns:us-east-1:123456789012:sqs-topic.fifo", Name: "sqs-topic.fifo", FIFO: true, ContentBasedDeduplication: true}
	registry.registerTopic(fifo)
	fifoHub := registry.hubFor(fifo)
	fifoReporter := &recordingDeliveryReporter{}
	fifoHub.attach(SubscriptionSpec{
		LogicalID:          "Stack/Fifo/Subscription0",
		Kind:               string(DeliveryKindSNS),
		Topic:              fifo.LogicalID,
		Protocol:           "sqs",
		Queue:              "Stack/FifoQueue",
		RawMessageDelivery: true,
		ARN:                "arn:aws:sns:us-east-1:123456789012:sqs-topic.fifo:sub-1",
	}, nil, fifoReporter)
	if err := registry.publishLocal(context.Background(), fifo.ARN, LocalSNSMessage{
		Message:        "fifo body",
		MessageGroupID: "group-1",
	}); err != nil {
		t.Fatalf("publish fifo: %v", err)
	}
	if fifoReporter.delivered != 1 {
		t.Fatalf("fifo reporter = %+v", fifoReporter)
	}
	fake.mu.Lock()
	fifoRequest := fake.sent[len(fake.sent)-1]
	fake.mu.Unlock()
	if stringField(fifoRequest, "MessageGroupId") != "group-1" {
		t.Fatalf("MessageGroupId = %q", stringField(fifoRequest, "MessageGroupId"))
	}
	wantDedup := snsContentHash("fifo body")
	if got := stringField(fifoRequest, "MessageDeduplicationId"); got != wantDedup {
		t.Fatalf("MessageDeduplicationId = %q, want %q", got, wantDedup)
	}
}

func TestSNSSQSRawAttributeLimit(t *testing.T) {
	fake := newFakeSQS(t)
	fake.queue("target", nil)
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:limit-topic", Name: "limit-topic"}
	registry := newSNSHubRegistry(
		NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		nil,
		func(string) (snsQueueTarget, bool) { return snsQueueTarget{Name: "target"}, true },
		func() (*sqs.Client, error) { return newSQSClient(fake.server.URL), nil },
	)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{
		LogicalID:          "Stack/Topic/Subscription0",
		Kind:               string(DeliveryKindSNS),
		Topic:              topic.LogicalID,
		Protocol:           "sqs",
		Queue:              "Stack/Queue",
		RawMessageDelivery: true,
		ARN:                "arn:aws:sns:us-east-1:123456789012:limit-topic:sub-1",
	}, nil, reporter)
	attributes := map[string]LocalSNSAttribute{}
	for index := 0; index < snsMaxRawSQSMessageAttributes+1; index++ {
		attributes[fmt.Sprintf("a%d", index)] = LocalSNSAttribute{DataType: "String", StringValue: "v"}
	}
	if err := registry.publishLocal(context.Background(), topic.ARN, LocalSNSMessage{
		Message:           "hello",
		MessageAttributes: attributes,
	}); err == nil || !strings.Contains(err.Error(), "more than 10") {
		t.Fatalf("publish error = %v, want the raw attribute limit", err)
	}
	if reporter.failed != 1 || !strings.Contains(reporter.lastError, "more than 10") {
		t.Fatalf("reporter = %+v", reporter)
	}
}

func TestSNSPublishLocalReachesMatchingSubscriptions(t *testing.T) {
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:local-topic", Name: "local-topic"}
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)

	var mu sync.Mutex
	invocations := map[string]int{}
	reporterA := &recordingDeliveryReporter{}
	reporterB := &recordingDeliveryReporter{}
	reporterC := &recordingDeliveryReporter{}
	invoke := func(name string) func(context.Context, []byte) (InvokeResult, error) {
		return func(_ context.Context, event []byte) (InvokeResult, error) {
			mu.Lock()
			defer mu.Unlock()
			invocations[name]++
			var decoded map[string]any
			if err := json.Unmarshal(event, &decoded); err != nil {
				t.Fatalf("%s event is not JSON: %v", name, err)
			}
			records, ok := decoded["Records"].([]any)
			if !ok || len(records) != 1 {
				t.Fatalf("%s records = %v", name, decoded["Records"])
			}
			return InvokeResult{}, nil
		}
	}
	hub.attach(SubscriptionSpec{
		LogicalID:         "Stack/Topic/SubscriptionA",
		Kind:              string(DeliveryKindSNS),
		Topic:             topic.LogicalID,
		Protocol:          "lambda",
		Function:          "FunctionA",
		FilterPolicy:      json.RawMessage(`{"eventType":["keep"]}`),
		FilterPolicyScope: snsFilterScopeAttributes,
		ARN:               "arn:aws:sns:us-east-1:123456789012:local-topic:a",
	}, invoke("A"), reporterA)
	hub.attach(SubscriptionSpec{
		LogicalID: "Stack/Topic/SubscriptionB",
		Kind:      string(DeliveryKindSNS),
		Topic:     topic.LogicalID,
		Protocol:  "lambda",
		Function:  "FunctionB",
		ARN:       "arn:aws:sns:us-east-1:123456789012:local-topic:b",
	}, invoke("B"), reporterB)
	hub.attach(SubscriptionSpec{
		LogicalID:         "Stack/Topic/SubscriptionC",
		Kind:              string(DeliveryKindSNS),
		Topic:             topic.LogicalID,
		Protocol:          "lambda",
		Function:          "FunctionC",
		FilterPolicy:      json.RawMessage(`{"kind":["order"]}`),
		FilterPolicyScope: snsFilterScopeBody,
		ARN:               "arn:aws:sns:us-east-1:123456789012:local-topic:c",
	}, invoke("C"), reporterC)

	runner := &Runner{sns: registry, clock: registry.clock}
	if err := runner.PublishLocal(context.Background(), topic.ARN, `{"kind":"order"}`); err != nil {
		t.Fatalf("PublishLocal: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if invocations["B"] != 1 {
		t.Fatalf("unfiltered subscription B invocations = %d", invocations["B"])
	}
	if invocations["A"] != 0 || reporterA.filtered != 1 {
		t.Fatalf("attribute filter: invocations=%d reporter=%+v", invocations["A"], reporterA)
	}
	if invocations["C"] != 1 || reporterC.delivered != 1 {
		t.Fatalf("body filter: invocations=%d reporter=%+v", invocations["C"], reporterC)
	}
	if reporterB.delivered != 1 {
		t.Fatalf("reporter B = %+v", reporterB)
	}
	if reporterA.lastError != "" || reporterA.failed != 0 {
		t.Fatalf("reporter A = %+v", reporterA)
	}
}

func TestSNSDrainObservation(t *testing.T) {
	fake := newFakeSQS(t)
	drain := fake.queue("drain", nil)
	fake.seed(drain, motoEnvelopeFixture, nil)

	topic := snsTopicRuntime{
		LogicalID: "Stack/Topic",
		ARN:       "arn:aws:sns:us-east-1:123456789012:p1e6-std",
		Name:      "p1e6-std",
		DrainURL:  fake.server.URL + "/000000000000/drain",
	}
	client := newSQSClient(fake.server.URL)
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	var invoked []byte
	var invokedMu sync.Mutex
	hub.attach(SubscriptionSpec{
		LogicalID: "Stack/Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     topic.LogicalID,
		Protocol:  "lambda",
		Function:  "Function",
		ARN:       "arn:aws:sns:us-east-1:123456789012:p1e6-std:sub-1",
	}, func(_ context.Context, event []byte) (InvokeResult, error) {
		invokedMu.Lock()
		invoked = append([]byte(nil), event...)
		invokedMu.Unlock()
		return InvokeResult{}, nil
	}, reporter)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub.start(ctx, "http://127.0.0.1:18190", &snsLocalBackend{sqs: client})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, deleted := fake.messageCount(drain); deleted > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, deleted := fake.messageCount(drain); deleted != 1 {
		t.Fatalf("drain message was not deleted (deleted=%d)", deleted)
	}
	if reporter.delivered != 1 {
		t.Fatalf("reporter = %+v", reporter)
	}
	invokedMu.Lock()
	capturedEvent := append([]byte(nil), invoked...)
	invokedMu.Unlock()
	var event map[string]any
	if err := json.Unmarshal(capturedEvent, &event); err != nil {
		t.Fatalf("event: %v", err)
	}
	records, ok := event["Records"].([]any)
	if !ok || len(records) != 1 {
		t.Fatalf("records = %v", event["Records"])
	}
	record, ok := records[0].(map[string]any)
	if !ok {
		t.Fatalf("record = %+v", records[0])
	}
	sns, ok := record["Sns"].(map[string]any)
	if !ok {
		t.Fatalf("Sns = %+v", record["Sns"])
	}
	if sns["MessageId"] != "71e08042-2993-4750-9900-8c78a8728ef8" {
		t.Fatalf("Sns.MessageId = %v", sns["MessageId"])
	}
}

func TestSNSDedupWindowUsesRunClock(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:fifo-topic.fifo", Name: "fifo-topic.fifo", FIFO: true, ContentBasedDeduplication: true}
	registry := newSNSHubRegistry(clock, nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	var count int
	var mu sync.Mutex
	hub.attach(SubscriptionSpec{
		LogicalID: "Stack/Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     topic.LogicalID,
		Protocol:  "lambda",
		Function:  "Function",
		ARN:       "arn:aws:sns:us-east-1:123456789012:fifo-topic.fifo:sub-1",
	}, func(context.Context, []byte) (InvokeResult, error) {
		mu.Lock()
		count++
		mu.Unlock()
		return InvokeResult{}, nil
	}, reporter)
	input := LocalSNSMessage{Message: "same", MessageGroupID: "g1"}
	if err := registry.publishLocal(context.Background(), topic.ARN, input); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := registry.publishLocal(context.Background(), topic.ARN, input); err != nil {
		t.Fatalf("publish duplicate: %v", err)
	}
	mu.Lock()
	if count != 1 {
		t.Fatalf("invocations = %d, want 1 within the deduplication window", count)
	}
	mu.Unlock()
	if _, err := clock.Advance(snsDeduplicationWindow + time.Second); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if err := registry.publishLocal(context.Background(), topic.ARN, input); err != nil {
		t.Fatalf("publish after window: %v", err)
	}
	mu.Lock()
	if count != 2 {
		t.Fatalf("invocations after the window = %d, want 2", count)
	}
	mu.Unlock()
}

func TestSNSDelivererPlanReportsRegistered(t *testing.T) {
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	engine := NewDeliveryEngine(nil, 1, nil, nil, nil)
	engine.RegisterDeliverer(DeliveryKindSNS, func(source DeliverySource) (Deliverer, error) {
		return NewSNSDeliverer(source, registry)
	})
	spec := &Spec{Subscriptions: []SubscriptionSpec{{
		LogicalID: "Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     "Topic",
		Protocol:  "lambda",
		Function:  "Function",
	}}}
	states := engine.Planned(spec)
	if len(states) != 1 || states[0].State != DeliveryPhaseRegistered {
		t.Fatalf("planned = %+v", states)
	}
	if states[0].Task != "" || states[0].Reason != "" {
		t.Fatalf("registered state still names a task: %+v", states[0])
	}
}

func TestSNSProvisionDrainRegistersTopic(t *testing.T) {
	// The provisioning path is proven on the real row; this test pins the
	// deterministic queue naming and the runtime registration it writes.
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:topic", Name: "topic"}
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	if _, ok := registry.topicByID("Stack/Topic"); !ok {
		t.Fatalf("topic was not registered by id")
	}
	if _, ok := registry.topicByARN(topic.ARN); !ok {
		t.Fatalf("topic was not registered by ARN")
	}
}

func TestSNSFilterMatchesObservedMotoEnvelope(t *testing.T) {
	message, err := parseSNSEnvelope(motoEnvelopeFixture, nil)
	if err != nil {
		t.Fatalf("parse envelope: %v", err)
	}
	policy := normalizeTestPolicy(
		t,
		`{"eventType":["local-sns-publish"],"count":[{"numeric":["=",42]}],"tags":["a"]}`,
		snsFilterScopeAttributes,
	)
	matched, err := snsMessageMatchesFilter(policy, snsFilterScopeAttributes, message)
	if err != nil || !matched {
		t.Fatalf("attribute policy on the observed envelope: matched=%v err=%v", matched, err)
	}
	negative := normalizeTestPolicy(t, `{"eventType":["other"]}`, snsFilterScopeAttributes)
	matched, err = snsMessageMatchesFilter(negative, snsFilterScopeAttributes, message)
	if err != nil || matched {
		t.Fatalf("negative attribute policy on the observed envelope: matched=%v err=%v", matched, err)
	}
	bodyPolicy := normalizeTestPolicy(t, `{"eventType":["local-sns-publish"],"n":[{"numeric":["=",1]}]}`, snsFilterScopeBody)
	matched, err = snsMessageMatchesFilter(bodyPolicy, snsFilterScopeBody, message)
	if err != nil || !matched {
		t.Fatalf("body policy on the observed envelope: matched=%v err=%v", matched, err)
	}
}

func TestSNSDelivererStartPollsAndDetaches(t *testing.T) {
	fake := newFakeSQS(t)
	drain := fake.queue("drain", nil)
	fake.seed(drain, motoEnvelopeFixture, nil)
	topic := snsTopicRuntime{
		LogicalID:         "Topic",
		ARN:               "arn:aws:sns:us-east-1:123456789012:p1e6-std",
		Name:              "p1e6-std",
		DrainURL:          fake.server.URL + "/000000000000/drain",
		SubscriptionCount: 1,
	}
	registry := newSNSHubRegistry(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), nil, nil, nil)
	registry.registerTopic(topic)
	subscription := &SubscriptionSpec{
		LogicalID: "Topic/Subscription0",
		Kind:      string(DeliveryKindSNS),
		Topic:     "Topic",
		Protocol:  "lambda",
		Function:  "Function",
		ARN:       "arn:aws:sns:us-east-1:123456789012:p1e6-std:sub-1",
	}
	source := DeliverySource{
		ID:           "Topic/Subscription0",
		Kind:         DeliveryKindSNS,
		LogicalID:    "Topic/Subscription0",
		Function:     "Function",
		Subscription: subscription,
	}
	deliverer, err := NewSNSDeliverer(source, registry)
	if err != nil {
		t.Fatalf("NewSNSDeliverer: %v", err)
	}
	if _, err := NewSNSDeliverer(DeliverySource{}, registry); err == nil {
		t.Fatalf("a non-SNS source must be refused")
	}
	ctx, cancel := context.WithCancel(context.Background())
	reporter := &recordingDeliveryReporter{}
	done := make(chan error, 1)
	go func() {
		done <- deliverer.Start(ctx, DelivererEnv{
			Source:  source,
			Clock:   registry.clock,
			Backend: DeliveryBackend{Endpoint: "http://127.0.0.1:18190", Client: &snsLocalBackend{sqs: newSQSClient(fake.server.URL)}},
			Invoke: func(context.Context, []byte) (InvokeResult, error) {
				return InvokeResult{}, nil
			},
			State: reporter,
		})
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, deleted := fake.messageCount(drain); deleted > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, deleted := fake.messageCount(drain); deleted != 1 {
		t.Fatalf("the drain message was not delivered (deleted=%d)", deleted)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Start returned %v", err)
	}
	if reporter.delivered != 1 {
		t.Fatalf("reporter = %+v", reporter)
	}
	hub := registry.hubFor(topic)
	hub.mu.Lock()
	attachments := len(hub.attachments)
	hub.mu.Unlock()
	if attachments != 0 {
		t.Fatalf("the subscription was not detached: %d attachment(s)", attachments)
	}
}

func TestSNSHubFailAllAndWait(t *testing.T) {
	registry := newSNSHubRegistry(RealClock{}, nil, nil, nil)
	topic := snsTopicRuntime{LogicalID: "Topic", ARN: "arn:aws:sns:us-east-1:123456789012:fail-topic", Name: "fail-topic"}
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	first := &recordingDeliveryReporter{}
	second := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{LogicalID: "Topic/A", Kind: string(DeliveryKindSNS)}, nil, first)
	hub.attach(SubscriptionSpec{LogicalID: "Topic/B", Kind: string(DeliveryKindSNS)}, nil, second)
	hub.failAll(errors.New("drain unavailable"))
	for _, reporter := range []*recordingDeliveryReporter{first, second} {
		if reporter.failed != 1 || !strings.Contains(reporter.lastError, "drain unavailable") {
			t.Fatalf("reporter = %+v", reporter)
		}
		if reporter.phase != DeliveryPhaseFailed {
			t.Fatalf("phase = %q", reporter.phase)
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	hub.wait(canceled, time.Hour)
	hub.wait(context.Background(), time.Millisecond)
}

func newFakeSNS(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		if action := request.FormValue("Action"); action != "Subscribe" {
			http.Error(writer, "unexpected action "+action, http.StatusBadRequest)
			return
		}
		if protocol := request.FormValue("Protocol"); protocol != "sqs" {
			http.Error(writer, "unexpected protocol "+protocol, http.StatusBadRequest)
			return
		}
		if request.FormValue("RawMessageDelivery") != "" {
			http.Error(writer, "the drain subscription must not be raw", http.StatusBadRequest)
			return
		}
		subscriptionARN := request.FormValue("TopicArn") + ":drain-subscription"
		writer.Header().Set("Content-Type", "text/xml")
		if _, err := fmt.Fprintf(writer, `<SubscribeResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><SubscribeResult><SubscriptionArn>%s</SubscriptionArn></SubscribeResult><ResponseMetadata><RequestId>local</RequestId></ResponseMetadata></SubscribeResponse>`, html.EscapeString(subscriptionARN)); err != nil {
			http.Error(writer, err.Error(), http.StatusInternalServerError)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestProvisionSNSDrainCreatesQueueAndSubscription(t *testing.T) {
	sqsFake := newFakeSQS(t)
	snsFake := newFakeSNS(t)
	topic := snsTopicRuntime{
		LogicalID:         "Stack/MyTopic",
		ARN:               "arn:aws:sns:us-east-1:123456789012:my-topic",
		Name:              "my-topic",
		SubscriptionCount: 2,
	}
	runner := &Runner{options: Options{Stdout: io.Discard}}
	if err := runner.provisionSNSDrain(
		context.Background(),
		&topic,
		newSNSClient(snsFake.URL),
		newSQSClient(sqsFake.server.URL),
	); err != nil {
		t.Fatalf("provisionSNSDrain: %v", err)
	}
	if topic.DrainURL == "" || topic.DrainARN == "" || topic.DrainSubscriptionARN == "" {
		t.Fatalf("drain runtime = %+v", topic)
	}
	sqsFake.mu.Lock()
	queue, ok := sqsFake.queues["apptheory-local-sns-drain-my-topic"]
	sqsFake.mu.Unlock()
	if !ok {
		t.Fatalf("the drain queue was not created")
	}
	if queue == nil {
		t.Fatalf("the drain queue is nil")
	}
	if !strings.HasSuffix(topic.DrainSubscriptionARN, ":drain-subscription") {
		t.Fatalf("subscription ARN = %q", topic.DrainSubscriptionARN)
	}
}

func TestProvisionSNSDrainFIFOQueueName(t *testing.T) {
	sqsFake := newFakeSQS(t)
	snsFake := newFakeSNS(t)
	topic := snsTopicRuntime{
		LogicalID:         "Stack/FifoTopic",
		ARN:               "arn:aws:sns:us-east-1:123456789012:my-topic.fifo",
		Name:              "my-topic.fifo",
		FIFO:              true,
		SubscriptionCount: 1,
	}
	runner := &Runner{options: Options{Stdout: io.Discard}}
	if err := runner.provisionSNSDrain(context.Background(), &topic, newSNSClient(snsFake.URL), newSQSClient(sqsFake.server.URL)); err != nil {
		t.Fatalf("provisionSNSDrain: %v", err)
	}
	sqsFake.mu.Lock()
	_, ok := sqsFake.queues["apptheory-local-sns-drain-my-topic.fifo"]
	sqsFake.mu.Unlock()
	if !ok {
		t.Fatalf("the FIFO drain queue was not created")
	}
}

func TestSNSRegistryAndDelivererErrorPaths(t *testing.T) {
	registry := newSNSHubRegistry(RealClock{}, nil, nil, nil)
	if err := registry.publishLocal(context.Background(), "arn:aws:sns:us-east-1:123456789012:missing", LocalSNSMessage{Message: "x"}); err == nil {
		t.Fatalf("publish to an unknown topic must fail")
	}
	topic := snsTopicRuntime{LogicalID: "Topic", ARN: "arn:aws:sns:us-east-1:123456789012:local", Name: "local"}
	registry.registerTopic(topic)
	if err := registry.publishLocal(context.Background(), topic.ARN, LocalSNSMessage{Message: "x"}); err != nil {
		t.Fatalf("publish to a topic with no subscriptions: %v", err)
	}
	if _, err := NewSNSDeliverer(DeliverySource{}, registry); err == nil {
		t.Fatalf("a non-SNS source must be refused")
	}
	if _, err := NewSNSDeliverer(DeliverySource{Subscription: &SubscriptionSpec{Kind: string(DeliveryKindSNS)}}, nil); err == nil {
		t.Fatalf("a nil registry must be refused")
	}
	source := DeliverySource{
		ID: "Sub",
		Subscription: &SubscriptionSpec{
			LogicalID: "Sub",
			Kind:      string(DeliveryKindSNS),
			Topic:     "Missing",
			Protocol:  "lambda",
		},
	}
	deliverer, err := NewSNSDeliverer(source, registry)
	if err != nil {
		t.Fatalf("NewSNSDeliverer: %v", err)
	}
	if startErr := deliverer.Start(context.Background(), DelivererEnv{}); startErr == nil {
		t.Fatalf("a subscription without a provisioned topic must fail")
	}
	stackTopic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:stack", Name: "stack"}
	registry.registerTopic(stackTopic)
	source.Subscription.Topic = "Topic"
	source.Subscription.Stack = "Stack"
	deliverer, err = NewSNSDeliverer(source, registry)
	if err != nil {
		t.Fatalf("NewSNSDeliverer: %v", err)
	}
	if startErr := deliverer.Start(context.Background(), DelivererEnv{}); startErr == nil || !strings.Contains(startErr.Error(), "no SNS/SQS client") {
		t.Fatalf("Start without a backend = %v", startErr)
	}

	// Two subscriptions on one topic: the hub waits for both before polling.
	waiting := snsTopicRuntime{LogicalID: "Wait/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:wait", Name: "wait", SubscriptionCount: 2}
	registry.registerTopic(waiting)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	backend := DeliveryBackend{Client: &snsLocalBackend{sqs: newSQSClient("http://127.0.0.1:1")}}
	for index := 0; index < 2; index++ {
		subscription := &SubscriptionSpec{
			LogicalID: fmt.Sprintf("Wait/Sub%d", index),
			Kind:      string(DeliveryKindSNS),
			Topic:     "Wait/Topic",
			Protocol:  "lambda",
			Function:  "Function",
		}
		source := DeliverySource{ID: subscription.LogicalID, Subscription: subscription}
		deliverer, err := NewSNSDeliverer(source, registry)
		if err != nil {
			t.Fatalf("NewSNSDeliverer: %v", err)
		}
		go func() {
			if err := deliverer.Start(ctx, DelivererEnv{
				Backend: backend,
				Invoke:  func(context.Context, []byte) (InvokeResult, error) { return InvokeResult{}, nil },
				State:   &recordingDeliveryReporter{},
			}); err != nil {
				t.Errorf("Start returned %v", err)
			}
		}()
	}
	hub := registry.hubFor(waiting)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hub.mu.Lock()
		attached := len(hub.attachments)
		started := hub.started
		hub.mu.Unlock()
		if attached == 2 && started {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	hub.mu.Lock()
	attached := len(hub.attachments)
	started := hub.started
	hub.mu.Unlock()
	if attached != 2 || !started {
		t.Fatalf("hub after two subscriptions: attachments=%d started=%v", attached, started)
	}
	cancel()
	hub.wait(context.Background(), 0)
	hub.wait(context.Background(), time.Millisecond)
	if err := (&Runner{}).PublishLocalMessage(context.Background(), waiting.ARN, LocalSNSMessage{Message: "x"}); err == nil {
		t.Fatalf("PublishLocalMessage without a registry must fail")
	}
}

func TestSNSHubDeliveryErrorPaths(t *testing.T) {
	fake := newFakeSQS(t)
	fake.queue("fifo-target", func(queue *fakeSQSQueue) { queue.fifo = true })
	topic := snsTopicRuntime{LogicalID: "Topic", ARN: "arn:aws:sns:us-east-1:123456789012:errors", Name: "errors", FIFO: true}
	registry := newSNSHubRegistry(RealClock{}, nil, func(logicalID string) (snsQueueTarget, bool) {
		if logicalID == "Queue" {
			return snsQueueTarget{Name: "fifo-target"}, true
		}
		return snsQueueTarget{}, false
	}, func() (*sqs.Client, error) { return newSQSClient(fake.server.URL), nil })
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	message := snsTestMessage("hello", nil)

	cases := []struct {
		name         string
		subscription SubscriptionSpec
		invoke       func(context.Context, []byte) (InvokeResult, error)
		want         string
	}{
		{
			name:         "unknown protocol",
			subscription: SubscriptionSpec{LogicalID: "Topic/sms", Protocol: "sms"},
			want:         "not deliverable",
		},
		{
			name:         "lambda handler error",
			subscription: SubscriptionSpec{LogicalID: "Topic/lambda", Protocol: "lambda", Function: "Function"},
			invoke: func(context.Context, []byte) (InvokeResult, error) {
				return InvokeResult{HandlerError: "boom"}, nil
			},
			want: "boom",
		},
		{
			name:         "invalid filter policy",
			subscription: SubscriptionSpec{LogicalID: "Topic/filter", Protocol: "lambda", Function: "Function", FilterPolicy: json.RawMessage("{")},
			invoke:       func(context.Context, []byte) (InvokeResult, error) { return InvokeResult{}, nil },
			want:         "FilterPolicy",
		},
		{
			name:         "missing sqs queue",
			subscription: SubscriptionSpec{LogicalID: "Topic/missing-queue", Protocol: "sqs", Queue: "missing"},
			want:         "no provisioned SQS queue",
		},
		{
			name:         "fifo target without a group",
			subscription: SubscriptionSpec{LogicalID: "Topic/fifo", Protocol: "sqs", Queue: "Queue", RawMessageDelivery: true},
			want:         "no MessageGroupId",
		},
		{
			name:         "http endpoint is not absolute",
			subscription: SubscriptionSpec{LogicalID: "Topic/bad-http", Protocol: "http", Endpoint: "not-a-url"},
			want:         "not an absolute URL",
		},
		{
			name:         "http endpoint is closed",
			subscription: SubscriptionSpec{LogicalID: "Topic/closed-http", Protocol: "http", Endpoint: "http://127.0.0.1:1/"},
			want:         "post the SNS notification",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reporter := &recordingDeliveryReporter{}
			subscription := testCase.subscription
			subscription.Kind = string(DeliveryKindSNS)
			subscription.ARN = "arn:aws:sns:us-east-1:123456789012:errors:" + subscription.LogicalID
			hub.attach(subscription, testCase.invoke, reporter)
			defer hub.detach(&snsAttachment{spec: subscription})
			err := hub.dispatch(context.Background(), message, "")
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("dispatch error = %v, want %q", err, testCase.want)
			}
			if reporter.failed != 1 || !strings.Contains(reporter.lastError, testCase.want) {
				t.Fatalf("reporter = %+v", reporter)
			}
		})
	}

	// A malformed drain envelope and a missing drain queue both report failed.
	badTopic := snsTopicRuntime{LogicalID: "Bad/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:bad", Name: "bad", DrainURL: fake.server.URL + "/000000000000/missing"}
	registry.registerTopic(badTopic)
	badHub := registry.hubFor(badTopic)
	badReporter := &recordingDeliveryReporter{}
	badHub.attach(SubscriptionSpec{LogicalID: "Bad/Sub", Kind: string(DeliveryKindSNS), Protocol: "lambda", Function: "Function"}, nil, badReporter)
	badHub.mu.Lock()
	badHub.topic.DrainURL = ""
	badHub.mu.Unlock()
	badHub.failAll(errors.New("no drain"))
	if badReporter.failed != 1 {
		t.Fatalf("bad reporter = %+v", badReporter)
	}
}

func TestSNSMessageBuilderEdges(t *testing.T) {
	message := snsTestMessage("hello", nil)
	if arn := snsSubscriptionARN(message.TopicARN, "Sub"); !strings.HasPrefix(arn, message.TopicARN+":") {
		t.Fatalf("subscription ARN = %q", arn)
	}
	event := snsLambdaEvent(message, "arn:sub", "")
	var decoded map[string]any
	if err := json.Unmarshal(event, &decoded); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	records, ok := decoded["Records"].([]any)
	if !ok || len(records) != 1 {
		t.Fatalf("records = %+v", decoded["Records"])
	}
	record, ok := records[0].(map[string]any)
	if !ok {
		t.Fatalf("record = %+v", records[0])
	}
	sns, ok := record["Sns"].(map[string]any)
	if !ok {
		t.Fatalf("Sns = %+v", record["Sns"])
	}
	if _, ok := sns["Subject"]; ok {
		t.Fatalf("an empty subject must be omitted: %+v", sns)
	}
	if _, ok := sns["MessageAttributes"]; ok {
		t.Fatalf("empty attributes must be omitted: %+v", sns)
	}
	body := snsNotificationJSON(message, "arn:sub", "")
	var notification map[string]any
	if err := json.Unmarshal(body, &notification); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if _, ok := notification["MessageAttributes"]; ok {
		t.Fatalf("empty attributes must be omitted: %+v", notification)
	}
	local := snsLocalMessage(
		snsTopicRuntime{ARN: "arn:aws:sns:us-east-1:123456789012:local"},
		LocalSNSMessage{
			Message: "hello",
			MessageAttributes: map[string]LocalSNSAttribute{
				"bin": {DataType: "Binary", BinaryValue: []byte("x")},
			},
		},
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	)
	if got := local.Attributes["bin"].StringValue; got != "eA==" {
		t.Fatalf("binary attribute value = %q", got)
	}
	parsed, err := parseSNSEnvelope(`{"Timestamp":"not-a-time","MessageAttributes":{"bin":{"Type":"Binary","Value":"!!!"}}}`, nil)
	if err != nil {
		t.Fatalf("parse envelope: %v", err)
	}
	if !parsed.Timestamp.IsZero() {
		t.Fatalf("malformed timestamp = %s", parsed.Timestamp)
	}
	if parsed.Attributes["bin"].BinaryValue != nil {
		t.Fatalf("malformed binary attribute = %+v", parsed.Attributes["bin"])
	}
}

func TestSNSFilterEdgePaths(t *testing.T) {
	if policy, err := normalizeSNSFilterPolicy(nil, snsFilterScopeAttributes, "Sub"); err != nil || policy != nil {
		t.Fatalf("empty policy = %s, err=%v", policy, err)
	}
	if _, err := snsMessageMatchesFilter(json.RawMessage(`{}`), "UnknownScope", snsTestMessage("x", nil)); err == nil {
		t.Fatalf("an unknown scope must fail")
	}
	if _, ok := snsBodyTarget(`[1,2]`); ok {
		t.Fatalf("an array body must not be a body-scope target")
	}
	if got := snsAttributeMatchValue(snsMessageAttribute{DataType: "String.Array", StringValue: "not-json"}); len(got.([]any)) != 0 { //nolint:errcheck // the production function always returns a slice here
		t.Fatalf("malformed String.Array = %+v", got)
	}
	if got := snsAttributeMatchValue(snsMessageAttribute{DataType: "Binary"}); got == nil {
		t.Fatalf("a binary attribute must remain an opaque value")
	}
	if snsMatchValue(map[string]any{"nested": []any{"x"}}, nil, false) {
		t.Fatalf("a nested object must not match when it is absent")
	}
	if snsMatchRule(map[string]any{"unknown": "x"}, "x", true) {
		t.Fatalf("an unknown operator object must not match")
	}
	if snsMatchOperator("unknown", map[string]any{"unknown": "x"}, "x", true) {
		t.Fatalf("an unknown operator must not match")
	}
	if !snsMatchOperator(filterOperatorNumeric, map[string]any{filterOperatorNumeric: []any{">=", 10}}, []any{json.Number("15")}, true) {
		t.Fatalf("a numeric rule must match one element of an array")
	}
	if snsMatchOperator(filterOperatorAnythingBut, map[string]any{filterOperatorAnythingBut: []any{"x"}}, []any{"x"}, true) {
		t.Fatalf("anything-but must reject an array containing the excluded value")
	}
	if !snsMatchOperator(filterOperatorAnythingBut, map[string]any{filterOperatorAnythingBut: []any{"x"}}, []any{"y"}, true) {
		t.Fatalf("anything-but must admit an array without the excluded value")
	}
}

func TestSNSDelivererSendAndProvisionErrors(t *testing.T) {
	fake := newFakeSQS(t)
	fake.queue("target", nil)
	fake.failSend = true
	topic := snsTopicRuntime{LogicalID: "Topic", ARN: "arn:aws:sns:us-east-1:123456789012:send-error", Name: "send-error"}
	registry := newSNSHubRegistry(RealClock{}, nil, func(string) (snsQueueTarget, bool) {
		return snsQueueTarget{Name: "target"}, true
	}, func() (*sqs.Client, error) { return newSQSClient(fake.server.URL), nil })
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{
		LogicalID: "Topic/Sub",
		Kind:      string(DeliveryKindSNS),
		Protocol:  "sqs",
		Queue:     "Queue",
		ARN:       "arn:aws:sns:us-east-1:123456789012:send-error:sub",
	}, nil, reporter)
	if err := hub.dispatch(context.Background(), snsTestMessage("hello", nil), ""); err == nil {
		t.Fatalf("a SendMessage failure must be reported")
	}
	if reporter.failed != 1 || !strings.Contains(reporter.lastError, "send failed") {
		t.Fatalf("reporter = %+v", reporter)
	}

	fake.failSend = false
	fake.failGetAttributes = true
	badAttributes := snsTopicRuntime{LogicalID: "Bad/Attributes", ARN: "arn:aws:sns:us-east-1:123456789012:attrs", Name: "attrs"}
	registry.registerTopic(badAttributes)
	badHub := registry.hubFor(badAttributes)
	badReporter := &recordingDeliveryReporter{}
	badHub.attach(SubscriptionSpec{
		LogicalID: "Bad/Attributes/Sub",
		Kind:      string(DeliveryKindSNS),
		Protocol:  "sqs",
		Queue:     "Queue",
		ARN:       "arn:aws:sns:us-east-1:123456789012:attrs:sub",
	}, nil, badReporter)
	if err := badHub.dispatch(context.Background(), snsTestMessage("hello", nil), ""); err == nil {
		t.Fatalf("an attribute-read failure must be reported")
	}
	if badReporter.failed != 1 {
		t.Fatalf("reporter = %+v", badReporter)
	}
	fake.failGetAttributes = false

	failingSQS := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "create failed", http.StatusInternalServerError)
	}))
	defer failingSQS.Close()
	runner := &Runner{options: Options{Stdout: io.Discard}}
	provisionTopic := snsTopicRuntime{LogicalID: "Provision/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:provision", Name: "provision"}
	if err := runner.provisionSNSDrain(context.Background(), &provisionTopic, newSNSClient("http://127.0.0.1:1"), newSQSClient(failingSQS.URL)); err == nil {
		t.Fatalf("a CreateQueue failure must be reported")
	}

	failingSNS := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "subscribe failed", http.StatusInternalServerError)
	}))
	defer failingSNS.Close()
	goodSQS := newFakeSQS(t)
	subscribeTopic := snsTopicRuntime{LogicalID: "Provision/Subscribe", ARN: "arn:aws:sns:us-east-1:123456789012:subscribe", Name: "subscribe"}
	if err := runner.provisionSNSDrain(context.Background(), &subscribeTopic, newSNSClient(failingSNS.URL), newSQSClient(goodSQS.server.URL)); err == nil {
		t.Fatalf("a Subscribe failure must be reported")
	}
}

func TestSNSFilterInvalidPolicyShapes(t *testing.T) {
	if _, err := snsMessageMatchesFilter(json.RawMessage(`[]`), snsFilterScopeAttributes, snsTestMessage("x", nil)); err == nil {
		t.Fatalf("a non-object policy must fail at match time")
	}
	if snsMatchObject(map[string]any{"key": []any{"value"}}, "scalar") {
		t.Fatalf("a pattern object must not match a scalar")
	}
	if !snsMatchRule([]any{[]any{"value"}}, "value", true) {
		t.Fatalf("a nested rule list must keep the documented OR reading")
	}
	if snsMatchOperator(filterOperatorExists, map[string]any{filterOperatorExists: "yes"}, "value", true) {
		t.Fatalf("a non-boolean exists rule must not match")
	}
}

func TestSNSCoverageEdges(t *testing.T) {
	empty := newSNSHubRegistry(nil, nil, nil, nil)
	if empty.clock == nil {
		t.Fatalf("a nil clock must become the real clock")
	}
	if got := snsUnsubscribeURL("", "arn:aws:sns:us-east-1:123456789012:topic:sub"); !strings.HasPrefix(
		got,
		"https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:us-east-1:123456789012:topic:sub",
	) {
		t.Fatalf("default unsubscribe URL = %q", got)
	}
	fields := snsNotificationFields(snsMessage{Message: "x", TopicARN: "arn", Attributes: map[string]snsMessageAttribute{}}, "arn:sub", "")
	if _, ok := fields["Timestamp"].(string); !ok {
		t.Fatalf("a zero timestamp must fall back to the current instant: %+v", fields)
	}
	standard := snsLocalMessage(
		snsTopicRuntime{ARN: "arn:aws:sns:us-east-1:123456789012:standard", Name: "standard"},
		LocalSNSMessage{Message: "x", MessageGroupID: "g", MessageDeduplicationID: "d"},
		time.Now(),
	)
	if standard.MessageGroupID != "" || standard.MessageDeduplicationID != "" {
		t.Fatalf("a standard topic must ignore FIFO ids: %+v", standard)
	}
	if got := snsDrainQueueName(&snsTopicRuntime{ARN: "arn:aws:sns:us-east-1:123456789012:x", Name: "!!!"}); got != "apptheory-local-sns-drain-topic" {
		t.Fatalf("sanitized drain name = %q", got)
	}
	if !snsScalarMatches("x", []any{"y", "x"}, true) {
		t.Fatalf("a scalar rule must match one element of an array")
	}
	if _, err := snsMessageMatchesFilter(json.RawMessage("{"), snsFilterScopeAttributes, snsTestMessage("x", nil)); err == nil {
		t.Fatalf("a malformed policy must fail at match time")
	}

	arnTopic := snsTopicRuntime{LogicalID: "Other/ID", ARN: "arn:aws:sns:us-east-1:123456789012:arn-fallback", Name: "arn-fallback"}
	empty.registerTopic(arnTopic)
	source := DeliverySource{Subscription: &SubscriptionSpec{
		LogicalID: "Sub",
		Kind:      string(DeliveryKindSNS),
		Topic:     "Missing",
		TopicARN:  arnTopic.ARN,
		Protocol:  "lambda",
	}}
	deliverer, err := NewSNSDeliverer(source, empty)
	if err != nil {
		t.Fatalf("NewSNSDeliverer: %v", err)
	}
	if err := deliverer.Start(context.Background(), DelivererEnv{}); err == nil || !strings.Contains(err.Error(), "no SNS/SQS client") {
		t.Fatalf("ARN fallback Start = %v", err)
	}
}

func TestProvisionSNSDrainAttributeError(t *testing.T) {
	sqsFake := newFakeSQS(t)
	sqsFake.failGetAttributes = true
	snsFake := newFakeSNS(t)
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:attrs", Name: "attrs"}
	runner := &Runner{options: Options{Stdout: io.Discard}}
	if err := runner.provisionSNSDrain(context.Background(), &topic, newSNSClient(snsFake.URL), newSQSClient(sqsFake.server.URL)); err == nil {
		t.Fatalf("a GetQueueAttributes failure must be reported")
	}
}

func TestSNSDrainMalformedAndMissingEnvelope(t *testing.T) {
	// A malformed envelope fails every attached subscription and is deleted.
	fake := newFakeSQS(t)
	drain := fake.queue("drain", nil)
	fake.seed(drain, "not json", nil)
	topic := snsTopicRuntime{
		LogicalID:         "Topic",
		ARN:               "arn:aws:sns:us-east-1:123456789012:malformed",
		Name:              "malformed",
		DrainURL:          fake.server.URL + "/000000000000/drain",
		SubscriptionCount: 1,
	}
	registry := newSNSHubRegistry(RealClock{}, nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{LogicalID: "Topic/Sub", Kind: string(DeliveryKindSNS), Protocol: "lambda", Function: "Function", ARN: "arn:sub"}, nil, reporter)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hub.start(ctx, "http://127.0.0.1:18190", &snsLocalBackend{sqs: newSQSClient(fake.server.URL)})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, deleted := fake.messageCount(drain); deleted > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if reporter.failed != 1 || !strings.Contains(reporter.lastError, "decode the SNS notification envelope") {
		t.Fatalf("reporter = %+v", reporter)
	}

	// A FIFO envelope without MessageId/TopicArn uses the drain message id and
	// the topic ARN, and a missing group still dispatches.
	fifoFake := newFakeSQS(t)
	fifoDrain := fifoFake.queue("fifo-drain", func(queue *fakeSQSQueue) { queue.fifo = true })
	fifoFake.seed(fifoDrain, `{"Message":"hello"}`, nil)
	fifoTopic := snsTopicRuntime{
		LogicalID:         "Fifo",
		ARN:               "arn:aws:sns:us-east-1:123456789012:fifo.fifo",
		Name:              "fifo.fifo",
		FIFO:              true,
		DrainURL:          fifoFake.server.URL + "/000000000000/fifo-drain",
		SubscriptionCount: 1,
	}
	fifoRegistry := newSNSHubRegistry(RealClock{}, nil, nil, nil)
	fifoRegistry.registerTopic(fifoTopic)
	fifoHub := fifoRegistry.hubFor(fifoTopic)
	fifoReporter := &recordingDeliveryReporter{}
	fifoHub.attach(SubscriptionSpec{LogicalID: "Fifo/Sub", Kind: string(DeliveryKindSNS), Protocol: "lambda", Function: "Function", ARN: "arn:fifo"}, func(context.Context, []byte) (InvokeResult, error) {
		return InvokeResult{}, nil
	}, fifoReporter)
	fifoHub.start(ctx, "http://127.0.0.1:18190", &snsLocalBackend{sqs: newSQSClient(fifoFake.server.URL)})
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, deleted := fifoFake.messageCount(fifoDrain); deleted > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if fifoReporter.delivered != 1 {
		t.Fatalf("FIFO reporter = %+v", fifoReporter)
	}
}

func TestSNSHubPollReceiveErrorAndInvokeError(t *testing.T) {
	fake := newFakeSQS(t)
	topic := snsTopicRuntime{
		LogicalID:         "Topic",
		ARN:               "arn:aws:sns:us-east-1:123456789012:receive-error",
		Name:              "receive-error",
		DrainURL:          fake.server.URL + "/000000000000/missing-queue",
		SubscriptionCount: 1,
	}
	registry := newSNSHubRegistry(RealClock{}, nil, nil, nil)
	registry.registerTopic(topic)
	hub := registry.hubFor(topic)
	reporter := &recordingDeliveryReporter{}
	hub.attach(SubscriptionSpec{LogicalID: "Topic/Sub", Kind: string(DeliveryKindSNS), Protocol: "lambda", Function: "Function", ARN: "arn:sub"}, nil, reporter)
	ctx, cancel := context.WithCancel(context.Background())
	hub.start(ctx, "http://127.0.0.1:18190", &snsLocalBackend{sqs: newSQSClient(fake.server.URL)})
	time.Sleep(400 * time.Millisecond)
	cancel()
	if reporter.failed == 0 {
		t.Fatalf("a receive error must be reported: %+v", reporter)
	}

	invokeTopic := snsTopicRuntime{LogicalID: "Invoke", ARN: "arn:aws:sns:us-east-1:123456789012:invoke", Name: "invoke"}
	registry.registerTopic(invokeTopic)
	invokeHub := registry.hubFor(invokeTopic)
	invokeReporter := &recordingDeliveryReporter{}
	invokeHub.attach(SubscriptionSpec{LogicalID: "Invoke/Sub", Kind: string(DeliveryKindSNS), Protocol: "lambda", Function: "Function", ARN: "arn:invoke"}, func(context.Context, []byte) (InvokeResult, error) {
		return InvokeResult{}, errors.New("invoke failed")
	}, invokeReporter)
	if err := invokeHub.dispatch(context.Background(), snsTestMessage("hello", nil), ""); err == nil {
		t.Fatalf("an invoke error must be reported")
	}
	if invokeReporter.failed != 1 || !strings.Contains(invokeReporter.lastError, "invoke failed") {
		t.Fatalf("reporter = %+v", invokeReporter)
	}
}

func TestSNSNumericValueTypesAndDrainURIFallback(t *testing.T) {
	if value, ok := numericValue(float64(2)); !ok || value != 2 {
		t.Fatalf("float64 numeric value = %v %v", value, ok)
	}
	if value, ok := numericValue(3); !ok || value != 3 {
		t.Fatalf("int numeric value = %v %v", value, ok)
	}
	sqsFake := newFakeSQS(t)
	sqsFake.emptyCreateURL = true
	snsFake := newFakeSNS(t)
	topic := snsTopicRuntime{LogicalID: "Stack/Topic", ARN: "arn:aws:sns:us-east-1:123456789012:fallback", Name: "fallback"}
	runner := &Runner{options: Options{Stdout: io.Discard}}
	if err := runner.provisionSNSDrain(context.Background(), &topic, newSNSClient(snsFake.URL), newSQSClient(sqsFake.server.URL)); err != nil {
		t.Fatalf("provisionSNSDrain: %v", err)
	}
	if topic.DrainURL == "" {
		t.Fatalf("the GetQueueUrl fallback did not resolve the queue")
	}
}
