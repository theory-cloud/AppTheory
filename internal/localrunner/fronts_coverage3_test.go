package localrunner

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// TestKMSFrontGetPublicKeyUpstreamError covers a moto key that disappeared and
// a malformed moto response.
//
//nolint:govet // a table of short expected-error checks
func TestKMSFrontGetPublicKeyUpstreamError(t *testing.T) {
	moto := newFakeMotoKMS()
	upstream := httptest.NewServer(moto)
	defer upstream.Close()
	front, err := newKMSFront("", upstream.URL, nil)
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	server := httptest.NewServer(front)
	defer server.Close()
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/Key", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	moto.mu.Lock()
	delete(moto.keys, kmsRawKeyID(keyID))
	moto.mu.Unlock()
	if _, err := client.GetPublicKey(context.Background(), &kms.GetPublicKeyInput{KeyId: aws.String(keyID)}); err == nil {
		t.Fatal("GetPublicKey succeeded after moto lost the key")
	}

	// A malformed success body reaches the decode branch.
	broken := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".GetPublicKey") {
			writer.Header().Set("Content-Type", kmsFrontJSONType)
			_, _ = writer.Write([]byte("not json")) //nolint:errcheck // fixture
			return
		}
		moto.ServeHTTP(writer, request)
	}))
	defer broken.Close()
	brokenFront, err := newKMSFront("", broken.URL, nil)
	if err != nil {
		t.Fatalf("new broken front: %v", err)
	}
	brokenServer := httptest.NewServer(brokenFront)
	defer brokenServer.Close()
	brokenClient := kmsClientFor(t, brokenServer.URL)
	brokenKey := createOwnedKey(t, brokenClient, "Stack/Broken", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if _, err := brokenClient.GetPublicKey(context.Background(), &kms.GetPublicKeyInput{KeyId: aws.String(brokenKey)}); err == nil {
		t.Fatal("a malformed GetPublicKey response was accepted")
	}
}

// TestKMSFrontReEncryptForwarding covers the forwarding branches.
func TestKMSFrontReEncryptForwarding(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	keyID := createOwnedKey(t, client, "Stack/Key", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: []byte("!!!"), DestinationKeyId: aws.String(keyID),
	}); err == nil {
		t.Fatal("an invalid base64 ReEncrypt succeeded")
	}
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(keyID), Plaintext: []byte("x")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, DestinationKeyId: aws.String("alias/missing"),
	}); err == nil {
		t.Fatal("ReEncrypt to a missing alias succeeded")
	}
}

// TestS3FrontBodyTooLarge covers the DeleteObjects body limit.
func TestS3FrontBodyTooLarge(t *testing.T) {
	backend := newFakeS3Proxy()
	upstream := httptest.NewServer(backend)
	defer upstream.Close()
	front, err := newS3Front("", upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	body := bytes.Repeat([]byte("x"), s3FrontMaxBody)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://front/bucket?delete", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized DeleteObjects status %d", recorder.Code)
	}
}

// TestS3FrontStreamingPutRejected covers the re-sign refusal on ServeHTTP.
func TestS3FrontStreamingPutRejected(t *testing.T) {
	backend := newFakeS3Proxy()
	upstream := httptest.NewServer(backend)
	defer upstream.Close()
	front, err := newS3Front("", upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/bucket/key?x-id=PutObject", strings.NewReader("x"))
	request.Header.Set(s3SSEAlgorithmHeader, "AES256")
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=dummy")
	request.Header.Set("X-Amz-Content-Sha256", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("streaming SSE put status %d", recorder.Code)
	}
}
