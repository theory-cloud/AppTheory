package zap

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	ubzap "go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/theory-cloud/apptheory/pkg/observability"
	"github.com/theory-cloud/apptheory/pkg/sanitization"
	"github.com/theory-cloud/apptheory/runtime"
)

const (
	levelDebug = "debug"
	levelInfo  = "info"
	levelWarn  = "warn"
	levelError = "error"
)

type Option func(*loggerOptions)

type loggerOptions struct {
	initErr error

	zapLogger *ubzap.Logger
	sanitizer observability.SanitizerFunc
	notifier  observability.ErrorNotifier

	maxRetries int
	retryDelay time.Duration
	bufferSize int
}

func WithZapLogger(logger *ubzap.Logger) Option {
	return func(opts *loggerOptions) {
		opts.zapLogger = logger
	}
}

func WithSanitizer(fn observability.SanitizerFunc) Option {
	return func(opts *loggerOptions) {
		opts.sanitizer = fn
	}
}

func WithErrorNotifier(notifier observability.ErrorNotifier) Option {
	return func(opts *loggerOptions) {
		opts.notifier = notifier
	}
}

type zapCore struct {
	logger *ubzap.Logger

	sanitizer observability.SanitizerFunc
	notifier  observability.ErrorNotifier

	retryDelay time.Duration
	maxRetries int

	notifyMu sync.Mutex
	notifyCh chan observability.LogEntry
	notifyWg sync.WaitGroup

	closeOnce sync.Once
	closed    atomic.Bool

	entriesLogged   atomic.Int64
	entriesDropped  atomic.Int64
	flushCount      atomic.Int64
	errorCount      atomic.Int64
	lastFlushNanos  atomic.Int64
	totalFlushNanos atomic.Int64
	lastError       atomic.Value
}

type Logger struct {
	core *zapCore
	log  *ubzap.Logger

	fields map[string]any

	requestID string
	tenantID  string
	userID    string
	traceID   string
	spanID    string
}

var _ observability.StructuredLogger = (*Logger)(nil)

func NewZapLogger(config observability.LoggerConfig, options ...Option) (observability.StructuredLogger, error) {
	cfg := normalizeLoggerConfig(config)

	opts := &loggerOptions{
		zapLogger:  nil,
		sanitizer:  sanitization.SanitizeFieldValue,
		notifier:   nil,
		maxRetries: cfg.MaxRetries,
		retryDelay: cfg.RetryDelay,
		bufferSize: cfg.BufferSize,
	}
	for _, opt := range options {
		if opt == nil {
			continue
		}
		opt(opts)
	}
	if opts.initErr != nil {
		return nil, opts.initErr
	}

	base := opts.zapLogger
	if base == nil {
		level, err := parseZapLevel(cfg.Level)
		if err != nil {
			return nil, err
		}

		enc := zapEncoderConfig(cfg.EnableCaller)
		var encoder zapcore.Encoder
		switch strings.ToLower(strings.TrimSpace(cfg.Format)) {
		case "console":
			encoder = zapcore.NewConsoleEncoder(enc)
		case "json", "":
			encoder = zapcore.NewJSONEncoder(enc)
		default:
			return nil, errors.New("observability/zap: unsupported log format")
		}

		core := zapcore.NewCore(encoder, zapcore.AddSync(os.Stdout), level)
		base = ubzap.New(core)
		if cfg.EnableCaller {
			base = base.WithOptions(ubzap.AddCaller())
		}
		if cfg.EnableStack {
			base = base.WithOptions(ubzap.AddStacktrace(zapcore.ErrorLevel))
		}
	}

	zcore := &zapCore{
		logger:     base,
		sanitizer:  opts.sanitizer,
		notifier:   opts.notifier,
		retryDelay: opts.retryDelay,
		maxRetries: opts.maxRetries,
		notifyCh:   nil,
	}
	zcore.lastError.Store("")

	if zcore.notifier != nil {
		if opts.bufferSize <= 0 {
			opts.bufferSize = 256
		}
		zcore.notifyCh = make(chan observability.LogEntry, opts.bufferSize)
		go zcore.runNotifier()
	}

	return &Logger{
		core:   zcore,
		log:    base,
		fields: map[string]any{},
	}, nil
}

func normalizeLoggerConfig(config observability.LoggerConfig) observability.LoggerConfig {
	cfg := config

	if strings.TrimSpace(cfg.Format) == "" {
		if apptheory.IsLambda() {
			cfg.Format = "json"
		} else {
			cfg.Format = "console"
		}
	}
	if strings.TrimSpace(cfg.Level) == "" {
		cfg.Level = levelInfo
	}
	if cfg.RetryDelay <= 0 {
		cfg.RetryDelay = time.Second
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 0
	}
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = 256
	}
	return cfg
}

func parseZapLevel(level string) (zapcore.Level, error) {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case levelDebug:
		return zapcore.DebugLevel, nil
	case levelInfo, "":
		return zapcore.InfoLevel, nil
	case levelWarn, "warning":
		return zapcore.WarnLevel, nil
	case levelError:
		return zapcore.ErrorLevel, nil
	default:
		return 0, errors.New("observability/zap: unsupported log level")
	}
}

