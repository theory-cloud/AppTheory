package observability

import (
	"reflect"
	"testing"
)

func TestLoggingProfile_BuiltInCatalog(t *testing.T) {
	got := BuiltInLoggingProfileNames()
	want := []string{"cloudwatch-json", "legacy", "local-dev", "paytheory-alert-v1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuiltInLoggingProfileNames: expected %#v, got %#v", want, got)
	}

	catalog := LoggingProfileCatalog()
	if catalog["schema_version"] != LoggingProfileSchemaVersion {
		t.Fatalf("catalog schema: expected %q, got %#v", LoggingProfileSchemaVersion, catalog["schema_version"])
	}
	if !reflect.DeepEqual(catalog["profiles"], want) {
		t.Fatalf("catalog profiles: expected %#v, got %#v", want, catalog["profiles"])
	}
}

func TestLoggingProfile_DefaultPayTheoryAlertValidates(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	if err := ValidateLoggingProfile(cfg); err != nil {
		t.Fatalf("ValidateLoggingProfile: %v", err)
	}
	if cfg.Encoding.Format != "json" || cfg.Encoding.TimestampField != "ts" {
		t.Fatalf("unexpected encoding defaults: %#v", cfg.Encoding)
	}
	if cfg.FieldMap["stack_hash"] != "stack_hash" {
		t.Fatalf("expected stack_hash field map, got %#v", cfg.FieldMap)
	}
	if !cfg.ErrorCapture.IncludeStackTrace || cfg.ErrorCapture.StackHashAlgorithm != "sha256" {
		t.Fatalf("unexpected error capture defaults: %#v", cfg.ErrorCapture)
	}
}

func TestLoggingProfile_ValidationErrorsAreDeterministic(t *testing.T) {
	cfg := LoggingProfileConfig{
		SchemaVersion: "apptheory.logging/v2",
		Profile:       "custom-alert",
		Encoding: LoggingProfileEncoding{
			Format:          "xml",
			TimestampFormat: "epoch_ms",
		},
		RequiredFields: []string{"raw_payload"},
		Enrichment: LoggingProfileEnrichment{Context: map[string]string{
			"request_id": "lambda.raw_event.requestContext.requestId",
		}},
		ErrorCapture: LoggingProfileErrorCapture{
			IncludeStackTrace:  true,
			StackHashAlgorithm: "md5",
		},
	}
	got := LoggingProfileValidationErrors(cfg)
	want := []string{
		"schema_version: unsupported value apptheory.logging/v2",
		"profile: unsupported value custom-alert",
		"encoding.format: unsupported value xml",
		"encoding.timestamp_format: unsupported value epoch_ms",
		"required_fields[0]: unsupported field raw_payload",
		"enrichment.context.request_id: unsupported source lambda.raw_event.requestContext.requestId",
		"error_capture.stack_hash_algorithm: unsupported value md5",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("validation errors:\nexpected %#v\ngot      %#v", want, got)
	}

	err := ValidateLoggingProfile(cfg)
	if err == nil {
		t.Fatal("expected validation error")
	}
	var profileErr *LoggingProfileValidationError
	if !reflect.TypeOf(err).AssignableTo(reflect.TypeOf(profileErr)) {
		t.Fatalf("expected *LoggingProfileValidationError, got %T", err)
	}
}

func TestLoggingProfile_EncodingFieldNamesFailClosed(t *testing.T) {
	cfg, err := DefaultLoggingProfile(LoggingProfilePayTheoryAlertV1)
	if err != nil {
		t.Fatalf("DefaultLoggingProfile: %v", err)
	}
	cfg.Encoding.TimestampField = "raw_payload"
	cfg.Encoding.LevelField = "raw_payload"
	cfg.Encoding.MessageField = "raw_payload"

	got := LoggingProfileValidationErrors(cfg)
	want := []string{
		"encoding.timestamp_field: unsupported field raw_payload",
		"encoding.level_field: unsupported field raw_payload",
		"encoding.message_field: unsupported field raw_payload",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("validation errors:\nexpected %#v\ngot      %#v", want, got)
	}
}

func TestLoggingProfile_DefaultUnknownProfileFails(t *testing.T) {
	_, err := DefaultLoggingProfile("custom-alert")
	if err == nil {
		t.Fatal("expected unsupported profile error")
	}
}
