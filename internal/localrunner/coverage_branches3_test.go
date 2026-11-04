package localrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fixtureMap returns a nested map from a test fixture.
func fixtureMap(t *testing.T, value any) map[string]any {
	t.Helper()
	nested, ok := value.(map[string]any)
	require.True(t, ok, "fixture value is %T, not a map", value)
	return nested
}

func TestDeriveWebSocketRefusals(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"Fn": withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Api": map[string]any{"Type": typeHTTPAPI, "Properties": map[string]any{
				"Name": "ws", "ProtocolType": "WEBSOCKET"}},
			"Stage": map[string]any{"Type": typeHTTPStage, "Properties": map[string]any{
				"ApiId": map[string]any{"Ref": "Api"}, "StageName": "dev"}},
			"Integ": map[string]any{"Type": typeHTTPIntegration, "Properties": map[string]any{
				"IntegrationType": "AWS_PROXY", "IntegrationUri": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
			"Route": map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{
				"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "$connect",
				"AuthorizationType": "NONE", "Target": map[string]any{"Ref": "Integ"}}},
		}
	}
	cases := map[string]func(map[string]any){
		"authorizer on a custom route": func(resources map[string]any) {
			resources["Auth"] = map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
				"AuthorizerType": "REQUEST", "AuthorizerUri": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}}
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["RouteKey"] = "chat"
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizationType"] = "CUSTOM"
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizerId"] = map[string]any{"Ref": "Auth"}
		},
		"jwt authorizer on $connect": func(resources map[string]any) {
			resources["Auth"] = map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
				"AuthorizerType": "JWT", "JwtConfiguration": map[string]any{"Issuer": "https://issuer.example"}}}
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizationType"] = "CUSTOM"
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizerId"] = map[string]any{"Ref": "Auth"}
		},
		"iam authorization": func(resources map[string]any) {
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizationType"] = "AWS_IAM"
		},
		"non-proxy integration": func(resources map[string]any) {
			fixtureMap(t, fixtureMap(t, resources["Integ"])["Properties"])["IntegrationType"] = "HTTP_PROXY"
		},
		"missing route key": func(resources map[string]any) {
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["RouteKey"] = ""
		},
		"authorizer id on a NONE route": func(resources map[string]any) {
			fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizerId"] = map[string]any{"Ref": "Missing"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			resources := base()
			mutate(resources)
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			require.Error(t, err)
		})
	}

	// A valid $connect authorizer is derived with its method ARN.
	resources := base()
	resources["Auth"] = map[string]any{"Type": typeHTTPAuthorizer, "Properties": map[string]any{
		"AuthorizerType": "REQUEST", "IdentitySource": []any{"$request.header.Authorization"},
		"AuthorizerUri": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}}
	fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizationType"] = "CUSTOM"
	fixtureMap(t, fixtureMap(t, resources["Route"])["Properties"])["AuthorizerId"] = map[string]any{"Ref": "Auth"}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	require.NoError(t, err)
	require.Len(t, spec.WebSockets, 1)
	api := spec.WebSockets[0]
	require.Equal(t, "dev", api.Stage)
	require.NotNil(t, api.Authorizer)
	require.Contains(t, api.Authorizer.MethodARN, "/dev/$connect")
	require.Equal(t, "$request.body.action", api.RouteSelectionExpression)
}

