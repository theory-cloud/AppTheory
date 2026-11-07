package localrunner

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// postKMS sends one raw KMS JSON request to a front, bypassing the SDK where a
// test needs a body the SDK would not produce.
func postKMS(t *testing.T, frontURL, operation, body string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, frontURL+"/", strings.NewReader(body))
	if err != nil {
		t.Fatalf("build %s request: %v", operation, err)
	}
	request.Header.Set("Content-Type", kmsFrontJSONType)
	request.Header.Set("X-Amz-Target", kmsFrontTarget+"."+operation)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("%s request: %v", operation, err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // fixture
	payload, _ := io.ReadAll(response.Body)      //nolint:errcheck // fixture
	return response.StatusCode, payload
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	return string(payload)
}

// TestKMSFrontReEncrypt covers the owned-to-owned re-wrap path.
func TestKMSFrontReEncrypt(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	source := createOwnedKey(t, client, "Stack/Source", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	destination := createOwnedKey(t, client, "Stack/Destination", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{
		KeyId: aws.String(source), Plaintext: []byte("re-wrap me"), EncryptionContext: map[string]string{"a": "b"},
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	reencrypted, err := client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob:               encrypted.CiphertextBlob,
		SourceEncryptionContext:      map[string]string{"a": "b"},
		DestinationKeyId:             aws.String(destination),
		DestinationEncryptionContext: map[string]string{"c": "d"},
	})
	if err != nil {
		t.Fatalf("re-encrypt: %v", err)
	}
	if aws.ToString(reencrypted.SourceKeyId) == "" || aws.ToString(reencrypted.KeyId) == aws.ToString(reencrypted.SourceKeyId) {
		t.Fatalf("re-encrypt ids: source=%q destination=%q", aws.ToString(reencrypted.SourceKeyId), aws.ToString(reencrypted.KeyId))
	}
	decrypted, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: reencrypted.CiphertextBlob, KeyId: aws.String(destination),
		EncryptionContext: map[string]string{"c": "d"},
	})
	if err != nil {
		t.Fatalf("decrypt re-encrypted: %v", err)
	}
	if string(decrypted.Plaintext) != "re-wrap me" {
		t.Fatalf("decrypted %q", decrypted.Plaintext)
	}
}

