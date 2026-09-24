package objectstore

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	store "github.com/theory-cloud/apptheory/v4/pkg/objectstore"
)

const (
	grantChecksumSHA256 = "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc="
	grantAtCapURL       = "https://objectstore.fake/apptheory-contract/objects/alpha.txt" +
		"?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=apptheory-fake&X-Amz-Date=20260101T000000Z" +
		"&X-Amz-Expires=900&X-Amz-Signature=fake" +
		"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256" +
		"&x-amz-checksum-sha256=JxNUv%2BpEygWMdjyXew%2BbVUVS2rnR6IFkvTTZRH9ivHc%3D" +
		"&x-amz-content-length=17" +
		"&x-amz-content-type=text%2Fplain%3B%20charset%3Dutf-8"
	grantNestedURL = "https://objectstore.fake/apptheory-contract/objects/nested/caf%C3%A9%20v1.txt" +
		"?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=apptheory-fake&X-Amz-Date=20260101T000000Z" +
		"&X-Amz-Expires=60&X-Amz-Signature=fake" +
		"&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256" +
		"&x-amz-checksum-sha256=JxNUv%2BpEygWMdjyXew%2BbVUVS2rnR6IFkvTTZRH9ivHc%3D" +
		"&x-amz-content-length=5" +
		"&x-amz-content-type=application%2Fjson"
)

func validGrantInput() store.PresignPutInput {
	return store.PresignPutInput{
		Ref:            store.ObjectRef{Bucket: "apptheory-contract", Key: "objects/alpha.txt"},
		ContentLength:  17,
		ChecksumSHA256: grantChecksumSHA256,
		ContentType:    "text/plain; charset=utf-8",
		MaxBytes:       1 << 20,
		ExpiresIn:      15 * time.Minute,
	}
}

// TestFakeStorePresignPutMatchesContractFixture pins the exact grant the shared contract fixture
// asserts, so the Go fake cannot drift from the TypeScript and Python fakes.
func TestFakeStorePresignPutMatchesContractFixture(t *testing.T) {
	fake := NewStore()
	out, err := fake.PresignPut(context.Background(), validGrantInput())
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if out.URL != grantAtCapURL {
		t.Fatalf("URL =\n%s\nwant\n%s", out.URL, grantAtCapURL)
	}
	if out.Method != "PUT" {
		t.Fatalf("Method = %q, want PUT", out.Method)
	}
	if got := out.ExpiresAt.UTC().Format(time.RFC3339); got != "2026-01-01T00:15:00Z" {
		t.Fatalf("ExpiresAt = %q, want 2026-01-01T00:15:00Z", got)
	}
	wantHeaders := map[string]string{
		"content-length":        "17",
		"content-type":          "text/plain; charset=utf-8",
		"x-amz-checksum-sha256": grantChecksumSHA256,
	}
	if len(out.Headers) != len(wantHeaders) {
		t.Fatalf("Headers = %v, want exactly %d entries", out.Headers, len(wantHeaders))
	}
	for name, value := range wantHeaders {
		if out.Headers[name] != value {
			t.Fatalf("Headers[%q] = %q, want %q", name, out.Headers[name], value)
		}
	}
	if out.Ref != validGrantInput().Ref {
		t.Fatalf("Ref = %+v, want the requested ref", out.Ref)
	}
}

func TestFakeStorePresignPutEncodesNonASCIIAndNestedKeys(t *testing.T) {
	input := store.PresignPutInput{
		Ref:            store.ObjectRef{Bucket: "apptheory-contract", Key: "objects/nested/café v1.txt"},
		ContentLength:  5,
		ChecksumSHA256: grantChecksumSHA256,
		ContentType:    "application/json",
		MaxBytes:       5,
		ExpiresIn:      time.Minute,
	}
	fake := NewStore()
	out, err := fake.PresignPut(context.Background(), input)
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if out.URL != grantNestedURL {
		t.Fatalf("URL =\n%s\nwant\n%s", out.URL, grantNestedURL)
	}
}

