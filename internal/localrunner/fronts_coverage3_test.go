package localrunner

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

// TestS3FrontDeleteObjectsBufferBoundary pins the buffer boundary: a body that
// fits is parsed and its SSE-S3 record cleared; one byte more is forwarded
// unchanged, because the v7.0.0 path accepted any body s3proxy accepted.
func TestS3FrontDeleteObjectsBufferBoundary(t *testing.T) {
	const (
		bucket = "bucket"
		key    = "at-the-boundary"
	)
	xmlBody := []byte(`<?xml version="1.0" encoding="UTF-8"?><Delete><Object><Key>` + key + `</Key></Object></Delete>`)
	for name, size := range map[string]int{
		"exactly the buffer": s3FrontMaxBody,
		"one byte above":     s3FrontMaxBody + 1,
	} {
		t.Run(name, func(t *testing.T) {
			backend := newFakeS3Proxy()
			front, server := newS3FrontForTest(t, "", backend)
			if err := front.index.set(bucket, key); err != nil {
				t.Fatalf("set the SSE-S3 record: %v", err)
			}
			body := append([]byte(nil), xmlBody...)
			body = append(body, bytes.Repeat([]byte(" "), size-len(body))...)
			request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+"/"+bucket+"?delete", bytes.NewReader(body))
			request.RequestURI = ""
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatalf("DeleteObjects: %v", err)
			}
			defer func() { _ = response.Body.Close() }() //nolint:errcheck // fixture
			if response.StatusCode != http.StatusOK {
				t.Fatalf("a %d-byte DeleteObjects body got status %d", size, response.StatusCode)
			}
			backend.mu.Lock()
			received := len(backend.lastDeleteBody)
			backend.mu.Unlock()
			if received != size {
				t.Fatalf("the backend received %d bytes, want %d", received, size)
			}
			if cleared := !front.index.has(bucket, key); cleared != (size == s3FrontMaxBody) {
				t.Fatalf("cleared=%v for a %d-byte body", cleared, size)
			}
		})
	}
}

// TestS3FrontStreamingPutRejected covers the re-sign refusal on ServeHTTP: a
// verified header-signed streaming put was signed over the SSE header the front
// must strip, and the chunk signatures cannot be replaced, so the front refuses
// it with 400 instead of forwarding a broken signature.
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
	payloadHash := "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if err := newS3Signer().SignHTTP(context.Background(), front.credentials, request, payloadHash, "s3", LocalRegion, time.Now().UTC()); err != nil {
		t.Fatalf("sign the streaming put: %v", err)
	}
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("streaming SSE put status %d", recorder.Code)
	}
}
