package logger

import (
	"context"
	"testing"

	"github.com/theory-cloud/apptheory/pkg/observability"
)

type stubLogger struct{}

func (s *stubLogger) Debug(_ string, _ ...map[string]any) {}
func (s *stubLogger) Info(_ string, _ ...map[string]any)  {}
func (s *stubLogger) Warn(_ string, _ ...map[string]any)  {}
func (s *stubLogger) Error(_ string, _ ...map[string]any) {}

func (s *stubLogger) WithField(_ string, _ any) observability.StructuredLogger {
	return s
}
func (s *stubLogger) WithFields(_ map[string]any) observability.StructuredLogger {
	return s
}
func (s *stubLogger) WithRequestID(_ string) observability.StructuredLogger { return s }
func (s *stubLogger) WithTenantID(_ string) observability.StructuredLogger  { return s }
func (s *stubLogger) WithUserID(_ string) observability.StructuredLogger    { return s }
func (s *stubLogger) WithTraceID(_ string) observability.StructuredLogger   { return s }
func (s *stubLogger) WithSpanID(_ string) observability.StructuredLogger    { return s }
func (s *stubLogger) Flush(_ context.Context) error                         { return nil }
func (s *stubLogger) Close() error                                          { return nil }
func (s *stubLogger) IsHealthy() bool                                       { return true }
func (s *stubLogger) GetStats() observability.LoggerStats                   { return observability.LoggerStats{} }

func TestLogger_DefaultIsNoOp(t *testing.T) {
	got := Logger()
	if got == nil {
		t.Fatal("expected Logger() to return a non-nil logger")
	}
	if !got.IsHealthy() {
		t.Fatal("expected default logger to be healthy")
	}
}

func TestLogger_SetLogger(t *testing.T) {
	stub := &stubLogger{}
	SetLogger(stub)
	if Logger() != stub {
		t.Fatal("expected Logger() to return the logger set via SetLogger")
	}

	SetLogger(nil)
	if Logger() == nil {
		t.Fatal("expected Logger() to reset to a non-nil logger")
	}
	if Logger() == stub {
		t.Fatal("expected Logger() to reset away from the previous logger")
	}
}
