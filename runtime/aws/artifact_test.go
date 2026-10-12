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
	"io"
	"sort"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v6/pkg/objectstore"
	objectstoretest "github.com/theory-cloud/apptheory/v6/testkit/objectstore"
)

const verifiedFixtureDigest = "sha256:21914ff0cff97bc82c93b3e91887a223484060ab6e64add1fbd8600827ae3aa5"

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

	store := &stubArtifactStore{err: context.Canceled}
	artifact, err := VerifyVersionedArtifact(context.Background(), store, validArtifactRequest())
	if !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactUnavailable", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want context.Canceled", err)
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
	if !errors.Is(err, objectstore.ErrObjectTooLarge) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want objectstore.ErrObjectTooLarge", err)
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

func TestVerifyVersionedArtifactRejectsPreModePathAndContentDigest(t *testing.T) {
	t.Parallel()

	raw := releaseArchive(t)
	entries, err := readVersionedArtifactArchive(raw)
	if err != nil {
		t.Fatalf("readVersionedArtifactArchive() error = %v", err)
	}
	preModeDigest := derivePreModeAggregateDigest(entries)
	store, request := artifactFixture(t, raw)
	request.ExpectedDigest = preModeDigest
	artifact, verifyErr := VerifyVersionedArtifact(context.Background(), store, request)
	if !errors.Is(verifyErr, ErrArtifactDigestMismatch) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactDigestMismatch", verifyErr)
	}
	if artifact.State != ArtifactVerificationDigestMismatch {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationDigestMismatch)
	}
	if got := artifact.ArchiveBytes(); got != nil {
		t.Fatalf("ArchiveBytes() after pre-mode digest rejection = %d bytes, want nil", len(got))
	}
}

func derivePreModeAggregateDigest(entries []ArtifactEntry) string {
	pairs := append([]ArtifactEntry(nil), entries...)
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].Path < pairs[j].Path })
	lines := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		lines = append(lines, pair.Path+"  "+pair.digest)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func TestVerifyVersionedArtifactAttestsPermissionMode(t *testing.T) {
	t.Parallel()

	base := tarArchive(t, []archiveMember{{path: "run.sh", mode: 0o644, content: "echo hi", typeflag: tar.TypeReg}})
	baseEntries, err := readVersionedArtifactArchive(base)
	if err != nil {
		t.Fatalf("readVersionedArtifactArchive(base) error = %v", err)
	}
	baseDigest := deriveAggregateDigest(baseEntries)

	for _, mode := range []int64{0o755, 0o4777} {
		t.Run(fmt.Sprintf("%04o", mode), func(t *testing.T) {
			t.Parallel()
			raw := tarArchive(t, []archiveMember{{path: "run.sh", mode: mode, content: "echo hi", typeflag: tar.TypeReg}})
			entries, readErr := readVersionedArtifactArchive(raw)
			if readErr != nil {
				t.Fatalf("readVersionedArtifactArchive() error = %v", readErr)
			}
			if got := deriveAggregateDigest(entries); got == baseDigest {
				t.Fatalf("aggregate digest = %q for modes 0644 and %04o", got, mode)
			}

			store, request := artifactFixture(t, raw)
			request.ExpectedDigest = baseDigest
			artifact, verifyErr := VerifyVersionedArtifact(context.Background(), store, request)
			if !errors.Is(verifyErr, ErrArtifactDigestMismatch) {
				t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactDigestMismatch", verifyErr)
			}
			if artifact.State != ArtifactVerificationDigestMismatch {
				t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationDigestMismatch)
			}
		})
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

	raw := []byte("not a tar archive")
	store, request := artifactFixture(t, raw)
	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if !errors.Is(err, ErrArtifactArchiveInvalid) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want ErrArtifactArchiveInvalid", err)
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("VerifyVersionedArtifact() error = %v, want io.ErrUnexpectedEOF", err)
	}
	if artifact.State != ArtifactVerificationArchiveInvalid {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationArchiveInvalid)
	}
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

func TestVerifyVersionedArtifactAcceptsGNUDefaultMaximumTrailingZeroPadding(t *testing.T) {
	t.Parallel()

	const (
		payloadSize       = 8_705
		tarBlockBytes     = 512
		gnuBlockingFactor = 20
		dataBlocks        = 18
		eofBlocks         = 2
		trailingBlocks    = 19
	)
	// One header + 18 payload blocks + two EOF blocks consumes 21 blocks.
	// GNU's blocking factor 20 pads to 40 blocks, leaving 19 trailing blocks.
	raw := tarArchive(t, []archiveMember{{
		path:     "payload.bin",
		content:  strings.Repeat("x", payloadSize),
		typeflag: tar.TypeReg,
	}})
	if got, want := len(raw), (1+dataBlocks+eofBlocks)*tarBlockBytes; got != want {
		t.Fatalf("unpadded archive length = %d, want %d", got, want)
	}
	raw = append(raw, make([]byte, trailingBlocks*tarBlockBytes)...)
	if got, want := len(raw), 2*gnuBlockingFactor*tarBlockBytes; got != want {
		t.Fatalf("GNU blocking-factor-20 archive length = %d, want %d", got, want)
	}
	entries, err := readVersionedArtifactArchive(raw)
	if err != nil {
		t.Fatalf("readVersionedArtifactArchive() error = %v", err)
	}
	store, request := artifactFixture(t, raw)
	request.ExpectedDigest = deriveAggregateDigest(entries)

	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if err != nil {
		t.Fatalf("VerifyVersionedArtifact() error = %v", err)
	}
	if artifact.State != ArtifactVerificationVerified {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVerified)
	}
	if got := len(artifact.ArchiveBytes()); got != len(raw) {
		t.Fatalf("ArchiveBytes() length = %d, want %d", got, len(raw))
	}
}

