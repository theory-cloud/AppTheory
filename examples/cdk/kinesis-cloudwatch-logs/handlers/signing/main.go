package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

const (
	signingKeyARNEnv   = "SIGNING_KEY_ARN"
	signingKeyAliasEnv = "SIGNING_KEY_ALIAS"
	dataKeyARNEnv      = "DATA_KEY_ARN"
	dataDirPlaintext   = "apptheory-data-dir-plaintext"
	dataDirMessage     = "apptheory-data-dir-signature"
)

var signingAlgorithm = kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256

type event struct {
	// Mode selects the --data-dir proof; an empty event keeps the wave-1 row.
	Mode              string `json:"mode"`
	Ciphertext        string `json:"ciphertext"`
	DataKeyCiphertext string `json:"dataKeyCiphertext"`
	Signature         string `json:"signature"`
	Message           string `json:"message"`
	PublicKey         string `json:"publicKey"`
	// The identities run 1 observed: a KMS key's id and ARN are permanent for
	// the key's lifetime, so run 2 must see the same ones and a signature made
	// in run 1 must Verify under the run-1 key id.
	SigningKeyID  string `json:"signingKeyId"`
	SigningKeyARN string `json:"signingKeyArn"`
	DataKeyID     string `json:"dataKeyId"`
	DataKeyARN    string `json:"dataKeyArn"`
}

type result struct {
	Alias             string `json:"alias"`
	KeyARN            string `json:"keyArn"`
	AliasSignatureLen int    `json:"aliasSignatureLength"`
	ARNSignatureLen   int    `json:"arnSignatureLength"`
	AliasVerified     bool   `json:"aliasVerified"`
	ARNVerified       bool   `json:"arnVerified"`
	PublicKeyBytes    int    `json:"publicKeyBytes"`
	SigningAlgorithms string `json:"signingAlgorithm"`
	// The DIGEST leg: the signature must be over the supplied digest, and a
	// second hash of it must not verify.
	DigestVerified    bool `json:"digestVerified"`
	DigestKMSValid    bool `json:"digestKMSValid"`
	DoubleHashBlocked bool `json:"doubleHashBlocked"`
}

func handler(ctx context.Context, raw json.RawMessage) (any, error) {
	var request event
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, fmt.Errorf("decode the event: %w", err)
		}
	}
	switch request.Mode {
	case "data-dir-write":
		return dataDirWrite(ctx)
	case "data-dir-read":
		return dataDirRead(ctx, request)
	}

	keyARN := strings.TrimSpace(os.Getenv(signingKeyARNEnv))
	alias := strings.TrimSpace(os.Getenv(signingKeyAliasEnv))
	if keyARN == "" || alias == "" {
		return nil, fmt.Errorf("%s and %s must be set", signingKeyARNEnv, signingKeyAliasEnv)
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	client := kms.NewFromConfig(cfg)
	message := []byte("apptheory-local-signing")

	// KMS accepts an alias name as KeyId:
	// https://docs.aws.amazon.com/kms/latest/developerguide/alias-using.html
	aliasSignature, err := client.Sign(ctx, &kms.SignInput{
		KeyId:            &alias,
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("sign with the alias: %w", err)
	}
	aliasVerified, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId:            &alias,
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		Signature:        aliasSignature.Signature,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("verify with the alias: %w", err)
	}

	arnSignature, err := client.Sign(ctx, &kms.SignInput{
		KeyId:            &keyARN,
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("sign with the key ARN: %w", err)
	}
	arnVerified, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId:            &keyARN,
		Message:          message,
		MessageType:      kmstypes.MessageTypeRaw,
		Signature:        arnSignature.Signature,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("verify with the key ARN: %w", err)
	}

	publicKey, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: &alias})
	if err != nil {
		return nil, fmt.Errorf("get the public key: %w", err)
	}
	// DIGEST: the message is a digest and KMS signs it as-is. Verify it
	// outside KMS with the public key from GetPublicKey, the check that caught
	// moto's double hash.
	// https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html
	digest := sha256.Sum256(message)
	digestSignature, err := client.Sign(ctx, &kms.SignInput{
		KeyId:            &alias,
		Message:          digest[:],
		MessageType:      kmstypes.MessageTypeDigest,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("sign the digest: %w", err)
	}
	public, err := x509.ParsePKIXPublicKey(publicKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("parse the public key: %w", err)
	}
	rsaPublic, ok := public.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("the public key is %T, want RSA", public)
	}
	digestVerified := rsa.VerifyPKCS1v15(rsaPublic, crypto.SHA256, digest[:], digestSignature.Signature) == nil
	double := sha256.Sum256(digest[:])
	doubleHashBlocked := rsa.VerifyPKCS1v15(rsaPublic, crypto.SHA256, double[:], digestSignature.Signature) != nil
	digestInKMS, err := client.Verify(ctx, &kms.VerifyInput{
		KeyId:            &alias,
		Message:          digest[:],
		MessageType:      kmstypes.MessageTypeDigest,
		Signature:        digestSignature.Signature,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("verify the digest: %w", err)
	}

	return result{
		Alias:             alias,
		KeyARN:            keyARN,
		AliasSignatureLen: len(aliasSignature.Signature),
		ARNSignatureLen:   len(arnSignature.Signature),
		AliasVerified:     aliasVerified.SignatureValid,
		ARNVerified:       arnVerified.SignatureValid,
		PublicKeyBytes:    len(publicKey.PublicKey),
		SigningAlgorithms: string(signingAlgorithm),
		DigestVerified:    digestVerified,
		DigestKMSValid:    digestInKMS.SignatureValid,
		DoubleHashBlocked: doubleHashBlocked,
	}, nil
}

