package localrunner

import (
	"bytes"
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// KMS key material and cryptography for the local front.
//
// The front signs a DIGEST as-is, as AWS documents, instead of hashing it a
// second time: https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
// RAW messages are hashed with the algorithm's digest, exactly as moto did.
//
// The symmetric envelope binds the ciphertext to the stable key id and the
// encryption context, the two properties AWS documents for Decrypt:
// https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html

const (
	kmsEnvelopeMagic = "APTKMS1\n"
	kmsStableIDLen   = 36
	kmsMaxPlaintext  = 4096
	// The signing algorithm families the front implements.
	kmsFamilyRSAPKCS1 = "rsa-pkcs1"
	kmsFamilyRSAPSS   = "rsa-pss"
	kmsFamilyECDSA    = "ecdsa"
)

// kmsMaterial is one key's parsed private material.
type kmsMaterial struct {
	symmetric []byte
	rsa       *rsa.PrivateKey
	ecdsa     *ecdsa.PrivateKey
}

// kmsSupportedKey reports whether the front serves this key type itself. The
// other specs keep moto's behavior: HMAC and RSA-encryption keys stay in moto,
// and so do SECG P256K1/SM2 signing keys, which Go's standard library cannot
// sign with.
func kmsSupportedKey(keySpec, keyUsage string) bool {
	switch keyUsage {
	case kmsUsageEncryptDecrypt:
		return keySpec == kmsSpecSymmetricDefault
	case kmsUsageSignVerify:
		switch keySpec {
		case "RSA_2048", "RSA_3072", "RSA_4096",
			"ECC_NIST_P256", "ECC_NIST_P384", "ECC_NIST_P521":
			return true
		}
	}
	return false
}

func newKMSKeyRecord(identity, keySpec, keyUsage string) (*kmsKeyRecord, error) {
	material, raw, err := generateKMSMaterial(keySpec, keyUsage)
	if err != nil {
		return nil, err
	}
	stableID, err := newKMSUUID()
	if err != nil {
		return nil, err
	}
	return &kmsKeyRecord{
		Identity:  identity,
		StableID:  stableID,
		KeySpec:   keySpec,
		KeyUsage:  keyUsage,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Material:  base64.StdEncoding.EncodeToString(raw),
		material:  material,
	}, nil
}

func generateKMSMaterial(keySpec, keyUsage string) (*kmsMaterial, []byte, error) {
	switch {
	case keyUsage == kmsUsageEncryptDecrypt && keySpec == kmsSpecSymmetricDefault:
		key := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, nil, fmt.Errorf("generate the symmetric KMS key: %w", err)
		}
		return &kmsMaterial{symmetric: key}, key, nil
	case keyUsage == kmsUsageSignVerify && strings.HasPrefix(keySpec, "RSA_"):
		bits, err := rsaBits(keySpec)
		if err != nil {
			return nil, nil, err
		}
		if bits < 2048 {
			return nil, nil, fmt.Errorf("a local RSA key must be at least 2048 bits")
		}
		key, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			return nil, nil, fmt.Errorf("generate the RSA KMS key: %w", err)
		}
		raw, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, nil, fmt.Errorf("encode the RSA KMS key: %w", err)
		}
		return &kmsMaterial{rsa: key}, raw, nil
	case keyUsage == kmsUsageSignVerify:
		curve, err := eccCurve(keySpec)
		if err != nil {
			return nil, nil, err
		}
		key, err := ecdsa.GenerateKey(curve, rand.Reader)
		if err != nil {
			return nil, nil, fmt.Errorf("generate the ECC KMS key: %w", err)
		}
		raw, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, nil, fmt.Errorf("encode the ECC KMS key: %w", err)
		}
		return &kmsMaterial{ecdsa: key}, raw, nil
	}
	return nil, nil, fmt.Errorf("unsupported local KMS key %s/%s", keySpec, keyUsage)
}

