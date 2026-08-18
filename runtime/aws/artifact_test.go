package runtimeaws

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const verifiedFixtureDigest = "sha256:b7a08ec283db64788286788097854b24cba0095651252167f4e3e961e682412d"

type fakeGetObjectClient struct {
	output *s3.GetObjectOutput
	err    error
	calls  int
	input  *s3.GetObjectInput
}

func (f *fakeGetObjectClient) GetObject(
	_ context.Context,
	input *s3.GetObjectInput,
	_ ...func(*s3.Options),
) (*s3.GetObjectOutput, error) {
	f.calls++
	f.input = input
	return f.output, f.err
}

type trackedReadCloser struct {
	io.Reader
	closed bool
}

func (r *trackedReadCloser) Close() error {
	r.closed = true
	return nil
}

func TestVerifyVersionedArtifactRequiresRequestedVersion(t *testing.T) {
	t.Parallel()

	client := &fakeGetObjectClient{}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, VersionedArtifactRequest{
		Bucket:         "artifacts",
		Key:            "ns/demo/release.tar",
		ExpectedDigest: verifiedFixtureDigest,
	})
	if !errors.Is(err, ErrArtifactVersionRequired) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactVersionRequired", err)
	}
	if artifact.State != ArtifactVerificationVersionRequired {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVersionRequired)
	}
	if client.calls != 0 {
		t.Fatalf("GetObject calls = %d, want 0", client.calls)
	}
}

func TestVerifyVersionedArtifactGetObjectError(t *testing.T) {
	t.Parallel()

	client := &fakeGetObjectClient{err: errors.New("s3 unavailable")}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, validArtifactRequest())
	if !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactUnavailable", err)
	}
	if artifact.State != ArtifactVerificationUnavailable {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationUnavailable)
	}
	assertVersionPinnedGetObject(t, client)
}

func TestVerifyVersionedArtifactReturnedVersionMismatch(t *testing.T) {
	t.Parallel()

	raw := releaseArchive(t)
	body := &trackedReadCloser{Reader: bytes.NewReader(raw)}
	client := &fakeGetObjectClient{output: &s3.GetObjectOutput{
		Body:      body,
		VersionId: awssdk.String("version-returned"),
	}}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, validArtifactRequest())
	if !errors.Is(err, ErrArtifactVersionMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactVersionMismatch", err)
	}
	if artifact.State != ArtifactVerificationVersionMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVersionMismatch)
	}
	if artifact.RequestedVersionID != "version-requested" || artifact.ReturnedVersionID != "version-returned" {
		t.Fatalf("version evidence = requested %q returned %q", artifact.RequestedVersionID, artifact.ReturnedVersionID)
	}
	if !body.closed {
		t.Fatal("GetObject body was not closed")
	}
	assertVersionPinnedGetObject(t, client)
}

func TestVerifyVersionedArtifactMissingReturnedVersionIsMismatch(t *testing.T) {
	t.Parallel()

	client := &fakeGetObjectClient{output: &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(releaseArchive(t))),
	}}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, validArtifactRequest())
	if !errors.Is(err, ErrArtifactVersionMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactVersionMismatch", err)
	}
	if artifact.State != ArtifactVerificationVersionMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVersionMismatch)
	}
}

func TestVerifyVersionedArtifactDigestMismatch(t *testing.T) {
	t.Parallel()

	request := validArtifactRequest()
	request.ExpectedDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	client := verifiedObjectClient(t)
	artifact, err := VerifyVersionedArtifact(context.Background(), client, request)
	if !errors.Is(err, ErrArtifactDigestMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactDigestMismatch", err)
	}
	if artifact.State != ArtifactVerificationDigestMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationDigestMismatch)
	}
	if artifact.ActualDigest != verifiedFixtureDigest {
		t.Fatalf("actual digest = %q, want %q", artifact.ActualDigest, verifiedFixtureDigest)
	}
	if got := artifact.ArchiveBytes(); got != nil {
		t.Fatalf("ArchiveBytes() after mismatch = %d bytes, want nil", len(got))
	}
	assertVersionPinnedGetObject(t, client)
}

