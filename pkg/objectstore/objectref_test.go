package objectstore

import (
	"errors"
	"testing"
)

func TestParseObjectRef(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want ObjectRef
	}{
		{
			name: "simple",
			raw:  "s3://bucket-a/path/to/object.json",
			want: ObjectRef{Bucket: "bucket-a", Key: "path/to/object.json"},
		},
		{
			name: "preserves bucket and key exactly",
			raw:  "s3://bucket.with.dots/Prefix/Case%2Fkept.json",
			want: ObjectRef{Bucket: "bucket.with.dots", Key: "Prefix/Case%2Fkept.json"},
		},
		{
			name: "key can start with slash",
			raw:  "s3://bucket-a//leading/slash.json",
			want: ObjectRef{Bucket: "bucket-a", Key: "/leading/slash.json"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseObjectRef(tt.raw)
			if err != nil {
				t.Fatalf("ParseObjectRef() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("ParseObjectRef() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestParseObjectRefInvalid(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "empty", raw: ""},
		{name: "trimmed ref rejected", raw: " s3://bucket-a/key"},
		{name: "wrong scheme", raw: "https://bucket-a/key"},
		{name: "uppercase scheme", raw: "S3://bucket-a/key"},
		{name: "missing bucket", raw: "s3:///key"},
		{name: "missing key", raw: "s3://bucket-a/"},
		{name: "missing slash", raw: "s3://bucket-a"},
		{name: "query rejected", raw: "s3://bucket-a/key?versionId=1"},
		{name: "fragment rejected", raw: "s3://bucket-a/key#frag"},
		{name: "bucket space rejected", raw: "s3://bucket a/key"},
		{name: "bucket control rejected", raw: "s3://bucket\na/key"},
		{name: "key control rejected", raw: "s3://bucket-a/key\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseObjectRef(tt.raw)
			if !errors.Is(err, ErrInvalidObjectRef) {
				t.Fatalf("ParseObjectRef() error = %v, want ErrInvalidObjectRef", err)
			}
		})
	}
}

func TestObjectRefValidate(t *testing.T) {
	tests := []struct {
		name string
		ref  ObjectRef
	}{
		{name: "basic", ref: ObjectRef{Bucket: "bucket-a", Key: "key"}},
		{name: "versioned", ref: ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "version-1"}},
		{name: "space in key preserved", ref: ObjectRef{Bucket: "bucket-a", Key: "key with spaces"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.ref.Validate(); err != nil {
				t.Fatalf("Validate() error = %v", err)
			}
		})
	}
}

func TestObjectRefValidateInvalid(t *testing.T) {
	tests := []struct {
		name string
		ref  ObjectRef
	}{
		{name: "missing bucket", ref: ObjectRef{Key: "key"}},
		{name: "missing key", ref: ObjectRef{Bucket: "bucket-a"}},
		{name: "bucket slash", ref: ObjectRef{Bucket: "bucket/a", Key: "key"}},
		{name: "bucket query", ref: ObjectRef{Bucket: "bucket-a?x", Key: "key"}},
		{name: "key query", ref: ObjectRef{Bucket: "bucket-a", Key: "key?x"}},
		{name: "version query", ref: ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "v?1"}},
		{name: "bucket space", ref: ObjectRef{Bucket: "bucket a", Key: "key"}},
		{name: "key control", ref: ObjectRef{Bucket: "bucket-a", Key: "key\n"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.ref.Validate(); !errors.Is(err, ErrInvalidObjectRef) {
				t.Fatalf("Validate() error = %v, want ErrInvalidObjectRef", err)
			}
		})
	}
}
