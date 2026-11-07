package localrunner

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// TestKMSFrontCheapBranches covers the remaining deterministic front branches
// that the behavioral tests do not need to reach.
func TestKMSFrontCheapBranches(t *testing.T) {
	if kmsStringField([]byte("{"), "KeyId") != "" {
		t.Fatal("malformed JSON produced a field")
	}
	if _, _, err := kmsSigningAlgorithm("RSA_2048", "RSASSA_PKCS1_V1_5_SHA_1"); err == nil {
		t.Fatal("an unknown digest suffix was accepted")
	}
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	signing := createOwnedKey(t, client, "Stack/Signing", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if _, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId: aws.String("alias/missing"), KeySpec: kmstypes.DataKeySpecAes256,
	}); err == nil {
		t.Fatal("GenerateDataKey on a missing alias succeeded")
	}
	if _, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(signing), Plaintext: []byte("x")}); err == nil {
		t.Fatal("Encrypt on a signing key succeeded")
	}
	symmetric := createOwnedKey(t, client, "Stack/Symmetric", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(symmetric), Plaintext: []byte("x")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String("alias/missing"),
	}); err == nil {
		t.Fatal("Decrypt with a missing alias succeeded")
	}
	if _, err := newS3Front("", "http://127.0.0.1:1", nil); err != nil {
		t.Fatalf("S3 front without a logger: %v", err)
	}
}

// TestS3FrontCheapBranches covers the bucket-delete write error and a failing
// DeleteObjects body read.
func TestS3FrontCheapBranches(t *testing.T) {
	backend := newFakeS3Proxy()
	upstream := httptest.NewServer(backend)
	defer upstream.Close()
	dir := t.TempDir()
	front, err := newS3Front(dir, upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	server := httptest.NewServer(front)
	defer server.Close()
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("x"),
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := os.Chmod(filepath.Join(dir, "s3sse"), 0o500); err != nil { //nolint:gosec // the test makes its own temp store unwritable
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "s3sse"), 0o700) }() //nolint:errcheck,gosec // restore for cleanup
	if _, err := client.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String("b")}); err != nil {
		t.Fatalf("delete bucket with a failing index write: %v", err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://front/bucket?delete", io.NopCloser(failingBodyReader{}))
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("failing DeleteObjects body: status %d", recorder.Code)
	}
}
