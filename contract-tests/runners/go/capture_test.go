package main

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()

	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = w

	var buf bytes.Buffer
	copyErr := make(chan error, 1)
	go func() {
		_, err := io.Copy(&buf, r)
		copyErr <- err
	}()

	fn()

	os.Stderr = old
	if err := w.Close(); err != nil {
		t.Fatalf("close write pipe: %v", err)
	}
	if err := <-copyErr; err != nil {
		t.Fatalf("copy stderr: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("close read pipe: %v", err)
	}
	return buf.String()
}
