package localrunner

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// fakeMotoKMS models the pinned moto behavior the front exists to correct: it
// ignores MessageType and would sign a DIGEST as if it were a raw message.
type fakeMotoKMS struct {
	mu           sync.Mutex
	next         int
	keys         map[string]fakeMotoKey
	aliases      map[string]string
	createBodies []map[string]any
	signCalls    int
	verifyCalls  int
	listCalls    int
}

type fakeMotoKey struct {
	arn   string
	spec  string
	usage string
}

var fakeMotoSequence atomic.Int64

func newFakeMotoKMS() *fakeMotoKMS {
	return &fakeMotoKMS{keys: map[string]fakeMotoKey{}, aliases: map[string]string{}}
}

func (f *fakeMotoKMS) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body := map[string]any{}
	_ = json.NewDecoder(request.Body).Decode(&body) //nolint:errcheck // a malformed body is the caller's test bug
	target := strings.TrimPrefix(request.Header.Get("X-Amz-Target"), kmsFrontTarget+".")
	f.mu.Lock()
	defer f.mu.Unlock()
	writer.Header().Set("Content-Type", kmsFrontJSONType)
	switch target {
	case "CreateKey":
		f.createBodies = append(f.createBodies, body)
		f.next++
		id := fmt.Sprintf("moto-key-%d-%d", fakeMotoSequence.Add(1), f.next)
		spec, _ := body["KeySpec"].(string)   //nolint:errcheck // fixture
		usage, _ := body["KeyUsage"].(string) //nolint:errcheck // fixture
		if spec == "" {
			spec = "SYMMETRIC_DEFAULT"
		}
		if usage == "" {
			usage = "ENCRYPT_DECRYPT"
		}
		key := fakeMotoKey{arn: "arn:aws:kms:us-east-1:123456789012:key/" + id, spec: spec, usage: usage}
		f.keys[id] = key
		writeJSONFixture(writer, map[string]any{"KeyMetadata": map[string]any{
			"KeyId": id, "Arn": key.arn, "KeySpec": spec, "KeyUsage": usage,
			"KeyManager": "CUSTOMER", "Origin": "AWS_KMS", "KeyState": "Enabled", "Enabled": true,
		}})
	case "CreateAlias":
		alias, _ := body["AliasName"].(string)       //nolint:errcheck // fixture
		targetKey, _ := body["TargetKeyId"].(string) //nolint:errcheck // fixture
		f.aliases[alias] = kmsRawKeyID(targetKey)
		writeJSONFixture(writer, nil)
	case "DescribeKey":
		id := f.resolve(body["KeyId"])
		key, ok := f.keys[id]
		if !ok {
			writeKMSFixtureError(writer, "NotFoundException", "Key does not exist")
			return
		}
		writeJSONFixture(writer, map[string]any{"KeyMetadata": map[string]any{
			"KeyId": id, "Arn": key.arn, "KeySpec": key.spec, "KeyUsage": key.usage,
			"KeyManager": "CUSTOMER", "Origin": "AWS_KMS", "KeyState": "Enabled", "Enabled": true,
		}})
	case "GetPublicKey":
		id := f.resolve(body["KeyId"])
		key, ok := f.keys[id]
		if !ok {
			writeKMSFixtureError(writer, "NotFoundException", "Key does not exist")
			return
		}
		writeJSONFixture(writer, map[string]any{
			"KeyId": id, "KeyUsage": key.usage, "CustomerMasterKeySpec": key.spec,
			"PublicKey": base64.StdEncoding.EncodeToString([]byte("moto-shadow-public-key")),
		})
	case "Sign":
		// Moto hashes the supplied message again; the front must not call this
		// for a key it owns.
		f.signCalls++
		writeKMSFixtureError(writer, "KMSInternalException", "the front must not delegate an owned signature to moto")
	case "Verify":
		f.verifyCalls++
		writeKMSFixtureError(writer, "KMSInternalException", "the front must not delegate an owned verification to moto")
	case "ListKeys":
		f.listCalls++
		writeJSONFixture(writer, map[string]any{"Keys": []any{}, "Truncated": false})
	case "GenerateRandom":
		writeJSONFixture(writer, map[string]any{"Plaintext": base64.StdEncoding.EncodeToString([]byte("random"))})
	default:
		writeKMSFixtureError(writer, "UnknownOperationException", target)
	}
}

