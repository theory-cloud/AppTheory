package localrunner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

func newTestS3Origin(t *testing.T, handler http.HandlerFunc) (*s3Origin, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := s3.New(s3.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(server.URL),
		UsePathStyle: true,
	})
	return &s3Origin{
		originID:     "Origin1",
		bucket:       "bucket",
		client:       client,
		noListBucket: true,
		requestID:    func() string { return "local-request-id" },
	}, server
}

func TestS3OriginGetReturnsTheObjectAndHeaders(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/bucket/hello.txt" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writer.Header().Set("ETag", `"abc123"`)
		writer.Header().Set("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
		writer.Header().Set("Content-Length", "6")
		writer.Header().Set("Cache-Control", "public, max-age=60")
		writer.Header().Set("x-amz-meta-owner", "example")
		_, _ = writer.Write([]byte("hello\n")) //nolint:errcheck // test response fixture
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/hello.txt"})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusOK || string(response.Body) != "hello\n" {
		t.Fatalf("response = %d %q", response.StatusCode, response.Body)
	}
	for name, want := range map[string]string{
		"Content-Type":     "text/plain; charset=utf-8",
		"ETag":             `"abc123"`,
		"Last-Modified":    "Wed, 21 Oct 2015 07:28:00 GMT",
		"Content-Length":   "6",
		"Cache-Control":    "public, max-age=60",
		"Accept-Ranges":    "bytes",
		"x-amz-meta-owner": "example",
	} {
		if got := response.Header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestS3OriginHeadHasNoBody(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead {
			t.Errorf("method = %s", request.Method)
		}
		writer.Header().Set("Content-Type", "text/html")
		writer.Header().Set("Content-Length", "5")
		writer.WriteHeader(http.StatusOK)
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodHead, URI: "/index.html"})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusOK || len(response.Body) != 0 {
		t.Fatalf("response = %d %q", response.StatusCode, response.Body)
	}
	if response.Header.Get("Content-Type") != "text/html" {
		t.Fatalf("content type = %q", response.Header.Get("Content-Type"))
	}
}

func TestS3OriginHeadRangeReturns206WithContentRange(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodHead {
			t.Errorf("method = %s", request.Method)
		}
		if got := request.Header.Get("Range"); got != "bytes=0-4" {
			t.Errorf("range = %q", got)
		}
		// S3 documents the 206 response, Content-Range and ranged Content-Length
		// for a satisfiable HeadObject Range. A backend that reports the ranged
		// metadata with a plain 200 must still map to 206 locally.
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Range", "bytes 0-4/11")
		writer.Header().Set("Content-Length", "5")
		writer.Header().Set("ETag", `"abc123"`)
		writer.WriteHeader(http.StatusOK)
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method: http.MethodHead,
		URI:    "/hello.txt",
		Range:  "bytes=0-4",
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206 for a satisfiable HEAD Range", response.StatusCode)
	}
	if got := response.Header.Get("Content-Range"); got != "bytes 0-4/11" {
		t.Fatalf("content range = %q", got)
	}
	if got := response.Header.Get("Content-Length"); got != "5" {
		t.Fatalf("content length = %q, want the ranged length", got)
	}
	if len(response.Body) != 0 {
		t.Fatalf("HEAD body = %q, want no body", response.Body)
	}
}

func TestS3OriginMissingObjectIs403UnderOACAnd404WithoutIt(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/xml")
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)) //nolint:errcheck // test response fixture
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/missing.txt"})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusForbidden || !strings.Contains(string(response.Body), "AccessDenied") {
		t.Fatalf("OAC response = %d %q", response.StatusCode, response.Body)
	}
	origin.noListBucket = false
	response, err = origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/missing.txt"})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusNotFound || !strings.Contains(string(response.Body), "NoSuchKey") {
		t.Fatalf("public response = %d %q", response.StatusCode, response.Body)
	}
}

