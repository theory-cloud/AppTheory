package observability

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const LoggingProfileSchemaVersion = "apptheory.logging/v1"

const (
	LoggingProfilePayTheoryAlertV1 = "paytheory-alert-v1"
	LoggingProfileCloudWatchJSON   = "cloudwatch-json"
	LoggingProfileLegacy           = "legacy"
	LoggingProfileLocalDev         = "local-dev"
)

const (
	loggingProfileTimestampFormatRFC3339Nano = "rfc3339nano"
	loggingProfileTimestampFormatRFC3339     = "rfc3339"
)

type LoggingProfileConfig struct {
	SchemaVersion     string                      `json:"schema_version" yaml:"schema_version"`
	Profile           string                      `json:"profile" yaml:"profile"`
	Encoding          LoggingProfileEncoding      `json:"encoding" yaml:"encoding"`
	Levels            map[string]string           `json:"levels,omitempty" yaml:"levels,omitempty"`
	RequiredFields    []string                    `json:"required_fields,omitempty" yaml:"required_fields,omitempty"`
	RecommendedFields []string                    `json:"recommended_fields,omitempty" yaml:"recommended_fields,omitempty"`
	FieldMap          map[string]string           `json:"field_map,omitempty" yaml:"field_map,omitempty"`
	Enrichment        LoggingProfileEnrichment    `json:"enrichment,omitempty" yaml:"enrichment,omitempty"`
	ErrorCapture      LoggingProfileErrorCapture  `json:"error_capture,omitempty" yaml:"error_capture,omitempty"`
	Sanitization      LoggingProfileSanitization  `json:"sanitization,omitempty" yaml:"sanitization,omitempty"`
	AlertingHints     LoggingProfileAlertingHints `json:"alerting_hints,omitempty" yaml:"alerting_hints,omitempty"`
}

type LoggingProfileEncoding struct {
	Format          string `json:"format" yaml:"format"`
	TimestampField  string `json:"timestamp_field,omitempty" yaml:"timestamp_field,omitempty"`
	TimestampFormat string `json:"timestamp_format,omitempty" yaml:"timestamp_format,omitempty"`
	LevelField      string `json:"level_field,omitempty" yaml:"level_field,omitempty"`
	MessageField    string `json:"message_field,omitempty" yaml:"message_field,omitempty"`
}

type LoggingProfileEnrichment struct {
	Static  map[string]string `json:"static,omitempty" yaml:"static,omitempty"`
	Context map[string]string `json:"context,omitempty" yaml:"context,omitempty"`
}

type LoggingProfileErrorCapture struct {
	IncludeErrorType   bool   `json:"include_error_type" yaml:"include_error_type"`
	IncludeErrorCode   bool   `json:"include_error_code" yaml:"include_error_code"`
	IncludeStackTrace  bool   `json:"include_stack_trace" yaml:"include_stack_trace"`
	StackTraceField    string `json:"stack_trace_field,omitempty" yaml:"stack_trace_field,omitempty"`
	StackHashField     string `json:"stack_hash_field,omitempty" yaml:"stack_hash_field,omitempty"`
	StackHashAlgorithm string `json:"stack_hash_algorithm,omitempty" yaml:"stack_hash_algorithm,omitempty"`
}

type LoggingProfileSanitization struct {
	ExistingSanitizedLogging bool   `json:"existing_sanitized_logging" yaml:"existing_sanitized_logging"`
	Notes                    string `json:"notes,omitempty" yaml:"notes,omitempty"`
}

type LoggingProfileAlertingHints struct {
	FingerprintFields  []string `json:"fingerprint_fields,omitempty" yaml:"fingerprint_fields,omitempty"`
	KeeperLookupFields []string `json:"keeper_lookup_fields,omitempty" yaml:"keeper_lookup_fields,omitempty"`
}

type LoggingProfileValidationError struct {
	Errors []string
}

func (e *LoggingProfileValidationError) Error() string {
	if e == nil || len(e.Errors) == 0 {
		return "logging profile validation failed"
	}
	return "logging profile validation failed: " + strings.Join(e.Errors, "; ")
}

func BuiltInLoggingProfileNames() []string {
	out := []string{
		LoggingProfileCloudWatchJSON,
		LoggingProfileLegacy,
		LoggingProfileLocalDev,
		LoggingProfilePayTheoryAlertV1,
	}
	sort.Strings(out)
	return out
}

