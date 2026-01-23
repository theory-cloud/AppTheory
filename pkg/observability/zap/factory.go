package zap

import "github.com/theory-cloud/apptheory/pkg/observability"

type Factory struct {
	options []Option
}

var _ observability.LoggerFactory = (*Factory)(nil)

func NewZapLoggerFactory(options ...Option) *Factory {
	return &Factory{options: append([]Option(nil), options...)}
}

func (f *Factory) CreateConsoleLogger(config observability.LoggerConfig) (observability.StructuredLogger, error) {
	return NewZapLogger(config, f.options...)
}

func (f *Factory) CreateTestLogger() observability.StructuredLogger {
	return observability.NewTestLogger()
}

func (f *Factory) CreateNoOpLogger() observability.StructuredLogger {
	return observability.NewNoOpLogger()
}