func TestVerifyVersionedArtifactAcceptsDocumentedTrailingZeroBoundary(t *testing.T) {
	t.Parallel()

	// Keep the contract boundary literal-anchored so changing the production
	// bound cannot make this test self-consistent.
	const boundary = 10_240
	raw := append(releaseArchive(t), make([]byte, boundary)...)
	store, request := artifactFixture(t, raw)

	artifact, err := VerifyVersionedArtifact(context.Background(), store, request)
	if err != nil {
		t.Fatalf("VerifyVersionedArtifact() error = %v", err)
	}
	if artifact.State != ArtifactVerificationVerified {
		t.Fatalf("VerifyVersionedArtifact() state = %q, want %q", artifact.State, ArtifactVerificationVerified)
	}
	if got := len(artifact.ArchiveBytes()); got != len(raw) {
		t.Fatalf("ArchiveBytes() length = %d, want %d", got, len(raw))
	}
}

func TestVerifyVersionedArtifactRejectsExcessiveZeroPadding(t *testing.T) {
	t.Parallel()

	const boundaryPlusOne = 10_241
	raw := append(releaseArchive(t), make([]byte, boundaryPlusOne)...)
	assertArchiveInvalidReason(t, raw, "archive has trailing data after its end marker")
}

func TestVerifyVersionedArtifactRejectsNonzeroTrailingPaddingAtBoundary(t *testing.T) {
	t.Parallel()

	const boundary = 10_240
	trailing := make([]byte, boundary)
	trailing[boundary-1] = 1
	raw := append(releaseArchive(t), trailing...)
	assertArchiveInvalidReason(t, raw, "archive has trailing data after its end marker")
}

func TestVerifyVersionedArtifactRejectsTooManyEntries(t *testing.T) {
	t.Parallel()

	members := make([]archiveMember, MaxVersionedArtifactEntries+1)
	for i := range members {
		members[i] = archiveMember{path: fmt.Sprintf("entry-%03d", i), typeflag: tar.TypeReg}
	}
	assertArchiveInvalid(t, tarArchive(t, members))
}

// TestArtifactMemberIsSparse covers both archive forms that expand members on
// read: the old GNU sparse type flag and the GNU PAX 1.0/0.1 form surfaced as a
// regular file with GNU.sparse.* records.
func TestArtifactMemberIsSparse(t *testing.T) {
	t.Parallel()

	if artifactMemberIsSparse(nil) {
		t.Fatal("nil header must not be sparse")
	}
	if artifactMemberIsSparse(&tar.Header{Typeflag: tar.TypeReg}) {
		t.Fatal("a plain regular file must not be sparse")
	}
	if !artifactMemberIsSparse(&tar.Header{Typeflag: tar.TypeGNUSparse}) {
		t.Fatal("the old GNU sparse type flag must be detected")
	}
	if !artifactMemberIsSparse(&tar.Header{
		Typeflag:   tar.TypeReg,
		PAXRecords: map[string]string{"GNU.sparse.major": "1"},
	}) {
		t.Fatal("a GNU PAX sparse regular file must be detected")
	}
}

// TestVerifyVersionedArtifactRejectsSparseMembers covers F4: a small physical tar
// whose members are GNU PAX sparse regular files (far larger logical than
// physical) must be rejected before any member is materialized.
func TestVerifyVersionedArtifactRejectsSparseMembers(t *testing.T) {
	t.Parallel()

	const logicalSize = 1 << 20 // 1 MiB logical from a single 512-byte physical block
	raw := sparsePAXArchive(t, logicalSize)

	// Prove the crafted shape first, so this test fails loudly if the craft stops
	// producing a PAX sparse regular file rather than silently testing nothing.
	tr := tar.NewReader(bytes.NewReader(raw))
	hdr, err := tr.Next()
	if err != nil {
		t.Fatalf("crafted archive Next() error = %v", err)
	}
	if hdr.Typeflag != tar.TypeReg || hdr.Size != logicalSize || hdr.PAXRecords["GNU.sparse.major"] == "" {
		t.Fatalf("crafted member is not a PAX sparse regular file: type=%q size=%d pax=%v", hdr.Typeflag, hdr.Size, hdr.PAXRecords)
	}
	if int64(len(raw)) > MaxVersionedArtifactBytes {
		t.Fatalf("crafted archive is %d physical bytes, want <= %d", len(raw), MaxVersionedArtifactBytes)
	}

	assertArchiveInvalidReason(t, raw, "is a sparse file")
}