func LoggingProfileCatalog() map[string]any {
	return map[string]any{
		"schema_version": LoggingProfileSchemaVersion,
		"profiles":       BuiltInLoggingProfileNames(),
	}
}

func DefaultLoggingProfile(profile string) (LoggingProfileConfig, error) {
	key := normalizeProfileToken(profile)
	switch key {
	case LoggingProfilePayTheoryAlertV1:
		return payTheoryAlertProfile(), nil
	case LoggingProfileCloudWatchJSON:
		cfg := baseJSONProfile(LoggingProfileCloudWatchJSON)
		cfg.RequiredFields = []string{"timestamp", "level", "message"}
		return cfg, nil
	case LoggingProfileLegacy:
		cfg := baseJSONProfile(LoggingProfileLegacy)
		cfg.Encoding.TimestampField = "timestamp"
		cfg.Encoding.LevelField = "level"
		cfg.Encoding.MessageField = "message"
		return cfg, nil
	case LoggingProfileLocalDev:
		cfg := baseJSONProfile(LoggingProfileLocalDev)
		cfg.Levels = map[string]string{"debug": "DEBUG", "info": "INFO", "warn": "WARN", "error": "ERROR"}
		return cfg, nil
	default:
		return LoggingProfileConfig{}, fmt.Errorf("profile: unsupported value %s", strings.TrimSpace(profile))
	}
}

func DecodeLoggingProfileJSON(raw []byte) (LoggingProfileConfig, error) {
	var config LoggingProfileConfig
	strictErrs, err := strictLoggingProfileJSONOptionErrors(raw)
	if err != nil {
		return config, err
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return config, fmt.Errorf("logging profile json: %w", err)
	}
	errs := make([]string, 0, len(strictErrs))
	errs = append(errs, strictErrs...)
	errs = append(errs, LoggingProfileValidationErrors(config)...)
	if len(errs) > 0 {
		return config, &LoggingProfileValidationError{Errors: errs}
	}
	return config, nil
}

func DecodeLoggingProfileYAML(raw []byte) (LoggingProfileConfig, error) {
	var config LoggingProfileConfig
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("logging profile yaml: %w", err)
	}
	if err := ValidateLoggingProfile(config); err != nil {
		return config, err
	}
	return config, nil
}

func ValidateLoggingProfile(config LoggingProfileConfig) error {
	errs := LoggingProfileValidationErrors(config)
	if len(errs) == 0 {
		return nil
	}
	return &LoggingProfileValidationError{Errors: errs}
}

func LoggingProfileValidationErrors(config LoggingProfileConfig) []string {
	var errs []string

	schema := strings.TrimSpace(config.SchemaVersion)
	if schema == "" {
		errs = append(errs, "schema_version: required")
	} else if schema != LoggingProfileSchemaVersion {
		errs = append(errs, "schema_version: unsupported value "+schema)
	}

	profile := normalizeProfileToken(config.Profile)
	if profile == "" {
		errs = append(errs, "profile: required")
	} else if !isSupportedProfile(profile) {
		errs = append(errs, "profile: unsupported value "+strings.TrimSpace(config.Profile))
	}

	format := strings.ToLower(strings.TrimSpace(config.Encoding.Format))
	if format == "" {
		errs = append(errs, "encoding.format: required")
	} else if format != "json" {
		errs = append(errs, "encoding.format: unsupported value "+strings.TrimSpace(config.Encoding.Format))
	}

	timestampFormat := strings.ToLower(strings.TrimSpace(config.Encoding.TimestampFormat))
	if timestampFormat != "" &&
		timestampFormat != loggingProfileTimestampFormatRFC3339Nano &&
		timestampFormat != loggingProfileTimestampFormatRFC3339 {
		errs = append(errs, "encoding.timestamp_format: unsupported value "+strings.TrimSpace(config.Encoding.TimestampFormat))
	}
	errs = append(errs, validateEncodingOutputField("encoding.timestamp_field", config.Encoding.TimestampField)...)
	errs = append(errs, validateEncodingOutputField("encoding.level_field", config.Encoding.LevelField)...)
	errs = append(errs, validateEncodingOutputField("encoding.message_field", config.Encoding.MessageField)...)

	errs = append(errs, validateLevelMap(config.Levels)...)
	errs = append(errs, validateProfileFieldList("required_fields", config.RequiredFields)...)
	errs = append(errs, validateProfileFieldList("recommended_fields", config.RecommendedFields)...)
	errs = append(errs, validateFieldMap(config.FieldMap)...)
	errs = append(errs, validateStaticEnrichment(config.Enrichment.Static)...)
	errs = append(errs, validateContextEnrichment(config.Enrichment.Context)...)
	errs = append(errs, validateErrorCapture(config.ErrorCapture)...)
	errs = append(errs, validateAlertingHints(config.AlertingHints)...)

	return errs
}

