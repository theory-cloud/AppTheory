package runtimeaws

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	// MaxVersionedArtifactBytes is the hard ceiling for one fetched release archive.
	MaxVersionedArtifactBytes int64 = 32 << 20
	// MaxVersionedArtifactEntries is the hard ceiling for archive members.
	MaxVersionedArtifactEntries = 512
)

var (
	// ErrArtifactInvalidRequest means bucket, key, or digest input was invalid.
	ErrArtifactInvalidRequest = errors.New("apptheory runtime aws: invalid versioned artifact request")
	// ErrArtifactVersionRequired means no non-empty S3 VersionId was pinned.
	ErrArtifactVersionRequired = errors.New("apptheory runtime aws: artifact version is required")
	// ErrArtifactUnavailable means the pinned object could not be read completely.
	ErrArtifactUnavailable = errors.New("apptheory runtime aws: versioned artifact is unavailable")
	// ErrArtifactVersionMismatch means S3 returned a different VersionId than requested.
	ErrArtifactVersionMismatch = errors.New("apptheory runtime aws: returned artifact version does not match requested version")
	// ErrArtifactArchiveInvalid means the object was not a bounded, regular-file tar archive.
	ErrArtifactArchiveInvalid = errors.New("apptheory runtime aws: versioned artifact archive is invalid")
	// ErrArtifactDigestMismatch means the archive-derived digest did not equal the pinned digest.
	ErrArtifactDigestMismatch = errors.New("apptheory runtime aws: versioned artifact digest does not match expected digest")
)

var aggregateDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ArtifactVerificationState is the explicit outcome of versioned-artifact verification.
type ArtifactVerificationState string

const (
	// ArtifactVerificationInvalidRequest means bucket, key, or digest input was invalid.
	ArtifactVerificationInvalidRequest ArtifactVerificationState = "invalid_request"
	// ArtifactVerificationVersionRequired means the request omitted its S3 VersionId pin.
	ArtifactVerificationVersionRequired ArtifactVerificationState = "version_required"
	// ArtifactVerificationUnavailable means GetObject or its bounded body read failed.
	ArtifactVerificationUnavailable ArtifactVerificationState = "unavailable"
	// ArtifactVerificationVersionMismatch means returned VersionId differed from the request.
	ArtifactVerificationVersionMismatch ArtifactVerificationState = "version_mismatch"
	// ArtifactVerificationArchiveInvalid means the fetched bytes were not a safe bounded tar.
	ArtifactVerificationArchiveInvalid ArtifactVerificationState = "archive_invalid"
	// ArtifactVerificationDigestMismatch means the archive-derived digest differed from the pin.
	ArtifactVerificationDigestMismatch ArtifactVerificationState = "digest_mismatch"
	// ArtifactVerificationVerified means all three F6 checks succeeded.
	ArtifactVerificationVerified ArtifactVerificationState = "verified"
)

// GetObjectAPI is the narrow S3 operation required by VerifyVersionedArtifact.
type GetObjectAPI interface {
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

// VersionedArtifactRequest pins one S3 object version to one aggregate archive digest.
type VersionedArtifactRequest struct {
	Bucket         string
	Key            string
	VersionID      string
	ExpectedDigest string
}

// ArtifactEntry is one regular-file member of a verified release archive.
// Content is available only through Bytes so callers cannot mutate the verified copy.
type ArtifactEntry struct {
	Path string
	Mode int64

	content []byte
	digest  string
}

// Bytes returns a defensive copy of the entry content.
func (e ArtifactEntry) Bytes() []byte {
	return cloneArtifactBytes(e.content)
}

// SHA256 returns the lower-case hexadecimal SHA-256 of the entry content.
func (e ArtifactEntry) SHA256() string {
	return e.digest
}

// VersionedArtifact records verification evidence and retains bytes only on success.
type VersionedArtifact struct {
	State              ArtifactVerificationState
	RequestedVersionID string
	ReturnedVersionID  string
	ExpectedDigest     string
	ActualDigest       string

	archive []byte
	entries []ArtifactEntry
}

// ArchiveBytes returns a defensive copy of the verified S3 object bytes.
func (a VersionedArtifact) ArchiveBytes() []byte {
	return cloneArtifactBytes(a.archive)
}

// Entries returns defensive copies of all verified regular-file members.
func (a VersionedArtifact) Entries() []ArtifactEntry {
	if a.entries == nil {
		return nil
	}
	entries := make([]ArtifactEntry, len(a.entries))
	for i, entry := range a.entries {
		entries[i] = ArtifactEntry{
			Path:    entry.Path,
			Mode:    entry.Mode,
			content: cloneArtifactBytes(entry.content),
			digest:  entry.digest,
		}
	}
	return entries
}

// VerifyVersionedArtifact performs the F6 triple without fallback: it requests
// an exact VersionId, requires S3 to echo that VersionId, then re-hashes every
// regular archive member and compares the derived aggregate digest.
func VerifyVersionedArtifact(
	ctx context.Context,
	client GetObjectAPI,
	request VersionedArtifactRequest,
) (VersionedArtifact, error) {
	artifact, bucket, key, err := validateVersionedArtifactRequest(request)
	if err != nil {
		return artifact, err
	}
	raw, returnedVersionID, err := fetchVersionedArtifact(ctx, client, bucket, key, artifact.RequestedVersionID)
	if err != nil {
		artifact.State = ArtifactVerificationUnavailable
		if errors.Is(err, ErrArtifactArchiveInvalid) {
			artifact.State = ArtifactVerificationArchiveInvalid
		}
		return artifact, err
	}

	artifact.ReturnedVersionID = returnedVersionID
	if artifact.ReturnedVersionID != artifact.RequestedVersionID {
		artifact.State = ArtifactVerificationVersionMismatch
		return artifact, ErrArtifactVersionMismatch
	}

	entries, err := readVersionedArtifactArchive(raw)
	if err != nil {
		artifact.State = ArtifactVerificationArchiveInvalid
		return artifact, fmt.Errorf("%w: %v", ErrArtifactArchiveInvalid, err)
	}
	artifact.ActualDigest = deriveAggregateDigest(entries)
	if artifact.ActualDigest != artifact.ExpectedDigest {
		artifact.State = ArtifactVerificationDigestMismatch
		return artifact, ErrArtifactDigestMismatch
	}

	artifact.State = ArtifactVerificationVerified
	artifact.archive = cloneArtifactBytes(raw)
	artifact.entries = entries
	return artifact, nil
}

func validateVersionedArtifactRequest(request VersionedArtifactRequest) (VersionedArtifact, string, string, error) {
	artifact := VersionedArtifact{
		State:              ArtifactVerificationInvalidRequest,
		RequestedVersionID: strings.TrimSpace(request.VersionID),
		ExpectedDigest:     strings.TrimSpace(request.ExpectedDigest),
	}
	if artifact.RequestedVersionID == "" {
		artifact.State = ArtifactVerificationVersionRequired
		return artifact, "", "", ErrArtifactVersionRequired
	}
	bucket := strings.TrimSpace(request.Bucket)
	key := strings.TrimSpace(request.Key)
	if bucket == "" || key == "" || !aggregateDigestPattern.MatchString(artifact.ExpectedDigest) {
		return artifact, "", "", ErrArtifactInvalidRequest
	}
	return artifact, bucket, key, nil
}

func fetchVersionedArtifact(
	ctx context.Context,
	client GetObjectAPI,
	bucket string,
	key string,
	versionID string,
) ([]byte, string, error) {
	if client == nil {
		return nil, "", ErrArtifactUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	output, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket:    awssdk.String(bucket),
		Key:       awssdk.String(key),
		VersionId: awssdk.String(versionID),
	})
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrArtifactUnavailable, err)
	}
	if output == nil || output.Body == nil {
		return nil, "", ErrArtifactUnavailable
	}
	raw, err := readVersionedArtifactBody(output.Body)
	if err != nil {
		return nil, "", err
	}
	return raw, strings.TrimSpace(awssdk.ToString(output.VersionId)), nil
}