// TestReadVersionedArtifactArchiveRejectsCumulativeLogicalOverflow covers F4's
// cumulative logical ceiling directly: two members that each satisfy the
// per-member ceiling but whose sum exceeds the cumulative ceiling are rejected
// before the overflowing member is allocated.
func TestReadVersionedArtifactArchiveRejectsCumulativeLogicalOverflow(t *testing.T) {
	t.Parallel()

	perMember := MaxVersionedArtifactBytes/2 + 1
	raw := tarArchive(t, []archiveMember{
		{path: "a.bin", content: strings.Repeat("a", int(perMember)), typeflag: tar.TypeReg},
		{path: "b.bin", content: strings.Repeat("b", int(perMember)), typeflag: tar.TypeReg},
	})
	_, err := readVersionedArtifactArchive(raw)
	if err == nil || !strings.Contains(err.Error(), "archive logical content exceeds") {
		t.Fatalf("readVersionedArtifactArchive() error = %v, want cumulative logical overflow", err)
	}
}

// sparsePAXArchive hand-encodes a GNU PAX 0.1 archive with one sparse regular
// member: the PAX records carry the logical size and the sparse map, while the
// member occupies a single 512-byte physical block. Go's archive/tar expands it
// to logicalSize on read, which is the amplification the artifact verifier must
// reject.
func sparsePAXArchive(t *testing.T, logicalSize int64) []byte {
	t.Helper()

	pax := tarPAXRecord("GNU.sparse.major", "0") +
		tarPAXRecord("GNU.sparse.minor", "1") +
		tarPAXRecord("GNU.sparse.name", "member.bin") +
		tarPAXRecord("GNU.sparse.size", fmt.Sprintf("%d", logicalSize)) +
		tarPAXRecord("GNU.sparse.numblocks", "1") +
		tarPAXRecord("GNU.sparse.map", "0,512")

	var buf bytes.Buffer
	buf.Write(tarHeaderBlock(t, "PaxHeaders.0/member.bin", int64(len(pax)), tar.TypeXHeader))
	buf.WriteString(pax)
	if pad := (512 - len(pax)%512) % 512; pad > 0 {
		buf.Write(make([]byte, pad))
	}
	buf.Write(tarHeaderBlock(t, "member.bin", 512, tar.TypeReg))
	buf.Write(make([]byte, 512))
	buf.Write(make([]byte, 1024)) // end-of-archive marker
	return buf.Bytes()
}

// tarPAXRecord encodes one POSIX PAX extended-header record ("<len> key=value\n").
func tarPAXRecord(key, value string) string {
	body := " " + key + "=" + value + "\n"
	length := len(body) + 1
	for {
		digits := fmt.Sprintf("%d", length)
		if len(digits)+len(body) == length {
			return digits + body
		}
		length = len(digits) + len(body)
	}
}

// tarHeaderBlock encodes one raw 512-byte tar header block.
func tarHeaderBlock(t *testing.T, name string, size int64, typeflag byte) []byte {
	t.Helper()

	block := make([]byte, 512)
	copy(block[0:100], name)
	copy(block[100:108], tarOctalField(0o644, 8))
	copy(block[108:116], tarOctalField(0, 8))
	copy(block[116:124], tarOctalField(0, 8))
	copy(block[124:136], tarOctalField(size, 12))
	copy(block[136:148], tarOctalField(0, 12))
	for i := 148; i < 156; i++ {
		block[i] = ' '
	}
	block[156] = typeflag
	copy(block[257:263], "ustar\x00")
	copy(block[263:265], "00")
	var sum int64
	for _, value := range block {
		sum += int64(value)
	}
	copy(block[148:154], fmt.Sprintf("%06o", sum))
	block[154] = 0
	block[155] = ' '
	return block
}

// tarOctalField encodes a numeric tar field as N-1 octal digits terminated by NUL.
func tarOctalField(value int64, width int) []byte {
	out := make([]byte, width)
	for i := range out {
		out[i] = '0'
	}
	digits := fmt.Sprintf("%o", value)
	copy(out[width-1-len(digits):width-1], digits)
	out[width-1] = 0
	return out
}

func TestVerifyVersionedArtifactRejectsDuplicateMemberPaths(t *testing.T) {
	t.Parallel()

	raw := tarArchive(t, []archiveMember{
		{path: "policy.json", content: "first", typeflag: tar.TypeReg},
		{path: "policy.json", content: "second", typeflag: tar.TypeReg},
	})
	assertArchiveInvalidReason(t, raw, `archive contains duplicate member path "policy.json"`)
}

func TestVerifyVersionedArtifactRejectsUnsafeMemberPaths(t *testing.T) {
	t.Parallel()

	paths := []string{
		"/absolute/path",
		"dir/../policy.json",
		`..\..\windows`,
		`C:\windows\system32`,
		"C:/windows/system32",
		"././nested",
		"nested/./policy.json",
		" policy.json",
		"policy.json ",
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
	mode     int64
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
		mode := member.mode
		if mode == 0 {
			mode = 0o644
		}
		if err := writer.WriteHeader(&tar.Header{
			Name:     member.path,
			Mode:     mode,
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