func zapEncoderConfig(enableCaller bool) zapcore.EncoderConfig {
	enc := zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		MessageKey:     "message",
		EncodeTime:     zapcore.RFC3339TimeEncoder,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeDuration: zapcore.StringDurationEncoder,
	}
	if enableCaller {
		enc.CallerKey = "caller"
		enc.EncodeCaller = zapcore.ShortCallerEncoder
	}
	return enc
}

func (l *Logger) Debug(message string, fields ...map[string]any) {
	l.logEntry(levelDebug, message, fields...)
}
func (l *Logger) Info(message string, fields ...map[string]any) {
	l.logEntry(levelInfo, message, fields...)
}
func (l *Logger) Warn(message string, fields ...map[string]any) {
	l.logEntry(levelWarn, message, fields...)
}
func (l *Logger) Error(message string, fields ...map[string]any) {
	l.logEntry(levelError, message, fields...)
}

func (l *Logger) WithField(key string, value any) observability.StructuredLogger {
	return l.WithFields(map[string]any{key: value})
}

func (l *Logger) WithFields(fields map[string]any) observability.StructuredLogger {
	next := l.clone()
	for k, v := range fields {
		next.fields[k] = v
	}
	next.log = next.log.With(anyFields(fields, l.core.sanitizer)...)
	return next
}

func (l *Logger) WithRequestID(requestID string) observability.StructuredLogger {
	next := l.clone()
	next.requestID = requestID
	next.log = next.log.With(ubzap.String("request_id", sanitization.SanitizeLogString(requestID)))
	return next
}

func (l *Logger) WithTenantID(tenantID string) observability.StructuredLogger {
	next := l.clone()
	next.tenantID = tenantID
	next.log = next.log.With(ubzap.String("tenant_id", sanitization.SanitizeLogString(tenantID)))
	return next
}

func (l *Logger) WithUserID(userID string) observability.StructuredLogger {
	next := l.clone()
	next.userID = userID
	next.log = next.log.With(ubzap.String("user_id", sanitization.SanitizeLogString(userID)))
	return next
}

func (l *Logger) WithTraceID(traceID string) observability.StructuredLogger {
	next := l.clone()
	next.traceID = traceID
	next.log = next.log.With(ubzap.String("trace_id", sanitization.SanitizeLogString(traceID)))
	return next
}

func (l *Logger) WithSpanID(spanID string) observability.StructuredLogger {
	next := l.clone()
	next.spanID = spanID
	next.log = next.log.With(ubzap.String("span_id", sanitization.SanitizeLogString(spanID)))
	return next
}

func (l *Logger) Flush(ctx context.Context) error {
	if l == nil || l.core == nil {
		return nil
	}

	if ctx == nil {
		ctx = context.Background()
	}

	start := time.Now()
	l.core.flushCount.Add(1)
	err := l.core.logger.Sync()
	if err != nil {
		l.core.errorCount.Add(1)
		l.core.lastError.Store(err.Error())
	}

	l.core.waitNotifier(ctx)

	dur := time.Since(start)
	l.core.lastFlushNanos.Store(time.Now().UnixNano())
	l.core.totalFlushNanos.Add(dur.Nanoseconds())

	return err
}

func (l *Logger) Close() error {
	if l == nil || l.core == nil {
		return nil
	}
	return l.core.close()
}

func (l *Logger) IsHealthy() bool {
	if l == nil || l.core == nil {
		return false
	}
	if l.core.closed.Load() {
		return false
	}
	return l.core.lastErrorString() == ""
}

func (l *Logger) GetStats() observability.LoggerStats {
	if l == nil || l.core == nil {
		return observability.LoggerStats{}
	}

	lastFlush := time.Unix(0, l.core.lastFlushNanos.Load())
	lastError := l.core.lastErrorString()
	flushCount := l.core.flushCount.Load()
	totalFlush := l.core.totalFlushNanos.Load()

	avg := time.Duration(0)
	if flushCount > 0 && totalFlush > 0 {
		avg = time.Duration(totalFlush / flushCount)
	}

	return observability.LoggerStats{
		LastFlush:      lastFlush,
		LastError:      lastError,
		EntriesLogged:  l.core.entriesLogged.Load(),
		EntriesDropped: l.core.entriesDropped.Load(),
		FlushCount:     flushCount,
		ErrorCount:     l.core.errorCount.Load(),
		AverageFlush:   avg,
	}
}

func (l *Logger) clone() *Logger {
	if l == nil {
		return &Logger{}
	}
	nextFields := make(map[string]any, len(l.fields))
	for k, v := range l.fields {
		nextFields[k] = v
	}
	return &Logger{
		core:      l.core,
		log:       l.log,
		fields:    nextFields,
		requestID: l.requestID,
		tenantID:  l.tenantID,
		userID:    l.userID,
		traceID:   l.traceID,
		spanID:    l.spanID,
	}
}

