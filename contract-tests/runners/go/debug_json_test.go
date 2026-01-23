package main

import (
	"strings"
	"testing"
)

func TestMarshalIndentOrPlaceholder_UsesPlaceholderOnMarshalError(t *testing.T) {
	// Channels are not JSON-marshalable.
	out := marshalIndentOrPlaceholder(make(chan int))
	if !strings.HasPrefix(string(out), "<unavailable:") {
		t.Fatalf("expected placeholder, got %q", string(out))
	}
}

func TestJSONEqual_FalseOnMarshalError(t *testing.T) {
	if jsonEqual(map[string]any{"ok": make(chan int)}, map[string]any{"ok": true}) {
		t.Fatal("expected false on marshal error")
	}
}
