package apptheory

import "testing"

func TestExtractTraceIDFromHeaders(t *testing.T) {
	t.Parallel()

	const w3cTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	const xrayTraceID = "1-65f1a2b3-1234567890abcdef12345678"

	tests := []struct {
		name    string
		headers map[string][]string
		want    string
	}{
		{
			name: "traceparent takes precedence over x-amzn trace id",
			headers: map[string][]string{
				traceParentHeaderName: {"00-" + w3cTraceID + "-00f067aa0ba902b7-01"},
				xAmznTraceIDHeader:    {"Root=" + xrayTraceID},
			},
			want: w3cTraceID,
		},
		{
			name: "falls back to x-amzn trace id when traceparent is invalid",
			headers: map[string][]string{
				traceParentHeaderName: {"00-not-a-trace-id-00f067aa0ba902b7-01"},
				xAmznTraceIDHeader:    {"Self=1; Root=" + xrayTraceID + "; Sampled=1"},
			},
			want: xrayTraceID,
		},
		{
			name: "uses first non-empty header value",
			headers: map[string][]string{
				traceParentHeaderName: {"  ", "\t00-" + w3cTraceID + "-00f067aa0ba902b7-01  "},
			},
			want: w3cTraceID,
		},
		{
			name:    "empty when no supported trace context is present",
			headers: map[string][]string{},
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := extractTraceIDFromHeaders(tt.headers); got != tt.want {
				t.Fatalf("unexpected trace id: got=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestTraceIDFromTraceParent(t *testing.T) {
	t.Parallel()

	valid := "4bf92f3577b34da6a3ce929d0e0e4736"
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "blank", value: " ", want: ""},
		{name: "too few parts", value: "00-" + valid, want: ""},
		{name: "wrong trace id length", value: "00-abc-00f067aa0ba902b7-01", want: ""},
		{name: "non hex trace id", value: "00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", want: ""},
		{name: "all zero trace id", value: "00-00000000000000000000000000000000-00f067aa0ba902b7-01", want: ""},
		{name: "valid trace id", value: "00-" + valid + "-00f067aa0ba902b7-01", want: valid},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := traceIDFromTraceParent(tt.value); got != tt.want {
				t.Fatalf("unexpected trace id: got=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestTraceIDFromXAmznTraceID(t *testing.T) {
	t.Parallel()

	valid := "1-65f1a2b3-1234567890abcdef12345678"
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "blank", value: " ", want: ""},
		{name: "no root", value: "Sampled=1;Parent=abc", want: ""},
		{name: "valid root", value: "Sampled=1; Root=" + valid + "; Parent=abcdef", want: valid},
		{name: "root key is case insensitive", value: "root=" + valid, want: valid},
		{name: "wrong part count", value: "Root=1-65f1a2b3", want: ""},
		{name: "wrong version", value: "Root=2-65f1a2b3-1234567890abcdef12345678", want: ""},
		{name: "wrong epoch length", value: "Root=1-65f1a2-1234567890abcdef12345678", want: ""},
		{name: "wrong unique length", value: "Root=1-65f1a2b3-1234567890abcdef", want: ""},
		{name: "non hex epoch", value: "Root=1-zzf1a2b3-1234567890abcdef12345678", want: ""},
		{name: "non hex unique", value: "Root=1-65f1a2b3-1234567890abcdef1234567z", want: ""},
		{name: "all zero unique", value: "Root=1-65f1a2b3-000000000000000000000000", want: ""},
		{name: "malformed segment before root is ignored", value: "Self;Root=" + valid, want: valid},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := traceIDFromXAmznTraceID(tt.value); got != tt.want {
				t.Fatalf("unexpected trace id: got=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestTraceContextHelpers(t *testing.T) {
	t.Parallel()

	if !isLowerHex("") || !isLowerHex("abc123") {
		t.Fatalf("expected empty and lowercase hex values to be accepted")
	}
	if isLowerHex("ABC123") || isLowerHex("abcxyz") {
		t.Fatalf("expected uppercase and non-hex values to be rejected")
	}
	if allZero("") || allZero("00010") || !allZero("00000") {
		t.Fatalf("unexpected all-zero classification")
	}
}

func TestContextTraceContextID(t *testing.T) {
	t.Parallel()

	var nilCtx *Context
	if got := nilCtx.TraceContextID(); got != "" {
		t.Fatalf("nil context trace id: got=%q want empty", got)
	}
	ctx := &Context{TraceID: " trace_1 \t"}
	if got := ctx.TraceContextID(); got != "trace_1" {
		t.Fatalf("context trace id: got=%q want trace_1", got)
	}
}