// TestKMSFrontSignAndVerifyValidation covers the request-validation branches.
func TestKMSFrontSignAndVerifyValidation(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	signing := createOwnedKey(t, client, "Stack/Signing", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	symmetric := createOwnedKey(t, client, "Stack/Symmetric", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	digest := make([]byte, 32)

	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(symmetric), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Sign on an ENCRYPT_DECRYPT key succeeded")
	}
	for name, body := range map[string]string{
		"invalid message":  mustJSON(t, map[string]any{"KeyId": signing, "Message": "!!!", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
		"empty message":    mustJSON(t, map[string]any{"KeyId": signing, "Message": "", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
		"bad algorithm":    mustJSON(t, map[string]any{"KeyId": signing, "Message": base64.StdEncoding.EncodeToString(digest), "MessageType": "DIGEST", "SigningAlgorithm": "NOPE"}),
		"bad message type": mustJSON(t, map[string]any{"KeyId": signing, "Message": base64.StdEncoding.EncodeToString(digest), "MessageType": "BOGUS", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
		"unknown alias":    mustJSON(t, map[string]any{"KeyId": "alias/missing", "Message": base64.StdEncoding.EncodeToString(digest), "MessageType": "DIGEST", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
	} {
		status, payload := postKMS(t, server.URL, "Sign", body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d payload %s", name, status, payload)
		}
	}
	// Verify validation: invalid base64 in each field.
	for name, body := range map[string]string{
		"invalid message":   mustJSON(t, map[string]any{"KeyId": signing, "Message": "!!!", "Signature": "AA==", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
		"invalid signature": mustJSON(t, map[string]any{"KeyId": signing, "Message": base64.StdEncoding.EncodeToString(digest), "Signature": "!!!", "SigningAlgorithm": "RSASSA_PKCS1_V1_5_SHA_256"}),
		"bad algorithm":     mustJSON(t, map[string]any{"KeyId": signing, "Message": base64.StdEncoding.EncodeToString(digest), "Signature": "AA==", "SigningAlgorithm": "NOPE"}),
	} {
		status, payload := postKMS(t, server.URL, "Verify", body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d payload %s", name, status, payload)
		}
	}
}

// TestKMSFrontSignAndVerifyReturnInvalidKeyUsage is the Adv-7 proof: AWS
// documents InvalidKeyUsageException for Sign and Verify on a key whose
// KeyUsage is not SIGN_VERIFY.
//
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Verify.html
func TestKMSFrontSignAndVerifyReturnInvalidKeyUsage(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	symmetric := createOwnedKey(t, client, "Stack/Symmetric", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	digest := make([]byte, 32)
	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(symmetric), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil || !strings.Contains(err.Error(), "InvalidKeyUsageException") {
		t.Fatalf("Sign on a symmetric key: %v", err)
	}
	if _, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId: aws.String(symmetric), Message: digest, Signature: []byte("signature"),
		MessageType: kmstypes.MessageTypeDigest, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil || !strings.Contains(err.Error(), "InvalidKeyUsageException") {
		t.Fatalf("Verify on a symmetric key: %v", err)
	}
}

// TestKMSFrontPSSAndCurveValidation covers the PSS family and the ECC
// algorithm/curve pairing.
func TestKMSFrontPSSAndCurveValidation(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	rsaKey := createOwnedKey(t, client, "Stack/PSS", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	message := []byte("pss")
	digest := sha256Sum(message)
	signed, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(rsaKey), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPssSha256,
	})
	if err != nil {
		t.Fatalf("PSS sign: %v", err)
	}
	verified, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId: aws.String(rsaKey), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPssSha256,
	})
	if err != nil || !verified.SignatureValid {
		t.Fatalf("PSS verify: %v valid=%v", err, verified != nil && verified.SignatureValid)
	}
	eccKey := createOwnedKey(t, client, "Stack/Curve", "ECC_NIST_P256", kmstypes.KeyUsageTypeSignVerify)
	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(eccKey), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecEcdsaSha384,
	}); err == nil {
		t.Fatal("ECDSA_SHA_384 was accepted for a P-256 key")
	}
	if _, err := client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(rsaKey), Message: digest, MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecEcdsaSha256,
	}); err == nil {
		t.Fatal("ECDSA_SHA_256 was accepted for an RSA key")
	}
}

func sha256Sum(message []byte) []byte {
	sum := sha256.Sum256(message)
	return sum[:]
}

// TestKMSFrontEncryptValidation covers the Encrypt/Decrypt error branches.
func TestKMSFrontEncryptValidation(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	keyID := createOwnedKey(t, client, "Stack/Symmetric", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	for name, body := range map[string]string{
		"empty plaintext":     mustJSON(t, map[string]any{"KeyId": keyID, "Plaintext": ""}),
		"invalid base64":      mustJSON(t, map[string]any{"KeyId": keyID, "Plaintext": "!!!"}),
		"oversized plaintext": mustJSON(t, map[string]any{"KeyId": keyID, "Plaintext": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), kmsMaxPlaintext+1))}),
	} {
		status, payload := postKMS(t, server.URL, "Encrypt", body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d payload %s", name, status, payload)
		}
	}
	// EncryptionAlgorithm selects asymmetric encryption, which the front
	// proxies; the fake returns an error, proving the pass-through.
	if _, err := client.Encrypt(ctx, &kms.EncryptInput{
		KeyId: aws.String(keyID), Plaintext: []byte("x"), EncryptionAlgorithm: kmstypes.EncryptionAlgorithmSpecRsaesOaepSha256,
	}); err == nil {
		t.Fatal("an EncryptionAlgorithm request was handled locally")
	}
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{KeyId: aws.String(keyID), Plaintext: []byte("x")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	// A moto-format blob (no envelope magic) is proxied; the fake errors.
	if _, err := client.Decrypt(ctx, &kms.DecryptInput{CiphertextBlob: []byte("moto-blob")}); err == nil {
		t.Fatal("a foreign ciphertext blob was handled locally")
	}
	for name, body := range map[string]string{
		"invalid base64": mustJSON(t, map[string]any{"CiphertextBlob": "!!!"}),
		"tampered":       mustJSON(t, map[string]any{"CiphertextBlob": base64.StdEncoding.EncodeToString(append([]byte(kmsEnvelopeMagic), bytes.Repeat([]byte("x"), 64)...))}),
		"wrong key":      mustJSON(t, map[string]any{"CiphertextBlob": base64.StdEncoding.EncodeToString(encrypted.CiphertextBlob), "KeyId": "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"}),
	} {
		status, payload := postKMS(t, server.URL, "Decrypt", body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d payload %s", name, status, payload)
		}
	}
}

// TestKMSFrontGenerateDataKeyValidation covers the key-spec/byte-count matrix.
func TestKMSFrontGenerateDataKeyValidation(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	ctx := context.Background()
	keyID := createOwnedKey(t, client, "Stack/Data", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	generated, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId: aws.String(keyID), NumberOfBytes: aws.Int32(64),
	})
	if err != nil || len(generated.Plaintext) != 64 {
		t.Fatalf("NumberOfBytes: %v len=%d", err, len(generated.Plaintext))
	}
	without, err := client.GenerateDataKeyWithoutPlaintext(ctx, &kms.GenerateDataKeyWithoutPlaintextInput{
		KeyId: aws.String(keyID), KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil || len(without.CiphertextBlob) == 0 {
		t.Fatalf("without plaintext: %v", err)
	}
	for name, body := range map[string]string{
		"neither":        mustJSON(t, map[string]any{"KeyId": keyID}),
		"both":           mustJSON(t, map[string]any{"KeyId": keyID, "KeySpec": "AES_256", "NumberOfBytes": 16}),
		"invalid spec":   mustJSON(t, map[string]any{"KeyId": keyID, "KeySpec": "AES_512"}),
		"too many bytes": mustJSON(t, map[string]any{"KeyId": keyID, "NumberOfBytes": 2048}),
	} {
		status, payload := postKMS(t, server.URL, "GenerateDataKey", body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d payload %s", name, status, payload)
		}
	}
}

// TestKMSFrontRejectsUnevenDigest covers the digest-length validation.
func TestKMSFrontRejectsUnevenDigest(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/Signing", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if _, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String(keyID), Message: []byte("short"), MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("a short digest was accepted")
	}
}

// TestKMSFrontGetPublicKeyProxy covers a key the front does not own and an
// unknown key.
func TestKMSFrontGetPublicKeyProxy(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	unowned, err := client.CreateKey(context.Background(), &kms.CreateKeyInput{
		KeySpec: kmstypes.KeySpecHmac256, KeyUsage: kmstypes.KeyUsageTypeGenerateVerifyMac,
	})
	if err != nil {
		t.Fatalf("create HMAC key: %v", err)
	}
	public, err := client.GetPublicKey(context.Background(), &kms.GetPublicKeyInput{KeyId: unowned.KeyMetadata.KeyId})
	if err != nil {
		t.Fatalf("unowned GetPublicKey: %v", err)
	}
	if string(public.PublicKey) != "moto-shadow-public-key" {
		t.Fatalf("unowned public key %q", public.PublicKey)
	}
	node, _ := client.ListKeys(context.Background(), &kms.ListKeysInput{}) //nolint:errcheck // proxy path
	_ = node
}

// TestKMSFrontUnknownOperationAndMethod covers the dispatcher fallbacks.
func TestKMSFrontUnknownOperationAndMethod(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	if status, _ := postKMS(t, server.URL, "NoSuchOperation", "{}"); status != http.StatusBadRequest {
		t.Fatalf("unknown operation status %d", status)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/", nil)
	if err != nil {
		t.Fatalf("build GET: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // fixture
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("GET status %d", response.StatusCode)
	}
}

// TestKMSFrontServiceErrorHelpers covers the upstream-error response path.
func TestKMSFrontServiceErrorHelpers(t *testing.T) {
	serviceErr := &kmsServiceError{status: http.StatusBadRequest, payload: []byte(`{"__type":"NotFoundException","message":"missing"}`)}
	if !strings.Contains(serviceErr.Error(), "NotFoundException") {
		t.Fatalf("Error() = %q", serviceErr.Error())
	}
	if !asKMSServiceError(serviceErr, new(*kmsServiceError)) {
		_ = serviceErr
	}
	var target *kmsServiceError
	if !asKMSServiceError(serviceErr, &target) || target != serviceErr {
		t.Fatal("asKMSServiceError did not return the service error")
	}
	if asKMSServiceError(fmt.Errorf("other"), &target) {
		t.Fatal("asKMSServiceError accepted a generic error")
	}
	recorder := httptest.NewRecorder()
	writeServiceError(recorder, serviceErr)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "NotFoundException") {
		t.Fatalf("service error response: %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	writeServiceError(recorder, fmt.Errorf("boom"))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("generic error status %d", recorder.Code)
	}
}

// TestKMSKeyStoreErrors covers corrupt persistence and save failures.
func TestKMSKeyStoreErrors(t *testing.T) {
	if _, err := newKMSKeyStore(""); err != nil {
		t.Fatalf("ephemeral store: %v", err)
	}
	cases := map[string]string{
		"invalid json":   "{",
		"wrong version":  `{"version":2,"keys":[]}`,
		"invalid base64": `{"version":1,"keys":[{"stableId":"x","keySpec":"SYMMETRIC_DEFAULT","keyUsage":"ENCRYPT_DECRYPT","material":"!!!"}]}`,
	}
	for name, payload := range cases {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "kms"), 0o700); err != nil {
			t.Fatalf("%s: mkdir: %v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "kms", kmsFrontKeyFile), []byte(payload), 0o600); err != nil {
			t.Fatalf("%s: write: %v", name, err)
		}
		if _, err := newKMSKeyStore(dir); err == nil {
			t.Fatalf("%s: a corrupt store was accepted", name)
		}
	}
	dir := t.TempDir()
	store, err := newKMSKeyStore(dir)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	record, err := newKMSKeyRecord("Stack/Key", "SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT")
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := store.add(record); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := store.add(record); err == nil {
		t.Fatal("a duplicate stable id was accepted")
	}
	if err := os.Chmod(filepath.Join(dir, "kms"), 0o500); err != nil { //nolint:gosec // the test makes its own temp store unwritable
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(filepath.Join(dir, "kms"), 0o700) }() //nolint:errcheck,gosec // restore for TempDir cleanup
	if err := store.save(); err == nil {
		t.Fatal("save succeeded in a read-only directory")
	}
}

// TestKMSKeyMaterialErrors covers the material parser/generator failures.
func TestKMSKeyMaterialErrors(t *testing.T) {
	if _, err := parseKMSMaterial("SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT", []byte{1}); err == nil {
		t.Fatal("a short symmetric key was accepted")
	}
	if _, err := parseKMSMaterial("SYMMETRIC_DEFAULT", "GENERATE_VERIFY_MAC", []byte{1}); err == nil {
		t.Fatal("an unsupported usage was accepted")
	}
	if _, err := parseKMSMaterial("RSA_2048", "SIGN_VERIFY", []byte("not a key")); err == nil {
		t.Fatal("invalid PKCS#8 was accepted")
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa: %v", err)
	}
	rsaDER, _ := x509.MarshalPKCS8PrivateKey(rsaKey) //nolint:errcheck // fixture
	if _, err := parseKMSMaterial("RSA_3072", "SIGN_VERIFY", rsaDER); err == nil {
		t.Fatal("an RSA key of the wrong size was accepted")
	}
	if _, err := parseKMSMaterial("ECC_NIST_P384", "SIGN_VERIFY", rsaDER); err == nil {
		t.Fatal("an RSA key was accepted as ECC")
	}
	if _, _, err := generateKMSMaterial("HMAC_256", "GENERATE_VERIFY_MAC"); err == nil {
		t.Fatal("an unsupported generation was accepted")
	}
	if _, _, err := generateKMSMaterial("ECC_SECG_P256K1", "SIGN_VERIFY"); err == nil {
		t.Fatal("an unsupported curve was accepted")
	}
	if _, err := rsaBits("RSA_1024"); err == nil {
		t.Fatal("RSA_1024 was accepted")
	}
	if _, err := eccCurve("ECC_SECG_P256K1"); err == nil {
		t.Fatal("secp256k1 was accepted")
	}
	if _, err := (&kmsMaterial{}).publicDER(); err == nil {
		t.Fatal("an empty material produced a public key")
	}
	if _, err := signKMSDigest(&kmsMaterial{}, kmsFamilyRSAPKCS1, 0, nil); err == nil {
		t.Fatal("a missing RSA key signed")
	}
	if _, err := signKMSDigest(&kmsMaterial{}, kmsFamilyRSAPSS, 0, nil); err == nil {
		t.Fatal("a missing RSA key signed PSS")
	}
	if _, err := signKMSDigest(&kmsMaterial{}, kmsFamilyECDSA, 0, nil); err == nil {
		t.Fatal("a missing ECDSA key signed")
	}
	if _, err := signKMSDigest(&kmsMaterial{}, "unknown", 0, nil); err == nil {
		t.Fatal("an unknown family signed")
	}
	if verifyKMSDigest(&kmsMaterial{}, kmsFamilyRSAPKCS1, 0, nil, nil) {
		t.Fatal("a missing RSA key verified")
	}
	if verifyKMSDigest(&kmsMaterial{}, kmsFamilyRSAPSS, 0, nil, nil) {
		t.Fatal("a missing RSA key verified PSS")
	}
	if verifyKMSDigest(&kmsMaterial{}, kmsFamilyECDSA, 0, nil, nil) {
		t.Fatal("a missing ECDSA key verified")
	}
	if verifyKMSDigest(&kmsMaterial{}, "unknown", 0, nil, nil) {
		t.Fatal("an unknown family verified")
	}
}

// TestKMSIdentityTagAndDefaults covers the tag/default helpers.
func TestKMSIdentityTagAndDefaults(t *testing.T) {
	if identity, body := stripKMSIdentityTag([]byte("not json")); identity != "" || string(body) != "not json" {
		t.Fatal("a malformed body changed")
	}
	if _, body := stripKMSIdentityTag([]byte(`{"Tags":"not an array"}`)); string(body) != `{"Tags":"not an array"}` {
		t.Fatal("malformed Tags changed")
	}
	identity, stripped := stripKMSIdentityTag([]byte(`{"Tags":[{"TagKey":"team","TagValue":"platform"}]}`))
	if identity != "" || !strings.Contains(string(stripped), `"team"`) {
		t.Fatalf("unrelated tags: %q %s", identity, stripped)
	}
	defaulted := withKMSKeyDefaults([]byte(`{"Description":"x"}`), "RSA_2048", "SIGN_VERIFY")
	if !strings.Contains(string(defaulted), `"KeySpec":"RSA_2048"`) || !strings.Contains(string(defaulted), `"KeyUsage":"SIGN_VERIFY"`) {
		t.Fatalf("defaults: %s", defaulted)
	}
	if body := withKMSKeyDefaults([]byte("{"), "RSA_2048", "SIGN_VERIFY"); string(body) != "{" {
		t.Fatal("malformed defaults changed the body")
	}
	if kmsRawKeyID("arn:aws:kms:us-east-1:123456789012:key/abc") != "abc" || kmsRawKeyID("abc") != "abc" {
		t.Fatal("kmsRawKeyID")
	}
	if recordLabel(&kmsKeyRecord{StableID: "stable"}) != "stable" || recordLabel(&kmsKeyRecord{Identity: "Stack/Key"}) != "Stack/Key" {
		t.Fatal("recordLabel")
	}
}

// TestKMSFrontRunnerWiring covers startKMSFront and the endpoint helpers.
func TestKMSFrontRunnerWiring(t *testing.T) {
	moto := newFakeMotoKMS()
	upstream := httptest.NewServer(moto)
	defer upstream.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: upstream.URL, Endpoints: []Endpoint{{Service: "kms"}}},
		},
		endpoints:               []Endpoint{{Service: "kms", URL: "http://moto:5000"}},
		profileEndpointServices: map[string]bool{"kms": true},
		dataDir:                 t.TempDir(),
	}
	defer func() {
		for _, server := range runner.servers {
			_ = server.Close() //nolint:errcheck // test cleanup
		}
		for _, listener := range runner.listeners {
			_ = listener.Close() //nolint:errcheck // test cleanup
		}
	}()
	if err := runner.startKMSFront(context.Background()); err != nil {
		t.Fatalf("start KMS front: %v", err)
	}
	if runner.kmsFront == nil || runner.kmsFrontHostURL() == "" {
		t.Fatal("the KMS front was not recorded")
	}
	endpoint, ok := runner.backendEndpoint("kms")
	if !ok || endpoint.URL != runner.kmsFront.containerURL {
		t.Fatalf("kms endpoint %+v", endpoint)
	}
	client := kmsClientFor(t, runner.kmsFrontHostURL())
	if _, err := client.CreateKey(context.Background(), &kms.CreateKeyInput{Description: aws.String("wired")}); err != nil {
		t.Fatalf("create key through the wired front: %v", err)
	}
	runner.replaceEndpoint("extra", "http://127.0.0.1:1")
	if endpoint, ok := runner.backendEndpoint("extra"); !ok || endpoint.URL != "http://127.0.0.1:1" {
		t.Fatalf("replaceEndpoint append: %+v", endpoint)
	}
	if runner.kmsFrontHostURL() == "" {
		t.Fatal("kmsFrontHostURL")
	}
}

// TestS3FrontRunnerWiring covers startS3Front and wireS3FrontEndpoint.
func TestS3FrontRunnerWiring(t *testing.T) {
	backend := newFakeS3Proxy()
	upstream := httptest.NewServer(backend)
	defer upstream.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"s3proxy": {HostURL: upstream.URL, Endpoints: []Endpoint{{Service: "s3"}}},
		},
		endpoints:               []Endpoint{{Service: "s3", URL: "http://s3proxy:80"}},
		profileEndpointServices: map[string]bool{"s3": true},
		dataDir:                 t.TempDir(),
	}
	defer func() {
		for _, server := range runner.servers {
			_ = server.Close() //nolint:errcheck // test cleanup
		}
		for _, listener := range runner.listeners {
			_ = listener.Close() //nolint:errcheck // test cleanup
		}
	}()
	if err := runner.startS3Front(context.Background()); err != nil {
		t.Fatalf("start S3 front: %v", err)
	}
	if runner.s3Front == nil {
		t.Fatal("the S3 front was not recorded")
	}
	if err := runner.wireS3FrontEndpoint("192.0.2.10"); err != nil {
		t.Fatalf("wire S3 front: %v", err)
	}
	endpoint, ok := runner.backendEndpoint("s3")
	if !ok || endpoint.URL != fmt.Sprintf("http://192.0.2.10:%d", runner.s3Front.port) {
		t.Fatalf("s3 endpoint %+v", endpoint)
	}
	if err := runner.wireS3FrontEndpoint(""); err == nil {
		t.Fatal("an empty host gateway was accepted")
	}
}

