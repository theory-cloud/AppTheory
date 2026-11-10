package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// LOCAL-W3-M1 validation, sixth pass: the WebSocket handshake refusals, the S3
// front's adoption of a run-issued signature, and the REST CUSTOM authorizer
// route.

func TestWebSocketServerRefusesBadHandshakes(t *testing.T) {
	api := testWebSocketAPI()
	server := &WebSocketServer{
		API:      api,
		Invokers: map[string]Invoker{"Fn": lambdaTestInvoker{fn: func([]byte) ([]byte, error) { return nil, errors.New("boom") }}},
		Clock:    NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}

	// A plain GET is not an upgrade.
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("a plain GET must be 400, got %d", recorder.Code)
	}

	// A failed $connect integration is a 500 and the connection never opens.
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	for name, value := range map[string]string{
		"Connection":            "Upgrade",
		"Upgrade":               "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key":     "dGhlIHNhbXBsZSBub25jZQ==",
	} {
		request.Header.Set(name, value)
	}
	failed := httptest.NewRecorder()
	server.ServeHTTP(failed, request)
	if failed.Code != http.StatusInternalServerError {
		t.Fatalf("a failed $connect must be 500, got %d", failed.Code)
	}

	// A $connect that answers non-2xx also refuses the connection.
	server.Invokers["Fn"] = &recordingWebSocketInvoker{respond: func(map[string]any) LambdaResponse {
		return LambdaResponse{StatusCode: http.StatusForbidden}
	}}
	non2xx := httptest.NewRecorder()
	server.ServeHTTP(non2xx, withWebSocketHeaders())
	if non2xx.Code != http.StatusInternalServerError {
		t.Fatalf("a non-2xx $connect must be 500, got %d", non2xx.Code)
	}
}

func withWebSocketHeaders() *http.Request {
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)
	for name, value := range map[string]string{
		"Connection":            "Upgrade",
		"Upgrade":               "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key":     "dGhlIHNhbXBsZSBub25jZQ==",
	} {
		request.Header.Set(name, value)
	}
	return request
}

func TestS3FrontAdoptsARunIssuedSignature(t *testing.T) {
	front, err := newS3Front(t.TempDir(), "http://127.0.0.1:1", func(string, ...any) {})
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	record := iamCredentialRecord{
		AccessKeyID: "ISSUEDKEY", Secret: "secret", Account: LocalAccountID,
		PrincipalARN: "arn:aws:iam::" + LocalAccountID + ":role/caller",
		BaseARN:      "arn:aws:iam::" + LocalAccountID + ":role/caller",
	}
	front.issuedRecord = func(accessKey string) (iamCredentialRecord, bool) {
		if accessKey == record.AccessKeyID {
			return record, true
		}
		return iamCredentialRecord{}, false
	}

	now := time.Now()
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/bucket/key", strings.NewReader("body"))
	request.Host = "127.0.0.1"
	signed := signTestServiceRequest(t, request, record.AccessKeyID, record.Secret, "", "s3", now)
	adopted, err := front.adoptIssuedSignature(signed)
	if err != nil || !adopted {
		t.Fatalf("a run-issued signature must be adopted: %v %v", adopted, err)
	}
	if !strings.Contains(signed.Header.Get("Authorization"), front.credentials.AccessKeyID) {
		t.Fatalf("the request must be re-signed with the store identity: %s", signed.Header.Get("Authorization"))
	}

	// A tampered signature is refused by name.
	tampered := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/bucket/key", strings.NewReader("body"))
	tampered.Host = "127.0.0.1"
	signedTampered := signTestServiceRequest(t, tampered, record.AccessKeyID, "wrong", "", "s3", now)
	if _, err := front.adoptIssuedSignature(signedTampered); err == nil {
		t.Fatal("a tampered signature must be refused")
	}
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, signedTampered)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "SignatureDoesNotMatch") {
		t.Fatalf("the front must answer 403: %d %s", recorder.Code, recorder.Body.String())
	}

	// A request signed with another key is left to the store.
	other := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/bucket/key", strings.NewReader("body"))
	other.Header.Set("Authorization", sigV4Authorization("OTHER/20261108/us-east-1/s3/aws4_request", "host", "00"))
	if adopted, err := front.adoptIssuedSignature(other); adopted || err != nil {
		t.Fatalf("another key must be left alone: %v %v", adopted, err)
	}
	// An unsigned request is left alone too.
	unsigned := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/bucket/key", nil)
	if adopted, err := front.adoptIssuedSignature(unsigned); adopted || err != nil {
		t.Fatalf("an unsigned request must be left alone: %v %v", adopted, err)
	}

	// bodyForSignature reads the body only when no content hash is carried.
	withHash := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("body"))
	withHash.Header.Set(sigV4ContentHashHeader, "hash")
	if body := bodyForSignature(withHash); body != nil {
		t.Fatalf("a content hash means no body is read: %q", body)
	}
	withoutHash := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("body"))
	if body := bodyForSignature(withoutHash); string(body) != "body" {
		t.Fatalf("the body must be read and restored: %q", body)
	}

	// The store's unimplemented checksum headers are stripped before signing.
	checksummed := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("body"))
	checksummed.Header.Set("X-Amz-Sdk-Checksum-Algorithm", "CRC32")
	checksummed.Header.Set("X-Amz-Chunk-Encoding", "")
	stripUnimplementedStoreHeaders(checksummed)
	if checksummed.Header.Get("X-Amz-Sdk-Checksum-Algorithm") != "" {
		t.Fatal("the checksum header must be stripped")
	}
}

