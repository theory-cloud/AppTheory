package runtimeaws

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v3/pkg/objectstore"
	objectstoretest "github.com/theory-cloud/apptheory/v3/testkit/objectstore"
)

const verifiedFixtureDigest = "sha256:b7a08ec283db64788286788097854b24cba0095651252167f4e3e961e682412d"

type stubArtifactStore struct {
	output *objectstore.GetOutput
	err    error
	calls  int
	input  objectstore.GetInput
}

func (s *stubArtifactStore) Put(context.Context, objectstore.PutInput) (objectstore.ObjectRef, error) {
	return objectstore.ObjectRef{}, errors.New("unexpected Put call")
}

func (s *stubArtifactStore) Get(_ context.Context, input objectstore.GetInput) (*objectstore.GetOutput, error) {
	s.calls++
	s.input = input
	return s.output, s.err
}

func (s *stubArtifactStore) Delete(context.Context, objectstore.DeleteInput) error {
	return errors.New("unexpected Delete call")
}

func TestVerifyVersionedArtifactRequiresRequestedVersion(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, VersionedArtifactRequest{
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
	if store.calls != 0 {
		t.Fatalf("Store.Get calls = %d, want 0", store.calls)
	}
}

func TestVerifyVersionedArtifactRejectsNullVersion(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{}
	request := validArtifactRequest()
	request.VersionID = " null "
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if !errors.Is(err, ErrArtifactInvalidRequest) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactInvalidRequest", err)
	}
	if artifact.State != ArtifactVerificationInvalidRequest {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationInvalidRequest)
	}
	if store.calls != 0 {
		t.Fatalf("Store.Get calls = %d, want 0", store.calls)
	}
}

func TestVerifyVersionedArtifactRejectsInvalidRequest(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		mutate func(*VersionedArtifactRequest)
	}{
		{name: "empty bucket", mutate: func(request *VersionedArtifactRequest) { request.Bucket = " " }},
		{name: "empty key", mutate: func(request *VersionedArtifactRequest) { request.Key = " " }},
		{name: "digest missing prefix", mutate: func(request *VersionedArtifactRequest) { request.ExpectedDigest = request.ExpectedDigest[7:] }},
		{name: "digest uppercase", mutate: func(request *VersionedArtifactRequest) {
			request.ExpectedDigest = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		}},
		{name: "digest wrong length", mutate: func(request *VersionedArtifactRequest) { request.ExpectedDigest = "sha256:abcd" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &stubArtifactStore{}
			request := validArtifactRequest()
			test.mutate(&request)
			artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
			if !errors.Is(err, ErrArtifactInvalidRequest) {
				t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactInvalidRequest", err)
			}
			if artifact.State != ArtifactVerificationInvalidRequest {
				t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationInvalidRequest)
			}
			if store.calls != 0 {
				t.Fatalf("Store.Get calls = %d, want 0", store.calls)
			}
		})
	}
}

func TestVerifyVersionedArtifactNilStoreFailsClosed(t *testing.T) {
	t.Parallel()

	artifact, err := VerifyVersionedArtifact(context.Background(), nil, validArtifactRequest())
	if !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactUnavailable", err)
	}
	if artifact.State != ArtifactVerificationUnavailable {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationUnavailable)
	}
}

func TestVerifyVersionedArtifactStoreError(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{err: errors.New("s3 unavailable")}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactUnavailable", err)
	}
	if artifact.State != ArtifactVerificationUnavailable {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationUnavailable)
	}
	assertVersionPinnedGet(t, store)
}

func TestVerifyVersionedArtifactNilGetOutputFailsClosed(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactUnavailable", err)
	}
	if artifact.State != ArtifactVerificationUnavailable {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationUnavailable)
	}
	assertVersionPinnedGet(t, store)
}

