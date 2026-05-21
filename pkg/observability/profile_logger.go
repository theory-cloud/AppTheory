package observability

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/theory-cloud/apptheory/pkg/sanitization"
	apptheory "github.com/theory-cloud/apptheory/runtime"
)

type LoggingProfileEvent struct {
	Timestamp         time.Time                    `json:"timestamp"`
	Level             string                       `json:"level"`
	Event             string                       `json:"event,omitempty"`
	Message           string                       `json:"message"`
	NormalizedMessage string                       `json:"normalized_message,omitempty"`
	Request           LoggingProfileRequestContext `json:"request,omitempty"`
	Job               LoggingProfileJobContext     `json:"job,omitempty"`
	Error             LoggingProfileError          `json:"error,omitempty"`
	Fields            map[string]any               `json:"fields,omitempty"`
}

type LoggingProfileRequestContext struct {
	RequestID     string `json:"request_id,omitempty"`
	TenantID      string `json:"tenant_id,omitempty"`
	UserID        string `json:"user_id,omitempty"`
	TraceID       string `json:"trace_id,omitempty"`
	SpanID        string `json:"span_id,omitempty"`
	CorrelationID string `json:"correlation_id,omitempty"`
	Route         string `json:"route,omitempty"`
	Method        string `json:"method,omitempty"`
	Path          string `json:"path,omitempty"`
	Status        int    `json:"status,omitempty"`
}

type LoggingProfileJobContext struct {
	Name string `json:"name,omitempty"`
}

