package localrunner

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// TestKMSFrontRemainingErrorPaths covers the branches the happy-path tests do
// not reach: unowned keys, missing aliases, foreign blobs and bad upstreams.
//
//nolint:govet // a table of short expected-error checks
func TestKMSFrontRemainingErrorPaths(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	signing := createOwnedKey(t, client, "Stack/Signing", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	symmetric := createOwnedKey(t, client, "Stack/Symmetric", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	hmac, err := client.CreateKey(ctx, &kms.CreateKeyInput{
		KeySpec: kmstypes.KeySpecHmac256, KeyUsage: kmstypes.KeyUsageTypeGenerateVerifyMac,
	})
	if err != nil {
		t.Fatalf("create HMAC key: %v", err)
	}

	// Unowned keys: every owned operation falls through to moto.
	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: hmac.KeyMetadata.KeyId, Message: []byte("x"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Sign on an unowned key was handled locally")
	}
	if _, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: hmac.KeyMetadata.KeyId, Plaintext: []byte("x")}); err == nil {
		t.Fatal("Encrypt on an unowned key was handled locally")
	}
	if _, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId: hmac.KeyMetadata.KeyId, KeySpec: kmstypes.DataKeySpecAes256,
	}); err == nil {
		t.Fatal("GenerateDataKey on an unowned key was handled locally")
	}
	if _, err := client.GenerateDataKeyWithoutPlaintext(ctx, &kms.GenerateDataKeyWithoutPlaintextInput{
		KeyId: hmac.KeyMetadata.KeyId, KeySpec: kmstypes.DataKeySpecAes256,
	}); err == nil {
		t.Fatal("GenerateDataKeyWithoutPlaintext on an unowned key was handled locally")
	}

	// Unknown aliases reach the moto DescribeKey error and return it.
	if _, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: aws.String("alias/missing")}); err == nil {
		t.Fatal("GetPublicKey on a missing alias succeeded")
	}
	if _, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String("alias/missing"), Plaintext: []byte("x")}); err == nil {
		t.Fatal("Encrypt on a missing alias succeeded")
	}
	if _, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId: aws.String("alias/missing"), Message: []byte("x"), Signature: []byte("y"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Verify on a missing alias succeeded")
	}

	// Verify on an ENCRYPT_DECRYPT key is refused.
	if _, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId: aws.String(symmetric), Message: []byte("x"), Signature: []byte("y"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Verify on an ENCRYPT_DECRYPT key succeeded")
	}

	// ReEncrypt: foreign source, invalid base64, unowned destination, a
	// tampered envelope and a destination that cannot take the source.
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(symmetric), Plaintext: []byte("x")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: []byte("foreign"), DestinationKeyId: aws.String(symmetric),
	}); err == nil {
		t.Fatal("ReEncrypt of a foreign blob succeeded")
	}
	tampered := append([]byte(kmsEnvelopeMagic), []byte("00000000-0000-4000-8000-000000000000")...)
	tampered = append(tampered, make([]byte, 64)...)
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: tampered, DestinationKeyId: aws.String(symmetric),
	}); err == nil {
		t.Fatal("ReEncrypt of a tampered envelope succeeded")
	}
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, DestinationKeyId: hmac.KeyMetadata.KeyId,
	}); err == nil {
		t.Fatal("ReEncrypt to an unowned key succeeded")
	}
	if _, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, DestinationKeyId: aws.String(signing),
	}); err == nil {
		t.Fatal("ReEncrypt to a signing key succeeded")
	}

	// Decrypt with the stable ARN the front reports is accepted.
	decrypted, err := client.Decrypt(ctx, &kms.DecryptInput{CiphertextBlob: encrypted.CiphertextBlob})
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if _, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: decrypted.KeyId,
	}); err != nil {
		t.Fatalf("decrypt with the reported key id: %v", err)
	}

	// Material helpers: ed25519 PKCS#8 and the other curves/sizes.
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519: %v", err)
	}
	_ = public
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatalf("ed25519 der: %v", err)
	}
	if _, err := parseKMSMaterial("RSA_2048", "SIGN_VERIFY", der); err == nil {
		t.Fatal("an ed25519 key was accepted as RSA")
	}
	for _, spec := range []string{"RSA_3072", "ECC_NIST_P384", "ECC_NIST_P521"} {
		if _, _, err := generateKMSMaterial(spec, "SIGN_VERIFY"); err != nil {
			t.Fatalf("generate %s: %v", spec, err)
		}
	}
	if _, err := sealKMSEnvelope("short", make([]byte, 32), []byte("x"), nil); err == nil {
		t.Fatal("a short stable id was sealed")
	}
	if _, err := sealKMSEnvelope(strings.Repeat("a", kmsStableIDLen), []byte("short"), []byte("x"), nil); err == nil {
		t.Fatal("a short key was sealed")
	}
	if _, err := newKMSFront("not a url", "", nil); err == nil {
		t.Fatal("an invalid KMS upstream was accepted")
	}
	if _, err := newS3Front("", "not a url", nil); err == nil {
		t.Fatal("an invalid S3 upstream was accepted")
	}
}

