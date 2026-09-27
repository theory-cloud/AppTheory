package apptheory

import (
	"context"
	"io"
	"sync"
)

func limitStreamedResponse(ctx context.Context, resp Response, maxBytes int) Response {
	if maxBytes <= 0 || (resp.BodyReader == nil && resp.BodyStream == nil) {
		return resp
	}

	limiter := &responseSizeLimiter{
		max:     maxBytes,
		emitted: len(resp.Body),
	}
	if resp.BodyReader != nil {
		resp.BodyReader = limitBodyReader(resp.BodyReader, limiter)
	}
	if resp.BodyStream != nil {
		resp.BodyStream = limitBodyStream(ctx, resp.BodyStream, limiter)
	}
	return resp
}

type responseSizeLimiter struct {
	max     int
	emitted int
	tripped bool
	mu      sync.Mutex
}

func (l *responseSizeLimiter) allowChunk(size int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.tripped {
		return false
	}
	if size <= 0 {
		return true
	}
	if l.emitted+size > l.max {
		l.tripped = true
		return false
	}
	l.emitted += size
	return true
}

func (l *responseSizeLimiter) consumeReader(size int) (int, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.tripped {
		return 0, true
	}
	remaining := l.max - l.emitted
	if remaining <= 0 {
		l.tripped = true
		return 0, true
	}
	if size > remaining {
		l.emitted = l.max
		l.tripped = true
		return remaining, true
	}
	l.emitted += size
	return size, false
}

func (l *responseSizeLimiter) limitErr() error {
	return &AppError{Code: errorCodeTooLarge, Message: errorMessageResponseTooLarge}
}

// limitBodyStream applies the response byte budget to a portably streamed body.
//
// A channel-to-channel transform needs a goroutine, so the producer observes ctx
// at both of its blocking points (the receive from the handler's stream and the
// send to the consumer). The adapters that buffer a streamed body cancel that
// context before they return, which is what lets the producer exit when the
// adapter abandons the body instead of outliving the invocation.
func limitBodyStream(ctx context.Context, stream BodyStream, limiter *responseSizeLimiter) BodyStream {
	if stream == nil || limiter == nil {
		return stream
	}
	if ctx == nil {
		ctx = context.Background()
	}

	out := make(chan StreamChunk)
	go func() {
		defer close(out)
		for {
			var chunk StreamChunk
			var ok bool
			select {
			case <-ctx.Done():
				return
			case chunk, ok = <-stream:
				if !ok {
					return
				}
			}
			if chunk.Err != nil {
				sendStreamChunk(ctx, out, chunk)
				return
			}
			if len(chunk.Bytes) == 0 {
				if !sendStreamChunk(ctx, out, StreamChunk{Bytes: []byte{}}) {
					return
				}
				continue
			}
			if !limiter.allowChunk(len(chunk.Bytes)) {
				sendStreamChunk(ctx, out, StreamChunk{Err: limiter.limitErr()})
				return
			}
			if !sendStreamChunk(ctx, out, StreamChunk{Bytes: append([]byte(nil), chunk.Bytes...)}) {
				return
			}
		}
	}()
	return out
}

func sendStreamChunk(ctx context.Context, out chan<- StreamChunk, chunk StreamChunk) bool {
	select {
	case <-ctx.Done():
		return false
	case out <- chunk:
		return true
	}
}

// limitBodyReader applies the response byte budget to a reader body.
//
// The accounting happens inline on the consumer's goroutine: the wrapper needs
// no producer of its own, so a reader the adapter abandons cannot leave a
// goroutine behind.
//
// The wrapper implements io.Closer and delegates Close to the reader it wraps.
// That is what keeps the close path intact through the limiter: a buffered
// adapter that gives up on a limited body closes it to unblock and join the
// producer behind it, and a response-streaming transport closes the body on a
// client disconnect. Without the forwarded Close the limiter would hide the
// producer's closer and the body could not be joined.
func limitBodyReader(reader io.Reader, limiter *responseSizeLimiter) io.Reader {
	if reader == nil || limiter == nil {
		return reader
	}
	return &limitedBodyReader{reader: reader, limiter: limiter}
}

type limitedBodyReader struct {
	reader  io.Reader
	limiter *responseSizeLimiter
}

func (r *limitedBodyReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n <= 0 {
		return n, err
	}

	emit, overflow := r.limiter.consumeReader(n)
	if overflow {
		// The budget is exhausted mid-read: hand the consumer the bytes that
		// still fit together with the size error, which is what the previous
		// pipe-based limiter produced across two reads.
		return emit, r.limiter.limitErr()
	}
	return emit, err
}

func (r *limitedBodyReader) Close() error {
	if r == nil || r.reader == nil {
		return nil
	}
	if closer, ok := r.reader.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}