func TestVerifyVersionedArtifactRejectsInvalidPayloadSize(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		payload    []byte
		wantReason string
	}{
		{name: "empty", wantReason: "fetched payload is empty"},
		{
			name:       "oversize",
			payload:    make([]byte, MaxVersionedArtifactBytes+1),
			wantReason: fmt.Sprintf("fetched payload exceeds %d bytes", MaxVersionedArtifactBytes),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &stubArtifactStore{output: &objectstore.GetOutput{
				Ref:     objectstore.ObjectRef{VersionID: "version-requested"},
				Payload: test.payload,
			}}
			artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
			if !errors.Is(err, ErrArtifactArchiveInvalid) {
				t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
			}
			if !strings.Contains(err.Error(), test.wantReason) {
				t.Fatalf("VerifyVersionedArtifact() error = %q, want reason %q", err, test.wantReason)
			}
			if artifact.State != ArtifactVerificationArchiveInvalid {
				t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
			}
		})
	}
}

func TestVerifyVersionedArtifactStoreEnforcesArchiveLimit(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{err: objectstore.ErrObjectTooLarge}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactArchiveInvalid) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
	}
	if artifact.State != ArtifactVerificationArchiveInvalid {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
	}
	if store.input.MaxBytes != MaxVersionedArtifactBytes {
		t.Fatalf("Store.Get MaxBytes = %d, want %d", store.input.MaxBytes, MaxVersionedArtifactBytes)
	}
}

func TestVerifyVersionedArtifactReturnedVersionMismatch(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{output: &objectstore.GetOutput{
		Ref:     objectstore.ObjectRef{VersionID: "version-returned"},
		Payload: releaseArchive(t),
	}}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactVersionMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactVersionMismatch", err)
	}
	if artifact.State != ArtifactVerificationVersionMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVersionMismatch)
	}
	if artifact.RequestedVersionID != "version-requested" || artifact.ReturnedVersionID != "version-returned" {
		t.Fatalf("version evidence = requested %q returned %q", artifact.RequestedVersionID, artifact.ReturnedVersionID)
	}
	assertVersionPinnedGet(t, store)
}

func TestVerifyVersionedArtifactMissingReturnedVersionIsMismatch(t *testing.T) {
	t.Parallel()

	store := &stubArtifactStore{output: &objectstore.GetOutput{Payload: releaseArchive(t)}}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactVersionMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactVersionMismatch", err)
	}
	if !strings.Contains(err.Error(), "response omitted VersionId") {
		t.Fatalf("VerifyVersionedArtifact() error = %q, want omitted-VersionId reason", err)
	}
	if artifact.State != ArtifactVerificationVersionMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVersionMismatch)
	}
}

func TestVerifyVersionedArtifactDigestMismatch(t *testing.T) {
	t.Parallel()

	store, request := artifactFixture(t, releaseArchive(t))
	request.ExpectedDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
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
}

func TestVerifyVersionedArtifactHappyPathUsesObjectStore(t *testing.T) {
	t.Parallel()

	raw := releaseArchive(t)
	store, request := artifactFixture(t, raw)
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if err != nil {
		t.Fatalf("VerifyVersionedArtifact() error = %v", err)
	}
	if artifact.State != ArtifactVerificationVerified {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVerified)
	}
	if artifact.ActualDigest != verifiedFixtureDigest {
		t.Fatalf("actual digest = %q, want %q", artifact.ActualDigest, verifiedFixtureDigest)
	}

	calls := store.Calls()
	if len(calls) != 2 || calls[1].Operation != objectstoretest.OperationGet {
		t.Fatalf("object-store calls = %#v, want Put then Get", calls)
	}
	if calls[1].Ref.Bucket != request.Bucket || calls[1].Ref.Key != request.Key || calls[1].Ref.VersionID != request.VersionID {
		t.Fatalf("Store.Get ref = %#v, want request pins", calls[1].Ref)
	}
	if calls[1].MaxBytes != MaxVersionedArtifactBytes {
		t.Fatalf("Store.Get MaxBytes = %d, want %d", calls[1].MaxBytes, MaxVersionedArtifactBytes)
	}

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
	sum := sha256.Sum256(entries[0].Bytes())
	if got, want := entries[0].SHA256(), hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("ArtifactEntry.SHA256() = %q, want %q", got, want)
	}
	entryBytes := entries[0].Bytes()
	entryBytes[0] = 'X'
	if string(artifact.Entries()[0].Bytes()) != `{"app":"demo"}` {
		t.Fatal("Entries() did not return defensive content copies")
	}
}

