package localrunner

import (
	"context"
	"crypto"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/require"
)

// fakeS3Bucket serves the ListObjectsV2 responses the watcher reads.
type fakeS3Bucket struct {
	mu      sync.Mutex
	objects []map[string]any
	pages   [][]map[string]any
	page    int
}

func (f *fakeS3Bucket) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var contents []map[string]any
	truncated := false
	if f.pages != nil {
		if f.page < len(f.pages) {
			contents = f.pages[f.page]
		}
		truncated = f.page < len(f.pages)-1
		f.page++
	} else {
		contents = f.objects
	}
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><IsTruncated>`)
	builder.WriteString(map[bool]string{true: "true", false: "false"}[truncated])
	builder.WriteString(`</IsTruncated>`)
	for _, object := range contents {
		builder.WriteString("<Contents><Key>")
		fmt.Fprint(&builder, object["key"])
		builder.WriteString("</Key><LastModified>")
		fmt.Fprint(&builder, object["lastModified"])
		builder.WriteString("</LastModified><ETag>")
		fmt.Fprint(&builder, object["etag"])
		builder.WriteString("</ETag><Size>")
		fmt.Fprint(&builder, object["size"])
		builder.WriteString("</Size></Contents>")
	}
	if truncated {
		builder.WriteString("<NextContinuationToken>next</NextContinuationToken>")
	}
	builder.WriteString("</ListBucketResult>")
	writer.Header().Set("Content-Type", "application/xml")
	_, _ = writer.Write([]byte(builder.String())) //nolint:errcheck // a fake S3 server
}

func TestListBucketObjects(t *testing.T) {
	bucket := &fakeS3Bucket{objects: []map[string]any{
		{"key": "a.json", "lastModified": "2026-01-01T00:00:00.000Z", "etag": `"etag-a"`, "size": "12"},
	}}
	server := httptest.NewServer(bucket)
	defer server.Close()
	objects, err := listBucketObjects(context.Background(), newS3Client(server.URL), "bucket")
	require.NoError(t, err)
	require.Equal(t, int64(12), objects["a.json"].Size)
	require.Equal(t, `"etag-a"`, objects["a.json"].ETag)
}

func TestListBucketObjectsPaginates(t *testing.T) {
	bucket := &fakeS3Bucket{pages: [][]map[string]any{
		{{"key": "a", "lastModified": "2026-01-01T00:00:00.000Z", "etag": "a", "size": "1"}},
		{{"key": "b", "lastModified": "2026-01-01T00:00:00.000Z", "etag": "b", "size": "2"}},
	}}
	server := httptest.NewServer(bucket)
	defer server.Close()
	objects, err := listBucketObjects(context.Background(), newS3Client(server.URL), "bucket")
	require.NoError(t, err)
	require.Len(t, objects, 2)
}

func TestS3NotificationDelivererDeliversAllDestinations(t *testing.T) {
	var invoked []string
	var queueBodies []string
	var snsBodies []string
	var busEntries []eventBridgeEntry
	supervisor := newS3NotificationSupervisor(
		NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		nil,
		nil,
		func(id string) (resourceValue, bool) {
			switch id {
			case "Queue":
				return resourceValue{Type: typeSQSQueue, Name: "q", URL: "http://sqs/q"}, true
			case "Topic":
				return resourceValue{Type: typeSNSTopic, Name: "t", ARN: "arn:aws:sns:us-east-1:123456789012:t"}, true
			}
			return resourceValue{}, false
		},
		func(_ context.Context, function string, _ []byte) (InvokeResult, error) {
			invoked = append(invoked, function)
			return InvokeResult{}, nil
		},
		func(_ context.Context, queueURL string, body []byte) error {
			queueBodies = append(queueBodies, queueURL+" "+string(body))
			return nil
		},
		func(_ context.Context, topicARN string, message LocalSNSMessage) error {
			snsBodies = append(snsBodies, topicARN+" "+message.Message)
			return nil
		},
		func(_ context.Context, entries []eventBridgeEntry) ([]eventBridgeResult, int) {
			busEntries = append(busEntries, entries...)
			return make([]eventBridgeResult, len(entries)), 0
		},
	)
	event := S3ObjectEvent{Bucket: "b", BucketARN: "arn:aws:s3:::b", Key: "incoming/a.json",
		EventName: s3RecordObjectCreatedPut, ConfigurationID: "cfg", Size: 1, ETag: "e",
		Sequencer: "01", Time: time.Now(), Reason: s3ReasonPutObject}
	require.NoError(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: notificationDestinationFunction, Destination: "Fn"}, event))
	require.Equal(t, []string{"Fn"}, invoked)
	require.NoError(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: notificationDestinationQueue, Destination: "Queue"}, event))
	require.Len(t, queueBodies, 1)
	require.NoError(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: notificationDestinationTopic, Destination: "Topic"}, event))
	require.Len(t, snsBodies, 1)
	require.NoError(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: notificationDestinationEventBridge, Destination: "b"}, event))
	require.Len(t, busEntries, 1)
	require.Equal(t, "aws.s3", busEntries[0].Source)
	require.Error(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: "unknown"}, event))
	require.Error(t, supervisor.deliver(context.Background(), NotificationSpec{
		DestinationType: notificationDestinationQueue, Destination: "Missing"}, event))
}

func TestS3NotificationDelivererSendsTestEvents(t *testing.T) {
	var queueBodies, snsBodies []string
	supervisor := newS3NotificationSupervisor(RealClock{}, nil, nil,
		func(id string) (resourceValue, bool) {
			if id == "Queue" {
				return resourceValue{Type: typeSQSQueue, URL: "http://sqs/q"}, true
			}
			return resourceValue{Type: typeSNSTopic, ARN: "arn:aws:sns:us-east-1:123456789012:t"}, true
		},
		nil,
		func(_ context.Context, _ string, body []byte) error {
			queueBodies = append(queueBodies, string(body))
			return nil
		},
		func(_ context.Context, _ string, message LocalSNSMessage) error {
			snsBodies = append(snsBodies, message.Message)
			return nil
		},
		nil,
	)
	watcher := &s3BucketWatcher{bucket: "Bucket", name: "b", known: map[string]s3ObjectState{}}
	queueReporter := &recordingDeliveryReporter{}
	topicReporter := &recordingDeliveryReporter{}
	functionReporter := &recordingDeliveryReporter{}
	watcher.destinations = []*s3Destination{
		{spec: NotificationSpec{DestinationType: notificationDestinationQueue, Destination: "Queue"}, state: queueReporter},
		{spec: NotificationSpec{DestinationType: notificationDestinationTopic, Destination: "Topic"}, state: topicReporter},
		{spec: NotificationSpec{DestinationType: notificationDestinationFunction, Destination: "Fn"}, state: functionReporter},
	}
	supervisor.sendTestEvents(context.Background(), watcher)
	require.Len(t, queueBodies, 1)
	require.Len(t, snsBodies, 1)
	require.Contains(t, queueBodies[0], "s3:TestEvent")
}

func TestS3NotificationRegisterRejectsAndStarts(t *testing.T) {
	supervisor := newS3NotificationSupervisor(RealClock{}, nil, nil, nil, nil, nil, nil, nil)
	require.Error(t, supervisor.register(context.Background(), NotificationSpec{}, &recordingDeliveryReporter{}))
	server := httptest.NewServer(&fakeS3Bucket{})
	defer server.Close()
	supervisor = newS3NotificationSupervisor(RealClock{}, nil,
		func() (*s3.Client, error) { return newS3Client(server.URL), nil },
		nil, nil, nil, nil, nil)
	supervisor.interval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	reporter := &recordingDeliveryReporter{}
	require.NoError(t, supervisor.register(ctx, NotificationSpec{
		LogicalID: "n", Bucket: "Bucket", BucketName: "b", DestinationType: notificationDestinationFunction}, reporter))
	// A second destination on the same bucket does not start another watcher.
	require.NoError(t, supervisor.register(ctx, NotificationSpec{
		LogicalID: "n2", Bucket: "Bucket", BucketName: "b", DestinationType: notificationDestinationFunction}, reporter))
	cancel()
}

func TestS3NotificationDelivererStartStopsOnContext(t *testing.T) {
	supervisor := newS3NotificationSupervisor(RealClock{}, nil, nil, nil, nil, nil, nil, nil)
	_, err := NewS3NotificationDeliverer(DeliverySource{}, supervisor)
	require.Error(t, err)
	_, err = NewS3NotificationDeliverer(DeliverySource{Notification: &NotificationSpec{}}, nil)
	require.Error(t, err)
	server := httptest.NewServer(&fakeS3Bucket{})
	defer server.Close()
	supervisor = newS3NotificationSupervisor(RealClock{}, nil,
		func() (*s3.Client, error) { return newS3Client(server.URL), nil }, nil, nil, nil, nil, nil)
	supervisor.interval = time.Hour
	deliverer, err := NewS3NotificationDeliverer(DeliverySource{
		ID: "n", Notification: &NotificationSpec{Bucket: "Bucket", BucketName: "b", DestinationType: notificationDestinationFunction},
	}, supervisor)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	err = deliverer.Start(ctx, DelivererEnv{State: &recordingDeliveryReporter{}})
	require.ErrorIs(t, err, context.Canceled)
}

func TestResolveRouteAuthorizers(t *testing.T) {
	runner := &Runner{
		resourceValues: resourceValues{
			"Stack/Pool": {Type: typeCognitoUserPool, Name: "us-east-1_abc",
				ARN:         "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc",
				LocalIssuer: "http://127.0.0.1:1/cognito-idp/us-east-1/us-east-1_abc"},
		},
	}
	spec := &Spec{APIs: []APISpec{
		{Class: APIHTTPV2, LogicalID: "Api", Stack: "Stack", Routes: []Route{
			{Method: "GET", Path: "/jwt", AuthorizerKind: AuthorizerKindJWT,
				JWTIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc"},
			{Method: "GET", Path: "/literal", AuthorizerKind: AuthorizerKindJWT,
				JWTIssuer: "https://issuer.example"},
			{Method: "GET", Path: "/expression", AuthorizerKind: AuthorizerKindJWT,
				JWTIssuerExpression:    `{"Fn::Join":["",["https://cognito-idp.us-east-1.amazonaws.com/",{"Ref":"Pool"}]]}`,
				JWTAudienceExpressions: []string{`"client"`, `{"Ref":"Pool"}`}},
			{Method: "GET", Path: "/cognito", AuthorizerKind: AuthorizerKindCognito,
				CognitoPoolARNs: []string{`{"Fn::GetAtt":["Pool","Arn"]}`}},
		}},
	}}
	spec.Resources = []ResourceSpec{{Stack: "Stack", LogicalID: "Pool", Type: typeCognitoUserPool}}
	require.NoError(t, runner.resolveRouteAuthorizers(spec))
	routes := spec.APIs[0].Routes
	require.Equal(t, []string{"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc",
		"http://127.0.0.1:1/cognito-idp/us-east-1/us-east-1_abc"}, routes[0].AcceptedIssuers)
	require.Contains(t, routes[0].JWKSURL, "/.well-known/jwks.json")
	require.Equal(t, []string{"https://issuer.example"}, routes[1].AcceptedIssuers)
	require.Equal(t, "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", routes[2].JWTIssuer)
	require.Equal(t, []string{"client", "us-east-1_abc"}, routes[2].JWTAudience)
	require.Len(t, routes[3].AcceptedIssuers, 2)

	// An unknown pool fails closed.
	missing := &Spec{APIs: []APISpec{{LogicalID: "Api", Stack: "Stack", Routes: []Route{{
		AuthorizerKind: AuthorizerKindJWT,
		JWTIssuer:      "https://cognito-idp.us-east-1.amazonaws.com/unknown",
	}}}}}
	missing.Resources = spec.Resources
	require.Error(t, runner.resolveRouteAuthorizers(missing))
	badARN := &Spec{APIs: []APISpec{{LogicalID: "Api", Stack: "Stack", Routes: []Route{{
		AuthorizerKind: AuthorizerKindCognito, CognitoPoolARNs: []string{`"not-an-arn"`},
	}}}}}
	badARN.Resources = spec.Resources
	require.Error(t, runner.resolveRouteAuthorizers(badARN))
	noPool := &Spec{APIs: []APISpec{{LogicalID: "Api", Stack: "Stack", Routes: []Route{{
		AuthorizerKind: AuthorizerKindCognito, CognitoPoolARNs: []string{`"arn:aws:cognito-idp:us-east-1:123456789012:userpool/other"`},
	}}}}}
	noPool.Resources = spec.Resources
	require.Error(t, runner.resolveRouteAuthorizers(noPool))
}

func TestJWTVerifierRefusesECDSAAndKeyParsing(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	verifier := newJWTVerifier(clock, issuer)
	// An ES256 token is refused by name: only RSA-based algorithms are supported.
	token := key.tokenWithHeader(t, map[string]any{"alg": "ES256", "kid": key.kid}, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a", "exp": clock.Now().Add(time.Hour).Unix(),
	})
	_, err := verifier.verifyToken(context.Background(), token)
	require.Error(t, err)
	require.Contains(t, err.Error(), "RSA-based")

	// A JWK that is not an RSA key is not usable.
	_, err = parseJWK("EC", "kid", "ES256", "", "", "P-256", "AA", "AA")
	require.Error(t, err)
	_, err = parseJWK("oct", "kid", "", "", "", "", "", "")
	require.Error(t, err)
	require.Len(t, hashInput(crypto.SHA384, "x"), 48)
	require.Len(t, hashInput(crypto.SHA512, "x"), 64)
	require.Nil(t, hashInput(crypto.MD5, "x"))
}

func TestJWTVerifierRefreshFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "nope", http.StatusInternalServerError)
	}))
	defer server.Close()
	verifier := newJWTVerifier(RealClock{}, jwtIssuer{JWKSURL: server.URL})
	_, err := verifier.keys(context.Background())
	require.Error(t, err)
	empty := newJWTVerifier(RealClock{}, jwtIssuer{})
	_, err = empty.keys(context.Background())
	require.Error(t, err)
	badBody := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("not-json")) //nolint:errcheck // a fake JWKS server
	}))
	defer badBody.Close()
	_, err = newJWTVerifier(RealClock{}, jwtIssuer{JWKSURL: badBody.URL}).keys(context.Background())
	require.Error(t, err)
}