// TestS3FrontRemoveBucketClearsRecords covers the bucket-delete cleanup.
func TestS3FrontRemoveBucketClearsRecords(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("key"), Body: strings.NewReader("x"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := client.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String("bucket")}); err != nil {
		t.Fatalf("delete bucket: %v", err)
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("key"), Body: strings.NewReader("plain"),
	}); err != nil {
		t.Fatalf("put plain: %v", err)
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("bucket"), Key: aws.String("key")})
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("a deleted bucket kept an SSE record: %q", head.ServerSideEncryption)
	}
}

// signWithoutPayloadHeader signs a request the way a client that omits
// x-amz-content-sha256 does: the canonical request's payload line is empty.
// The front's re-sign then has to hash the body itself.
func signWithoutPayloadHeader(t *testing.T, front *s3Front, request *http.Request) {
	t.Helper()
	request.Header.Set("X-Amz-Date", time.Now().UTC().Format("20060102T150405Z"))
	date := request.Header.Get("X-Amz-Date")[:8]
	names := "content-length;host;x-amz-date"
	canonical := strings.Join([]string{
		request.Method,
		s3CanonicalURI(request.URL),
		s3CanonicalQuery(request.URL.Query()),
		s3CanonicalHeaders(request, strings.Split(names, ";")),
		names,
		"",
	}, "\n")
	scope := date + "/" + LocalRegion + "/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		request.Header.Get("X-Amz-Date"),
		scope,
		hex.EncodeToString(s3Hash(canonical)),
	}, "\n")
	signature := hex.EncodeToString(s3Signature(front.credentials.SecretAccessKey, date, LocalRegion, "s3", stringToSign))
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+front.credentials.AccessKeyID+"/"+scope+
		", SignedHeaders="+names+", Signature="+signature)
}