// TestKMSFrontCreateKeyVariants covers the CreateKey branches for unpinned
// origins, multi-region keys and a changed spec for a persisted identity.
func TestKMSFrontCreateKeyVariants(t *testing.T) {
	_, _, server := newFrontForTest(t, t.TempDir())
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	if _, err := client.CreateKey(ctx, &kms.CreateKeyInput{
		Origin: kmstypes.OriginTypeExternal,
	}); err != nil {
		t.Fatalf("external-origin create: %v", err)
	}
	if _, err := client.CreateKey(ctx, &kms.CreateKeyInput{
		MultiRegion: aws.Bool(true),
	}); err != nil {
		t.Fatalf("multi-region create: %v", err)
	}
	if _, err := client.CreateKey(ctx, &kms.CreateKeyInput{
		KeySpec: kmstypes.KeySpecRsa2048, KeyUsage: kmstypes.KeyUsageTypeSignVerify,
		Tags: []kmstypes.Tag{{TagKey: aws.String(kmsFrontIdentityTag), TagValue: aws.String("Stack/Stable")}},
	}); err != nil {
		t.Fatalf("tagged create: %v", err)
	}
	if _, err := client.CreateKey(ctx, &kms.CreateKeyInput{
		KeySpec: kmstypes.KeySpecSymmetricDefault, KeyUsage: kmstypes.KeyUsageTypeEncryptDecrypt,
		Tags: []kmstypes.Tag{{TagKey: aws.String(kmsFrontIdentityTag), TagValue: aws.String("Stack/Stable")}},
	}); err == nil {
		t.Fatal("a changed spec reused the persisted identity")
	}
}

// TestKMSFrontCorruptIndexes covers the S3 index's persistence failures.
func TestKMSFrontCorruptIndexes(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "s3sse"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, "s3sse", s3FrontIndexFile)
	for name, payload := range map[string]string{
		"invalid json":  "{",
		"wrong version": `{"version":2,"objects":[]}`,
	} {
		if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
			t.Fatalf("%s: write: %v", name, err)
		}
		if _, err := newS3SSEIndex(dir); err == nil {
			t.Fatalf("%s: a corrupt index was accepted", name)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove the corrupt index: %v", err)
	}
	index, err := newS3SSEIndex(dir)
	if err != nil {
		t.Fatalf("new index: %v", err)
	}
	if err := index.removeBucket("missing"); err != nil {
		t.Fatalf("remove missing bucket: %v", err)
	}
}

// TestS3FrontIndexErrors covers the index file write error.
func TestS3FrontIndexErrors(t *testing.T) {
	dir := t.TempDir()
	index, err := newS3SSEIndex(dir)
	if err != nil {
		t.Fatalf("new index: %v", err)
	}
	if err := os.Chmod(filepath.Join(dir, "s3sse"), 0o500); err != nil { //nolint:gosec // the test makes its own temp store unwritable
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "s3sse"), 0o700) }() //nolint:errcheck,gosec // restore for cleanup
	if err := index.set("bucket", "key"); err == nil {
		t.Fatal("the index wrote into a read-only directory")
	}
}
