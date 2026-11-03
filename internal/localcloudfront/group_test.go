package localcloudfront

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestOriginGroupServesThePrimaryWhenItSucceeds(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 200, Body: []byte("primary")}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200, Body: []byte("secondary")}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary, OriginPath: "/html"},
		{OriginID: "Secondary", Origin: secondary, OriginPath: "/ssr"},
	}, []int{403, 404})
	response, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/x"})
	if err != nil || response.StatusCode != 200 || string(response.Body) != "primary" {
		t.Fatalf("response = %+v err = %v", response, err)
	}
	if len(secondary.requests) != 0 {
		t.Fatalf("secondary called %d times", len(secondary.requests))
	}
	if primary.requests[0].OriginPath != "/html" {
		t.Fatalf("primary origin path = %q", primary.requests[0].OriginPath)
	}
}

func TestOriginGroupFailsOverOnAConfiguredStatus(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 403, Body: []byte("denied")}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200, Body: []byte("ssr")}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary, OriginPath: "/html", Host: "html.example"},
		{OriginID: "Secondary", Origin: secondary, OriginPath: "/ssr", Host: "ssr.example"},
	}, []int{403, 404})
	response, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet, URI: "/x"})
	if err != nil || response.StatusCode != 200 || string(response.Body) != "ssr" {
		t.Fatalf("response = %+v err = %v", response, err)
	}
	if len(secondary.requests) != 1 || secondary.requests[0].OriginPath != "/ssr" || secondary.requests[0].Host != "ssr.example" {
		t.Fatalf("secondary request = %+v", secondary.requests)
	}
}

func TestOriginGroupDoesNotFailOverOnAnUnconfiguredStatus(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 500}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary},
		{OriginID: "Secondary", Origin: secondary},
	}, []int{403})
	response, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet})
	if err != nil || response.StatusCode != 500 {
		t.Fatalf("response = %+v err = %v", response, err)
	}
	if len(secondary.requests) != 0 {
		t.Fatalf("secondary called %d times", len(secondary.requests))
	}
}

func TestOriginGroupDoesNotFailOverNonRetryableMethods(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		primary := &recordingOrigin{response: OriginResponse{StatusCode: 403}}
		secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
		group := NewOriginGroupOrigin("Group", []OriginGroupMember{
			{OriginID: "Primary", Origin: primary},
			{OriginID: "Secondary", Origin: secondary},
		}, []int{403, 404})
		response, err := group.Fetch(context.Background(), OriginRequest{Method: method})
		if err != nil || response.StatusCode != 403 {
			t.Fatalf("%s response = %+v err = %v", method, response, err)
		}
		if len(secondary.requests) != 0 {
			t.Fatalf("%s: secondary called %d times", method, len(secondary.requests))
		}
	}
}

func TestOriginGroupFailsOverForHead(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 404}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary},
		{OriginID: "Secondary", Origin: secondary},
	}, []int{404})
	if _, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodHead}); err != nil {
		t.Fatalf("HEAD: %v", err)
	}
	if len(secondary.requests) != 1 {
		t.Fatalf("HEAD: secondary called %d times", len(secondary.requests))
	}
}

func TestOriginGroupFailsOverOptionsOnlyWhenCachedMethodsIncludesIt(t *testing.T) {
	cases := []struct {
		name          string
		cachedMethods []string
		wantSecondary int
	}{
		{name: "omitted", cachedMethods: nil, wantSecondary: 0},
		{name: "get and head only", cachedMethods: []string{"GET", "HEAD"}, wantSecondary: 0},
		{name: "options cached", cachedMethods: []string{"GET", "HEAD", "OPTIONS"}, wantSecondary: 1},
		{name: "options cached lowercase", cachedMethods: []string{"options"}, wantSecondary: 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			primary := &recordingOrigin{response: OriginResponse{StatusCode: 404}}
			secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
			group := NewOriginGroupOrigin("Group", []OriginGroupMember{
				{OriginID: "Primary", Origin: primary},
				{OriginID: "Secondary", Origin: secondary},
			}, []int{404})
			response, err := group.Fetch(context.Background(), OriginRequest{
				Method:        http.MethodOptions,
				CachedMethods: testCase.cachedMethods,
			})
			if err != nil {
				t.Fatalf("OPTIONS: %v", err)
			}
			if testCase.wantSecondary == 0 {
				if response.StatusCode != 404 {
					t.Fatalf("status = %d, want the primary's 404", response.StatusCode)
				}
			} else if response.StatusCode != 200 {
				t.Fatalf("status = %d, want the secondary's 200", response.StatusCode)
			}
			if len(secondary.requests) != testCase.wantSecondary {
				t.Fatalf("secondary called %d times, want %d", len(secondary.requests), testCase.wantSecondary)
			}
		})
	}
}

