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
)

// TestKMSFrontCreateKeySaveError covers a CreateKey whose persistence write
// fails after moto created the key.
func TestKMSFrontCreateKeySaveError(t *testing.T) {
	dir := t.TempDir()
	moto := newFakeMotoKMS()
	upstream := httptest.NewServer(moto)
	defer upstream.Close()
	front, err := newKMSFront(dir, upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	server := httptest.NewServer(front)
	defer server.Close()
	if err := os.Chmod(filepath.Join(dir, "kms"), 0o500); err != nil { //nolint:gosec // the test makes its own temp store unwritable
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "kms"), 0o700) }() //nolint:errcheck,gosec // restore for cleanup
	client := kmsClientFor(t, server.URL)
	if _, err := client.CreateKey(context.Background(), &kms.CreateKeyInput{
		Tags: []kmstypes.Tag{{TagKey: aws.String(kmsFrontIdentityTag), TagValue: aws.String("Stack/Key")}},
	}); err == nil {
		t.Fatal("CreateKey succeeded with an unwritable store")
	}
}

// TestKMSFrontDescribeKeyMalformed covers the DescribeKey decode branch.
func TestKMSFrontDescribeKeyMalformed(t *testing.T) {
	moto := newFakeMotoKMS()
	broken := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".DescribeKey") {
			writer.Header().Set("Content-Type", kmsFrontJSONType)
			_, _ = writer.Write([]byte("not json")) //nolint:errcheck // fixture
			return
		}
		moto.ServeHTTP(writer, request)
	}))
	defer broken.Close()
	front, err := newKMSFront("", broken.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	server := httptest.NewServer(front)
	defer server.Close()
	client := kmsClientFor(t, server.URL)
	createOwnedKey(t, client, "Stack/Key", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if _, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String("alias/broken"), Message: []byte("x"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Sign with a malformed DescribeKey response succeeded")
	}
}

// TestKMSFrontServeHTTPBodyReadError covers a short read from the request body
// by closing it before the handler reads.
func TestKMSFrontServeHTTPBodyReadError(t *testing.T) {
	front, err := newKMSFront("", "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://front/", io.NopCloser(failingBodyReader{}))
	request.Header.Set("X-Amz-Target", kmsFrontTarget+".Sign")
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("body read error status %d", recorder.Code)
	}
}

type failingBodyReader struct{}

func (failingBodyReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