func TestFakeStorePresignPutRecordsTheCallLog(t *testing.T) {
	fake := NewStore()
	if _, err := fake.PresignPut(context.Background(), validGrantInput()); err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	calls := fake.Calls()
	if len(calls) != 1 {
		t.Fatalf("Calls() = %d entries, want 1", len(calls))
	}
	call := calls[0]
	if call.Operation != OperationPresignPut {
		t.Fatalf("call.Operation = %q, want %q", call.Operation, OperationPresignPut)
	}
	if call.ContentLength != 17 || call.ChecksumSHA256 != grantChecksumSHA256 || call.ExpiresIn != 900 {
		t.Fatalf("call = %+v, want the granted constraints", call)
	}
	if call.ContentType != "text/plain; charset=utf-8" || call.MaxBytes != 1<<20 {
		t.Fatalf("call = %+v, want the granted constraints", call)
	}
	if call.Payload != nil || call.Metadata != nil {
		t.Fatalf("call = %+v, want no payload or metadata", call)
	}
}

func TestFakeStorePresignPutClockInjection(t *testing.T) {
	fake := NewStore()
	fake.SetClock(func() time.Time { return time.Date(2030, time.March, 4, 5, 6, 7, 0, time.UTC) })
	out, err := fake.PresignPut(context.Background(), validGrantInput())
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if !strings.Contains(out.URL, "X-Amz-Date=20300304T050607Z") {
		t.Fatalf("URL = %s, want the injected clock date", out.URL)
	}
	if got := out.ExpiresAt.UTC().Format(time.RFC3339); got != "2030-03-04T05:21:07Z" {
		t.Fatalf("ExpiresAt = %q, want 2030-03-04T05:21:07Z", got)
	}

	fake.SetClock(nil)
	out, err = fake.PresignPut(context.Background(), validGrantInput())
	if err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if out.URL != grantAtCapURL {
		t.Fatalf("URL after clock reset =\n%s\nwant\n%s", out.URL, grantAtCapURL)
	}
}

func TestFakeStorePresignPutFailsClosedWithoutRecording(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*store.PresignPutInput)
		want   error
	}{
		{name: "versioned-ref", mutate: func(i *store.PresignPutInput) { i.Ref.VersionID = "v1" }, want: store.ErrInvalidObjectRef},
		{name: "empty-key", mutate: func(i *store.PresignPutInput) { i.Ref.Key = "" }, want: store.ErrInvalidObjectRef},
		{name: "missing-checksum", mutate: func(i *store.PresignPutInput) { i.ChecksumSHA256 = "" }, want: store.ErrInvalidPresignPut},
		{name: "zero-length", mutate: func(i *store.PresignPutInput) { i.ContentLength = 0 }, want: store.ErrInvalidPresignPut},
		{name: "length-over-max", mutate: func(i *store.PresignPutInput) { i.MaxBytes = 1 }, want: store.ErrInvalidPresignPut},
		{name: "missing-content-type", mutate: func(i *store.PresignPutInput) { i.ContentType = "" }, want: store.ErrInvalidPresignPut},
		{name: "expiry-over-cap", mutate: func(i *store.PresignPutInput) { i.ExpiresIn = 16 * time.Minute }, want: store.ErrInvalidPresignPut},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := NewStore()
			input := validGrantInput()
			test.mutate(&input)
			if _, err := fake.PresignPut(context.Background(), input); !errors.Is(err, test.want) {
				t.Fatalf("PresignPut() error = %v, want %v", err, test.want)
			}
			if calls := fake.Calls(); len(calls) != 0 {
				t.Fatalf("Calls() = %+v, want nothing recorded for a refused grant", calls)
			}
		})
	}
}

func TestFakeStorePresignPutFailureInjection(t *testing.T) {
	injected := errors.New("grant unavailable")
	fake := NewStore()
	fake.SetError(OperationPresignPut, injected)
	if _, err := fake.PresignPut(context.Background(), validGrantInput()); !errors.Is(err, injected) {
		t.Fatalf("PresignPut() error = %v, want %v", err, injected)
	}
	if calls := fake.Calls(); len(calls) != 1 {
		t.Fatalf("Calls() = %d entries, want 1 recorded call", len(calls))
	}

	fake.SetError(OperationPresignPut, nil)
	if _, err := fake.PresignPut(context.Background(), validGrantInput()); err != nil {
		t.Fatalf("PresignPut() after clearing the injection error = %v", err)
	}
}

func TestFakeStorePresignPutDoesNotCreateObjects(t *testing.T) {
	fake := NewStore()
	if _, err := fake.PresignPut(context.Background(), validGrantInput()); err != nil {
		t.Fatalf("PresignPut() error = %v", err)
	}
	if _, err := fake.Get(context.Background(), store.GetInput{Ref: validGrantInput().Ref, MaxBytes: 1024}); !errors.Is(err, store.ErrObjectNotFound) {
		t.Fatalf("Get() after PresignPut error = %v, want ErrObjectNotFound", err)
	}
}
