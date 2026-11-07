package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

const (
	signingKeyARNEnv   = "SIGNING_KEY_ARN"
	signingKeyAliasEnv = "SIGNING_KEY_ALIAS"
)

var signingAlgorithm = kmstypes.SigningAlgorithmSpecRsassaPkcs1V15Sha256

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

func handler(ctx context.Context, event json.RawMessage) (any, error) {
	_ = event
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

func main() {
	lambda.Start(handler)
}