func parseKMSMaterial(keySpec, keyUsage string, raw []byte) (*kmsMaterial, error) {
	if keyUsage == kmsUsageEncryptDecrypt && keySpec == kmsSpecSymmetricDefault {
		if len(raw) != 32 {
			return nil, fmt.Errorf("a SYMMETRIC_DEFAULT key must hold 32 bytes, got %d", len(raw))
		}
		return &kmsMaterial{symmetric: raw}, nil
	}
	if keyUsage != kmsUsageSignVerify {
		return nil, fmt.Errorf("unsupported local KMS key %s/%s", keySpec, keyUsage)
	}
	private, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("parse the KMS private key: %w", err)
	}
	switch key := private.(type) {
	case *rsa.PrivateKey:
		bits, bitsErr := rsaBits(keySpec)
		if bitsErr != nil {
			return nil, bitsErr
		}
		if key.N.BitLen() != bits {
			return nil, fmt.Errorf("the persisted RSA key is %d bits, the definition asks for %s", key.N.BitLen(), keySpec)
		}
		return &kmsMaterial{rsa: key}, nil
	case *ecdsa.PrivateKey:
		curve, curveErr := eccCurve(keySpec)
		if curveErr != nil {
			return nil, curveErr
		}
		if key.Curve != curve {
			return nil, fmt.Errorf("the persisted ECC key's curve does not match %s", keySpec)
		}
		return &kmsMaterial{ecdsa: key}, nil
	default:
		return nil, fmt.Errorf("the persisted key is %T, not an RSA or ECDSA key", private)
	}
}

func rsaBits(keySpec string) (int, error) {
	switch keySpec {
	case "RSA_2048":
		return 2048, nil
	case "RSA_3072":
		return 3072, nil
	case "RSA_4096":
		return 4096, nil
	}
	return 0, fmt.Errorf("unsupported RSA key spec %q", keySpec)
}

func eccCurve(keySpec string) (elliptic.Curve, error) {
	switch keySpec {
	case "ECC_NIST_P256":
		return elliptic.P256(), nil
	case "ECC_NIST_P384":
		return elliptic.P384(), nil
	case "ECC_NIST_P521":
		return elliptic.P521(), nil
	}
	return nil, fmt.Errorf("unsupported ECC key spec %q", keySpec)
}

// publicDER is the SubjectPublicKeyInfo GetPublicKey returns.
func (m *kmsMaterial) publicDER() ([]byte, error) {
	switch {
	case m.rsa != nil:
		return x509.MarshalPKIXPublicKey(&m.rsa.PublicKey)
	case m.ecdsa != nil:
		return x509.MarshalPKIXPublicKey(&m.ecdsa.PublicKey)
	}
	return nil, fmt.Errorf("the key has no public key")
}

// handleSign signs a RAW message or a DIGEST as AWS documents.
func (f *kmsFront) handleSign(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		KeyID            string `json:"KeyId"`
		Message          string `json:"Message"`
		MessageType      string `json:"MessageType"`
		SigningAlgorithm string `json:"SigningAlgorithm"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the Sign request: "+err.Error())
		return
	}
	run, owned, err := f.resolveOwned(ctx, request.KeyID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".Sign", body)
		return
	}
	if run.record.KeyUsage != kmsUsageSignVerify {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
			"1 validation error detected: Value '%s' at 'KeyId' failed to satisfy constraint: Member must point to a key with usage: 'SIGN_VERIFY'", request.KeyID))
		return
	}
	message, err := base64.StdEncoding.DecodeString(request.Message)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Message must be base64 encoded")
		return
	}
	if len(message) == 0 {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException",
			"1 validation error detected: Value at 'Message' failed to satisfy constraint: Member must have length greater than or equal to 1")
		return
	}
	family, digestHash, err := kmsSigningAlgorithm(run.record.KeySpec, request.SigningAlgorithm)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", err.Error())
		return
	}
	digest, err := kmsDigest(message, request.MessageType, digestHash)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", err.Error())
		return
	}
	signature, err := signKMSDigest(run.record.material, family, digestHash, digest)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", err.Error())
		return
	}
	writeKMSJSON(writer, map[string]any{
		"KeyId":            f.responseKeyARN(run.record),
		"Signature":        base64.StdEncoding.EncodeToString(signature),
		"SigningAlgorithm": request.SigningAlgorithm,
	})
}

// handleVerify verifies a RAW message or a DIGEST as AWS documents.
func (f *kmsFront) handleVerify(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		KeyID            string `json:"KeyId"`
		Message          string `json:"Message"`
		MessageType      string `json:"MessageType"`
		Signature        string `json:"Signature"`
		SigningAlgorithm string `json:"SigningAlgorithm"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the Verify request: "+err.Error())
		return
	}
	run, owned, err := f.resolveOwned(ctx, request.KeyID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".Verify", body)
		return
	}
	if run.record.KeyUsage != kmsUsageSignVerify {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
			"1 validation error detected: Value '%s' at 'KeyId' failed to satisfy constraint: Member must point to a key with usage: 'SIGN_VERIFY'", request.KeyID))
		return
	}
	message, err := base64.StdEncoding.DecodeString(request.Message)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Message must be base64 encoded")
		return
	}
	signature, err := base64.StdEncoding.DecodeString(request.Signature)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Signature must be base64 encoded")
		return
	}
	family, digestHash, err := kmsSigningAlgorithm(run.record.KeySpec, request.SigningAlgorithm)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", err.Error())
		return
	}
	digest, err := kmsDigest(message, request.MessageType, digestHash)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", err.Error())
		return
	}
	valid := verifyKMSDigest(run.record.material, family, digestHash, digest, signature)
	writeKMSJSON(writer, map[string]any{
		"KeyId":            f.responseKeyARN(run.record),
		"SignatureValid":   valid,
		"SigningAlgorithm": request.SigningAlgorithm,
	})
}