func TestVerifyVersionedArtifactRejectsInvalidArchive(t *testing.T) {
	t.Parallel()

	assertArchiveInvalid(t, []byte("not a tar archive"))
}

func TestVerifyVersionedArtifactRejectsCompressedArchive(t *testing.T) {
	t.Parallel()

	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(releaseArchive(t)); err != nil {
		t.Fatalf("gzip Write() error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("gzip Close() error = %v", err)
	}
	assertArchiveInvalidReason(t, compressed.Bytes(), "compressed archives are not accepted")
}

func TestVerifyVersionedArtifactRejectsArchiveWithoutRegularMembers(t *testing.T) {
	t.Parallel()

	raw := tarArchive(t, []archiveMember{{path: "empty/", typeflag: tar.TypeDir}})
	assertArchiveInvalidReason(t, raw, "archive holds no regular-file members")
}

func TestVerifyVersionedArtifactRejectsNonRegularMember(t *testing.T) {
	t.Parallel()

	raw := tarArchive(t, []archiveMember{{path: "release-link", typeflag: tar.TypeSymlink, linkname: "release.json"}})
	assertArchiveInvalid(t, raw)
}

func TestVerifyVersionedArtifactRejectsOversizedMember(t *testing.T) {
	t.Parallel()

	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	if err := writer.WriteHeader(&tar.Header{
		Name:     "oversized.bin",
		Mode:     0o644,
		Size:     32 << 40,
		Typeflag: tar.TypeReg,
		Format:   tar.FormatGNU,
	}); err != nil {
		t.Fatalf("WriteHeader() error = %v", err)
	}
	assertArchiveInvalidReason(t, buffer.Bytes(), `archive member "oversized.bin" has an invalid size`)
}

func TestVerifyVersionedArtifactRejectsTrailingArchivePayload(t *testing.T) {
	t.Parallel()

	raw := append(releaseArchive(t), []byte("smuggled payload after tar end marker")...)
	assertArchiveInvalidReason(t, raw, "archive has trailing data after its end marker")
}

func TestVerifyVersionedArtifactAcceptsGNUDefaultTarPadding(t *testing.T) {
	t.Parallel()

	raw := releaseArchive(t)
	if len(raw) >= 10_240 {
		t.Fatalf("release archive = %d bytes, want room for GNU default padding", len(raw))
	}
	raw = append(raw, make([]byte, 10_240-len(raw))...)
	store, request := artifactFixture(t, raw)

	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if err != nil {
		t.Fatalf("VerifyVersionedArtifact() error = %v", err)
	}
	if artifact.State != ArtifactVerificationVerified {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVerified)
	}
	if got := len(artifact.ArchiveBytes()); got != 10_240 {
		t.Fatalf("ArchiveBytes() length = %d, want 10240", got)
	}
}

func TestVerifyVersionedArtifactRejectsTooManyEntries(t *testing.T) {
	t.Parallel()

	members := make([]archiveMember, MaxVersionedArtifactEntries+1)
	for i := range members {
		members[i] = archiveMember{path: fmt.Sprintf("entry-%03d", i), typeflag: tar.TypeReg}
	}
	assertArchiveInvalid(t, tarArchive(t, members))
}

func TestVerifyVersionedArtifactRejectsUnsafeMemberPaths(t *testing.T) {
	t.Parallel()

	paths := []string{
		"/absolute/path",
		"dir/../policy.json",
		"two  spaces",
		"line\nfeed",
		"carriage\rreturn",
		"control\x01character",
	}
	for _, memberPath := range paths {
		t.Run(fmt.Sprintf("%q", memberPath), func(t *testing.T) {
			t.Parallel()
			assertArchiveInvalid(t, tarArchive(t, []archiveMember{{path: memberPath, content: "content", typeflag: tar.TypeReg}}))
		})
	}
}