func readVersionedArtifactBody(body io.ReadCloser) ([]byte, error) {
	raw, readErr := io.ReadAll(io.LimitReader(body, MaxVersionedArtifactBytes+1))
	closeErr := body.Close()
	if readErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrArtifactUnavailable, readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrArtifactUnavailable, closeErr)
	}
	if len(raw) == 0 || int64(len(raw)) > MaxVersionedArtifactBytes {
		return nil, ErrArtifactArchiveInvalid
	}
	return raw, nil
}

func readVersionedArtifactArchive(raw []byte) ([]ArtifactEntry, error) {
	if compressedArtifact(raw) {
		return nil, errors.New("compressed archives are not accepted")
	}
	reader := tar.NewReader(bytes.NewReader(raw))
	entries := make([]ArtifactEntry, 0)
	members := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		members++
		if members > MaxVersionedArtifactEntries {
			return nil, fmt.Errorf("archive holds more than %d members", MaxVersionedArtifactEntries)
		}
		name := strings.TrimPrefix(strings.TrimSpace(header.Name), "./")
		if name == "" || strings.HasSuffix(name, "/") || header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("archive member %q is not a regular file", name)
		}
		if header.Size < 0 || header.Size > MaxVersionedArtifactBytes {
			return nil, fmt.Errorf("archive member %q has an invalid size", name)
		}
		content, err := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if err != nil {
			return nil, fmt.Errorf("archive member %q could not be read: %w", name, err)
		}
		if int64(len(content)) != header.Size {
			return nil, fmt.Errorf("archive member %q length does not match its header", name)
		}
		sum := sha256.Sum256(content)
		entries = append(entries, ArtifactEntry{
			Path:    name,
			Mode:    header.Mode,
			content: content,
			digest:  hex.EncodeToString(sum[:]),
		})
	}
	if len(entries) == 0 {
		return nil, errors.New("archive holds no regular-file members")
	}
	return entries, nil
}

func deriveAggregateDigest(entries []ArtifactEntry) string {
	pairs := make([]ArtifactEntry, len(entries))
	copy(pairs, entries)
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Path != pairs[j].Path {
			return pairs[i].Path < pairs[j].Path
		}
		return pairs[i].digest < pairs[j].digest
	})
	lines := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		lines = append(lines, pair.Path+"  "+pair.digest)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func compressedArtifact(raw []byte) bool {
	magics := [][]byte{
		{0x1f, 0x8b},
		{0x42, 0x5a, 0x68},
		{0xfd, '7', 'z', 'X', 'Z'},
		{0x28, 0xb5, 0x2f, 0xfd},
		{'P', 'K', 0x03, 0x04},
	}
	for _, magic := range magics {
		if bytes.HasPrefix(raw, magic) {
			return true
		}
	}
	return false
}

func cloneArtifactBytes(input []byte) []byte {
	if input == nil {
		return nil
	}
	output := make([]byte, len(input))
	copy(output, input)
	return output
}
