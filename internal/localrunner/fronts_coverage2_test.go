package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// TestKMSFrontUpstreamDown covers the upstream-error paths: proxy, forward,
// CreateKey, GetPublicKey and alias resolution.
func TestKMSFrontUpstreamDown(t *testing.T) {
	moto := newFakeMotoKMS()
	upstream := httptest.NewServer(moto)
	front, err := newKMSFront("", upstream.URL, nil)
	if err != nil {
		t.Fatalf("new front: %v", err)
	}
	server := httptest.NewServer(front)
	defer server.Close()
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/Key", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	upstream.Close()

	ctx := context.Background()
	if _, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: aws.String(keyID)}); err == nil {
		t.Fatal("GetPublicKey succeeded with the upstream down")
	}
	if _, err := client.CreateKey(ctx, &kms.CreateKeyInput{}); err == nil {
		t.Fatal("CreateKey succeeded with the upstream down")
	}
	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String("alias/down"), Message: []byte("x"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Sign with an alias succeeded with the upstream down")
	}
	if status, _ := postKMS(t, server.URL, "NoSuchOperation", "{}"); status != http.StatusInternalServerError {
		t.Fatalf("forward with the upstream down: status %d", status)
	}
}

// TestKMSFrontWriteJSONError covers the marshal-error branch.
func TestKMSFrontWriteJSONError(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeKMSJSON(recorder, make(chan int))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("marshal error status %d", recorder.Code)
	}
}

// TestKMSFrontMaterialParseSuccess covers the parser's success branches.
func TestKMSFrontMaterialParseSuccess(t *testing.T) {
	for _, spec := range []string{"RSA_2048", "ECC_NIST_P256", "ECC_NIST_P384", "ECC_NIST_P521"} {
		_, raw, err := generateKMSMaterial(spec, "SIGN_VERIFY")
		if err != nil {
			t.Fatalf("generate %s: %v", spec, err)
		}
		material, err := parseKMSMaterial(spec, "SIGN_VERIFY", raw)
		if err != nil || material == nil {
			t.Fatalf("parse %s: %v", spec, err)
		}
		if _, err := material.publicDER(); err != nil {
			t.Fatalf("public %s: %v", spec, err)
		}
	}
	if _, err := newKMSKeyRecord("", "HMAC_256", "GENERATE_VERIFY_MAC"); err == nil {
		t.Fatal("an unsupported record was created")
	}
	if _, err := parseKMSMaterial("RSA_2048", "SIGN_VERIFY", []byte("bad")); err == nil {
		t.Fatal("bad PKCS#8 was accepted")
	}
}

// TestOpenKMSEnvelopeErrors covers the short-blob and bad-key branches.
func TestOpenKMSEnvelopeErrors(t *testing.T) {
	if _, _, err := openKMSEnvelope([]byte("short"), nil, func(string) []byte { return nil }); err == nil {
		t.Fatal("a short envelope was opened")
	}
	blob := make([]byte, len(kmsEnvelopeMagic)+kmsStableIDLen+12+16+1)
	copy(blob, kmsEnvelopeMagic)
	if _, _, err := openKMSEnvelope(blob, nil, func(string) []byte { return []byte("bad") }); err == nil {
		t.Fatal("a bad key length was accepted")
	}
	if _, _, err := openKMSEnvelope(blob, nil, func(string) []byte { return nil }); err == nil {
		t.Fatal("an unknown key was accepted")
	}
}

// TestKMSFrontNewCorruptStore covers newKMSFront and startKMSFront with a
// corrupt data directory.
func TestKMSFrontNewCorruptStore(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "kms"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "kms", kmsFrontKeyFile), []byte("{"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newKMSFront(dir, "http://127.0.0.1:1", nil); err == nil {
		t.Fatal("a corrupt store was accepted")
	}
	runner := &Runner{
		options:                 Options{Stdout: io.Discard},
		backends:                map[string]backendProcess{"moto": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "kms"}}}},
		endpoints:               []Endpoint{{Service: "kms", URL: "http://moto:5000"}},
		profileEndpointServices: map[string]bool{"kms": true},
		dataDir:                 dir,
	}
	if err := runner.startKMSFront(context.Background()); err == nil {
		t.Fatal("startKMSFront accepted a corrupt store")
	}
}

