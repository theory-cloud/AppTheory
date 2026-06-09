package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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
	return &s3.GetObjectOutput{
		Body:        &trackingReadCloser{Reader: bytes.NewReader(c.getBody), closed: &c.bodyClosed},
		VersionId:   aws.String(c.getVersionID),
		ContentType: aws.String(c.contentType),
		Metadata:    cloneMetadata(c.metadata),
	}, nil
}

func (c *recordingS3Client) DeleteObject(_ context.Context, params *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	c.operations = append(c.operations, "DeleteObject")
	c.deleteInput = params
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