func (f *fakeMotoKMS) resolve(raw any) string {
	value, _ := raw.(string) //nolint:errcheck // fixture
	if target, ok := f.aliases[value]; ok {
		return target
	}
	return kmsRawKeyID(value)
}

func writeJSONFixture(writer http.ResponseWriter, value any) {
	if value == nil {
		_, _ = writer.Write([]byte("{}")) //nolint:errcheck // fixture
		return
	}
	payload, _ := json.Marshal(value) //nolint:errcheck // fixture
	_, _ = writer.Write(payload)      //nolint:errcheck // fixture
}

func writeKMSFixtureError(writer http.ResponseWriter, code, message string) {
	writer.WriteHeader(http.StatusBadRequest)
	payload, _ := json.Marshal(map[string]string{"__type": code, "message": message}) //nolint:errcheck // fixture
	_, _ = writer.Write(payload)                                                      //nolint:errcheck // fixture
}

func kmsClientFor(t *testing.T, endpoint string) *kms.Client {
	t.Helper()
	return kms.New(kms.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(endpoint),
	})
}

func newFrontForTest(t *testing.T, dataDir string) (*kmsFront, *fakeMotoKMS, *httptest.Server) {
	t.Helper()
	moto := newFakeMotoKMS()
	upstream := httptest.NewServer(moto)
	t.Cleanup(upstream.Close)
	front, err := newKMSFront(dataDir, upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new KMS front: %v", err)
	}
	server := httptest.NewServer(front)
	t.Cleanup(server.Close)
	return front, moto, server
}

func createOwnedKey(t *testing.T, client *kms.Client, identity, spec string, usage kmstypes.KeyUsageType) string {
	t.Helper()
	input := &kms.CreateKeyInput{
		Description: aws.String("test key"),
		KeySpec:     kmstypes.KeySpec(spec),
		KeyUsage:    usage,
	}
	if identity != "" {
		input.Tags = []kmstypes.Tag{{
			TagKey:   aws.String(kmsFrontIdentityTag),
			TagValue: aws.String(identity),
		}}
	}
	created, err := client.CreateKey(context.Background(), input)
	if err != nil {
		t.Fatalf("create key: %v", err)
	}
	return aws.ToString(created.KeyMetadata.KeyId)
}

func publicKeyFromGet(t *testing.T, client *kms.Client, keyID string) crypto.PublicKey {
	t.Helper()
	response, err := client.GetPublicKey(context.Background(), &kms.GetPublicKeyInput{KeyId: aws.String(keyID)})
	if err != nil {
		t.Fatalf("get public key: %v", err)
	}
	public, err := x509.ParsePKIXPublicKey(response.PublicKey)
	if err != nil {
		t.Fatalf("parse public key: %v", err)
	}
	return public
}

// TestKMSFrontSignDigestSignsTheDigestAsIs is the check that caught the bug:
// the recovered PKCS#1 digest must equal sha256(message), not
// sha256(sha256(message)).
func TestKMSFrontSignDigestSignsTheDigestAsIs(t *testing.T) {
	_, moto, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/SigningKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)

	message := []byte("apptheory-digest-probe")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId:            aws.String(keyID),
		Message:          digest[:],
		MessageType:      kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign digest: %v", err)
	}
	public := publicKeyFromGet(t, client, keyID)
	rsaPublic, ok := public.(*rsa.PublicKey)
	if !ok {
		t.Fatalf("public key is %T, want RSA", public)
	}
	if err := rsa.VerifyPKCS1v15(rsaPublic, crypto.SHA256, digest[:], signed.Signature); err != nil {
		t.Fatalf("the signature is not over the supplied digest: %v", err)
	}
	// Recover the PKCS#1 digest and prove it is the single hash.
	recovered := rsaRecoveredDigest(t, rsaPublic, signed.Signature)
	if got, want := fmt.Sprintf("%x", recovered), fmt.Sprintf("%x", digest); got != want {
		t.Fatalf("recovered digest %s, want %s (the double hash would be %x)", got, want, sha256.Sum256(digest[:]))
	}
	if moto.signCalls != 0 {
		t.Fatalf("the front delegated an owned DIGEST signature to moto %d time(s)", moto.signCalls)
	}
}