func (l *Logger) logEntry(level string, message string, fields ...map[string]any) {
	if !l.canLog() {
		return
	}

	message = sanitization.SanitizeLogString(message)
	callFields := mergeFieldSets(fields...)

	l.write(level, message, anyFields(callFields, l.core.sanitizer))
	l.core.entriesLogged.Add(1)

	if l.shouldNotify(level) {
		l.core.enqueueNotification(l.notificationEntry(level, message, callFields))
	}
}

func anyFields(fields map[string]any, sanitizerFn observability.SanitizerFunc) []ubzap.Field {
	if len(fields) == 0 {
		return nil
	}

	out := make([]ubzap.Field, 0, len(fields))
	for k, v := range fields {
		if sanitizerFn != nil {
			v = sanitizerFn(k, v)
		} else {
			v = sanitization.SanitizeFieldValue(k, v)
		}
		out = append(out, ubzap.Any(k, v))
	}
	return out
}

func (l *Logger) canLog() bool {
	if l == nil || l.core == nil || l.log == nil {
		return false
	}
	return !l.core.closed.Load()
}

func (l *Logger) shouldNotify(level string) bool {
	return l.core != nil && l.core.notifier != nil && level == levelError
}

func mergeFieldSets(fieldSets ...map[string]any) map[string]any {
	out := make(map[string]any)
	for _, set := range fieldSets {
		for k, v := range set {
			out[k] = v
		}
	}
	return out
}

func mergeFields(base map[string]any, override map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(override))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range override {
		out[k] = v
	}
	return out
}

func sanitizeFields(fields map[string]any, sanitizerFn observability.SanitizerFunc) map[string]any {
	out := make(map[string]any, len(fields))
	for k, v := range fields {
		if sanitizerFn != nil {
			out[k] = sanitizerFn(k, v)
		} else {
			out[k] = sanitization.SanitizeFieldValue(k, v)
		}
	}
	return out
}

func (l *Logger) write(level string, message string, fields []ubzap.Field) {
	switch level {
	case levelDebug:
		l.log.Debug(message, fields...)
	case levelWarn:
		l.log.Warn(message, fields...)
	case levelError:
		l.log.Error(message, fields...)
	default:
		l.log.Info(message, fields...)
	}
}

func (l *Logger) notificationEntry(level string, message string, callFields map[string]any) observability.LogEntry {
	merged := mergeFields(l.fields, callFields)
	sanitized := sanitizeFields(merged, l.core.sanitizer)
	return observability.LogEntry{
		Timestamp: time.Now(),
		Level:     level,
		Message:   message,
		Fields:    sanitized,

		RequestID: l.requestID,
		TenantID:  l.tenantID,
		UserID:    l.userID,
		TraceID:   l.traceID,
		SpanID:    l.spanID,
	}
}

func (c *zapCore) enqueueNotification(entry observability.LogEntry) {
	c.notifyMu.Lock()
	defer c.notifyMu.Unlock()
	if c.closed.Load() || c.notifyCh == nil {
		c.entriesDropped.Add(1)
		return
	}

	c.notifyWg.Add(1)
	select {
	case c.notifyCh <- entry:
		return
	default:
		c.notifyWg.Done()
		c.entriesDropped.Add(1)
	}
}

func (c *zapCore) runNotifier() {
	for entry := range c.notifyCh {
		if err := c.notifyWithRetries(entry); err != nil {
			c.errorCount.Add(1)
			c.lastError.Store(err.Error())
		}
		c.notifyWg.Done()
	}
}

func (c *zapCore) notifyWithRetries(entry observability.LogEntry) error {
	if c.notifier == nil {
		return nil
	}

	maxRetries := c.maxRetries
	if maxRetries <= 0 {
		maxRetries = 3
	}
	retryDelay := c.retryDelay
	if retryDelay <= 0 {
		retryDelay = time.Second
	}

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if err := c.notifier.Notify(context.Background(), entry); err != nil {
			lastErr = err
			if attempt < maxRetries-1 {
				time.Sleep(retryDelay)
			}
			continue
		}
		return nil
	}
	return lastErr
}

func (c *zapCore) waitNotifier(ctx context.Context) {
	if c.notifyCh == nil {
		return
	}

	done := make(chan struct{})
	go func() {
		c.notifyWg.Wait()
		close(done)
	}()

	select {
	case <-ctx.Done():
		return
	case <-done:
		return
	}
}

func (c *zapCore) close() error {
	var err error
	c.closeOnce.Do(func() {
		c.notifyMu.Lock()
		c.closed.Store(true)
		if c.notifyCh != nil {
			close(c.notifyCh)
			c.notifyCh = nil
		}
		c.notifyMu.Unlock()

		c.notifyWg.Wait()
		err = c.logger.Sync()
		if err != nil {
			c.errorCount.Add(1)
			c.lastError.Store(err.Error())
		}
	})
	return err
}

func (c *zapCore) lastErrorString() string {
	if c == nil {
		return ""
	}
	lastError, ok := c.lastError.Load().(string)
	if !ok {
		return ""
	}
	return lastError
}
