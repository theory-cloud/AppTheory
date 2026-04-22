package apptheory

import (
	"io"
	"sync"
)

func limitStreamedResponse(resp Response, maxBytes int) Response {
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
		resp.BodyStream = limitBodyStream(resp.BodyStream, limiter)
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

func limitBodyStream(stream BodyStream, limiter *responseSizeLimiter) BodyStream {
	if stream == nil || limiter == nil {
		return stream
	}

	out := make(chan StreamChunk)
	go func() {
		defer close(out)
		for chunk := range stream {
			if chunk.Err != nil {
				out <- chunk
				return
			}
			if len(chunk.Bytes) == 0 {
				out <- StreamChunk{Bytes: []byte{}}
				continue
			}
			if !limiter.allowChunk(len(chunk.Bytes)) {
				out <- StreamChunk{Err: limiter.limitErr()}
				return
			}
			out <- StreamChunk{Bytes: append([]byte(nil), chunk.Bytes...)}
		}
	}()
	return out
}

func limitBodyReader(reader io.Reader, limiter *responseSizeLimiter) io.Reader {
	if reader == nil || limiter == nil {
		return reader
	}

	pr, pw := io.Pipe()
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := reader.Read(buf)
			if writeLimitedReaderChunk(pw, limiter, buf[:n]) {
				return
			}
			if err == nil {
				continue
			}
			if err == io.EOF {
				closeResponseLimitPipeWriter(pw)
				return
			}
			closeResponseLimitPipeWriterWithError(pw, err)
			return
		}
	}()

	return pr
}

func writeLimitedReaderChunk(pw *io.PipeWriter, limiter *responseSizeLimiter, chunk []byte) bool {
	if len(chunk) == 0 {
		return false
	}

	emit, overflow := limiter.consumeReader(len(chunk))
	if emit > 0 {
		if _, err := pw.Write(chunk[:emit]); err != nil {
			return true
		}
	}
	if !overflow {
		return false
	}

	closeResponseLimitPipeWriterWithError(pw, limiter.limitErr())
	return true
}

func closeResponseLimitPipeWriter(pw *io.PipeWriter) {
	if pw == nil {
		return
	}
	if err := pw.Close(); err != nil {
		return
	}
}

func closeResponseLimitPipeWriterWithError(pw *io.PipeWriter, err error) {
	if pw == nil {
		return
	}
	if closeErr := pw.CloseWithError(err); closeErr != nil {
		return
	}
}