type LoggingProfileError struct {
	Type       string `json:"type,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
	StackTrace string `json:"stack_trace,omitempty"`
}

type ProfileLoggerOption func(*profileLoggerOptions)

type profileLoggerOptions struct {
	environment map[string]string
	writer      io.Writer
	sanitizer   SanitizerFunc
	clock       func() time.Time
}

type ProfileLogger struct {
	root *ProfileLogger

	config      LoggingProfileConfig
	environment map[string]string
	writer      io.Writer
	sanitizer   SanitizerFunc
	clock       func() time.Time

	mu      sync.Mutex
	entries []map[string]any
	fields  map[string]any

	requestID string
	tenantID  string
	userID    string
	traceID   string
	spanID    string

	closed        atomic.Bool
	entriesLogged atomic.Int64
	lastError     atomic.Value
}

var _ StructuredLogger = (*ProfileLogger)(nil)

func WithProfileEnvironment(environment map[string]string) ProfileLoggerOption {
	return func(opts *profileLoggerOptions) {
		opts.environment = copyStringMap(environment)
	}
}

func WithProfileWriter(writer io.Writer) ProfileLoggerOption {
	return func(opts *profileLoggerOptions) {
		opts.writer = writer
	}
}

func WithProfileSanitizer(fn SanitizerFunc) ProfileLoggerOption {
	return func(opts *profileLoggerOptions) {
		opts.sanitizer = fn
	}
}

func WithProfileClock(clock func() time.Time) ProfileLoggerOption {
	return func(opts *profileLoggerOptions) {
		opts.clock = clock
	}
}

func NewProfileLogger(config LoggingProfileConfig, options ...ProfileLoggerOption) (*ProfileLogger, error) {
	if err := ValidateLoggingProfile(config); err != nil {
		return nil, err
	}

	opts := &profileLoggerOptions{
		environment: map[string]string{},
		writer:      os.Stdout,
		sanitizer:   sanitization.SanitizeFieldValue,
		clock:       time.Now,
	}
	for _, opt := range options {
		if opt != nil {
			opt(opts)
		}
	}
	if opts.writer == nil {
		opts.writer = io.Discard
	}
	if opts.sanitizer == nil {
		opts.sanitizer = sanitization.SanitizeFieldValue
	}
	if opts.clock == nil {
		opts.clock = time.Now
	}

	logger := &ProfileLogger{
		config:      config,
		environment: copyStringMap(opts.environment),
		writer:      opts.writer,
		sanitizer:   opts.sanitizer,
		clock:       opts.clock,
		fields:      map[string]any{},
	}
	logger.lastError.Store("")
	return logger, nil
}

func EncodeLoggingProfileEvent(config LoggingProfileConfig, environment map[string]string, event LoggingProfileEvent) (map[string]any, error) {
	return EncodeLoggingProfileEventWithSanitizer(config, environment, event, sanitization.SanitizeFieldValue)
}

func EncodeLoggingProfileEventWithSanitizer(config LoggingProfileConfig, environment map[string]string, event LoggingProfileEvent, sanitizerFn SanitizerFunc) (map[string]any, error) {
	if err := ValidateLoggingProfile(config); err != nil {
		return nil, err
	}
	if sanitizerFn == nil {
		sanitizerFn = sanitization.SanitizeFieldValue
	}

	out := map[string]any{}
	putProfileField(out, timestampField(config), formatProfileTimestamp(event.Timestamp, config.Encoding.TimestampFormat), sanitizerFn)
	putProfileField(out, levelField(config), profileLevel(config, event.Level), sanitizerFn)
	putProfileField(out, messageField(config), sanitization.SanitizeLogString(event.Message), sanitizerFn)

	if event.Event != "" {
		putCanonicalMappedField(out, config, "event", event.Event, sanitizerFn)
	}
	if event.NormalizedMessage != "" {
		putCanonicalMappedField(out, config, "normalized_message", event.NormalizedMessage, sanitizerFn)
	}

	applyStaticEnrichment(out, config, environment, sanitizerFn)
	applyContextEnrichment(out, config, event, sanitizerFn)
	applyErrorCapture(out, config, event, sanitizerFn)
	applySafeEventFields(out, event.Fields, sanitizerFn)

	if missing := missingRequiredProfileFields(out, config.RequiredFields); len(missing) > 0 {
		return nil, fmt.Errorf("logging profile required fields missing: %s", strings.Join(missing, ", "))
	}
	return out, nil
}

func HooksFromProfileLogger(config LoggingProfileConfig, options ...ProfileLoggerOption) (apptheory.ObservabilityHooks, *ProfileLogger, error) {
	logger, err := NewProfileLogger(config, options...)
	if err != nil {
		return apptheory.ObservabilityHooks{}, nil, err
	}
	return HooksFromLogger(logger), logger, nil
}

func (l *ProfileLogger) Debug(message string, fields ...map[string]any) {
	l.log("debug", message, fields...)
}

func (l *ProfileLogger) Info(message string, fields ...map[string]any) {
	l.log("info", message, fields...)
}

func (l *ProfileLogger) Warn(message string, fields ...map[string]any) {
	l.log("warn", message, fields...)
}

func (l *ProfileLogger) Error(message string, fields ...map[string]any) {
	l.log("error", message, fields...)
}

func (l *ProfileLogger) WithField(key string, value any) StructuredLogger {
	return l.WithFields(map[string]any{key: value})
}

func (l *ProfileLogger) WithFields(fields map[string]any) StructuredLogger {
	next := l.clone()
	if next.fields == nil {
		next.fields = map[string]any{}
	}
	for k, v := range fields {
		next.fields[k] = v
	}
	return next
}

func (l *ProfileLogger) WithRequestID(requestID string) StructuredLogger {
	next := l.clone()
	next.requestID = requestID
	return next
}

func (l *ProfileLogger) WithTenantID(tenantID string) StructuredLogger {
	next := l.clone()
	next.tenantID = tenantID
	return next
}

func (l *ProfileLogger) WithUserID(userID string) StructuredLogger {
	next := l.clone()
	next.userID = userID
	return next
}

func (l *ProfileLogger) WithTraceID(traceID string) StructuredLogger {
	next := l.clone()
	next.traceID = traceID
	return next
}

func (l *ProfileLogger) WithSpanID(spanID string) StructuredLogger {
	next := l.clone()
	next.spanID = spanID
	return next
}

func (l *ProfileLogger) Flush(_ context.Context) error {
	return nil
}

func (l *ProfileLogger) Close() error {
	if l == nil {
		return nil
	}
	l.rootLogger().closed.Store(true)
	return nil
}

func (l *ProfileLogger) IsHealthy() bool {
	if l == nil || l.rootLogger().closed.Load() {
		return false
	}
	return l.lastErrorString() == ""
}

func (l *ProfileLogger) GetStats() LoggerStats {
	if l == nil {
		return LoggerStats{}
	}
	root := l.rootLogger()
	return LoggerStats{EntriesLogged: root.entriesLogged.Load(), LastError: l.lastErrorString()}
}

func (l *ProfileLogger) Entries() []map[string]any {
	if l == nil {
		return nil
	}
	root := l.rootLogger()
	root.mu.Lock()
	defer root.mu.Unlock()
	out := make([]map[string]any, len(root.entries))
	for i, entry := range root.entries {
		out[i] = copyAnyMap(entry)
	}
	return out
}

func (l *ProfileLogger) clone() *ProfileLogger {
	if l == nil {
		return &ProfileLogger{fields: map[string]any{}}
	}
	return &ProfileLogger{
		root:        l.rootLogger(),
		config:      l.config,
		environment: copyStringMap(l.environment),
		writer:      l.writer,
		sanitizer:   l.sanitizer,
		clock:       l.clock,
		fields:      copyAnyMap(l.fields),
		requestID:   l.requestID,
		tenantID:    l.tenantID,
		userID:      l.userID,
		traceID:     l.traceID,
		spanID:      l.spanID,
	}
}

func (l *ProfileLogger) log(level string, message string, fields ...map[string]any) {
	if l == nil || l.rootLogger().closed.Load() {
		return
	}
	merged := copyAnyMap(l.fields)
	for _, set := range fields {
		for k, v := range set {
			merged[k] = v
		}
	}

	event := LoggingProfileEvent{
		Timestamp: l.clock(),
		Level:     level,
		Message:   message,
		Request: LoggingProfileRequestContext{
			RequestID: l.requestID,
			TenantID:  l.tenantID,
			UserID:    l.userID,
			TraceID:   l.traceID,
			SpanID:    l.spanID,
		},
		Fields: merged,
	}
	applyKnownProfileFieldsToEvent(&event, merged)

	encoded, err := EncodeLoggingProfileEventWithSanitizer(l.config, l.environment, event, l.sanitizer)
	if err != nil {
		l.rootLogger().lastError.Store(err.Error())
		return
	}

	root := l.rootLogger()
	root.mu.Lock()
	root.entries = append(root.entries, copyAnyMap(encoded))
	root.mu.Unlock()

	if l.writer != nil {
		line, err := json.Marshal(encoded)
		if err != nil {
			root.lastError.Store(err.Error())
			return
		}
		if _, err := l.writer.Write(append(line, '\n')); err != nil {
			root.lastError.Store(err.Error())
			return
		}
	}
	root.entriesLogged.Add(1)
}

func (l *ProfileLogger) rootLogger() *ProfileLogger {
	if l == nil {
		return nil
	}
	if l.root != nil {
		return l.root
	}
	return l
}

func (l *ProfileLogger) lastErrorString() string {
	if l == nil {
		return ""
	}
	value := l.rootLogger().lastError.Load()
	if value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

func timestampField(config LoggingProfileConfig) string {
	if field := strings.TrimSpace(config.Encoding.TimestampField); field != "" {
		return field
	}
	return mappedFieldOrDefault(config, "timestamp", "timestamp")
}

func levelField(config LoggingProfileConfig) string {
	if field := strings.TrimSpace(config.Encoding.LevelField); field != "" {
		return field
	}
	return mappedFieldOrDefault(config, "severity", "level")
}

func messageField(config LoggingProfileConfig) string {
	if field := strings.TrimSpace(config.Encoding.MessageField); field != "" {
		return field
	}
	return mappedFieldOrDefault(config, "message", "message")
}

func mappedFieldOrDefault(config LoggingProfileConfig, canonical string, fallback string) string {
	if config.FieldMap != nil {
		if mapped := strings.TrimSpace(config.FieldMap[canonical]); mapped != "" {
			return mapped
		}
	}
	return fallback
}

func putCanonicalMappedField(out map[string]any, config LoggingProfileConfig, canonical string, value any, sanitizerFn SanitizerFunc) {
	field := mappedFieldOrDefault(config, canonical, canonical)
	putProfileField(out, field, value, sanitizerFn)
}

func putProfileField(out map[string]any, field string, value any, sanitizerFn SanitizerFunc) {
	key := strings.TrimSpace(field)
	if key == "" || isZeroProfileValue(value) {
		return
	}
	if sanitizerFn != nil {
		value = sanitizerFn(key, value)
	} else {
		value = sanitization.SanitizeFieldValue(key, value)
	}
	out[key] = value
}

func putProfileRawString(out map[string]any, field string, value string) {
	key := strings.TrimSpace(field)
	if key == "" || strings.TrimSpace(value) == "" {
		return
	}
	out[key] = value
}

func profileLevel(config LoggingProfileConfig, level string) string {
	key := strings.ToLower(strings.TrimSpace(level))
	if key == "" {
		key = "info"
	}
	if config.Levels != nil {
		if mapped := strings.TrimSpace(config.Levels[key]); mapped != "" {
			return mapped
		}
	}
	return strings.ToUpper(key)
}

func formatProfileTimestamp(value time.Time, format string) string {
	if value.IsZero() {
		value = time.Unix(0, 0).UTC()
	}
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "rfc3339":
		return value.UTC().Format(time.RFC3339)
	default:
		return value.UTC().Format(time.RFC3339Nano)
	}
}

func applyStaticEnrichment(out map[string]any, config LoggingProfileConfig, environment map[string]string, sanitizerFn SanitizerFunc) {
	for _, field := range sortedMapKeys(config.Enrichment.Static) {
		value := resolveStaticEnrichmentValue(config.Enrichment.Static[field], environment)
		putProfileField(out, field, value, sanitizerFn)
	}
}

func resolveStaticEnrichmentValue(value string, environment map[string]string) string {
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(trimmed, "${") && strings.HasSuffix(trimmed, "}") && len(trimmed) > 3 {
		name := strings.TrimSpace(trimmed[2 : len(trimmed)-1])
		if environment != nil {
			if v, ok := environment[name]; ok {
				return v
			}
		}
		return os.Getenv(name)
	}
	return value
}

func applyContextEnrichment(out map[string]any, config LoggingProfileConfig, event LoggingProfileEvent, sanitizerFn SanitizerFunc) {
	for _, field := range sortedMapKeys(config.Enrichment.Context) {
		value := contextSourceValue(config.Enrichment.Context[field], event)
		putProfileField(out, field, value, sanitizerFn)
	}
}

func contextSourceValue(source string, event LoggingProfileEvent) any {
	switch strings.TrimSpace(source) {
	case "request.request_id":
		return event.Request.RequestID
	case "request.tenant_id":
		return event.Request.TenantID
	case "request.user_id":
		return event.Request.UserID
	case "request.trace_id":
		return event.Request.TraceID
	case "request.span_id":
		return event.Request.SpanID
	case "request.correlation_id":
		return event.Request.CorrelationID
	case "request.route":
		return event.Request.Route
	case "request.method":
		return event.Request.Method
	case "request.path":
		return event.Request.Path
	case "request.status":
		return event.Request.Status
	case "job.name":
		return event.Job.Name
	default:
		return nil
	}
}

func applyErrorCapture(out map[string]any, config LoggingProfileConfig, event LoggingProfileEvent, sanitizerFn SanitizerFunc) {
	if config.ErrorCapture.IncludeErrorType {
		putCanonicalMappedField(out, config, "error_type", event.Error.Type, sanitizerFn)
	}
	if config.ErrorCapture.IncludeErrorCode {
		putCanonicalMappedField(out, config, "error_code", event.Error.Code, sanitizerFn)
	}
	if config.ErrorCapture.IncludeStackTrace {
		field := strings.TrimSpace(config.ErrorCapture.StackTraceField)
		if field == "" {
			field = mappedFieldOrDefault(config, "stack_trace", "stack_trace")
		}
		putProfileRawString(out, field, event.Error.StackTrace)
	}
	if strings.TrimSpace(config.ErrorCapture.StackHashField) != "" && event.Error.StackTrace != "" {
		putProfileField(out, config.ErrorCapture.StackHashField, profileStackHash(event.Error.StackTrace), sanitizerFn)
	}
}

func profileStackHash(stackTrace string) string {
	sum := sha256.Sum256([]byte(stackTrace))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func applySafeEventFields(out map[string]any, fields map[string]any, sanitizerFn SanitizerFunc) {
	for _, key := range sortedMapKeys(fields) {
		trimmed := strings.TrimSpace(key)
		if !isAllowedProfileEventField(trimmed) {
			continue
		}
		putProfileField(out, trimmed, fields[key], sanitizerFn)
	}
}

func isAllowedProfileEventField(field string) bool {
	if strings.HasPrefix(field, "safe_") {
		return true
	}
	return isSupportedProfileOutputField(field)
}

func missingRequiredProfileFields(out map[string]any, required []string) []string {
	var missing []string
	for _, field := range required {
		key := strings.TrimSpace(field)
		if key == "" {
			continue
		}
		value, ok := out[key]
		if !ok || isZeroProfileValue(value) {
			missing = append(missing, key)
		}
	}
	return missing
}

func isZeroProfileValue(value any) bool {
	if value == nil {
		return true
	}
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v) == ""
	case int:
		return v == 0
	case int64:
		return v == 0
	case float64:
		return v == 0
	default:
		return false
	}
}

func applyKnownProfileFieldsToEvent(event *LoggingProfileEvent, fields map[string]any) {
	if event == nil {
		return
	}
	if event.NormalizedMessage == "" {
		event.NormalizedMessage = stringField(fields, "normalized_message")
	}
	if event.Event == "" {
		event.Event = stringField(fields, "event")
	}
	if event.Request.CorrelationID == "" {
		event.Request.CorrelationID = stringField(fields, "correlation_id")
	}
	if event.Request.Route == "" {
		event.Request.Route = stringField(fields, "route")
	}
	if event.Request.Method == "" {
		event.Request.Method = stringField(fields, "method")
	}
	if event.Request.Path == "" {
		event.Request.Path = stringField(fields, "path")
	}
	if event.Request.Status == 0 {
		event.Request.Status = intField(fields, "status")
	}
	if event.Job.Name == "" {
		event.Job.Name = stringField(fields, "job_name")
	}
	if event.Error.Type == "" {
		event.Error.Type = firstStringField(fields, "error_type", "error.type")
	}
	if event.Error.Code == "" {
		event.Error.Code = firstStringField(fields, "error_code", "error.code")
	}
	if event.Error.StackTrace == "" {
		event.Error.StackTrace = stringField(fields, "stack_trace")
	}
}

func firstStringField(fields map[string]any, names ...string) string {
	for _, name := range names {
		if value := stringField(fields, name); value != "" {
			return value
		}
	}
	return ""
}

func stringField(fields map[string]any, name string) string {
	value, ok := fields[name]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func intField(fields map[string]any, name string) int {
	value, ok := fields[name]
	if !ok || value == nil {
		return 0
	}
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
	}
	return 0
}

func copyStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func copyAnyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
