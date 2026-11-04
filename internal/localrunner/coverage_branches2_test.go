package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// fakeSQS answers the SendMessage JSON protocol.
func fakeSQSMessageServer(t *testing.T, seen *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body) //nolint:errcheck // a fake server
		if message, ok := body["MessageBody"].(string); ok && seen != nil {
			*seen = append(*seen, request.URL.Path+" "+message)
		}
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		_, _ = writer.Write([]byte(`{"MessageId":"11111111-2222-3333-4444-555555555555"}`)) //nolint:errcheck // a fake server
	}))
}

func TestSendLocalSQS(t *testing.T) {
	runner := &Runner{}
	require.Error(t, runner.sendLocalSQS(context.Background(), "http://sqs:9324/123456789012/queue", []byte("x")))

	var seen []string
	server := fakeSQSMessageServer(t, &seen)
	defer server.Close()
	runner.backends = map[string]backendProcess{"sqs": {
		HostURL:   server.URL,
		Endpoints: []Endpoint{{Service: backendSQS, URL: "http://sqs:9324"}},
	}}
	require.NoError(t, runner.sendLocalSQS(
		context.Background(), "http://sqs:9324/123456789012/queue", []byte("body")))
	require.Len(t, seen, 1)
	require.Contains(t, seen[0], "body")
}

func TestStartWebSocketManagement(t *testing.T) {
	runner := &Runner{scratch: t.TempDir()}
	require.NoError(t, runner.startWebSocketManagement(context.Background(), &Spec{}))
	require.Nil(t, runner.webSocketManagement)
	require.NoError(t, runner.startWebSocketManagement(context.Background(), &Spec{
		WebSockets: []WebSocketAPISpec{{LogicalID: "Ws"}}}))
	require.NotNil(t, runner.webSocketManagement)
	runner.webSocketManagement.close()
	require.Error(t, (&Runner{scratch: "/nonexistent/path/for/test"}).startWebSocketManagement(
		context.Background(), &Spec{WebSockets: []WebSocketAPISpec{{LogicalID: "Ws"}}}))
}

// rawBytesInvoker returns fixed bytes, as a Lambda authorizer does.
type rawBytesInvoker []byte

func (i rawBytesInvoker) Invoke(_ context.Context, _ []byte) ([]byte, error) {
	return []byte(i), nil
}

func TestTransportAuthorizeDefaultKind(t *testing.T) {
	transport := &Transport{
		API:      APISpec{Class: APIHTTPV2, LogicalID: "Api"},
		Invokers: map[string]Invoker{"AuthFn": rawBytesInvoker(`{"isAuthorized":true,"context":{"tenant":"t"}}`)},
		Now:      time.Now,
	}
	route := Route{AuthorizerFunction: "AuthFn"}
	result, err := transport.authorize(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), route, nil, "/", nil, "req")
	require.NoError(t, err)
	require.Zero(t, result.Status)
	require.Equal(t, "t", result.Lambda["tenant"])

	// No authorizer at all is allowed and carries no context.
	result, err = transport.authorize(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), Route{}, nil, "/", nil, "req")
	require.NoError(t, err)
	require.Nil(t, result.Lambda)
}

func TestRouteTableRendering(t *testing.T) {
	spec := &Spec{
		APIs: []APISpec{
			{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default", Routes: []Route{
				{Method: "GET", Path: "/a", Function: "Fn", AuthorizerFunction: "Auth"},
				{Method: "GET", Path: "/b", Function: "Fn", AuthorizerKind: AuthorizerKindJWT, JWTIssuer: "https://issuer"},
				{Method: "GET", Path: "/c", Mock: &MockResponse{StatusCode: 204}},
				{Method: "GET", Path: "/d", Function: "Fn", AuthorizerKind: AuthorizerKindCognito},
			}},
		},
		WebSockets: []WebSocketAPISpec{{
			Class: APIWebSocket, LogicalID: "Ws", Stage: "dev", RouteSelectionExpression: "$request.body.action",
			Routes:     []WebSocketRouteSpec{{RouteKey: "$connect", Function: "Fn"}, {RouteKey: "$default", Function: "Fn", TwoWay: true}},
			Authorizer: &WebSocketAuthorizerSpec{Function: "Auth"},
		}},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Function: "Fn"}},
		CloudFront: []*localcloudfront.Distribution{{
			LogicalID: "Dist",
			DefaultBehavior: &localcloudfront.Behavior{
				TargetOriginID: "origin", ViewerRequestFunction: "fn",
			},
			CacheBehaviors: []*localcloudfront.Behavior{{PathPattern: "/api", TargetOriginID: "origin"}},
			Refusals:       []string{"signed URLs are not modeled"},
		}},
	}
	lines := strings.Join(RouteTable(spec), "\n")
	for _, want := range []string{"api httpv2", "authorizer=Auth", "authorizer=jwt issuer=https://issuer",
		"MOCK 204", "api websocket", "two-way", "$connect   authorizer", "api fnurl",
		"cloudfront Dist", "refused", "DEFAULT", "BEHAVIOR"} {
		require.Contains(t, lines, want)
	}
	require.Contains(t, lines, "authorizer=cognito-user-pools")
	require.Equal(t, []string{"Dist"}, []string{spec.CloudFront[0].LogicalID})
}

func TestDistributionHasFunctions(t *testing.T) {
	require.False(t, distributionHasFunctions(&localcloudfront.Distribution{}))
	require.True(t, distributionHasFunctions(&localcloudfront.Distribution{
		DefaultBehavior: &localcloudfront.Behavior{ViewerRequestFunction: "fn"}}))
	require.True(t, distributionHasFunctions(&localcloudfront.Distribution{
		CacheBehaviors: []*localcloudfront.Behavior{{ViewerResponseFunction: "fn"}}}))
}

func TestS3DeleteWithoutBackend(t *testing.T) {
	session := &localSession{
		runner: &Runner{resourceValues: resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "b"}}},
		spec:   &Spec{Resources: []ResourceSpec{{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket}}},
	}
	_, err := session.s3Delete(context.Background(), sessionRequest{Bucket: "Bucket", ObjectKey: "k"})
	require.Error(t, err)
	_, err = session.s3Delete(context.Background(), sessionRequest{Bucket: "Missing", ObjectKey: "k"})
	require.Error(t, err)
}

func TestQueueHelpers(t *testing.T) {
	require.Equal(t, 3, queueAttributeCount(map[string]string{"ApproximateNumberOfMessages": "3"}, "ApproximateNumberOfMessages"))
	require.Equal(t, 0, queueAttributeCount(map[string]string{"x": "y"}, "ApproximateNumberOfMessages"))
	require.Equal(t, int32(10), boundedInt32(50, 10))
	require.Equal(t, int32(0), boundedInt32(-1, 10))

	client := newSQSClient("http://127.0.0.1:1")
	require.NotNil(t, client)
	require.Equal(t, int32(3), *aws.Int32(3))
	var input sqs.SendMessageInput
	input.QueueUrl = aws.String("http://q")
	require.Equal(t, "http://q", *input.QueueUrl)
}
