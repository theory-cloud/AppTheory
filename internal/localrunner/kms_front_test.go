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
		keys := make([]any, 0, len(f.keys))
		for id, key := range f.keys {
			keys = append(keys, map[string]any{"KeyId": id, "KeyArn": key.arn})
		}
		writeJSONFixture(writer, map[string]any{"Keys": keys, "Truncated": false})
	case "ListAliases":
		aliases := make([]any, 0, len(f.aliases))
		for name, target := range f.aliases {
			aliases = append(aliases, map[string]any{
				"AliasName": name, "AliasArn": "arn:aws:kms:us-east-1:123456789012:" + name, "TargetKeyId": target,
			})
		}
		writeJSONFixture(writer, map[string]any{"Aliases": aliases, "Truncated": false})
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

// TestKMSFrontPersistsMaterialAcrossRestart is the G2/G8 proof at the front
// level: run 1 creates the keys, encrypts, signs and aliases; run 2 re-creates
// them from the same identity, sees the same KeyId/ARN, decrypts, resolves the
// alias and verifies the run-1 signature through KMS addressed by the run-1 id.
func TestKMSFrontPersistsMaterialAcrossRestart(t *testing.T) {
	dataDir := t.TempDir()
	first, _, firstServer := newFrontForTest(t, dataDir)
	_ = first
	client := kmsClientFor(t, firstServer.URL)
	ctx := context.Background()
	keyID := createOwnedKey(t, client, "Stack/DataKey", "SYMMETRIC_DEFAULT", kmstypes.KeyUsageTypeEncryptDecrypt)
	keyMetadata, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(keyID)})
	if err != nil {
		t.Fatalf("describe the data key in run 1: %v", err)
	}
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{
		KeyId: aws.String(keyID), Plaintext: []byte("persisted secret"),
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	generated, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId: aws.String(keyID), KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		t.Fatalf("generate data key: %v", err)
	}
	signingID := createOwnedKey(t, client, "Stack/SigningKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	signingMetadata, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(signingID)})
	if err != nil {
		t.Fatalf("describe the signing key in run 1: %v", err)
	}
	alias := "alias/apptheory-data-dir-signing"
	if _, aliasErr := client.CreateAlias(ctx, &kms.CreateAliasInput{
		AliasName: aws.String(alias), TargetKeyId: aws.String(signingID),
	}); aliasErr != nil {
		t.Fatalf("create alias: %v", aliasErr)
	}
	message := []byte("stable across restarts")
	digest := sha256.Sum256(message)
	signed, err := client.Sign(ctx, &kms.SignInput{
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
	if keyID2 != keyID {
		t.Fatalf("the key id changed across restarts: %s -> %s", keyID, keyID2)
	}
	keyMetadata2, err := client2.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(keyID2)})
	if err != nil {
		t.Fatalf("describe the data key in run 2: %v", err)
	}
	if got, want := aws.ToString(keyMetadata2.KeyMetadata.Arn), aws.ToString(keyMetadata.KeyMetadata.Arn); got != want {
		t.Fatalf("the key ARN changed across restarts: %s -> %s", want, got)
	}
	decrypted, err := client2.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: encrypted.CiphertextBlob, KeyId: aws.String(keyID),
	})
	if err != nil {
		t.Fatalf("decrypt after restart by the run-1 key id: %v", err)
	}
	if string(decrypted.Plaintext) != "persisted secret" {
		t.Fatalf("decrypted %q", decrypted.Plaintext)
	}
	dataKey, err := client2.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: generated.CiphertextBlob, KeyId: aws.String(keyID),
	})
	if err != nil {
		t.Fatalf("decrypt data key: %v", err)
	}
	if len(dataKey.Plaintext) != 32 {
		t.Fatalf("data key length %d", len(dataKey.Plaintext))
	}
	signingID2 := createOwnedKey(t, client2, "Stack/SigningKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if signingID2 != signingID {
		t.Fatalf("the signing key id changed across restarts: %s -> %s", signingID, signingID2)
	}
	// The runner re-provisions aliases on every start; the re-created alias
	// must resolve to the same persisted key.
	if _, aliasErr := client2.CreateAlias(ctx, &kms.CreateAliasInput{
		AliasName: aws.String(alias), TargetKeyId: aws.String(signingID2),
	}); aliasErr != nil {
		t.Fatalf("re-create the alias in run 2: %v", aliasErr)
	}
	aliased, err := client2.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(alias)})
	if err != nil {
		t.Fatalf("describe the alias in run 2: %v", err)
	}
	if got, want := aws.ToString(aliased.KeyMetadata.KeyId), signingID; got != want {
		t.Fatalf("the alias resolves to key id %s, want %s", got, want)
	}
	secondPublic := publicKeyFromGet(t, client2, alias)
	if !publicKeysEqual(firstPublic, secondPublic) {
		t.Fatal("the signing key's public key changed across the restart")
	}
	// KMS Verify in run 2 addressed by the raw key id and by the ARN recorded
	// in run 1, the app-level check Autheory's pinned kid needs.
	for name, keyRef := range map[string]string{
		"run-1 key id":  signingID,
		"run-1 key ARN": aws.ToString(signingMetadata.KeyMetadata.Arn),
	} {
		verified, verifyErr := client2.Verify(ctx, &kms.VerifyInput{
			KeyId: aws.String(keyRef), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
			Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
		})
		if verifyErr != nil || !verified.SignatureValid {
			t.Fatalf("KMS Verify by the %s failed: valid=%v err=%v", name, verified != nil && verified.SignatureValid, verifyErr)
		}
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

// TestKMSFrontIdentityResponsesUseTheStableID proves DescribeKey, ListKeys and
// ListAliases expose the persisted id and ARN, never the id moto generated for
// the current run.
func TestKMSFrontIdentityResponsesUseTheStableID(t *testing.T) {
	dataDir := t.TempDir()
	first, firstMoto, firstServer := newFrontForTest(t, dataDir)
	_ = first
	client := kmsClientFor(t, firstServer.URL)
	ctx := context.Background()
	stableID := createOwnedKey(t, client, "Stack/ListedKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	alias := "alias/apptheory-listed"
	if _, err := client.CreateAlias(ctx, &kms.CreateAliasInput{
		AliasName: aws.String(alias), TargetKeyId: aws.String(stableID),
	}); err != nil {
		t.Fatalf("create alias: %v", err)
	}
	firstMotoID := onlyFakeMotoKeyID(t, firstMoto)
	if firstMotoID == stableID {
		t.Fatalf("the fixture reused the stable id %s as moto's id", stableID)
	}
	metadata, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(stableID)})
	if err != nil {
		t.Fatalf("describe in run 1: %v", err)
	}
	stableARN := aws.ToString(metadata.KeyMetadata.Arn)

	// Run 2: a new front and a new moto id behind the same --data-dir.
	second, secondMoto, secondServer := newFrontForTest(t, dataDir)
	_ = second
	client2 := kmsClientFor(t, secondServer.URL)
	got := createOwnedKey(t, client2, "Stack/ListedKey", "RSA_2048", kmstypes.KeyUsageTypeSignVerify)
	if got != stableID {
		t.Fatalf("CreateKey returned %s in run 2, want the run-1 id %s", got, stableID)
	}
	if _, aliasErr := client2.CreateAlias(ctx, &kms.CreateAliasInput{
		AliasName: aws.String(alias), TargetKeyId: aws.String(got),
	}); aliasErr != nil {
		t.Fatalf("re-create the alias in run 2: %v", aliasErr)
	}
	secondMotoID := onlyFakeMotoKeyID(t, secondMoto)
	if secondMotoID == firstMotoID {
		t.Fatal("the fixture reused moto's id; the run-2 mapping is not exercised")
	}
	described, err := client2.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: aws.String(secondMotoID)})
	if err != nil {
		t.Fatalf("describe by the current moto id: %v", err)
	}
	if aws.ToString(described.KeyMetadata.KeyId) != stableID || aws.ToString(described.KeyMetadata.Arn) != stableARN {
		t.Fatalf("DescribeKey exposed moto's identity: %+v", described.KeyMetadata)
	}
	listed, err := client2.ListKeys(ctx, &kms.ListKeysInput{})
	if err != nil {
		t.Fatalf("list keys: %v", err)
	}
	if len(listed.Keys) != 1 || aws.ToString(listed.Keys[0].KeyId) != stableID || aws.ToString(listed.Keys[0].KeyArn) != stableARN {
		t.Fatalf("ListKeys exposed moto's identity: %+v", listed.Keys)
	}
	aliases, err := client2.ListAliases(ctx, &kms.ListAliasesInput{})
	if err != nil {
		t.Fatalf("list aliases: %v", err)
	}
	if len(aliases.Aliases) != 1 || aws.ToString(aliases.Aliases[0].TargetKeyId) != stableID {
		t.Fatalf("ListAliases exposed moto's identity: %+v", aliases.Aliases)
	}
	// The alias still signs with the persisted material.
	digest := sha256.Sum256([]byte("listed alias"))
	signed, err := client2.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(alias), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil {
		t.Fatalf("sign with the alias in run 2: %v", err)
	}
	verified, err := client2.Verify(ctx, &kms.VerifyInput{
		KeyId: aws.String(stableID), Message: digest[:], MessageType: kmstypes.MessageTypeDigest,
		Signature: signed.Signature, SigningAlgorithm: kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256,
	})
	if err != nil || !verified.SignatureValid {
		t.Fatalf("verify the alias signature by the run-1 id: valid=%v err=%v", verified != nil && verified.SignatureValid, err)
	}
}