// TestS3FrontNewCorruptStore covers newS3Front and startS3Front with a corrupt
// data directory.
func TestS3FrontNewCorruptStore(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "s3sse"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "s3sse", s3FrontIndexFile), []byte("{"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newS3Front(dir, "http://127.0.0.1:1", nil); err == nil {
		t.Fatal("a corrupt index was accepted")
	}
	runner := &Runner{
		options:                 Options{Stdout: io.Discard},
		backends:                map[string]backendProcess{"s3proxy": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "s3"}}}},
		endpoints:               []Endpoint{{Service: "s3", URL: "http://s3proxy:80"}},
		profileEndpointServices: map[string]bool{"s3": true},
		dataDir:                 dir,
	}
	if err := runner.startS3Front(context.Background()); err == nil {
		t.Fatal("startS3Front accepted a corrupt index")
	}
}

// TestKMSFrontDecryptWithStableARN covers the stable-id lookup in resolveOwned.
//
//nolint:govet // a table of short expected-error checks
func TestKMSFrontDecryptWithStableARN(t *testing.T) {
	dir := t.TempDir()
	_, _, server := newFrontForTest(t, dir)
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/Stable", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(context.Background(), &kms.EncryptInput{KeyId: aws.String(keyID), Plaintext: []byte("x")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	payload, err := os.ReadFile(filepath.Join(dir, "kms", kmsFrontKeyFile)) //nolint:gosec // the path is the test temp dir
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	var file struct {
		Keys []struct {
			StableID string `json:"stableId"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(payload, &file); err != nil || len(file.Keys) != 1 {
		t.Fatalf("decode store: %v %+v", err, file)
	}
	stable := "arn:aws:kms:us-east-1:123456789012:key/" + file.Keys[0].StableID
	decrypted, err := client.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String(stable),
	})
	if err != nil || string(decrypted.Plaintext) != "x" {
		t.Fatalf("decrypt with the stable ARN: %v", err)
	}
	// A foreign ARN with the same suffix must not resolve to the front's
	// persisted key: AWS accepts a key ARN only for a key that exists in the
	// named account and Region, and moto never had the stable id.
	// https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#key-id
	for name, foreign := range map[string]string{
		"foreign region":    "arn:aws:kms:eu-west-1:123456789012:key/" + file.Keys[0].StableID,
		"foreign account":   "arn:aws:kms:us-east-1:999999999999:key/" + file.Keys[0].StableID,
		"foreign partition": "arn:aws-cn:kms:us-east-1:123456789012:key/" + file.Keys[0].StableID,
	} {
		if _, err := client.Decrypt(context.Background(), &kms.DecryptInput{
			CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String(foreign),
		}); err == nil {
			t.Fatalf("a %s ARN resolved to the local persisted key", name)
		}
	}
}

// TestS3FrontRecordWriteError covers the index write-error log path.
//
//nolint:govet // short error checks share the outer err
func TestS3FrontRecordWriteError(t *testing.T) {
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
	if err := os.Chmod(filepath.Join(dir, "s3sse"), 0o500); err != nil { //nolint:gosec // the test makes its own temp store unwritable
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "s3sse"), 0o700) }() //nolint:errcheck,gosec // restore for cleanup
	client := s3ClientFor(t, server.URL)
	put, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("x"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	})
	if err != nil || put.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("put with a failing index write: %v", err)
	}
}

// TestS3FrontSubresource covers the subresource helper.
func TestS3FrontSubresource(t *testing.T) {
	if !s3HasSubresource(url.Values{"acl": {"x"}}, "acl", "tagging") {
		t.Fatal("acl was not found")
	}
	if s3HasSubresource(url.Values{"x-id": {"PutObject"}}, "acl", "tagging") {
		t.Fatal("x-id matched a subresource")
	}
}
