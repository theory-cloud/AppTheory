package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func TestS3StorePutGetDelete(t *testing.T) {
	client := &recordingS3Client{
		putVersionID: "put-v1",
		getVersionID: "get-v1",
		getBody:      []byte("payload"),
		contentType:  "application/json",
		metadata:     map[string]string{"sha256": "abc"},
	}
	store, err := newS3StoreWithClient(client, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	putRef, err := store.Put(context.Background(), PutInput{
		Ref:         ObjectRef{Bucket: "bucket-a", Key: "objects/1.json"},
		Payload:     []byte("payload"),
		ContentType: "application/json",
		Metadata:    map[string]string{"sha256": "abc"},
	})
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if putRef != (ObjectRef{Bucket: "bucket-a", Key: "objects/1.json", VersionID: "put-v1"}) {
		t.Fatalf("Put() ref = %#v", putRef)
	}
	if aws.ToString(client.putInput.Bucket) != "bucket-a" || aws.ToString(client.putInput.Key) != "objects/1.json" {
		t.Fatalf("PutObject bucket/key mismatch: %#v", client.putInput)
	}
	if client.putInput.Metadata["sha256"] != "abc" || aws.ToString(client.putInput.ContentType) != "application/json" {
		t.Fatalf("PutObject metadata/content type mismatch: %#v", client.putInput)
	}

	got, err := store.Get(context.Background(), GetInput{
		Ref:      ObjectRef{Bucket: "bucket-a", Key: "objects/1.json", VersionID: "get-v1"},
		MaxBytes: 7,
	})
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got.Payload) != "payload" || got.Ref.VersionID != "get-v1" {
		t.Fatalf("Get() output mismatch: %#v", got)
	}
	if got.ContentType != "application/json" || got.Metadata["sha256"] != "abc" {
		t.Fatalf("Get() metadata/content type mismatch: %#v", got)
	}
	if !client.bodyClosed {
		t.Fatalf("Get() did not close body")
	}
	if aws.ToString(client.getInput.VersionId) != "get-v1" {
		t.Fatalf("GetObject VersionId = %q", aws.ToString(client.getInput.VersionId))
	}

	if err := store.Delete(context.Background(), DeleteInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "objects/1.json", VersionID: "del-v1"}}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if aws.ToString(client.deleteInput.VersionId) != "del-v1" {
		t.Fatalf("DeleteObject VersionId = %q", aws.ToString(client.deleteInput.VersionId))
	}
	if !reflect.DeepEqual(client.operations, []string{"PutObject", "GetObject", "DeleteObject"}) {
		t.Fatalf("operations = %#v", client.operations)
	}
}