type loggingProfileJSONOptionSchema struct {
	allowed map[string]struct{}
	nested  map[string]loggingProfileJSONOptionSchema
}

var loggingProfileJSONOptions = loggingProfileJSONOptionSchema{
	allowed: optionNameSet(
		"schema_version", "profile", "encoding", "levels", "required_fields", "recommended_fields",
		"field_map", "enrichment", "error_capture", "sanitization", "alerting_hints",
	),
	nested: map[string]loggingProfileJSONOptionSchema{
		"encoding":   {allowed: optionNameSet("format", "timestamp_field", "timestamp_format", "level_field", "message_field")},
		"enrichment": {allowed: optionNameSet("static", "context")},
		"error_capture": {allowed: optionNameSet(
			"include_error_type", "include_error_code", "include_stack_trace",
			"stack_trace_field", "stack_hash_field", "stack_hash_algorithm",
		)},
		"sanitization":   {allowed: optionNameSet("existing_sanitized_logging", "notes")},
		"alerting_hints": {allowed: optionNameSet("fingerprint_fields", "keeper_lookup_fields")},
	},
}

func strictLoggingProfileJSONOptionErrors(raw []byte) ([]string, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("logging profile json: %w", err)
	}
	return validateLoggingProfileJSONOptions("", root, loggingProfileJSONOptions), nil
}

func validateLoggingProfileJSONOptions(path string, object map[string]json.RawMessage, schema loggingProfileJSONOptionSchema) []string {
	var errs []string
	for _, key := range sortedMapKeys(object) {
		childPath := profileJSONOptionPath(path, key)
		if !stringInSet(key, schema.allowed) {
			errs = append(errs, childPath+": unsupported option")
			continue
		}
		childSchema, ok := schema.nested[key]
		if !ok {
			continue
		}
		var child map[string]json.RawMessage
		if err := json.Unmarshal(object[key], &child); err != nil {
			continue
		}
		errs = append(errs, validateLoggingProfileJSONOptions(childPath, child, childSchema)...)
	}
	return errs
}

func profileJSONOptionPath(parent string, key string) string {
	if parent == "" {
		return key
	}
	return parent + "." + key
}

func optionNameSet(names ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(names))
	for _, name := range names {
		out[name] = struct{}{}
	}
	return out
}

func baseJSONProfile(profile string) LoggingProfileConfig {
	return LoggingProfileConfig{
		SchemaVersion: LoggingProfileSchemaVersion,
		Profile:       profile,
		Encoding: LoggingProfileEncoding{
			Format:          "json",
			TimestampField:  "timestamp",
			TimestampFormat: loggingProfileTimestampFormatRFC3339Nano,
			LevelField:      "level",
			MessageField:    "message",
		},
		Levels: map[string]string{"debug": "DEBUG", "info": "INFO", "warn": "WARN", "error": "ERROR"},
		FieldMap: map[string]string{
			"timestamp": "timestamp",
			"severity":  "level",
			"message":   "message",
		},
	}
}