func TestDeriveAuthorizerRefusals(t *testing.T) {
	base := func(authorizer map[string]any) map[string]any {
		return map[string]any{
			"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Api":    map[string]any{"Type": typeHTTPAPI, "Properties": map[string]any{"ProtocolType": "HTTP"}},
			"Auth":   map[string]any{"Type": typeHTTPAuthorizer, "Properties": authorizer},
			"Integ":  map[string]any{"Type": typeHTTPIntegration, "Properties": map[string]any{"IntegrationType": "AWS_PROXY", "IntegrationUri": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
			"Route":  map[string]any{"Type": typeHTTPRoute, "Properties": map[string]any{"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "GET /", "AuthorizationType": "JWT", "AuthorizerId": map[string]any{"Ref": "Auth"}, "Target": map[string]any{"Ref": "Integ"}}},
			"Rest":   map[string]any{"Type": typeRESTAPI, "Properties": map[string]any{"Name": "r"}},
			"RestAu": map[string]any{"Type": typeRESTAuthorizer, "Properties": map[string]any{}},
		}
	}
	cases := map[string]map[string]any{
		"jwt without issuer":      {"AuthorizerType": "JWT"},
		"jwt with a non-http URL": {"AuthorizerType": "JWT", "JwtConfiguration": map[string]any{"Issuer": "ftp://issuer"}},
		"jwt with an empty issuer": {"AuthorizerType": "JWT",
			"JwtConfiguration": map[string]any{"Issuer": ""}},
		"unknown authorizer type": {"AuthorizerType": "SOMETHING"},
		"request without a function": {"AuthorizerType": "REQUEST",
			"AuthorizerUri": map[string]any{"Fn::GetAtt": []any{"Missing", "Arn"}}},
	}
	for name, authorizer := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeAssembly(t, base(authorizer))
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			require.Error(t, err)
		})
	}

	// An authorizer no method references is parsed but harmless.
	for name, authorizer := range map[string]map[string]any{
		"rest token":   {"Type": "TOKEN"},
		"rest cognito": {"Type": "COGNITO_USER_POOLS", "ProviderARNs": []any{"arn:aws:cognito-idp:us-east-1:123456789012:userpool/x"}},
	} {
		t.Run(name, func(t *testing.T) {
			resources := base(map[string]any{"AuthorizerType": "JWT", "JwtConfiguration": map[string]any{"Issuer": "https://issuer.example"}})
			resources["RestAu"] = map[string]any{"Type": typeRESTAuthorizer, "Properties": authorizer}
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			require.NoError(t, err)
		})
	}
	for name, authorizer := range map[string]map[string]any{
		"rest cognito no pool": {"Type": "COGNITO_USER_POOLS"},
		"rest no type":         {},
	} {
		t.Run(name, func(t *testing.T) {
			resources := base(map[string]any{"AuthorizerType": "JWT", "JwtConfiguration": map[string]any{"Issuer": "https://issuer.example"}})
			resources["RestAu"] = map[string]any{"Type": typeRESTAuthorizer, "Properties": authorizer}
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			require.Error(t, err)
		})
	}
}

func TestWebSocketBinaryAndContextClose(t *testing.T) {
	invoker := &recordingWebSocketInvoker{}
	server := &WebSocketServer{
		API:      testWebSocketAPI(),
		Invokers: map[string]Invoker{"Fn": invoker},
		Clock:    NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	httpServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		server.ServeHTTP(writer, request)
	}))
	defer httpServer.Close()

	conn, reader := dialTestWebSocket(t, httpServer.URL, nil, "")
	writeClientFrame(t, conn, wsOpcodeBinary, []byte{0x00, 0x01})
	opcode, payload := readServerFrame(t, reader)
	require.Equal(t, byte(wsOpcodeClose), opcode)
	require.Equal(t, wsCloseUnsupportedData, closeCodeOf(payload))
	require.NoError(t, conn.Close())

	// A message with no matching route and no $default is dropped, not fatal.
	api := testWebSocketAPI()
	api.Routes = []WebSocketRouteSpec{{RouteKey: webSocketConnect, Function: "Fn"}}
	server.API = api
	conn, _ = dialTestWebSocket(t, httpServer.URL, nil, "")
	writeClientFrame(t, conn, wsOpcodeText, []byte(`{}`))
	time.Sleep(50 * time.Millisecond)
	require.NoError(t, conn.Close())
}

func TestManagementPostToAClosedConnection(t *testing.T) {
	management, err := newWebSocketManagement(t.TempDir(), nil)
	require.NoError(t, err)
	server := httptest.NewServer(management)
	defer server.Close()
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = listener.Close() }() //nolint:errcheck // test cleanup
	client, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", listener.Addr().String())
	require.NoError(t, err)
	serverConn, err := listener.Accept()
	require.NoError(t, err)
	require.NoError(t, client.Close())
	require.NoError(t, serverConn.Close())
	ws := newWSConn(serverConn, bufio.NewReadWriter(bufio.NewReader(serverConn), bufio.NewWriter(serverConn)))
	management.register(&webSocketConnection{id: "gone", conn: ws, closeRequested: make(chan struct{})})
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		server.URL+"/@connections/gone", strings.NewReader("x"))
	require.NoError(t, err)
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	require.NoError(t, err)
	require.Equal(t, http.StatusGone, response.StatusCode)
	require.NoError(t, response.Body.Close())
	management.unregister("gone")
	_ = ws.conn.Close() //nolint:errcheck // test cleanup
}

func TestS3EventBridgeDeleteDetail(t *testing.T) {
	entry := s3EventBridgeEntry(S3ObjectEvent{
		Bucket: "b", BucketARN: "arn:aws:s3:::b", Key: "k", EventName: s3RecordObjectRemovedDelete,
		ETag: "e", Sequencer: "01", Time: time.Now(), Reason: s3ReasonDeleteObject,
	})
	require.Equal(t, "Object Deleted", entry.DetailType)
	var detail map[string]any
	require.NoError(t, json.Unmarshal([]byte(entry.Detail), &detail))
	require.Equal(t, "Permanently Deleted", detail["deletion-type"])
	object, ok := detail["object"].(map[string]any)
	require.True(t, ok)
	require.NotContains(t, object, "size")
	require.Equal(t, "e", object["etag"])
	// An empty event time falls back to the observation instant.
	record, err := BuildS3NotificationRecord(S3ObjectEvent{
		Bucket: "b", BucketARN: "arn:aws:s3:::b", Key: "k", EventName: s3RecordObjectRemovedDelete,
		ConfigurationID: "cfg", Now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	require.Contains(t, string(record), "2026-01-01T00:00:00.000Z")
}