func TestS3StoreGetBoundsAndClosesBody(t *testing.T) {
	client := &recordingS3Client{getBody: []byte("too-large")}
	store, err := newS3StoreWithClient(client, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	_, err = store.Get(context.Background(), GetInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key"}, MaxBytes: 3})
	if !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("Get() error = %v, want ErrObjectTooLarge", err)
	}
	if !client.bodyClosed {
		t.Fatalf("Get() did not close body after bounded read failure")
	}
}

func TestS3StoreGetVersionIsResponseAttested(t *testing.T) {
	client := &recordingS3Client{getBody: []byte("payload")}
	store, err := newS3StoreWithClient(client, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	got, err := store.Get(context.Background(), GetInput{
		Ref:      ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "requested-version"},
		MaxBytes: 7,
	})
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Ref.VersionID != "" {
		t.Fatalf("Get() response VersionID = %q, want empty without S3 attestation", got.Ref.VersionID)
	}
	if aws.ToString(client.getInput.VersionId) != "requested-version" {
		t.Fatalf("GetObject request VersionId = %q, want requested-version", aws.ToString(client.getInput.VersionId))
	}
}

func TestS3StoreFailClosedValidation(t *testing.T) {
	client := &recordingS3Client{}
	store, err := newS3StoreWithClient(client, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	_, err = store.Put(context.Background(), PutInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "v1"}})
	if !errors.Is(err, ErrInvalidObjectRef) {
		t.Fatalf("Put() with VersionID error = %v, want ErrInvalidObjectRef", err)
	}
	_, err = store.Get(context.Background(), GetInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key"}})
	if !errors.Is(err, ErrInvalidGetLimit) {
		t.Fatalf("Get() without cap error = %v, want ErrInvalidGetLimit", err)
	}
	if err := store.Delete(context.Background(), DeleteInput{Ref: ObjectRef{Bucket: "bucket-a"}}); !errors.Is(err, ErrInvalidObjectRef) {
		t.Fatalf("Delete() invalid ref error = %v, want ErrInvalidObjectRef", err)
	}
	if len(client.operations) != 0 {
		t.Fatalf("invalid requests reached S3 client: %#v", client.operations)
	}
}

func TestS3StoreConfigValidation(t *testing.T) {
	_, err := newS3StoreWithClient(nil, S3StoreConfig{})
	if !errors.Is(err, ErrInvalidStoreConfig) {
		t.Fatalf("newS3StoreWithClient(nil) error = %v, want ErrInvalidStoreConfig", err)
	}
	var nilStore *s3Store
	_, err = nilStore.Get(context.Background(), GetInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key"}, MaxBytes: 1})
	if !errors.Is(err, ErrInvalidStoreConfig) {
		t.Fatalf("nilStore.Get() error = %v, want ErrInvalidStoreConfig", err)
	}
}

func TestNewS3StoreLoadsAWSConfig(t *testing.T) {
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	store, err := NewS3Store(context.Background(), S3StoreConfig{})
	if err != nil {
		t.Fatalf("NewS3Store() error = %v", err)
	}
	if store == nil {
		t.Fatalf("NewS3Store() returned nil store")
	}
}

type recordingS3Client struct {
	operations   []string
	putInput     *s3.PutObjectInput
	getInput     *s3.GetObjectInput
	deleteInput  *s3.DeleteObjectInput
	putVersionID string
	getVersionID string
	getBody      []byte
	getErr       error
	deleteErr    error
	contentType  string
	metadata     map[string]string
	bodyClosed   bool
}

func (c *recordingS3Client) PutObject(_ context.Context, params *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	c.operations = append(c.operations, "PutObject")
	c.putInput = params
	return &s3.PutObjectOutput{VersionId: aws.String(c.putVersionID)}, nil
}

func (c *recordingS3Client) GetObject(_ context.Context, params *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	c.operations = append(c.operations, "GetObject")
	c.getInput = params
	if c.getErr != nil {
		return nil, c.getErr
	}
	output := &s3.GetObjectOutput{
		Body:        &trackingReadCloser{Reader: bytes.NewReader(c.getBody), closed: &c.bodyClosed},
		ContentType: aws.String(c.contentType),
		Metadata:    cloneMetadata(c.metadata),
	}
	if c.getVersionID != "" {
		output.VersionId = aws.String(c.getVersionID)
	}
	return output, nil
}

func (c *recordingS3Client) DeleteObject(_ context.Context, params *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	c.operations = append(c.operations, "DeleteObject")
	c.deleteInput = params
	if c.deleteErr != nil {
		return nil, c.deleteErr
	}
	return &s3.DeleteObjectOutput{}, nil
}

type trackingReadCloser struct {
	io.Reader
	closed *bool
}

func (r *trackingReadCloser) Close() error {
	*r.closed = true
	return nil
}

func TestS3StoreEncryption(t *testing.T) {
	tests := []struct {
		name      string
		config    S3StoreConfig
		wantSSE   types.ServerSideEncryption
		wantKMSID string
	}{
		{name: "bucket default", config: S3StoreConfig{}, wantSSE: ""},
		{
			name:    "s3 managed",
			config:  S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionS3Managed}},
			wantSSE: types.ServerSideEncryptionAes256,
		},
		{
			name:      "kms",
			config:    S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionKMS, KMSKeyID: "arn:aws:kms:us-east-1:123456789012:key/abc"}},
			wantSSE:   types.ServerSideEncryptionAwsKms,
			wantKMSID: "arn:aws:kms:us-east-1:123456789012:key/abc",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &recordingS3Client{}
			store, err := newS3StoreWithClient(client, tt.config)
			if err != nil {
				t.Fatalf("newS3StoreWithClient() error = %v", err)
			}
			_, err = store.Put(context.Background(), PutInput{
				Ref:     ObjectRef{Bucket: "bucket-a", Key: "key"},
				Payload: []byte("payload"),
			})
			if err != nil {
				t.Fatalf("Put() error = %v", err)
			}
			if client.putInput.ServerSideEncryption != tt.wantSSE {
				t.Fatalf("ServerSideEncryption = %q, want %q", client.putInput.ServerSideEncryption, tt.wantSSE)
			}
			if aws.ToString(client.putInput.SSEKMSKeyId) != tt.wantKMSID {
				t.Fatalf("SSEKMSKeyId = %q, want %q", aws.ToString(client.putInput.SSEKMSKeyId), tt.wantKMSID)
			}
		})
	}
}

func TestS3StoreEncryptionFailClosed(t *testing.T) {
	tests := []struct {
		name   string
		config S3StoreConfig
	}{
		{
			name:   "kms mode without key",
			config: S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionKMS}},
		},
		{
			name:   "kms mode with blank key",
			config: S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionKMS, KMSKeyID: " "}},
		},
		{
			name:   "s3 managed with kms key",
			config: S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionS3Managed, KMSKeyID: "key"}},
		},
		{
			name:   "bucket default with kms key",
			config: S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionBucketDefault, KMSKeyID: "key"}},
		},
		{
			name:   "unknown mode",
			config: S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionMode("custom")}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &recordingS3Client{}
			store, err := newS3StoreWithClient(client, tt.config)
			if !errors.Is(err, ErrInvalidEncryptionConfig) {
				t.Fatalf("newS3StoreWithClient() error = %v, want ErrInvalidEncryptionConfig", err)
			}
			if store != nil {
				t.Fatalf("newS3StoreWithClient() returned store for invalid config")
			}
			if len(client.operations) != 0 {
				t.Fatalf("invalid encryption config reached S3 client: %#v", client.operations)
			}
		})
	}
}