func TestVerifyVersionedArtifactHappyPath(t *testing.T) {
	t.Parallel()

	raw := releaseArchive(t)
	body := &trackedReadCloser{Reader: bytes.NewReader(raw)}
	client := &fakeGetObjectClient{output: &s3.GetObjectOutput{
		Body:      body,
		VersionId: awssdk.String("version-requested"),
	}}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, validArtifactRequest())
	if err != nil {
		t.Fatalf("VerifyVersionedArtifact() error = %v", err)
	}
	if artifact.State != ArtifactVerificationVerified {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVerified)
	}
	if artifact.ActualDigest != verifiedFixtureDigest {
		t.Fatalf("actual digest = %q, want %q", artifact.ActualDigest, verifiedFixtureDigest)
	}
	if !body.closed {
		t.Fatal("GetObject body was not closed")
	}
	assertVersionPinnedGetObject(t, client)

	archiveCopy := artifact.ArchiveBytes()
	if !bytes.Equal(archiveCopy, raw) {
		t.Fatal("ArchiveBytes() did not preserve the fetched archive")
	}
	archiveCopy[0] ^= 0xff
	if bytes.Equal(artifact.ArchiveBytes(), archiveCopy) {
		t.Fatal("ArchiveBytes() did not return a defensive copy")
	}

	entries := artifact.Entries()
	if len(entries) != 2 {
		t.Fatalf("Entries() count = %d, want 2", len(entries))
	}
	if entries[0].Path != "release.json" || string(entries[0].Bytes()) != `{"app":"demo"}` {
		t.Fatalf("Entries()[0] = path %q content %q", entries[0].Path, string(entries[0].Bytes()))
	}
	entryBytes := entries[0].Bytes()
	entryBytes[0] = 'X'
	if string(artifact.Entries()[0].Bytes()) != `{"app":"demo"}` {
		t.Fatal("Entries() did not return defensive content copies")
	}
}

func TestVerifyVersionedArtifactRejectsInvalidArchive(t *testing.T) {
	t.Parallel()

	client := &fakeGetObjectClient{output: &s3.GetObjectOutput{
		Body:      io.NopCloser(bytes.NewReader([]byte("not a tar archive"))),
		VersionId: awssdk.String("version-requested"),
	}}
	artifact, err := VerifyVersionedArtifact(context.Background(), client, validArtifactRequest())
	if !errors.Is(err, ErrArtifactArchiveInvalid) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
	}
	if artifact.State != ArtifactVerificationArchiveInvalid {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
	}
}

func validArtifactRequest() VersionedArtifactRequest {
	return VersionedArtifactRequest{
		Bucket:         " artifacts ",
		Key:            " ns/demo/release.tar ",
		VersionID:      " version-requested ",
		ExpectedDigest: verifiedFixtureDigest,
	}
}

func verifiedObjectClient(t *testing.T) *fakeGetObjectClient {
	t.Helper()
	return &fakeGetObjectClient{output: &s3.GetObjectOutput{
		Body:      io.NopCloser(bytes.NewReader(releaseArchive(t))),
		VersionId: awssdk.String("version-requested"),
	}}
}

func assertVersionPinnedGetObject(t *testing.T, client *fakeGetObjectClient) {
	t.Helper()
	if client.calls != 1 {
		t.Fatalf("GetObject calls = %d, want 1", client.calls)
	}
	if client.input == nil {
		t.Fatal("GetObject input is nil")
	}
	if got := awssdk.ToString(client.input.Bucket); got != "artifacts" {
		t.Fatalf("GetObject Bucket = %q, want artifacts", got)
	}
	if got := awssdk.ToString(client.input.Key); got != "ns/demo/release.tar" {
		t.Fatalf("GetObject Key = %q, want ns/demo/release.tar", got)
	}
	if got := awssdk.ToString(client.input.VersionId); got != "version-requested" {
		t.Fatalf("GetObject VersionId = %q, want version-requested", got)
	}
}

func releaseArchive(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	files := []struct {
		path    string
		content string
	}{
		{path: "release.json", content: `{"app":"demo"}`},
		{path: "cdk/app.template.json", content: `{}`},
	}
	for _, file := range files {
		if err := writer.WriteHeader(&tar.Header{
			Name:     file.path,
			Mode:     0o644,
			Size:     int64(len(file.content)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatalf("WriteHeader(%q) error = %v", file.path, err)
		}
		if _, err := writer.Write([]byte(file.content)); err != nil {
			t.Fatalf("Write(%q) error = %v", file.path, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar Close() error = %v", err)
	}
	return buffer.Bytes()
}