// handleGetPublicKey keeps moto's metadata response and replaces the public
// key with the owned material's SubjectPublicKeyInfo.
func (f *kmsFront) handleGetPublicKey(ctx context.Context, writer http.ResponseWriter, body []byte) {
	run, owned, err := f.resolveOwned(ctx, kmsStringField(body, "KeyId"))
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".GetPublicKey", body)
		return
	}
	publicKey, err := run.record.material.publicDER()
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	status, _, payload, err := f.proxy(ctx, kmsFrontTarget+".GetPublicKey", body)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	if status >= http.StatusMultipleChoices {
		writeRawResponse(writer, status, nil, payload)
		return
	}
	var response map[string]json.RawMessage
	if parseErr := json.Unmarshal(payload, &response); parseErr != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", "decode the GetPublicKey response: "+parseErr.Error())
		return
	}
	encoded, err := json.Marshal(base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	response["PublicKey"] = encoded
	// The key id is part of the identity a caller may pin (Autheory derives
	// its JWKS kid from it), so report the persisted one under --data-dir.
	response["KeyId"], _ = json.Marshal(f.responseKeyID(run.record)) //nolint:errcheck // a string never fails to marshal
	updated, err := json.Marshal(response)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	writeRawResponse(writer, http.StatusOK, nil, updated)
}