// dataDirWrite runs in run 1 of the --data-dir KMS row: it encrypts under the
// symmetric key, generates a data key, and signs a digest with the asymmetric
// key. The harness passes the returned values to run 2.
func dataDirWrite(ctx context.Context) (any, error) {
	client, alias, dataKeyARN, err := dataDirClient(ctx)
	if err != nil {
		return nil, err
	}
	signingKey, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: &alias})
	if err != nil {
		return nil, fmt.Errorf("describe the signing key for --data-dir: %w", err)
	}
	dataKeyMetadata, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: &dataKeyARN})
	if err != nil {
		return nil, fmt.Errorf("describe the data key for --data-dir: %w", err)
	}
	encrypted, err := client.Encrypt(ctx, &kms.EncryptInput{
		KeyId:     &dataKeyARN,
		Plaintext: []byte(dataDirPlaintext),
	})
	if err != nil {
		return nil, fmt.Errorf("encrypt for --data-dir: %w", err)
	}
	generated, err := client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:   &dataKeyARN,
		KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		return nil, fmt.Errorf("generate a data key for --data-dir: %w", err)
	}
	digest := sha256.Sum256([]byte(dataDirMessage))
	signature, err := client.Sign(ctx, &kms.SignInput{
		KeyId:            &alias,
		Message:          digest[:],
		MessageType:      kmstypes.MessageTypeDigest,
		SigningAlgorithm: signingAlgorithm,
	})
	if err != nil {
		return nil, fmt.Errorf("sign for --data-dir: %w", err)
	}
	publicKey, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: &alias})
	if err != nil {
		return nil, fmt.Errorf("get the public key for --data-dir: %w", err)
	}
	return map[string]any{
		"mode":              "data-dir-write",
		"ciphertext":        base64.StdEncoding.EncodeToString(encrypted.CiphertextBlob),
		"dataKeyCiphertext": base64.StdEncoding.EncodeToString(generated.CiphertextBlob),
		"signature":         base64.StdEncoding.EncodeToString(signature.Signature),
		"message":           dataDirMessage,
		"publicKey":         base64.StdEncoding.EncodeToString(publicKey.PublicKey),
		"signingKeyId":      aws.ToString(signingKey.KeyMetadata.KeyId),
		"signingKeyArn":     aws.ToString(signingKey.KeyMetadata.Arn),
		"dataKeyId":         aws.ToString(dataKeyMetadata.KeyMetadata.KeyId),
		"dataKeyArn":        aws.ToString(dataKeyMetadata.KeyMetadata.Arn),
	}, nil
}