func TestVerifyVersionedArtifactRejectsAggregateDigestCollisionPath(t *testing.T) {
	t.Parallel()

	legitimate := tarArchive(t, []archiveMember{
		{path: "policy.json", content: "ALLOWLIST", typeflag: tar.TypeReg},
		{path: "run.sh", content: "echo hi", typeflag: tar.TypeReg},
	})
	entries, err := readVersionedArtifactArchive(legitimate)
	if err != nil {
		t.Fatalf("readVersionedArtifactArchive(legitimate) error = %v", err)
	}
	expectedDigest := deriveAggregateDigest(entries)
	policySum := sha256.Sum256([]byte("ALLOWLIST"))
	craftedName := "policy.json  " + hex.EncodeToString(policySum[:]) + "\nrun.sh"
	crafted := tarArchive(t, []archiveMember{{path: craftedName, content: "echo hi", typeflag: tar.TypeReg}})
	store, request := artifactFixture(t, crafted)
	request.ExpectedDigest = expectedDigest

	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
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

func artifactFixture(t *testing.T, raw []byte) (*objectstoretest.FakeStore, VersionedArtifactRequest) {
	t.Helper()
	store := objectstoretest.NewStore()
	ref, err := store.Put(context.Background(), objectstore.PutInput{
		Ref:     objectstore.ObjectRef{Bucket: "artifacts", Key: "ns/demo/release.tar"},
		Payload: raw,
	})
	if err != nil {
		t.Fatalf("FakeStore.Put() error = %v", err)
	}
	return store, VersionedArtifactRequest{
		Bucket:         ref.Bucket,
		Key:            ref.Key,
		VersionID:      ref.VersionID,
		ExpectedDigest: verifiedFixtureDigest,
	}
}

func assertVersionPinnedGet(t *testing.T, store *stubArtifactStore) {
	t.Helper()
	if store.calls != 1 {
		t.Fatalf("Store.Get calls = %d, want 1", store.calls)
	}
	if got := store.input.Ref; got != (objectstore.ObjectRef{Bucket: "artifacts", Key: "ns/demo/release.tar", VersionID: "version-requested"}) {
		t.Fatalf("Store.Get Ref = %#v", got)
	}
	if store.input.MaxBytes != MaxVersionedArtifactBytes {
		t.Fatalf("Store.Get MaxBytes = %d, want %d", store.input.MaxBytes, MaxVersionedArtifactBytes)
	}
}

func assertArchiveInvalid(t *testing.T, raw []byte) {
	t.Helper()
	store, request := artifactFixture(t, raw)
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if !errors.Is(err, ErrArtifactArchiveInvalid) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
	}
	if artifact.State != ArtifactVerificationArchiveInvalid {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
	}
}

func assertArchiveInvalidReason(t *testing.T, raw []byte, wantReason string) {
	t.Helper()
	store, request := artifactFixture(t, raw)
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if !errors.Is(err, ErrArtifactArchiveInvalid) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
	}
	if !strings.Contains(err.Error(), wantReason) {
		t.Fatalf("VerifyVersionedArtifact() error = %q, want reason %q", err, wantReason)
	}
	if artifact.State != ArtifactVerificationArchiveInvalid {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
	}
	if got := artifact.ArchiveBytes(); got != nil {
		t.Fatalf("ArchiveBytes() after invalid archive = %d bytes, want nil", len(got))
	}
}

type archiveMember struct {
	path     string
	content  string
	typeflag byte
	linkname string
}

func releaseArchive(t *testing.T) []byte {
	t.Helper()
	return tarArchive(t, []archiveMember{
		{path: "release.json", content: `{"app":"demo"}`, typeflag: tar.TypeReg},
		{path: "cdk/app.template.json", content: `{}`, typeflag: tar.TypeReg},
	})
}

func tarArchive(t *testing.T, members []archiveMember) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, member := range members {
		if err := writer.WriteHeader(&tar.Header{
			Name:     member.path,
			Mode:     0o644,
			Size:     int64(len(member.content)),
			Typeflag: member.typeflag,
			Linkname: member.linkname,
		}); err != nil {
			t.Fatalf("WriteHeader(%q) error = %v", member.path, err)
		}
		if _, err := writer.Write([]byte(member.content)); err != nil {
			t.Fatalf("Write(%q) error = %v", member.path, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("tar Close() error = %v", err)
	}
	return buffer.Bytes()
}