func payTheoryAlertProfile() LoggingProfileConfig {
	cfg := baseJSONProfile(LoggingProfilePayTheoryAlertV1)
	cfg.Encoding = LoggingProfileEncoding{
		Format:          "json",
		TimestampField:  "ts",
		TimestampFormat: "rfc3339nano",
		LevelField:      "level",
		MessageField:    "message",
	}
	cfg.RequiredFields = []string{"ts", "level", "message", "service", "stage", "partner", "function", "aws_region"}
	cfg.RecommendedFields = []string{
		"source_account_id", "account_family", "request_id", "trace_id", "correlation_id",
		"error_type", "error_code", "normalized_message", "stack_hash", "route", "job_name",
	}
	cfg.FieldMap = map[string]string{
		"timestamp":          "ts",
		"severity":           "level",
		"message":            "message",
		"normalized_message": "normalized_message",
		"error_type":         "error_type",
		"error_code":         "error_code",
		"request_id":         "request_id",
		"trace_id":           "trace_id",
		"correlation_id":     "correlation_id",
		"stack_trace":        "stack_trace",
		"stack_hash":         "stack_hash",
		"service":            "service",
		"stage":              "stage",
		"partner":            "partner",
		"function":           "function",
		"account_family":     "account_family",
		"source_account_id":  "source_account_id",
		"aws_region":         "aws_region",
		"route":              "route",
		"job_name":           "job_name",
	}
	cfg.Enrichment = LoggingProfileEnrichment{
		Static: map[string]string{
			"service":           "${SERVICE_NAME}",
			"stage":             "${STAGE}",
			"partner":           "${PARTNER}",
			"function":          "${AWS_LAMBDA_FUNCTION_NAME}",
			"aws_region":        "${AWS_REGION}",
			"source_account_id": "${SOURCE_ACCOUNT_ID}",
			"account_family":    "${ACCOUNT_FAMILY}",
		},
		Context: map[string]string{
			"request_id":     "request.request_id",
			"trace_id":       "request.trace_id",
			"correlation_id": "request.correlation_id",
			"route":          "request.route",
			"job_name":       "job.name",
		},
	}
	cfg.ErrorCapture = LoggingProfileErrorCapture{
		IncludeErrorType:   true,
		IncludeErrorCode:   true,
		IncludeStackTrace:  true,
		StackTraceField:    "stack_trace",
		StackHashField:     "stack_hash",
		StackHashAlgorithm: "sha256",
	}
	cfg.Sanitization = LoggingProfileSanitization{ExistingSanitizedLogging: true}
	cfg.AlertingHints = LoggingProfileAlertingHints{
		FingerprintFields:  []string{"service", "normalized_message", "error_type", "stack_hash"},
		KeeperLookupFields: []string{"partner", "stage", "account_family", "aws_region", "service", "function", "request_id", "trace_id"},
	}
	return cfg
}

func validateLevelMap(levels map[string]string) []string {
	var errs []string
	keys := sortedMapKeys(levels)
	for _, key := range keys {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if !stringInSet(normalized, map[string]struct{}{"debug": {}, "info": {}, "warn": {}, "error": {}}) {
			errs = append(errs, "levels."+key+": unsupported level "+key)
			continue
		}
		if strings.TrimSpace(levels[key]) == "" {
			errs = append(errs, "levels."+key+": required")
		}
	}
	return errs
}

func validateProfileFieldList(path string, fields []string) []string {
	var errs []string
	for i, field := range fields {
		trimmed := strings.TrimSpace(field)
		if trimmed == "" {
			errs = append(errs, fmt.Sprintf("%s[%d]: required", path, i))
			continue
		}
		if !isSupportedProfileOutputField(trimmed) {
			errs = append(errs, fmt.Sprintf("%s[%d]: unsupported field %s", path, i, trimmed))
		}
	}
	return errs
}

func validateEncodingOutputField(path string, field string) []string {
	trimmed := strings.TrimSpace(field)
	if trimmed == "" {
		return nil
	}
	if !isSupportedProfileOutputField(trimmed) {
		return []string{path + ": unsupported field " + trimmed}
	}
	return nil
}

func validateFieldMap(fieldMap map[string]string) []string {
	var errs []string
	for _, key := range sortedMapKeys(fieldMap) {
		canonical := strings.TrimSpace(key)
		if !isSupportedCanonicalField(canonical) {
			errs = append(errs, "field_map."+key+": unsupported source "+canonical)
		}
		out := strings.TrimSpace(fieldMap[key])
		if out == "" {
			errs = append(errs, "field_map."+key+": required")
		} else if !isSupportedProfileOutputField(out) {
			errs = append(errs, "field_map."+key+": unsupported field "+out)
		}
	}
	return errs
}

func validateStaticEnrichment(static map[string]string) []string {
	var errs []string
	for _, key := range sortedMapKeys(static) {
		if !isSupportedProfileOutputField(strings.TrimSpace(key)) {
			errs = append(errs, "enrichment.static."+key+": unsupported field "+strings.TrimSpace(key))
		}
	}
	return errs
}

