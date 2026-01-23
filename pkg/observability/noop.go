package observability

import "context"

type noopLogger struct{}

var _ StructuredLogger = (*noopLogger)(nil)

func NewNoOpLogger() StructuredLogger {
	return &noopLogger{}
}

func (n *noopLogger) Debug(_ string, _ ...map[string]any) {}
func (n *noopLogger) Info(_ string, _ ...map[string]any)  {}
func (n *noopLogger) Warn(_ string, _ ...map[string]any)  {}
func (n *noopLogger) Error(_ string, _ ...map[string]any) {}

func (n *noopLogger) WithField(_ string, _ any) StructuredLogger   { return n }
func (n *noopLogger) WithFields(_ map[string]any) StructuredLogger { return n }
func (n *noopLogger) WithRequestID(_ string) StructuredLogger      { return n }
func (n *noopLogger) WithTenantID(_ string) StructuredLogger       { return n }
func (n *noopLogger) WithUserID(_ string) StructuredLogger         { return n }
func (n *noopLogger) WithTraceID(_ string) StructuredLogger        { return n }
func (n *noopLogger) WithSpanID(_ string) StructuredLogger         { return n }
func (n *noopLogger) Flush(_ context.Context) error                { return nil }
func (n *noopLogger) Close() error                                 { return nil }
func (n *noopLogger) IsHealthy() bool                              { return true }
func (n *noopLogger) GetStats() LoggerStats                        { return LoggerStats{} }
