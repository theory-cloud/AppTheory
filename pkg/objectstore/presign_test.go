package objectstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	signer "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// helloChecksumSHA256 is the canonical base64 SHA-256 of "hello objectstore".
const helloChecksumSHA256 = "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc="

func validPresignPutInput() PresignPutInput {
	return PresignPutInput{
		Ref:            ObjectRef{Bucket: "bucket-a", Key: "objects/alpha.txt"},
		ContentLength:  17,
		ChecksumSHA256: helloChecksumSHA256,
		ContentType:    "text/plain; charset=utf-8",
		MaxBytes:       1 << 20,
		ExpiresIn:      15 * time.Minute,
	}
}

func TestPresignPutChecksumFixtureMatchesPayload(t *testing.T) {
	digest := sha256.Sum256([]byte("hello objectstore"))
	if got := base64.StdEncoding.EncodeToString(digest[:]); got != helloChecksumSHA256 {
		t.Fatalf("fixture checksum = %q, want %q", got, helloChecksumSHA256)
	}
}

func TestPresignPutInputValidation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*PresignPutInput)
		want   error
	}{
		{
			name:   "valid-at-cap",
			mutate: func(*PresignPutInput) {},
		},
		{
			name:   "valid-below-cap",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = time.Second },
		},
		{
			name:   "missing-version-required",
			mutate: func(input *PresignPutInput) { input.Ref.VersionID = "v1" },
			want:   ErrInvalidObjectRef,
		},
		{
			name:   "malformed-ref",
			mutate: func(input *PresignPutInput) { input.Ref.Key = "" },
			want:   ErrInvalidObjectRef,
		},
		{
			name:   "ref-with-query",
			mutate: func(input *PresignPutInput) { input.Ref.Key = "objects/alpha.txt?versionId=1" },
			want:   ErrInvalidObjectRef,
		},
		{
			name:   "missing-length",
			mutate: func(input *PresignPutInput) { input.ContentLength = 0 },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "negative-length",
			mutate: func(input *PresignPutInput) { input.ContentLength = -1 },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "length-over-max-bytes",
			mutate: func(input *PresignPutInput) { input.MaxBytes = input.ContentLength - 1 },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "missing-max-bytes",
			mutate: func(input *PresignPutInput) { input.MaxBytes = 0 },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "missing-checksum",
			mutate: func(input *PresignPutInput) { input.ChecksumSHA256 = "" },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "checksum-wrong-length",
			mutate: func(input *PresignPutInput) { input.ChecksumSHA256 = "c2hvcnQ=" },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "checksum-wrong-alphabet",
			mutate: func(input *PresignPutInput) { input.ChecksumSHA256 = strings.Repeat("*", 43) + "=" },
			want:   ErrInvalidPresignPut,
		},
		{
			name: "checksum-non-canonical-padding",
			mutate: func(input *PresignPutInput) {
				input.ChecksumSHA256 = helloChecksumSHA256[:43] + "9"
			},
			want: ErrInvalidPresignPut,
		},
		{
			name:   "missing-content-type",
			mutate: func(input *PresignPutInput) { input.ContentType = "" },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "padded-content-type",
			mutate: func(input *PresignPutInput) { input.ContentType = " text/plain " },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "content-type-header-injection",
			mutate: func(input *PresignPutInput) { input.ContentType = "text/plain\r\nx-amz-acl: public-read" },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "missing-expiry",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = 0 },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "negative-expiry",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = -time.Minute },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "expiry-over-framework-cap",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = MaxPresignPutExpiresIn + time.Second },
			want:   ErrInvalidPresignPut,
		},
		{
			// The grant carries the expiry as the integer X-Amz-Expires; a sub-second expiry would
			// be truncated to zero by the signer and mint an already-expired link.
			name:   "sub-second-expiry",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = 500 * time.Millisecond },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "fractional-expiry",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = 1500 * time.Millisecond },
			want:   ErrInvalidPresignPut,
		},
		{
			name:   "nanosecond-expiry",
			mutate: func(input *PresignPutInput) { input.ExpiresIn = 900*time.Second + time.Nanosecond },
			want:   ErrInvalidPresignPut,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validPresignPutInput()
			test.mutate(&input)
			err := input.Validate()
			if test.want == nil {
				if err != nil {
					t.Fatalf("input.Validate() error = %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, test.want) {
				t.Fatalf("input.Validate() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestPresignPutHeadersCarryTheGrantedConstraints(t *testing.T) {
	headers := presignPutHeaders(validPresignPutInput())
	want := map[string]string{
		"content-length":        "17",
		"content-type":          "text/plain; charset=utf-8",
		"x-amz-checksum-sha256": helloChecksumSHA256,
	}
	if len(headers) != len(want) {
		t.Fatalf("headers = %v, want exactly %d entries", headers, len(want))
	}
	for name, value := range want {
		if headers[name] != value {
			t.Fatalf("headers[%q] = %q, want %q", name, headers[name], value)
		}
	}
}

func TestVerifyPresignPutURLFailClosed(t *testing.T) {
	strong := "https://bucket-a.s3.us-east-1.amazonaws.com/objects/alpha.txt" +
		"?X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256"
	tests := []struct {
		name string
		url  string
		want error
	}{
		{name: "strong-signature", url: strong},
		{
			name: "sigv2-shape-has-no-signed-headers",
			url:  "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?AWSAccessKeyId=A&Expires=1&Signature=s",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "checksum-hoisted-into-query",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&x-amz-checksum-sha256=abc",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "checksum-not-signed",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "content-type-not-signed",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "content-length-not-signed",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-over-framework-cap",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=1800" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-outlives-requested",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "missing-expiry",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "queryless-url",
			url:  "https://bucket-a.s3.amazonaws.com/objects/alpha.txt",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "unparseable-url",
			url:  "https://bucket-a.s3.amazonaws.com/%zz?a=b",
			want: ErrInvalidStoreConfig,
		},
		// X-Amz-Expires must be bare ASCII digits, in every runtime.
		{
			name: "expiry-with-sign",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=%2B900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-padded",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=%20900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-underscored",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=9_00" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-fractional",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900.0" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-fullwidth-digits",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=%EF%BC%99%EF%BC%90%EF%BC%90" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
			want: ErrInvalidStoreConfig,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requested := 15 * time.Minute
			if test.name == "expiry-outlives-requested" {
				requested = time.Minute
			}
			err := verifyPresignPutURL(test.url, requested)
			if test.want == nil {
				if err != nil {
					t.Fatalf("verifyPresignPutURL() error = %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, test.want) {
				t.Fatalf("verifyPresignPutURL() error = %v, want %v", err, test.want)
			}
		})
	}
}

// TestS3StorePresignPutSignsConstraintHeaders is the security proof for the Go runtime: the real
// AWS SDK presigner is asked for an upload grant and the resulting URL is inspected directly.
func TestS3StorePresignPutSignsConstraintHeaders(t *testing.T) {
	client := s3.NewFromConfig(aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKIAEXAMPLE", "secret", ""),
	})
	store, err := newS3StoreWithClient(client, S3StoreConfig{}, withS3Presigner(s3.NewPresignClient(client)))
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	before := time.Now()
	out, err := store.PresignPut(context.Background(), validPresignPutInput())
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if out.Method != "PUT" {
		t.Fatalf("Method = %q, want PUT", out.Method)
	}
	if out.Ref != validPresignPutInput().Ref {
		t.Fatalf("Ref = %+v, want the requested ref", out.Ref)
	}

	parsed, err := url.Parse(out.URL)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	query := parsed.Query()

	signed := parsed.Query().Get("X-Amz-SignedHeaders")
	if signed == "" {
		t.Fatalf("presigned url has no X-Amz-SignedHeaders: %s", out.URL)
	}
	for _, required := range []string{"content-length", "content-type", "x-amz-checksum-sha256"} {
		if !strings.Contains(strings.ToLower(signed), required) {
			t.Fatalf("X-Amz-SignedHeaders = %q, must sign %q", signed, required)
		}
	}
	for _, required := range []string{"content-length", "content-type", "x-amz-checksum-sha256"} {
		if query.Has(required) {
			t.Fatalf("query parameter %q must not be an unsigned query parameter: %s", required, out.URL)
		}
	}
	if got := query.Get("X-Amz-Expires"); got != "900" {
		t.Fatalf("X-Amz-Expires = %q, want 900", got)
	}
	expiresAt := out.ExpiresAt
	if expiresAt.Before(before.Add(15*time.Minute)) || expiresAt.After(time.Now().Add(15*time.Minute)) {
		t.Fatalf("ExpiresAt = %s, want now + 15m", expiresAt)
	}
}

func TestS3StorePresignPutFailsClosedOnWeakSignature(t *testing.T) {
	signedHeaders := []string{"content-length", "content-type", "host", "x-amz-checksum-sha256"}
	tests := []struct {
		name string
		url  string
		want error
	}{
		{
			name: "hoisted-checksum",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900" +
				"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&x-amz-checksum-sha256=" + url.QueryEscape(helloChecksumSHA256),
			want: ErrInvalidStoreConfig,
		},
		{
			name: "no-signed-headers",
			url:  "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900",
			want: ErrInvalidStoreConfig,
		},
		{
			name: "expiry-over-cap",
			url: "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=3600&X-Amz-SignedHeaders=" +
				url.QueryEscape(strings.Join(signedHeaders, ";")),
			want: ErrInvalidStoreConfig,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, err := newS3StoreWithClient(&recordingS3Client{}, S3StoreConfig{},
				withS3Presigner(&stubPresignPutClient{url: test.url}))
			if err != nil {
				t.Fatalf("newS3StoreWithClient() error = %v", err)
			}
			if _, err := store.PresignPut(context.Background(), validPresignPutInput()); !errors.Is(err, test.want) {
				t.Fatalf("PresignPut() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestS3StorePresignPutRequiresPresigner(t *testing.T) {
	store, err := newS3StoreWithClient(&recordingS3Client{}, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}
	if _, err := store.PresignPut(context.Background(), validPresignPutInput()); !errors.Is(err, ErrInvalidStoreConfig) {
		t.Fatalf("PresignPut() error = %v, want ErrInvalidStoreConfig", err)
	}

	var nilStore *s3Store
	if _, err := nilStore.PresignPut(context.Background(), validPresignPutInput()); !errors.Is(err, ErrInvalidStoreConfig) {
		t.Fatalf("nil store PresignPut() error = %v, want ErrInvalidStoreConfig", err)
	}

	// Request validation is reported before capability problems, in every runtime.
	invalid := validPresignPutInput()
	invalid.ChecksumSHA256 = ""
	if _, err := store.PresignPut(context.Background(), invalid); !errors.Is(err, ErrInvalidPresignPut) {
		t.Fatalf("PresignPut() error = %v, want ErrInvalidPresignPut", err)
	}
}

func TestS3StorePresignPutValidationPrecedesSigning(t *testing.T) {
	presigner := &stubPresignPutClient{url: "https://example.invalid/?X-Amz-Expires=1&X-Amz-SignedHeaders=host"}
	store, err := newS3StoreWithClient(&recordingS3Client{}, S3StoreConfig{}, withS3Presigner(presigner))
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}
	input := validPresignPutInput()
	input.ChecksumSHA256 = ""
	if _, err := store.PresignPut(context.Background(), input); !errors.Is(err, ErrInvalidPresignPut) {
		t.Fatalf("PresignPut() error = %v, want ErrInvalidPresignPut", err)
	}
	if presigner.calls != 0 {
		t.Fatalf("presigner calls = %d, want 0 (must fail closed before signing)", presigner.calls)
	}
}

func TestS3StorePresignPutPropagatesSignerError(t *testing.T) {
	signerErr := errors.New("signer unavailable")
	store, err := newS3StoreWithClient(&recordingS3Client{}, S3StoreConfig{},
		withS3Presigner(&stubPresignPutClient{err: signerErr}))
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}
	if _, err := store.PresignPut(context.Background(), validPresignPutInput()); !errors.Is(err, signerErr) {
		t.Fatalf("PresignPut() error = %v, want %v", err, signerErr)
	}
}

func TestS3StorePresignPutRejectsNilSignedRequest(t *testing.T) {
	store, err := newS3StoreWithClient(&recordingS3Client{}, S3StoreConfig{}, withS3Presigner(&stubPresignPutClient{}))
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}
	if _, err := store.PresignPut(context.Background(), validPresignPutInput()); !errors.Is(err, ErrInvalidStoreConfig) {
		t.Fatalf("PresignPut() error = %v, want ErrInvalidStoreConfig", err)
	}
}

type stubPresignPutClient struct {
	url   string
	err   error
	calls int
	input *s3.PutObjectInput
	opts  s3.PresignOptions
}

func (c *stubPresignPutClient) PresignPutObject(
	_ context.Context,
	params *s3.PutObjectInput,
	optFns ...func(*s3.PresignOptions),
) (*signer.PresignedHTTPRequest, error) {
	c.calls++
	c.input = params
	if len(optFns) > 0 {
		optFns[0](&c.opts)
	}
	if c.err != nil {
		return nil, c.err
	}
	if c.url == "" {
		return nil, nil
	}
	return &signer.PresignedHTTPRequest{URL: c.url, Method: "PUT"}, nil
}
