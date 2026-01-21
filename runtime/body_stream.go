package apptheory

import (
	"context"
	"errors"
)

// StreamChunk is a single streaming response body chunk.
//
// If Err is non-nil, the stream MUST terminate and callers MUST treat it as a stream error.
type StreamChunk struct {
	Bytes []byte
	Err   error
}

// BodyStream is a portable stream-of-bytes response body.
//
// It is represented as a channel of chunks so callers can deterministically capture chunk boundaries in tests.
type BodyStream <-chan StreamChunk

// StreamBytes builds a BodyStream from an ordered list of byte chunks.
func StreamBytes(chunks ...[]byte) BodyStream {
	out := make(chan StreamChunk, len(chunks))
	for _, chunk := range chunks {
		out <- StreamChunk{Bytes: append([]byte(nil), chunk...)}
	}
	close(out)
	return out
}

// StreamError emits a terminal stream error.
func StreamError(err error) BodyStream {
	out := make(chan StreamChunk, 1)
	out <- StreamChunk{Err: err}
	close(out)
	return out
}

// CaptureBodyStream reads the provided stream until completion, context cancellation, or error.
//
// It returns the captured chunks, concatenated body bytes, and an error if one occurred.
func CaptureBodyStream(ctx context.Context, stream BodyStream) ([][]byte, []byte, error) {
	if ctx == nil {
		return nil, nil, errors.New("apptheory: nil context")
	}
	if stream == nil {
		return nil, nil, nil
	}

	var chunks [][]byte
	var body []byte

	for {
		select {
		case <-ctx.Done():
			return chunks, body, ctx.Err()
		case chunk, ok := <-stream:
			if !ok {
				return chunks, body, nil
			}
			if chunk.Err != nil {
				return chunks, body, chunk.Err
			}
			if len(chunk.Bytes) == 0 {
				chunks = append(chunks, []byte{})
				continue
			}
			copied := append([]byte(nil), chunk.Bytes...)
			chunks = append(chunks, copied)
			body = append(body, copied...)
		}
	}
}