func TestNewS3StoreEncryptionValidationPrecedesAWSConfig(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := NewS3Store(ctx, S3StoreConfig{Encryption: S3EncryptionConfig{Mode: S3EncryptionKMS}})
	if !errors.Is(err, ErrInvalidEncryptionConfig) {
		t.Fatalf("NewS3Store() error = %v, want ErrInvalidEncryptionConfig", err)
	}
}

// stubS3APIError carries the two smithy error shapes the store classifies without
// importing smithy-go. NoSuchVersion is not modeled by aws-sdk-go-v2, so this is the
// exact shape a version-specific read produces.
type stubS3APIError struct {
	code   string
	status int
}

func (e *stubS3APIError) Error() string { return e.code }

func (e *stubS3APIError) ErrorCode() string { return e.code }

func (e *stubS3APIError) HTTPStatusCode() int { return e.status }

func TestS3StoreGetMapsMissingObjectToNotFound(t *testing.T) {
	noSuchKey := &types.NoSuchKey{Message: aws.String("The specified key does not exist.")}
	tests := []struct {
		name         string
		err          error
		wantNotFound bool
	}{
		{name: "modeled NoSuchKey", err: noSuchKey, wantNotFound: true},
		{
			name:         "unmodeled NoSuchVersion 404",
			err:          &stubS3APIError{code: "NoSuchVersion", status: http.StatusNotFound},
			wantNotFound: true,
		},
		{name: "generic 404", err: &stubS3APIError{status: http.StatusNotFound}, wantNotFound: true},
		{
			name:         "access denied 403",
			err:          &stubS3APIError{code: "AccessDenied", status: http.StatusForbidden},
			wantNotFound: false,
		},
		{
			name:         "KMS denial 403",
			err:          &stubS3APIError{code: "KMSAccessDeniedException", status: http.StatusForbidden},
			wantNotFound: false,
		},
		{
			name:         "no such bucket 404",
			err:          &stubS3APIError{code: "NoSuchBucket", status: http.StatusNotFound},
			wantNotFound: false,
		},
		{
			name:         "server error 500",
			err:          &stubS3APIError{code: "InternalError", status: http.StatusInternalServerError},
			wantNotFound: false,
		},
		{
			name:         "transport error",
			err:          errors.New("dial tcp 127.0.0.1:443: connect: connection refused"),
			wantNotFound: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &recordingS3Client{getErr: tt.err}
			store, err := newS3StoreWithClient(client, S3StoreConfig{})
			if err != nil {
				t.Fatalf("newS3StoreWithClient() error = %v", err)
			}

			_, err = store.Get(context.Background(), GetInput{
				Ref:      ObjectRef{Bucket: "bucket-a", Key: "key"},
				MaxBytes: 1,
			})
			if err == nil {
				t.Fatalf("Get() error = nil, want failure")
			}
			if got := errors.Is(err, ErrObjectNotFound); got != tt.wantNotFound {
				t.Fatalf("errors.Is(err, ErrObjectNotFound) = %v, want %v (err = %v)", got, tt.wantNotFound, err)
			}
			if !errors.Is(err, tt.err) {
				t.Fatalf("Get() error = %v, want original SDK error preserved", err)
			}
			if len(client.operations) != 1 || client.operations[0] != "GetObject" {
				t.Fatalf("operations = %#v, want one GetObject", client.operations)
			}
			if tt.wantNotFound {
				if !strings.Contains(err.Error(), ErrObjectNotFound.Error()) {
					t.Fatalf("Get() message = %q, want %q in the chain", err.Error(), ErrObjectNotFound.Error())
				}
				var noSuchKeyErr *types.NoSuchKey
				if tt.err == noSuchKey && !errors.As(err, &noSuchKeyErr) {
					t.Fatalf("errors.As(err, *types.NoSuchKey) = false, want true")
				}
			} else if err != tt.err {
				t.Fatalf("Get() error = %v, want the unchanged SDK error %v", err, tt.err)
			}
		})
	}
}

func TestS3StoreDeleteKeepsS3ErrorSemantics(t *testing.T) {
	sentinel := errors.New("s3: delete failed")
	client := &recordingS3Client{deleteErr: sentinel}
	store, err := newS3StoreWithClient(client, S3StoreConfig{})
	if err != nil {
		t.Fatalf("newS3StoreWithClient() error = %v", err)
	}

	err = store.Delete(context.Background(), DeleteInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "missing"}})
	if err != sentinel {
		t.Fatalf("Delete() error = %v, want the unchanged S3 error", err)
	}
	if errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("Delete() error = %v, must not be ErrObjectNotFound", err)
	}
}