// handleEncrypt serves the symmetric envelope the front can decrypt later.
func (f *kmsFront) handleEncrypt(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		KeyID               string            `json:"KeyId"`
		Plaintext           string            `json:"Plaintext"`
		EncryptionContext   map[string]string `json:"EncryptionContext"`
		EncryptionAlgorithm string            `json:"EncryptionAlgorithm"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the Encrypt request: "+err.Error())
		return
	}
	if strings.TrimSpace(request.EncryptionAlgorithm) != "" {
		f.forward(ctx, writer, kmsFrontTarget+".Encrypt", body)
		return
	}
	run, owned, err := f.resolveOwned(ctx, request.KeyID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".Encrypt", body)
		return
	}
	plaintext, err := base64.StdEncoding.DecodeString(request.Plaintext)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Plaintext must be base64 encoded")
		return
	}
	if len(plaintext) == 0 || len(plaintext) > kmsMaxPlaintext {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
			"1 validation error detected: Value at 'Plaintext' failed to satisfy constraint: Member must have length between 1 and %d", kmsMaxPlaintext))
		return
	}
	blob, err := sealKMSEnvelope(run.record.StableID, run.record.material.symmetric, plaintext, request.EncryptionContext)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	writeKMSJSON(writer, map[string]any{
		"CiphertextBlob": base64.StdEncoding.EncodeToString(blob),
		"KeyId":          f.responseKeyARN(run.record),
	})
}

// handleDecrypt opens the front's envelope and binds it to the requested key
// when the caller names one, as AWS does.
func (f *kmsFront) handleDecrypt(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		KeyID             string            `json:"KeyId"`
		CiphertextBlob    string            `json:"CiphertextBlob"`
		EncryptionContext map[string]string `json:"EncryptionContext"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the Decrypt request: "+err.Error())
		return
	}
	blob, err := base64.StdEncoding.DecodeString(request.CiphertextBlob)
	if err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "CiphertextBlob must be base64 encoded")
		return
	}
	if !hasKMSEnvelope(blob) {
		f.forward(ctx, writer, kmsFrontTarget+".Decrypt", body)
		return
	}
	stableID, plaintext, err := openKMSEnvelope(blob, request.EncryptionContext, func(stableID string) []byte {
		record := f.store.stable(stableID)
		if record == nil {
			return nil
		}
		return record.material.symmetric
	})
	if err != nil {
		if errors.Is(err, errKMSKeyGone) {
			writeKMSError(writer, http.StatusBadRequest, "AccessDeniedException",
				"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
			return
		}
		writeKMSError(writer, http.StatusBadRequest, "InvalidCiphertextException",
			"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
		return
	}
	record := f.store.stable(stableID)
	if record == nil {
		writeKMSError(writer, http.StatusBadRequest, "AccessDeniedException",
			"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
		return
	}
	keyARN := f.responseKeyARN(record)
	if strings.TrimSpace(request.KeyID) != "" {
		run, owned, resolveErr := f.resolveOwned(ctx, request.KeyID)
		if resolveErr != nil {
			writeServiceError(writer, resolveErr)
			return
		}
		if !owned || run.record.StableID != stableID {
			writeKMSError(writer, http.StatusBadRequest, "AccessDeniedException",
				"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
			return
		}
		keyARN = f.responseKeyARN(run.record)
	}
	writeKMSJSON(writer, map[string]any{
		"Plaintext": base64.StdEncoding.EncodeToString(plaintext),
		"KeyId":     keyARN,
	})
}

// handleGenerateDataKey creates a data key and seals it under the master key.
//
//nolint:gocyclo // one branch per documented key-spec and byte-count form
func (f *kmsFront) handleGenerateDataKey(ctx context.Context, writer http.ResponseWriter, body []byte, includePlaintext bool) {
	var request struct {
		KeyID             string            `json:"KeyId"`
		KeySpec           string            `json:"KeySpec"`
		NumberOfBytes     int               `json:"NumberOfBytes"`
		EncryptionContext map[string]string `json:"EncryptionContext"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the GenerateDataKey request: "+err.Error())
		return
	}
	run, owned, err := f.resolveOwned(ctx, request.KeyID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		operation := kmsFrontTarget + ".GenerateDataKey"
		if !includePlaintext {
			operation = kmsFrontTarget + ".GenerateDataKeyWithoutPlaintext"
		}
		f.forward(ctx, writer, operation, body)
		return
	}
	if request.KeySpec != "" && request.KeySpec != "AES_256" && request.KeySpec != "AES_128" {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
			"1 validation error detected: Value '%s' at 'keySpec' failed to satisfy constraint: Member must satisfy enum value set: [AES_256, AES_128]", request.KeySpec))
		return
	}
	var length int
	switch {
	case request.KeySpec == "AES_256" && request.NumberOfBytes == 0:
		length = 32
	case request.KeySpec == "AES_128" && request.NumberOfBytes == 0:
		length = 16
	case request.KeySpec == "" && request.NumberOfBytes > 0:
		if request.NumberOfBytes > 1024 {
			writeKMSError(writer, http.StatusBadRequest, "ValidationException", fmt.Sprintf(
				"1 validation error detected: Value '%d' at 'numberOfBytes' failed to satisfy constraint: Member must have value less than or equal to 1024", request.NumberOfBytes))
			return
		}
		length = request.NumberOfBytes
	case request.KeySpec != "" && request.NumberOfBytes > 0:
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Please specify either number of bytes or key spec.")
		return
	default:
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "Please specify either number of bytes or key spec.")
		return
	}
	dataKey := make([]byte, length)
	if _, randErr := io.ReadFull(rand.Reader, dataKey); randErr != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", randErr.Error())
		return
	}
	blob, err := sealKMSEnvelope(run.record.StableID, run.record.material.symmetric, dataKey, request.EncryptionContext)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	response := map[string]any{
		"CiphertextBlob": base64.StdEncoding.EncodeToString(blob),
		"KeyId":          f.responseKeyARN(run.record),
	}
	if includePlaintext {
		response["Plaintext"] = base64.StdEncoding.EncodeToString(dataKey)
	}
	writeKMSJSON(writer, response)
}

// handleReEncrypt re-wraps one owned ciphertext under another owned key.
func (f *kmsFront) handleReEncrypt(ctx context.Context, writer http.ResponseWriter, body []byte) {
	var request struct {
		CiphertextBlob               string            `json:"CiphertextBlob"`
		SourceEncryptionContext      map[string]string `json:"SourceEncryptionContext"`
		DestinationKeyID             string            `json:"DestinationKeyId"`
		DestinationEncryptionContext map[string]string `json:"DestinationEncryptionContext"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		writeKMSError(writer, http.StatusBadRequest, "ValidationException", "decode the ReEncrypt request: "+err.Error())
		return
	}
	blob, err := base64.StdEncoding.DecodeString(request.CiphertextBlob)
	if err != nil || !hasKMSEnvelope(blob) {
		f.forward(ctx, writer, kmsFrontTarget+".ReEncrypt", body)
		return
	}
	destination, owned, err := f.resolveOwned(ctx, request.DestinationKeyID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if !owned {
		f.forward(ctx, writer, kmsFrontTarget+".ReEncrypt", body)
		return
	}
	stableID, plaintext, err := openKMSEnvelope(blob, request.SourceEncryptionContext, func(stableID string) []byte {
		record := f.store.stable(stableID)
		if record == nil {
			return nil
		}
		return record.material.symmetric
	})
	if err != nil {
		if errors.Is(err, errKMSKeyGone) {
			writeKMSError(writer, http.StatusBadRequest, "AccessDeniedException",
				"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
			return
		}
		writeKMSError(writer, http.StatusBadRequest, "InvalidCiphertextException",
			"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
		return
	}
	source := f.store.stable(stableID)
	if source == nil {
		writeKMSError(writer, http.StatusBadRequest, "AccessDeniedException",
			"The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.")
		return
	}
	reencrypted, err := sealKMSEnvelope(destination.record.StableID, destination.record.material.symmetric, plaintext, request.DestinationEncryptionContext)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	writeKMSJSON(writer, map[string]any{
		"CiphertextBlob": base64.StdEncoding.EncodeToString(reencrypted),
		"KeyId":          f.responseKeyARN(destination.record),
		"SourceKeyId":    f.responseKeyARN(source),
	})
}

// kmsDigest turns a RAW message into its digest, or validates and returns a
// DIGEST unchanged. AWS: "DIGEST - the message is a digest, and KMS signs it
// as-is": https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
func kmsDigest(message []byte, messageType string, digestHash crypto.Hash) ([]byte, error) {
	switch strings.TrimSpace(messageType) {
	case "", "RAW":
		hasher := digestHash.New()
		_, _ = hasher.Write(message) //nolint:errcheck // hash.Hash.Write never fails
		return hasher.Sum(nil), nil
	case "DIGEST":
		if len(message) != digestHash.Size() {
			return nil, fmt.Errorf("the message must be a %d-byte digest for this signing algorithm; got %d bytes", digestHash.Size(), len(message))
		}
		return message, nil
	default:
		return nil, fmt.Errorf("1 validation error detected: Value '%s' at 'messageType' failed to satisfy constraint: Member must satisfy enum value set: [RAW, DIGEST]", messageType)
	}
}

// kmsSigningAlgorithm validates the algorithm against the key spec and returns
// its family and hash.
func kmsSigningAlgorithm(keySpec, algorithm string) (string, crypto.Hash, error) {
	var family string
	switch {
	case strings.HasPrefix(algorithm, "RSASSA_PKCS1_V1_5_"):
		family = kmsFamilyRSAPKCS1
	case strings.HasPrefix(algorithm, "RSASSA_PSS_"):
		family = kmsFamilyRSAPSS
	case strings.HasPrefix(algorithm, "ECDSA_"):
		family = kmsFamilyECDSA
	default:
		return "", 0, fmt.Errorf("1 validation error detected: Value '%s' at 'SigningAlgorithm' failed to satisfy constraint: Member must satisfy enum value set", algorithm)
	}
	isRSA := strings.HasPrefix(keySpec, "RSA_")
	isECC := strings.HasPrefix(keySpec, "ECC_")
	if (family == kmsFamilyECDSA && !isECC) || (family != kmsFamilyECDSA && !isRSA) {
		return "", 0, fmt.Errorf("1 validation error detected: Value '%s' at 'SigningAlgorithm' failed to satisfy constraint: Member must satisfy enum value set for key spec %s", algorithm, keySpec)
	}
	if isECC {
		// AWS pairs each NIST curve with exactly one ECDSA digest:
		// https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html
		required := map[string]string{
			"ECC_NIST_P256": "ECDSA_SHA_256",
			"ECC_NIST_P384": "ECDSA_SHA_384",
			"ECC_NIST_P521": "ECDSA_SHA_512",
		}[keySpec]
		if required == "" || algorithm != required {
			return "", 0, fmt.Errorf("1 validation error detected: Value '%s' at 'SigningAlgorithm' failed to satisfy constraint: Member must satisfy enum value set for key spec %s", algorithm, keySpec)
		}
	}
	switch {
	case strings.HasSuffix(algorithm, "SHA_256"):
		return family, crypto.SHA256, nil
	case strings.HasSuffix(algorithm, "SHA_384"):
		return family, crypto.SHA384, nil
	case strings.HasSuffix(algorithm, "SHA_512"):
		return family, crypto.SHA512, nil
	}
	return "", 0, fmt.Errorf("1 validation error detected: Value '%s' at 'SigningAlgorithm' failed to satisfy constraint: Member must satisfy enum value set", algorithm)
}

func signKMSDigest(material *kmsMaterial, family string, digestHash crypto.Hash, digest []byte) ([]byte, error) {
	switch family {
	case kmsFamilyRSAPKCS1:
		if material.rsa == nil {
			return nil, fmt.Errorf("the key is not an RSA key")
		}
		return rsa.SignPKCS1v15(rand.Reader, material.rsa, digestHash, digest)
	case kmsFamilyRSAPSS:
		if material.rsa == nil {
			return nil, fmt.Errorf("the key is not an RSA key")
		}
		return rsa.SignPSS(rand.Reader, material.rsa, digestHash, digest, &rsa.PSSOptions{
			SaltLength: rsa.PSSSaltLengthEqualsHash,
			Hash:       digestHash,
		})
	case kmsFamilyECDSA:
		if material.ecdsa == nil {
			return nil, fmt.Errorf("the key is not an ECDSA key")
		}
		return ecdsa.SignASN1(rand.Reader, material.ecdsa, digest)
	}
	return nil, fmt.Errorf("unsupported signing algorithm family %q", family)
}

func verifyKMSDigest(material *kmsMaterial, family string, digestHash crypto.Hash, digest, signature []byte) bool {
	switch family {
	case kmsFamilyRSAPKCS1:
		if material.rsa == nil {
			return false
		}
		return rsa.VerifyPKCS1v15(&material.rsa.PublicKey, digestHash, digest, signature) == nil
	case kmsFamilyRSAPSS:
		if material.rsa == nil {
			return false
		}
		return rsa.VerifyPSS(&material.rsa.PublicKey, digestHash, digest, signature, &rsa.PSSOptions{
			SaltLength: rsa.PSSSaltLengthAuto,
			Hash:       digestHash,
		}) == nil
	case kmsFamilyECDSA:
		if material.ecdsa == nil {
			return false
		}
		return ecdsa.VerifyASN1(&material.ecdsa.PublicKey, digest, signature)
	}
	return false
}

// sealKMSEnvelope binds ciphertext to the stable key id and the encryption
// context. Layout: magic | 36-byte stable id | 12-byte nonce | ciphertext | tag.
func sealKMSEnvelope(stableID string, key, plaintext []byte, encryptionContext map[string]string) ([]byte, error) {
	if len(stableID) != kmsStableIDLen {
		return nil, fmt.Errorf("the KMS stable id %q must be %d bytes", stableID, kmsStableIDLen)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("initialize the KMS cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("initialize the KMS GCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate the KMS nonce: %w", err)
	}
	out := make([]byte, 0, len(kmsEnvelopeMagic)+kmsStableIDLen+len(nonce)+len(plaintext)+gcm.Overhead())
	out = append(out, kmsEnvelopeMagic...)
	out = append(out, stableID...)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plaintext, kmsContextAAD(encryptionContext))
	return out, nil
}

func hasKMSEnvelope(blob []byte) bool {
	return bytes.HasPrefix(blob, []byte(kmsEnvelopeMagic))
}

// errKMSKeyGone reports a ciphertext whose stable key is not in the store.
var errKMSKeyGone = errors.New("the ciphertext names an unknown key")

// openKMSEnvelope parses and decrypts one envelope. keyFor returns the key
// material for the stable id; nil means the key is gone.
func openKMSEnvelope(blob []byte, encryptionContext map[string]string, keyFor func(string) []byte) (string, []byte, error) {
	header := len(kmsEnvelopeMagic) + kmsStableIDLen
	if len(blob) < header {
		return "", nil, fmt.Errorf("the ciphertext is too short")
	}
	stableID := string(blob[len(kmsEnvelopeMagic):header])
	rest := blob[header:]
	key := keyFor(stableID)
	if len(key) == 0 {
		return stableID, nil, errKMSKeyGone
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return stableID, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return stableID, nil, err
	}
	if len(rest) < gcm.NonceSize()+gcm.Overhead() {
		return stableID, nil, fmt.Errorf("the ciphertext is too short")
	}
	nonce := rest[:gcm.NonceSize()]
	sealed := rest[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, sealed, kmsContextAAD(encryptionContext))
	if err != nil {
		return stableID, nil, err
	}
	return stableID, plaintext, nil
}

// kmsContextAAD encodes the encryption context unambiguously in sorted order.
func kmsContextAAD(context map[string]string) []byte {
	if len(context) == 0 {
		return nil
	}
	keys := make([]string, 0, len(context))
	for key := range context {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var buffer bytes.Buffer
	var length [binary.MaxVarintLen64]byte
	for _, key := range keys {
		value := context[key]
		n := binary.PutUvarint(length[:], uint64(len(key)))
		buffer.Write(length[:n])
		buffer.WriteString(key)
		n = binary.PutUvarint(length[:], uint64(len(value)))
		buffer.Write(length[:n])
		buffer.WriteString(value)
	}
	return buffer.Bytes()
}

func stableARN(record *kmsKeyRecord) string {
	return "arn:" + LocalPartition + ":kms:" + LocalRegion + ":" + LocalAccountID + ":key/" + record.StableID
}

// newKMSUUID returns a random UUIDv4 string.
func newKMSUUID() (string, error) {
	var raw [16]byte
	if _, err := io.ReadFull(rand.Reader, raw[:]); err != nil {
		return "", fmt.Errorf("generate a local KMS id: %w", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func writeKMSJSON(writer http.ResponseWriter, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		writeKMSError(writer, http.StatusInternalServerError, "KMSInternalException", err.Error())
		return
	}
	writer.Header().Set("Content-Type", kmsFrontJSONType)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(payload) //nolint:errcheck // the response is already committed
}

// kmsStringField returns a top-level string field from a JSON request body.
func kmsStringField(body []byte, name string) string {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return ""
	}
	var value string
	_ = json.Unmarshal(fields[name], &value) //nolint:errcheck // a non-string or absent field is empty
	return value
}
