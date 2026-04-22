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
		resp.BodyReader = &limitedResponseReader{reader: resp.BodyReader, limiter: limiter}
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

func (l *responseSizeLimiter) remaining() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.tripped {
		return 0
	}
	remaining := l.max - l.emitted
	if remaining <= 0 {
		l.tripped = true
		return 0
	}
	return remaining
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

type limitedResponseReader struct {
	reader     io.Reader
	limiter    *responseSizeLimiter
	pendingErr error
}

func (r *limitedResponseReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if r.pendingErr != nil {
		err := r.pendingErr
		r.pendingErr = nil
		return 0, err
	}

	remaining := r.limiter.remaining()
	if remaining <= 0 {
		return 0, r.limiter.limitErr()
	}

	readSize := len(p)
	if readSize > remaining {
		readSize = remaining + 1
	}

	target := p
	if readSize != len(p) {
		target = make([]byte, readSize)
	}

	n, err := r.reader.Read(target)
	if n == 0 {
		return 0, err
	}

	emit, overflow := r.limiter.consumeReader(n)
	copy(p, target[:emit])
	if overflow {
		r.pendingErr = r.limiter.limitErr()
		if emit > 0 {
			return emit, nil
		}
		err := r.pendingErr
		r.pendingErr = nil
		return 0, err
	}
	return emit, err
}