func TestS3OriginRangeReturns206(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Range"); got != "bytes=0-4" {
			t.Errorf("range = %q", got)
		}
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Range", "bytes 0-4/11")
		writer.Header().Set("Content-Length", "5")
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write([]byte("hello")) //nolint:errcheck // test response fixture
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method: http.MethodGet,
		URI:    "/hello.txt",
		Range:  "bytes=0-4",
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.StatusCode != http.StatusPartialContent || string(response.Body) != "hello" {
		t.Fatalf("response = %d %q", response.StatusCode, response.Body)
	}
	if response.Header.Get("Content-Range") != "bytes 0-4/11" {
		t.Fatalf("content range = %q", response.Header.Get("Content-Range"))
	}
}

func TestS3OriginAppliesResponseOverridesUnlessTheManagedPolicySuppressedThem(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Disposition", "attachment; filename=object.txt")
		writer.Header().Set("Cache-Control", "public, max-age=60")
		writer.Header().Set("Content-Length", "2")
		_, _ = writer.Write([]byte("ok")) //nolint:errcheck // test response fixture
	})
	query := "a=1&response-content-type=text/html&response-content-disposition=inline&response-content-encoding=gzip"
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method:                      http.MethodGet,
		URI:                         "/hello.txt",
		Query:                       query,
		SuppressS3ResponseOverrides: true,
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got := response.Header.Get("Content-Type"); got != "text/plain" {
		t.Fatalf("suppressed content type = %q", got)
	}
	response, err = origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method: http.MethodGet,
		URI:    "/hello.txt",
		Query:  query,
	})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got := response.Header.Get("Content-Type"); got != "text/html" {
		t.Fatalf("overridden content type = %q", got)
	}
	if got := response.Header.Get("Content-Disposition"); got != "inline" {
		t.Fatalf("overridden disposition = %q", got)
	}
}

func TestS3OriginOptionsRefusesCORSInsteadOfInventingIt(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(http.ResponseWriter, *http.Request) {
		t.Error("OPTIONS must not reach the S3 emulator")
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodOptions, URI: "/hello.txt"})
	if err != nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("without CORS: %d %v", response.StatusCode, err)
	}
	origin.hasCORS = true
	response, err = origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodOptions, URI: "/hello.txt"})
	if err != nil || response.StatusCode != http.StatusNotImplemented {
		t.Fatalf("with CORS: %d %v", response.StatusCode, err)
	}
}

func TestS3OriginRefusesMethodsItDoesNotImplement(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(http.ResponseWriter, *http.Request) {
		t.Error("an unsupported method must not reach S3")
	})
	_, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodPut, URI: "/hello.txt"})
	if err == nil || !strings.Contains(err.Error(), "GET, HEAD and OPTIONS") {
		t.Fatalf("err = %v", err)
	}
}

func TestS3OriginEmptyPathIsMissing(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(http.ResponseWriter, *http.Request) {
		t.Error("an empty key must not reach S3")
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/"})
	if err != nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("response = %d err = %v", response.StatusCode, err)
	}
}

func TestS3OriginUnreachableBackendIsAnError(t *testing.T) {
	origin, server := newTestS3Origin(t, func(http.ResponseWriter, *http.Request) {})
	server.Close()
	_, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/hello.txt"})
	if err == nil {
		t.Fatal("an unreachable S3 backend must be an error")
	}
}

func TestS3OriginPassesVersionAndConditionalHeaders(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("versionId") != "v1" {
			t.Errorf("versionId = %q", request.URL.Query().Get("versionId"))
		}
		if request.Header.Get("If-Modified-Since") == "" || request.Header.Get("If-None-Match") == "" {
			t.Errorf("conditional headers were not forwarded: %v", request.Header)
		}
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Length", "2")
		_, _ = writer.Write([]byte("ok")) //nolint:errcheck // test response fixture
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
		Method: http.MethodGet,
		URI:    "/hello.txt",
		Query:  "versionId=v1",
		Header: http.Header{
			"If-None-Match":     {`"abc"`},
			"If-Modified-Since": {"Wed, 21 Oct 2015 07:28:00 GMT"},
		},
	})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("response = %d err = %v", response.StatusCode, err)
	}
}

