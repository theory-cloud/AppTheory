package testkit

import (
	"context"
	"errors"
	"io"

	"github.com/theory-cloud/apptheory/runtime"
)

// StreamResult captures a streamed AppTheory response deterministically for tests.
type StreamResult struct {
	Status          int
	Headers         map[string][]string
	Cookies         []string
	Chunks          [][]byte
	Body            []byte
	IsBase64        bool
	StreamErrorCode string
}

// InvokeStreaming executes an AppTheory request and captures streamed response chunks deterministically.
//
// Headers and cookies are captured before reading the first chunk so tests can assert header finalization.
func (e *Env) InvokeStreaming(ctx context.Context, app *apptheory.App, req apptheory.Request) StreamResult {
	if ctx == nil {
		ctx = context.Background()
	}

	resp := e.Invoke(ctx, app, req)

	headers := cloneHeaders(resp.Headers)
	cookies := append([]string(nil), resp.Cookies...)

	var chunks [][]byte
	var body []byte
	var streamErr error

	if len(resp.Body) > 0 {
		prefix := append([]byte(nil), resp.Body...)
		chunks = append(chunks, prefix)
		body = append(body, prefix...)
	}

	if resp.BodyReader != nil {
		b, err := io.ReadAll(resp.BodyReader)
		if err != nil {
			streamErr = err
		} else if len(b) > 0 {
			copied := append([]byte(nil), b...)
			chunks = append(chunks, copied)
			body = append(body, copied...)
		}
	}

	if resp.BodyStream != nil && streamErr == nil {
		streamChunks, streamBody, err := apptheory.CaptureBodyStream(ctx, resp.BodyStream)
		chunks = append(chunks, streamChunks...)
		body = append(body, streamBody...)
		streamErr = err
	}

	return StreamResult{
		Status:          resp.Status,
		Headers:         headers,
		Cookies:         cookies,
		Chunks:          chunks,
		Body:            body,
		IsBase64:        resp.IsBase64,
		StreamErrorCode: streamErrorCode(streamErr),
	}
}

func cloneHeaders(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range in {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func streamErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var appErr *apptheory.AppError
	if errors.As(err, &appErr) && appErr.Code != "" {
		return appErr.Code
	}
	return "app.internal"
}