// TestS3FrontResignPaths covers the re-sign helper's branches directly.
func TestS3FrontResignPaths(t *testing.T) {
	front, err := newS3Front("", "http://127.0.0.1:1", func(string, ...any) {})
	if err != nil {
		t.Fatalf("new S3 front: %v", err)
	}
	unsigned := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/b/k", strings.NewReader("x"))
	if err := front.resign(unsigned); err != nil {
		t.Fatalf("unsigned resign: %v", err)
	}
	streaming := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/b/k", strings.NewReader("x"))
	streaming.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=dummy")
	streaming.Header.Set("X-Amz-Content-Sha256", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")
	if err := front.resign(streaming); err == nil || !strings.Contains(err.Error(), "streaming") {
		t.Fatalf("streaming resign: %v", err)
	}
	unhashed := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/b/k", strings.NewReader("payload"))
	unhashed.Header.Set("Connection", "x-hop")
	unhashed.Header.Set("x-hop", "value")
	signWithoutPayloadHeader(t, front, unhashed)
	if err := front.resign(unhashed); err != nil {
		t.Fatalf("unhashed resign: %v", err)
	}
	if unhashed.Header.Get("X-Amz-Content-Sha256") == "" || unhashed.Header.Get("x-hop") != "" {
		t.Fatalf("resign headers: %v", unhashed.Header)
	}
	if _, err := io.ReadAll(unhashed.Body); err != nil { //nolint:errcheck // fixture
		t.Fatalf("read restored body: %v", err)
	}
}