func TestS3OriginPassesConditionalStatusesThroughWithValidators(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		header   string
		value    string
		want     int
		wantDate bool
	}{
		{name: "not modified", status: http.StatusNotModified, header: "If-None-Match", value: `"abc123"`, want: http.StatusNotModified},
		{name: "precondition failed if-match", status: http.StatusPreconditionFailed, header: "If-Match", value: `"abc123"`, want: http.StatusPreconditionFailed, wantDate: true},
		{name: "precondition failed if-unmodified-since", status: http.StatusPreconditionFailed, header: "If-Unmodified-Since", value: "Wed, 21 Oct 2015 07:28:00 GMT", want: http.StatusPreconditionFailed, wantDate: true},
	}
	for _, testCase := range cases {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			t.Run(testCase.name+"/"+method, func(t *testing.T) {
				origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, request *http.Request) {
					if testCase.wantDate && request.Header.Get("If-Unmodified-Since") == "" {
						t.Errorf("If-Unmodified-Since was not forwarded: %v", request.Header)
					}
					writer.Header().Set("ETag", `"abc123"`)
					writer.Header().Set("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
					writer.WriteHeader(testCase.status)
				})
				headers := http.Header{testCase.header: {testCase.value}}
				if testCase.header != "If-Unmodified-Since" {
					headers.Set("If-Unmodified-Since", "Wed, 21 Oct 2015 07:28:00 GMT")
				}
				response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{
					Method: method,
					URI:    "/hello.txt",
					Header: headers,
				})
				if err != nil {
					t.Fatalf("fetch: %v", err)
				}
				if response.StatusCode != testCase.want {
					t.Fatalf("status = %d, want %d", response.StatusCode, testCase.want)
				}
				if got := response.Header.Get("ETag"); got != `"abc123"` {
					t.Fatalf("etag = %q", got)
				}
				if got := response.Header.Get("Last-Modified"); got != "Wed, 21 Oct 2015 07:28:00 GMT" {
					t.Fatalf("last-modified = %q", got)
				}
				if len(response.Body) != 0 {
					t.Fatalf("body = %q, want no body", response.Body)
				}
			})
		}
	}
}

func TestS3OriginMapsAccessDeniedAndInvalidRange(t *testing.T) {
	cases := []struct {
		status int
		code   string
		want   int
	}{
		{status: http.StatusForbidden, code: "AccessDenied", want: http.StatusForbidden},
		{status: http.StatusRequestedRangeNotSatisfiable, code: "InvalidRange", want: http.StatusRequestedRangeNotSatisfiable},
	}
	for _, testCase := range cases {
		t.Run(testCase.code, func(t *testing.T) {
			origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/xml")
				writer.WriteHeader(testCase.status)
				_, _ = writer.Write([]byte(`<Error><Code>` + testCase.code + `</Code><Message>no</Message></Error>`)) //nolint:errcheck // test response fixture
			})
			response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x"})
			if err != nil || response.StatusCode != testCase.want {
				t.Fatalf("response = %d err = %v", response.StatusCode, err)
			}
			if !strings.Contains(string(response.Body), testCase.code) {
				t.Fatalf("body = %q", response.Body)
			}
		})
	}
}

func TestS3OriginHeadMissingIs403UnderOAC(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodHead, URI: "/x"})
	if err != nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("response = %d err = %v", response.StatusCode, err)
	}
	if len(response.Body) != 0 {
		t.Fatalf("HEAD error body = %q", response.Body)
	}
}

func TestS3OriginPassesExpires(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Expires", "Wed, 21 Oct 2015 07:28:00 GMT")
		writer.Header().Set("Content-Length", "2")
		_, _ = writer.Write([]byte("ok")) //nolint:errcheck // test response fixture
	})
	response, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x"})
	if err != nil || response.Header.Get("Expires") != "Wed, 21 Oct 2015 07:28:00 GMT" {
		t.Fatalf("expires = %q err = %v", response.Header.Get("Expires"), err)
	}
}

func TestS3OriginReadErrorIsAnError(t *testing.T) {
	origin, _ := newTestS3Origin(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Length", "100")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte("short")) //nolint:errcheck // test response fixture
	})
	if _, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x"}); err == nil {
		t.Fatal("a short object body must be an error")
	}
}