// dataDirRead runs in run 2 with the same --data-dir: it decrypts the run 1
// ciphertexts by the run-1 key id and verifies the run 1 signature through KMS
// with the run-1 key id and ARN, then with the run 2 public key.
func dataDirRead(ctx context.Context, request event) (any, error) {
	client, alias, dataKeyARN, err := dataDirClient(ctx)
	if err != nil {
		return nil, err
	}
	signingKey, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: &alias})
	if err != nil {
		return nil, fmt.Errorf("describe the signing key in run 2: %w", err)
	}
	dataKeyMetadata, err := client.DescribeKey(ctx, &kms.DescribeKeyInput{KeyId: &dataKeyARN})
	if err != nil {
		return nil, fmt.Errorf("describe the data key in run 2: %w", err)
	}
	// The run-1 key id is what a caller recorded (Autheory pins its JWKS kid
	// from it); decrypting and verifying by it is the restart proof.
	decryptKey := request.DataKeyID
	if decryptKey == "" {
		decryptKey = dataKeyARN
	}
	ciphertext, err := base64.StdEncoding.DecodeString(request.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decode the ciphertext: %w", err)
	}
	decrypted, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: ciphertext,
		KeyId:          &decryptKey,
	})
	if err != nil {
		return nil, fmt.Errorf("decrypt across --data-dir: %w", err)
	}
	dataKeyCiphertext, err := base64.StdEncoding.DecodeString(request.DataKeyCiphertext)
	if err != nil {
		return nil, fmt.Errorf("decode the data key ciphertext: %w", err)
	}
	dataKey, err := client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: dataKeyCiphertext,
		KeyId:          &decryptKey,
	})
	if err != nil {
		return nil, fmt.Errorf("decrypt the data key across --data-dir: %w", err)
	}
	publicKey, err := client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: &alias})
	if err != nil {
		return nil, fmt.Errorf("get the public key in run 2: %w", err)
	}
	publicKeyStable := base64.StdEncoding.EncodeToString(publicKey.PublicKey) == request.PublicKey
	signature, err := base64.StdEncoding.DecodeString(request.Signature)
	if err != nil {
		return nil, fmt.Errorf("decode the signature: %w", err)
	}
	public, err := x509.ParsePKIXPublicKey(publicKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("parse the public key in run 2: %w", err)
	}
	rsaPublic, ok := public.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("the public key is %T, want RSA", public)
	}
	digest := sha256.Sum256([]byte(request.Message))
	signatureVerified := rsa.VerifyPKCS1v15(rsaPublic, crypto.SHA256, digest[:], signature) == nil
	verifyWith := func(keyID string) bool {
		if keyID == "" {
			return false
		}
		verified, verifyErr := client.Verify(ctx, &kms.VerifyInput{
			KeyId:            aws.String(keyID),
			Message:          digest[:],
			MessageType:      kmstypes.MessageTypeDigest,
			Signature:        signature,
			SigningAlgorithm: signingAlgorithm,
		})
		return verifyErr == nil && verified.SignatureValid
	}
	return map[string]any{
		"mode":               "data-dir-read",
		"plaintext":          string(decrypted.Plaintext),
		"dataKeyLength":      len(dataKey.Plaintext),
		"publicKeyStable":    publicKeyStable,
		"signatureVerified":  signatureVerified,
		"keyIdStable":        aws.ToString(signingKey.KeyMetadata.KeyId) == request.SigningKeyID,
		"keyArnStable":       aws.ToString(signingKey.KeyMetadata.Arn) == request.SigningKeyARN,
		"dataKeyIdStable":    aws.ToString(dataKeyMetadata.KeyMetadata.KeyId) == request.DataKeyID,
		"dataKeyArnStable":   aws.ToString(dataKeyMetadata.KeyMetadata.Arn) == request.DataKeyARN,
		"run1KeyIdVerified":  verifyWith(request.SigningKeyID),
		"run1KeyArnVerified": verifyWith(request.SigningKeyARN),
	}, nil
}

func dataDirClient(ctx context.Context) (*kms.Client, string, string, error) {
	alias := strings.TrimSpace(os.Getenv(signingKeyAliasEnv))
	dataKeyARN := strings.TrimSpace(os.Getenv(dataKeyARNEnv))
	if alias == "" || dataKeyARN == "" {
		return nil, "", "", fmt.Errorf("%s and %s must be set", signingKeyAliasEnv, dataKeyARNEnv)
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, "", "", fmt.Errorf("load AWS config: %w", err)
	}
	return kms.NewFromConfig(cfg), alias, dataKeyARN, nil
}

func main() {
	lambda.Start(handler)
}