// TestKMSFrontSignRawStillHashesTheMessage proves RAW keeps the v7.0.0
// behavior: the signature is over sha256(message).
func TestKMSFrontSignRawStillHashesTheMessage(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/RawKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)

	message := []byte("apptheory-raw-probe")
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId:            aws.String(keyID),
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign raw: %v", err)
	}
	public := publicKeyFromGet(t, client, keyID).(*rsa.PublicKey) //nolint:errcheck,forcetypeassert // fixture
	digest := sha256.Sum256(message)
	if verifyErr := rsa.VerifyPKCS1v15(public, crypto.SHA256, digest[:], signed.Signature); verifyErr != nil {
		t.Fatalf("the RAW signature is not over sha256(message): %v", verifyErr)
	}
	verified, err := client.Verify(context.Background(), &kms.VerifyInput{
		KeyId:            aws.String(keyID),
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		Signature:        signed.Signature,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil || !verified.SignatureValid {
		t.Fatalf("verify raw: valid=%v err=%v", verified != nil && verified.SignatureValid, err)
	}
}

// TestKMSFrontVerifyDigestRejectsTheDoubleHash proves Verify(DIGEST) checks
// the supplied digest, not a second hash of it.
func TestKMSFrontVerifyDigestRejectsTheDoubleHash(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/VerifyKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	message := []byte("verify-digest")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String(keyID), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	verified, err := client.Verify(context.Background(), &kms.VerifyInput{
		KeyId: aws.String(keyID), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil || !verified.SignatureValid {
		t.Fatalf("a valid digest signature was rejected: %v", err)
	}
	double := sha256.Sum256(digest[:])
	doubleVerified, err := client.Verify(context.Background(), &kms.VerifyInput{
		KeyId: aws.String(keyID), Message: double[:], MessageType: kmstypes.MessageTypeDigest,
		Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("verify double hash: %v", err)
	}
	if doubleVerified.SignatureValid {
		t.Fatal("the double hash verified; moto's bug is still in the path")
	}
	if _, err := client.Verify(context.Background(), &kms.VerifyInput{
		KeyId: aws.String(keyID), Message: []byte("short"), MessageType: kmstypes.MessageTypeDigest,
		Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("a digest of the wrong length was accepted")
	}
}

// TestKMSFrontECDSADigest covers the ECC signing algorithms.
func TestKMSFrontECDSADigest(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/EccKey", "ECC_NIST_P256", kmstypes.KeyUsageTypeSignVerify)
	message := []byte("ecdsa-digest")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String(keyID), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecEcdsaSha256,
	})
	if err != nil {
		t.Fatalf("sign ECDSA digest: %v", err)
	}
	public := publicKeyFromGet(t, client, keyID).(*ecdsa.PublicKey) //nolint:errcheck,forcetypeassert // fixture
	if !ecdsa.VerifyASN1(public, digest[:], signed.Signature) {
		t.Fatal("the ECDSA signature is not over the supplied digest")
	}
	double := sha256.Sum256(digest[:])
	if ecdsa.VerifyASN1(public, double[:], signed.Signature) {
		t.Fatal("the ECDSA signature verified over the double hash")
	}
}

func TestKMSFrontPersistsMaterialAcrossRestart(t *testing.T) {
	dataDir := t.TempDir()
	first, _, firstServer := newFrontForTest(t, dataDir)
	_ = first
	client := kmsClientFor(t, firstServer.URL)
	keyID := createOwnedKey(t, client, "Stack/DataKey", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(context.Background(), &kms.EncryptInput{
		KeyId: aws.String(keyID), Plaintext: []byte("persisted secret"),
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	generated, err := client.GenerateDataKey(context.Background(), &kms.GenerateDataKeyInput{
		KeyId: aws.String(keyID), KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		t.Fatalf("generate data key: %v", err)
	}
	signingID := createOwnedKey(t, client, "Stack/SigningKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	message := []byte("stable across restarts")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String(signingID), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	firstPublic := publicKeyFromGet(t, client, signingID)

	// Run 2: a new front over the same data dir, with a new moto upstream.
	second, _, secondServer := newFrontForTest(t, dataDir)
	_ = second
	client2 := kmsClientFor(t, secondServer.URL)
	keyID2 := createOwnedKey(t, client2, "Stack/DataKey", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	if keyID2 == keyID {
		t.Fatal("the moto key id was not re-created on the second run")
	}
	decrypted, err := client2.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String(keyID2),
	})
	if err != nil {
		t.Fatalf("decrypt after restart: %v", err)
	}
	if string(decrypted.Plaintext) != "persisted secret" {
		t.Fatalf("decrypted %q", decrypted.Plaintext)
	}
	dataKey, err := client2.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: generated.CiphertextBlob, KeyId: aws.String(keyID2),
	})
	if err != nil {
		t.Fatalf("decrypt data key: %v", err)
	}
	if len(dataKey.Plaintext) != 32 {
		t.Fatalf("data key length %d", len(dataKey.Plaintext))
	}
	signingID2 := createOwnedKey(t, client2, "Stack/SigningKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	secondPublic := publicKeyFromGet(t, client2, signingID2)
	if !publicKeysEqual(firstPublic, secondPublic) {
		t.Fatal("the signing key's public key changed across the restart")
	}
	rsaPublic := secondPublic.(*rsa.PublicKey) //nolint:errcheck,forcetypeassert // fixture
	if signatureErr := rsa.VerifyPKCS1v15(rsaPublic, crypto.SHA256, digest[:], signed.Signature); signatureErr != nil {
		t.Fatalf("the run-1 signature did not verify with the run-2 public key: %v", signatureErr)
	}
	info, err := os.Stat(filepath.Join(dataDir, "kms", kmsFrontKeyFile))
	if err != nil {
		t.Fatalf("the persisted key file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the persisted key file mode is %v, want 0600", info.Mode().Perm())
	}
}

// TestKMSFrontEphemeralStaysEphemeral proves the default has not changed: no
// --data-dir means new material and no persisted file.
func TestKMSFrontEphemeralStaysEphemeral(t *testing.T) {
	first, _, firstServer := newFrontForTest(t, "")
	_ = first
	client := kmsClientFor(t, firstServer.URL)
	keyID := createOwnedKey(t, client, "Stack/Key", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(context.Background(), &kms.EncryptInput{KeyId: aws.String(keyID), Plaintext: []byte("ephemeral")})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	second, _, secondServer := newFrontForTest(t, "")
	_ = second
	client2 := kmsClientFor(t, secondServer.URL)
	keyID2 := createOwnedKey(t, client2, "Stack/Key", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	if _, err := client2.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String(keyID2),
	}); err == nil {
		t.Fatal("an ephemeral ciphertext decrypted under a fresh key")
	}
}

func TestKMSFrontStripsIdentityTag(t *testing.T) {
	_, moto, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	_, err := client.CreateKey(context.Background(), &kms.CreateKeyInput{
		Description: aws.String("tagged"),
		Tags: []kmstypes.Tag{
			{TagKey: aws.String(kmsFrontIdentityTag), TagValue: aws.String("Stack/Key")},
			{TagKey: aws.String("team"), TagValue: aws.String("platform")},
		},
	})
	if err != nil {
		t.Fatalf("create key: %v", err)
	}
	if len(moto.createBodies) != 1 {
		t.Fatalf("moto saw %d CreateKey calls", len(moto.createBodies))
	}
	raw, _ := json.Marshal(moto.createBodies[0]) //nolint:errcheck // fixture
	if strings.Contains(string(raw), kmsFrontIdentityTag) {
		t.Fatalf("the identity tag reached moto: %s", raw)
	}
	if !strings.Contains(string(raw), `"team"`) {
		t.Fatalf("the application tag was dropped: %s", raw)
	}
}

// TestKMSFrontAliasResolution proves a Sign with an alias reaches the owned
// material.
func TestKMSFrontAliasResolution(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/AliasKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	alias := "alias/apptheory-test"
	if _, err := client.CreateAlias(context.Background(), &kms.CreateAliasInput{
		AliasName: aws.String(alias), TargetKeyId: aws.String(keyID),
	}); err != nil {
		t.Fatalf("create alias: %v", err)
	}
	message := []byte("alias message")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: aws.String(alias), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign with alias: %v", err)
	}
	public := publicKeyFromGet(t, client, alias).(*rsa.PublicKey) //nolint:errcheck,forcetypeassert // fixture
	if err := rsa.VerifyPKCS1v15(public, crypto.SHA256, digest[:], signed.Signature); err != nil {
		t.Fatalf("alias signature: %v", err)
	}
}

// TestKMSFrontProxiesOperationsItDoesNotOwn proves unknown operations and
// non-owned keys keep moto's behavior.
func TestKMSFrontProxiesOperationsItDoesNotOwn(t *testing.T) {
	_, moto, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	if _, err := client.ListKeys(context.Background(), &kms.ListKeysInput{}); err != nil {
		t.Fatalf("list keys: %v", err)
	}
	if moto.listCalls != 1 {
		t.Fatalf("ListKeys was not proxied: %d", moto.listCalls)
	}
	// HMAC keys stay with moto; Sign must be proxied (and the fixture error
	// proves the front did not handle it).
	hmacKey, err := client.CreateKey(context.Background(), &kms.CreateKeyInput{
		KeySpec:  kmstypes.KeySpecHmac256,
		KeyUsage: kmstypes.KeyUsageTypeGenerateVerifyMac,
	})
	if err != nil {
		t.Fatalf("create HMAC key: %v", err)
	}
	if _, err := client.Sign(context.Background(), &kms.SignInput{
		KeyId: hmacKey.KeyMetadata.KeyId, Message: []byte("x"),
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	}); err == nil {
		t.Fatal("Sign on an unowned key was handled locally")
	}
	if moto.signCalls != 1 {
		t.Fatalf("Sign on an unowned key was not proxied: %d", moto.signCalls)
	}
}

func publicKeysEqual(a, b crypto.PublicKey) bool {
	aDER, aErr := x509.MarshalPKIXPublicKey(a)
	bDER, bErr := x509.MarshalPKIXPublicKey(b)
	return aErr == nil && bErr == nil && string(aDER) == string(bDER)
}

// rsaRecoveredDigest recovers the PKCS#1 v1.5 DigestInfo digest from a
// signature, the check the Autheory probe used.
func rsaRecoveredDigest(t *testing.T, public *rsa.PublicKey, signature []byte) []byte {
	t.Helper()
	em := rsaRawVerification(t, public, signature)
	// DigestInfo prefix for SHA-256: 30 31 30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20.
	prefix := []byte{0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20}
	index := strings.Index(string(em), string(prefix))
	if index < 0 || len(em) < index+len(prefix)+32 {
		t.Fatalf("the signature carries no SHA-256 DigestInfo")
	}
	return em[index+len(prefix) : index+len(prefix)+32]
}

// rsaRawVerification applies the public operation to the signature.
func rsaRawVerification(t *testing.T, public *rsa.PublicKey, signature []byte) []byte {
	t.Helper()
	message, err := rsaPublicOperation(public, signature)
	if err != nil {
		t.Fatalf("recover the PKCS#1 encoding: %v", err)
	}
	return message
}

func rsaPublicOperation(public *rsa.PublicKey, signature []byte) ([]byte, error) {
	if len(signature) != public.Size() {
		return nil, fmt.Errorf("signature length %d, want %d", len(signature), public.Size())
	}
	k := new(big.Int).SetBytes(signature)
	result := new(big.Int).Exp(k, big.NewInt(int64(public.E)), public.N)
	return result.Bytes(), nil
}

// TestKMSFrontGenerateDataKeyLengths keeps the documented key-spec forms.
func TestKMSFrontGenerateDataKeyLengths(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/DataKey", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	for _, test := range []struct {
		spec kmstypes.DataKeySpec
		want int
	}{
		{kmstypes.DataKeySpecAes256, 32},
		{kmstypes.DataKeySpecAes128, 16},
	} {
		generated, err := client.GenerateDataKey(context.Background(), &kms.GenerateDataKeyInput{
			KeyId: aws.String(keyID), KeySpec: test.spec,
		})
		if err != nil {
			t.Fatalf("generate %s: %v", test.spec, err)
		}
		if len(generated.Plaintext) != test.want {
			t.Fatalf("%s plaintext length %d, want %d", test.spec, len(generated.Plaintext), test.want)
		}
	}
}

// TestKMSFrontEncryptionContextIsBound proves a different context cannot
// decrypt the ciphertext.
func TestKMSFrontEncryptionContextIsBound(t *testing.T) {
	_, _, server := newFrontForTest(t, "")
	client := kmsClientFor(t, server.URL)
	keyID := createOwnedKey(t, client, "Stack/DataKey", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	encrypted, err := client.Encrypt(context.Background(), &kms.EncryptInput{
		KeyId: aws.String(keyID), Plaintext: []byte("ctx"), EncryptionContext: map[string]string{"tenant": "a"},
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := client.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, EncryptionContext: map[string]string{"tenant": "b"},
	}); err == nil {
		t.Fatal("a different encryption context decrypted the ciphertext")
	}
	if _, err := client.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, EncryptionContext: map[string]string{"tenant": "a"},
	}); err != nil {
		t.Fatalf("the matching encryption context did not decrypt: %v", err)
	}
}