func onlyFakeMotoKeyID(t *testing.T, moto *fakeMotoKMS) string {
	t.Helper()
	moto.mu.Lock()
	defer moto.mu.Unlock()
	if len(moto.keys) != 1 {
		t.Fatalf("the fixture has %d moto keys, want 1", len(moto.keys))
	}
	for id := range moto.keys {
		return id
	}
	return ""
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

// TestKMSFrontStripsIdentityTag proves the runner's reserved tag never reaches
// moto and other tags are preserved.
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

// TestKMSFrontIdentityRewriteEdges covers the no-op and malformed shapes of
// the identity rewriting, so an unknown key or body passes through unchanged
// rather than inventing an identity.
func TestKMSFrontIdentityRewriteEdges(t *testing.T) {
	front, err := newKMSFront(t.TempDir(), "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new KMS front: %v", err)
	}
	record := &kmsKeyRecord{
		Identity: "Stack/Edge", StableID: "11111111-1111-4111-8111-111111111111",
		KeySpec: kmsSpecSymmetricDefault, KeyUsage: kmsUsageEncryptDecrypt,
	}
	if addErr := front.store.add(record); addErr != nil {
		t.Fatalf("add the record: %v", addErr)
	}
	motoARN := "arn:aws:kms:us-east-1:123456789012:key/moto-edge"
	front.store.bind("moto-edge", motoARN, record)

	for _, field := range []string{"KeyId", "TargetKeyId", "DestinationKeyId", "SourceKeyId"} {
		body := []byte(`{"` + field + `":"` + record.StableID + `","Other":1}`)
		if got := front.rewriteRequestIdentity(body); !strings.Contains(string(got), `"moto-edge"`) {
			t.Fatalf("%s was not mapped to the current run id: %s", field, got)
		}
	}
	for _, body := range []string{
		`{"KeyId":"alias/example"}`,
		`{"KeyId":"unknown"}`,
		`{"KeyId":""}`,
		`not json`,
		`{"Other":1}`,
	} {
		if got := front.rewriteRequestIdentity([]byte(body)); string(got) != body {
			t.Fatalf("the request body changed: %q -> %q", body, got)
		}
	}
	if got := kmsOperationName("TrentService.DescribeKey"); got != "DescribeKey" {
		t.Fatalf("operation name %q", got)
	}
	if got := kmsOperationName("DescribeKey"); got != "DescribeKey" {
		t.Fatalf("unprefixed operation name %q", got)
	}
	for _, test := range []struct {
		operation string
		payload   string
	}{
		{"DescribeKey", `not json`},
		{"DescribeKey", `{}`},
		{"DescribeKey", `{"KeyMetadata":42}`},
		{"DescribeKey", `{"KeyMetadata":{}}`},
		{"DescribeKey", `{"KeyMetadata":{"KeyId":"unknown"}}`},
		{"ListKeys", `{"Keys":42}`},
		{"ListKeys", `{"Keys":[{"KeyId":42},{"Other":1}]}`},
		{"ListKeys", `{"Keys":[]}`},
		{"ListAliases", `{"Aliases":42}`},
		{"ListAliases", `{"Aliases":[{"TargetKeyId":42}]}`},
		{"ListAliases", `{"Aliases":[]}`},
		{"Unknown", `{"KeyMetadata":{"KeyId":"moto-edge"}}`},
	} {
		if got := front.rewriteResponseIdentity(test.operation, []byte(test.payload)); string(got) != test.payload {
			t.Fatalf("%s response changed: %q -> %q", test.operation, test.payload, got)
		}
	}
	described := front.rewriteResponseIdentity("DescribeKey",
		[]byte(`{"KeyMetadata":{"KeyId":"moto-edge","Arn":"`+motoARN+`","KeySpec":"SYMMETRIC_DEFAULT"}}`))
	if !strings.Contains(string(described), `"KeyId":"`+record.StableID+`"`) || !strings.Contains(string(described), `"Arn":"`+stableARN(record)+`"`) {
		t.Fatalf("DescribeKey did not use the stable identity: %s", described)
	}
	listed := front.rewriteResponseIdentity("ListKeys",
		[]byte(`{"Keys":[{"KeyId":"moto-edge","KeyArn":"`+motoARN+`"}]}`))
	if !strings.Contains(string(listed), record.StableID) || !strings.Contains(string(listed), stableARN(record)) {
		t.Fatalf("ListKeys did not use the stable identity: %s", listed)
	}
	if _, createErr := front.rewriteCreateKeyPayload([]byte(`{}`), record); createErr == nil {
		t.Fatal("a CreateKey payload without KeyMetadata was accepted")
	}
	if got, rewriteErr := front.rewriteCreateKeyPayload([]byte(`{"KeyMetadata":{"KeyId":"moto-edge"}}`), record); rewriteErr != nil ||
		!strings.Contains(string(got), record.StableID) {
		t.Fatalf("CreateKey was not rewritten: %s (%v)", got, rewriteErr)
	}

	// Without --data-dir nothing is rewritten, and an unbound record falls
	// back to its own stable identity.
	ephemeral, err := newKMSFront("", "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new ephemeral KMS front: %v", err)
	}
	if got := ephemeral.rewriteRequestIdentity([]byte(`{"KeyId":"x"}`)); string(got) != `{"KeyId":"x"}` {
		t.Fatalf("the ephemeral request body changed: %s", got)
	}
	if got := ephemeral.responseKeyID(record); got != record.StableID {
		t.Fatalf("the unbound ephemeral key id is %q", got)
	}
	if got := ephemeral.responseKeyARN(record); got != stableARN(record) {
		t.Fatalf("the unbound ephemeral key ARN is %q", got)
	}
	payload := `{"KeyMetadata":{"KeyId":"x"}}`
	if got, err := ephemeral.rewriteCreateKeyPayload([]byte(payload), record); err != nil || string(got) != payload {
		t.Fatalf("the ephemeral CreateKey payload changed: %s (%v)", got, err)
	}
}
