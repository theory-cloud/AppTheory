package localrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDeriveS3CustomResourceErrors(t *testing.T) {
	base := func(properties map[string]any) map[string]any {
		return map[string]any{
			"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Bucket": map[string]any{"Type": typeS3Bucket},
			"Custom": map[string]any{"Type": typeBucketNotifications, "Properties": properties},
		}
	}
	cases := map[string]map[string]any{
		"bad bucket reference": {
			"BucketName": "not-a-ref",
			"NotificationConfiguration": map[string]any{
				"LambdaFunctionConfigurations": []any{map[string]any{
					"Events":            []any{"s3:ObjectCreated:*"},
					"LambdaFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				}},
			},
		},
		"unresolvable destination": {
			"BucketName": map[string]any{"Ref": "Bucket"},
			"NotificationConfiguration": map[string]any{
				"QueueConfigurations": []any{map[string]any{
					"Events":   []any{"s3:ObjectCreated:*"},
					"QueueArn": "arn:aws:sqs:us-east-1:123456789012:missing",
				}},
			},
		},
		"event without the prefix": {
			"BucketName": map[string]any{"Ref": "Bucket"},
			"NotificationConfiguration": map[string]any{
				"QueueConfigurations": []any{map[string]any{
					"Events":   []any{"ObjectCreated:Put"},
					"QueueArn": map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
				}},
			},
		},
	}
	for name, properties := range cases {
		t.Run(name, func(t *testing.T) {
			resources := base(properties)
			resources["Queue"] = map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "q"}}
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			require.Error(t, err)
		})
	}

	// A custom resource with no configuration is ignored.
	resources := base(map[string]any{"BucketName": map[string]any{"Ref": "Bucket"}})
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	require.NoError(t, err)
	require.Empty(t, spec.Notifications)
}

func TestWebSocketRouteWithoutARunningFunction(t *testing.T) {
	server := &WebSocketServer{API: testWebSocketAPI(), Invokers: map[string]Invoker{}, Clock: RealClock{}}
	connection := &webSocketConnection{
		id: "c", closeRequested: make(chan struct{}), conn: nil,
	}
	// The route exists, but no container does: the message is logged, not fatal.
	server.routeMessage(context.Background(), connection, `{"action":"chat"}`)
	server.routeMessage(context.Background(), connection, `{}`)
}

func TestWebSocketFrameTooLarge(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = listener.Close() }() //nolint:errcheck // test cleanup
	client, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", listener.Addr().String())
	require.NoError(t, err)
	server, err := listener.Accept()
	require.NoError(t, err)
	ws := newWSConn(server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)))
	// A 40 KB frame exceeds the documented 32 KB frame size.
	header := []byte{0x81, 0x80 | 126, 0x9C, 0x40} // 40000 bytes
	_, err = client.Write(append(header, 0, 0, 0, 0))
	require.NoError(t, err)
	_, _, err = ws.readMessage()
	require.Error(t, err)
	require.NoError(t, client.Close())
	require.NoError(t, server.Close())
}

func TestJWTKeySetWithoutUsableKeys(t *testing.T) {
	payload, err := json.Marshal(map[string]any{"keys": []any{map[string]any{"kty": "oct"}}})
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write(payload) //nolint:errcheck // a fake JWKS server
	}))
	defer server.Close()
	verifier := newJWTVerifier(RealClock{}, jwtIssuer{JWKSURL: server.URL})
	_, err = verifier.keys(context.Background())
	require.Error(t, err)
}
