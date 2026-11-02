package localrunner

import (
	"bytes"
	"encoding/base64"
	"errors"
	"testing"
)

func TestDecodeResponsePlain(t *testing.T) {
	response, err := DecodeResponse([]byte(`{
		"statusCode": 201,
		"headers": {"x-one": "1"},
		"multiValueHeaders": {"x-two": ["2", "3"]},
		"cookies": ["a=b", "c=d"],
		"body": "hello"
	}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.StatusCode != 201 || string(response.Body) != "hello" {
		t.Fatalf("unexpected response: %+v", response)
	}
	if len(response.Headers["x-one"]) != 1 || response.Headers["x-one"][0] != "1" {
		t.Fatalf("single header lost: %+v", response.Headers)
	}
	if len(response.Headers["x-two"]) != 2 {
		t.Fatalf("multi-value header lost: %+v", response.Headers)
	}
	if len(response.Cookies) != 2 || response.Streamed {
		t.Fatalf("unexpected cookies/streamed: %+v", response)
	}
}

func TestDecodeResponseBase64(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte{0x00, 0xff, 0x10})
	response, err := DecodeResponse([]byte(`{"statusCode":200,"isBase64Encoded":true,"body":"` + encoded + `"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !bytes.Equal(response.Body, []byte{0x00, 0xff, 0x10}) {
		t.Fatalf("unexpected body: %v", response.Body)
	}
}

func TestDecodeResponseStreamingFrame(t *testing.T) {
	metadata := `{"statusCode":200,"headers":{"content-type":"text/event-stream"},"cookies":["session=1"]}`
	frame := append([]byte(metadata), streamingFrameSeparator...)
	frame = append(frame, []byte("data: one\n\ndata: two\n\n")...)
	response, err := DecodeResponse(frame)
	if err != nil {
		t.Fatalf("decode framed response: %v", err)
	}
	if !response.Streamed {
		t.Fatal("the eight NUL separator must be reported as a framed streaming response")
	}
	if response.StatusCode != 200 || string(response.Body) != "data: one\n\ndata: two\n\n" {
		t.Fatalf("unexpected framed response: %+v", response)
	}
	if response.Headers["content-type"][0] != "text/event-stream" || len(response.Cookies) != 1 {
		t.Fatalf("framed metadata lost: %+v", response)
	}
}

func TestDecodeResponseOrdinaryJSONWithBracesIsNotAFrame(t *testing.T) {
	response, err := DecodeResponse([]byte(`{"statusCode":200,"body":"{\"nested\":true}"}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Streamed || string(response.Body) != `{"nested":true}` {
		t.Fatalf("ordinary JSON was misread as a frame: %+v", response)
	}
}

func TestDecodeResponseHandlerError(t *testing.T) {
	_, err := DecodeResponse([]byte(`{"errorType":"Runtime.Error","errorMessage":"boom"}`))
	var handlerErr *HandlerError
	if !errors.As(err, &handlerErr) {
		t.Fatalf("expected a handler error, got %v", err)
	}
	if handlerErr.Type != "Runtime.Error" || handlerErr.Message != "boom" {
		t.Fatalf("unexpected handler error: %+v", handlerErr)
	}
}

func TestDecodeResponseRejectsInvalidPayloads(t *testing.T) {
	cases := map[string]string{
		"empty":          "   ",
		"not json":       "plain text",
		"missing status": `{"body":"hello"}`,
		"invalid status": `{"statusCode":700,"body":"hello"}`,
		"invalid base64": `{"statusCode":200,"isBase64Encoded":true,"body":"!!!"}`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeResponse([]byte(payload)); err == nil {
				t.Fatalf("expected %s to fail", name)
			}
		})
	}
}
