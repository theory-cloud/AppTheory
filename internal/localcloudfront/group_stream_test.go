package localcloudfront

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestOriginGroupStreamsTheSecondaryWhenThePrimaryFailsOver(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: http.StatusForbidden, Body: []byte("denied")}}
	secondary := &fakeStreamOrigin{
		header: http.Header{"Content-Type": []string{"text/html"}},
		chunks: []string{"streamed"},
	}
	group := NewOriginGroupOrigin("group", []OriginGroupMember{
		{OriginID: "primary", Origin: primary, Host: "bucket.example"},
		{OriginID: "secondary", Origin: secondary, Host: "function.example"},
	}, []int{http.StatusForbidden})
	stream, err := group.FetchStream(context.Background(), OriginRequest{
		OriginID: "group", Method: http.MethodGet, URI: "/", Host: "viewer.example",
	})
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.StatusCode != http.StatusOK || !stream.Chunked {
		t.Fatalf("secondary response: %d chunked=%v", stream.StatusCode, stream.Chunked)
	}
	body, err := io.ReadAll(stream.Body)
	if err != nil || string(body) != "streamed" {
		t.Fatalf("streamed body: %q %v", body, err)
	}
}

func TestOriginGroupDoesNotFailOverAStreamedResponseOutsideTheCriteria(t *testing.T) {
	primary := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"primary"}}
	secondary := &fakeStreamOrigin{header: http.Header{}, chunks: []string{"secondary"}}
	group := NewOriginGroupOrigin("group", []OriginGroupMember{
		{OriginID: "primary", Origin: primary},
		{OriginID: "secondary", Origin: secondary},
	}, []int{http.StatusBadGateway})
	stream, err := group.FetchStream(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/"})
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	body, readErr := io.ReadAll(stream.Body)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if string(body) != "primary" {
		t.Fatalf("a 200 primary must not fail over: %q", body)
	}
	if secondary.fetchCount() != 0 {
		t.Fatal("the secondary must not be called")
	}
}

func TestOriginGroupWrapsABufferedPrimaryAsASingleChunk(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/plain"}}, Body: []byte("buffered")}}
	secondary := &fakeStreamOrigin{}
	group := NewOriginGroupOrigin("group", []OriginGroupMember{
		{OriginID: "primary", Origin: primary},
		{OriginID: "secondary", Origin: secondary},
	}, nil)
	stream, err := group.FetchStream(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/"})
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.Chunked {
		t.Fatal("a buffered member is not chunked")
	}
	body, readErr := io.ReadAll(stream.Body)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if string(body) != "buffered" {
		t.Fatalf("body: %q", body)
	}
}

func TestOriginGroupStreamErrorFailsOverOnlyWhenConfigured(t *testing.T) {
	failing := OriginFunc(func(context.Context, OriginRequest) (OriginResponse, error) {
		return OriginResponse{}, &OriginUnavailableError{OriginID: "primary", Reason: "down"}
	})
	secondary := &fakeStreamOrigin{chunks: []string{"secondary"}}
	group := NewOriginGroupOrigin("group", []OriginGroupMember{
		{OriginID: "primary", Origin: failing},
		{OriginID: "secondary", Origin: secondary},
	}, []int{http.StatusServiceUnavailable})
	stream, err := group.FetchStream(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/"})
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	body, readErr := io.ReadAll(stream.Body)
	if readErr != nil {
		t.Fatalf("read stream: %v", readErr)
	}
	if string(body) != "secondary" {
		t.Fatalf("failover body: %q", body)
	}

	notConfigured := NewOriginGroupOrigin("group", []OriginGroupMember{
		{OriginID: "primary", Origin: failing},
		{OriginID: "secondary", Origin: secondary},
	}, []int{http.StatusBadGateway})
	if _, err := notConfigured.FetchStream(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/"}); err == nil ||
		!errors.Is(err, ErrOriginUnavailable) {
		t.Fatalf("an unconfigured failover must return the primary error: %v", err)
	}
}

func TestOriginGroupStreamNeedsTwoMembers(t *testing.T) {
	group := NewOriginGroupOrigin("group", []OriginGroupMember{{OriginID: "only", Origin: &recordingOrigin{}}}, nil)
	if _, err := group.FetchStream(context.Background(), OriginRequest{}); err == nil ||
		!strings.Contains(err.Error(), "needs a primary and a secondary") {
		t.Fatalf("single member: %v", err)
	}
}