func TestOriginGroupFailoverUsesTheMemberHostUnlessTheViewerHostWasForwarded(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 404}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary, Host: "primary.example"},
		{OriginID: "Secondary", Origin: secondary, Host: "secondary.example"},
	}, []int{404})
	if _, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet, Host: "viewer.example"}); err != nil {
		t.Fatal(err)
	}
	if secondary.requests[0].Host != "viewer.example" {
		t.Fatalf("forwarded Host = %q", secondary.requests[0].Host)
	}
}

func TestOriginGroupFailsOverOnConnectionAndTimeoutErrorsWhenConfigured(t *testing.T) {
	timeout := &netTimeoutError{}
	cases := []struct {
		name   string
		err    error
		codes  []int
		called bool
	}{
		{name: "connection with 503", err: errors.New("connection refused"), codes: []int{503}, called: true},
		{name: "connection without 503", err: errors.New("connection refused"), codes: []int{403}, called: false},
		{name: "timeout with 504", err: timeout, codes: []int{504}, called: true},
		{name: "deadline with 504", err: context.DeadlineExceeded, codes: []int{504}, called: true},
		{name: "timeout without 504", err: timeout, codes: []int{503}, called: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			primary := &recordingOrigin{err: testCase.err}
			secondary := &recordingOrigin{response: OriginResponse{StatusCode: 200}}
			group := NewOriginGroupOrigin("Group", []OriginGroupMember{
				{OriginID: "Primary", Origin: primary},
				{OriginID: "Secondary", Origin: secondary},
			}, testCase.codes)
			response, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet})
			if testCase.called {
				if err != nil || response.StatusCode != 200 || len(secondary.requests) != 1 {
					t.Fatalf("response = %+v err = %v calls = %d", response, err, len(secondary.requests))
				}
				return
			}
			if !errors.Is(err, testCase.err) || len(secondary.requests) != 0 {
				t.Fatalf("err = %v calls = %d", err, len(secondary.requests))
			}
		})
	}
}

func TestOriginGroupReturnsTheSecondaryResponseWhenBothMembersFail(t *testing.T) {
	primary := &recordingOrigin{response: OriginResponse{StatusCode: 403}}
	secondary := &recordingOrigin{response: OriginResponse{StatusCode: 404, Body: []byte("missing")}}
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{
		{OriginID: "Primary", Origin: primary},
		{OriginID: "Secondary", Origin: secondary},
	}, []int{403, 404})
	response, err := group.Fetch(context.Background(), OriginRequest{Method: http.MethodGet})
	if err != nil || response.StatusCode != 404 || string(response.Body) != "missing" {
		t.Fatalf("response = %+v err = %v", response, err)
	}
	if len(secondary.requests) != 1 {
		t.Fatalf("secondary called %d times", len(secondary.requests))
	}
}

func TestOriginGroupWithoutTwoMembersIsUnavailable(t *testing.T) {
	group := NewOriginGroupOrigin("Group", []OriginGroupMember{{OriginID: "Only", Origin: &recordingOrigin{}}}, nil)
	_, err := group.Fetch(context.Background(), OriginRequest{})
	var unavailable *OriginUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("err = %v", err)
	}
}

type netTimeoutError struct{}

func (e *netTimeoutError) Error() string   { return "i/o timeout" }
func (e *netTimeoutError) Timeout() bool   { return true }
func (e *netTimeoutError) Temporary() bool { return true }