func validateContextEnrichment(context map[string]string) []string {
	var errs []string
	for _, key := range sortedMapKeys(context) {
		if !isSupportedProfileOutputField(strings.TrimSpace(key)) {
			errs = append(errs, "enrichment.context."+key+": unsupported field "+strings.TrimSpace(key))
		}
		source := strings.TrimSpace(context[key])
		if source == "" {
			errs = append(errs, "enrichment.context."+key+": required")
		} else if !isSupportedContextSource(source) {
			errs = append(errs, "enrichment.context."+key+": unsupported source "+source)
		}
	}
	return errs
}

func validateErrorCapture(capture LoggingProfileErrorCapture) []string {
	var errs []string
	if strings.TrimSpace(capture.StackTraceField) != "" && !isSupportedProfileOutputField(strings.TrimSpace(capture.StackTraceField)) {
		errs = append(errs, "error_capture.stack_trace_field: unsupported field "+strings.TrimSpace(capture.StackTraceField))
	}
	if strings.TrimSpace(capture.StackHashField) != "" && !isSupportedProfileOutputField(strings.TrimSpace(capture.StackHashField)) {
		errs = append(errs, "error_capture.stack_hash_field: unsupported field "+strings.TrimSpace(capture.StackHashField))
	}
	algorithm := strings.ToLower(strings.TrimSpace(capture.StackHashAlgorithm))
	if algorithm != "" && algorithm != "sha256" {
		errs = append(errs, "error_capture.stack_hash_algorithm: unsupported value "+strings.TrimSpace(capture.StackHashAlgorithm))
	}
	return errs
}

func validateAlertingHints(hints LoggingProfileAlertingHints) []string {
	errs := make([]string, 0, len(hints.FingerprintFields)+len(hints.KeeperLookupFields))
	errs = append(errs, validateProfileFieldList("alerting_hints.fingerprint_fields", hints.FingerprintFields)...)
	errs = append(errs, validateProfileFieldList("alerting_hints.keeper_lookup_fields", hints.KeeperLookupFields)...)
	return errs
}

func isSupportedProfile(profile string) bool {
	return stringInSet(normalizeProfileToken(profile), map[string]struct{}{
		LoggingProfilePayTheoryAlertV1: {},
		LoggingProfileCloudWatchJSON:   {},
		LoggingProfileLegacy:           {},
		LoggingProfileLocalDev:         {},
	})
}

func isSupportedCanonicalField(field string) bool {
	return stringInSet(field, map[string]struct{}{
		"timestamp": {}, "severity": {}, "message": {}, "event": {},
		"normalized_message": {}, "error_type": {}, "error_code": {},
		"request_id": {}, "tenant_id": {}, "user_id": {}, "trace_id": {}, "span_id": {}, "correlation_id": {},
		"stack_trace": {}, "stack_hash": {}, "service": {}, "stage": {}, "partner": {}, "function": {},
		"account_family": {}, "source_account_id": {}, "aws_region": {}, "route": {}, "job_name": {},
		"method": {}, "path": {}, "status": {},
	})
}

func isSupportedProfileOutputField(field string) bool {
	return stringInSet(field, map[string]struct{}{
		"ts": {}, "timestamp": {}, "level": {}, "severity": {}, "message": {}, "event": {},
		"service": {}, "stage": {}, "partner": {}, "function": {}, "aws_region": {},
		"source_account_id": {}, "account_family": {}, "request_id": {}, "tenant_id": {}, "user_id": {},
		"trace_id": {}, "span_id": {}, "correlation_id": {}, "error_type": {}, "error_code": {},
		"normalized_message": {}, "stack_trace": {}, "stack_hash": {}, "route": {}, "job_name": {},
		"method": {}, "path": {}, "status": {},
	})
}

func isSupportedContextSource(source string) bool {
	return stringInSet(source, map[string]struct{}{
		"request.request_id": {}, "request.tenant_id": {}, "request.user_id": {}, "request.trace_id": {},
		"request.span_id": {}, "request.correlation_id": {}, "request.route": {}, "request.method": {},
		"request.path": {}, "request.status": {}, "job.name": {},
	})
}

func normalizeProfileToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func sortedMapKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringInSet(value string, set map[string]struct{}) bool {
	_, ok := set[value]
	return ok
}