func TestRESTRouteCarriesACustomAuthorizer(t *testing.T) {
	resources := map[string]any{
		"Api": map[string]any{"Type": typeRESTAPI, "Properties": map[string]any{"Name": "rest"}},
		"Fn":  withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Auth": map[string]any{"Type": "AWS::ApiGateway::Authorizer", "Properties": map[string]any{
			"Name": "auth", "Type": "REQUEST", "RestApiId": map[string]any{"Ref": "Api"},
			"AuthorizerUri": map[string]any{"Fn::Join": []any{"", []any{
				"arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/",
				map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}, "/invocations",
			}}},
			"IdentitySource":               "method.request.header.Authorization",
			"AuthorizerResultTtlInSeconds": 300,
		}},
		"Resource": map[string]any{"Type": "AWS::ApiGateway::Resource", "Properties": map[string]any{
			"ParentId": map[string]any{"Fn::GetAtt": []any{"Api", "RootResourceId"}},
			"PathPart": "items", "RestApiId": map[string]any{"Ref": "Api"},
		}},
		"Method": map[string]any{"Type": "AWS::ApiGateway::Method", "Properties": map[string]any{
			"HttpMethod": "GET", "ResourceId": map[string]any{"Ref": "Resource"},
			"RestApiId": map[string]any{"Ref": "Api"}, "AuthorizationType": "CUSTOM",
			"AuthorizerId": map[string]any{"Ref": "Auth"},
			"Integration": map[string]any{
				"Type": "AWS_PROXY", "IntegrationHttpMethod": "POST",
				"Uri": map[string]any{"Fn::Join": []any{"", []any{
					"arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/",
					map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}, "/invocations",
				}}},
			},
		}},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	route := spec.APIs[0].Routes[0]
	if route.AuthorizerKind != AuthorizerKindLambdaRequest {
		t.Fatalf("a CUSTOM method must carry the Lambda authorizer: %+v", route)
	}
	if route.AuthorizerRESTType != "REQUEST" || route.Path != "/items" {
		t.Fatalf("the authorizer and path must be derived: %+v", route)
	}
	if route.AuthorizerCacheTTLSeconds != 300 {
		t.Fatalf("the cache TTL must be derived: %+v", route)
	}
}

func TestLambdaResponseStatusIsCarried(t *testing.T) {
	// A tiny guard on the helper the WebSocket rows use, so a change to the
	// encoded response shape fails here rather than in a container row.
	response, err := encodeTestLambdaResponse(http.StatusTeapot, "body")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(response, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["statusCode"] != float64(http.StatusTeapot) {
		t.Fatalf("the encoded status is %v", decoded["statusCode"])
	}
}
