package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTransportServeHTTPRefusesBadTokens(t *testing.T) {
	key := newJWTTestKey(t)
	issuer, closeServer := jwtTestIssuer(t, key)
	defer closeServer()
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	transport := jwtTransport(t, key, issuer, []string{"api/read"})
	transport.Clock = clock
	route := transport.API.Routes[0]
	route.Function = "Fn"
	transport.API.Routes[0] = route
	transport.Invokers = map[string]Invoker{"Fn": &recordingWebSocketInvoker{}}
	server := httptest.NewServer(transport)
	defer server.Close()

	// No token is 401 through the transport.
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/protected", nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, response.StatusCode)
	require.NoError(t, response.Body.Close())

	// A valid token without the scope is 403.
	token := key.token(t, map[string]any{
		"iss": issuer.Accepted[0], "aud": "client-a", "exp": clock.Now().Add(time.Hour).Unix(),
	})
	request, err = http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/protected", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+token)
	response, err = http.DefaultClient.Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	require.NoError(t, response.Body.Close())
}

func TestHijackUpgradeNeedsAHijacker(t *testing.T) {
	recorder := httptest.NewRecorder()
	_, _, err := hijackUpgrade(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil), "accept")
	require.Error(t, err)
}

func TestNotificationTargetFunctionName(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"Fn": {Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"named-fn"}`)},
	}}}
	target, err := resolveNotificationTarget(stack, map[string]string{"Fn": typeLambdaFunction},
		notificationDestinationFunction, json.RawMessage(`{"Fn::GetAtt":["Fn","Arn"]}`))
	require.NoError(t, err)
	require.Equal(t, "named-fn", target.value.Name)
	require.Contains(t, target.value.ARN, "function:named-fn")
}

func TestS3DeleteSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.Equal(t, http.MethodDelete, request.Method)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	session := &localSession{
		runner: &Runner{
			resourceValues: resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "b"}},
			backends: map[string]backendProcess{"s3": {
				HostURL:   server.URL,
				Endpoints: []Endpoint{{Service: "s3", URL: server.URL}},
			}},
		},
		spec: &Spec{Resources: []ResourceSpec{{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket}}},
	}
	result, err := session.s3Delete(context.Background(), sessionRequest{Bucket: "Bucket", ObjectKey: "k"})
	require.NoError(t, err)
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"deleted":true`)
	_, err = session.s3Delete(context.Background(), sessionRequest{Bucket: "Bucket"})
	require.Error(t, err)
}

func TestWebSocketUpgradeRefused(t *testing.T) {
	server := &WebSocketServer{API: testWebSocketAPI(), Invokers: map[string]Invoker{}, Clock: RealClock{}}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	// A plain GET is refused before any handler runs.
	response, err := http.Get(httpServer.URL) //nolint:noctx // a test request
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, response.StatusCode)
	require.Equal(t, "13", response.Header.Get("Sec-WebSocket-Version"))
	require.NoError(t, response.Body.Close())
}
