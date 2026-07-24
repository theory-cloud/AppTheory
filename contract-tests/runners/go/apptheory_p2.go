package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v2/pkg/observability"
	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
	"github.com/theory-cloud/apptheory/v2/testkit"
)

func runFixtureP2(f Fixture) error {
	if isLoggingProfileContractFixture(f) {
		return compareLoggingProfileContract(f)
	}

	now := time.Unix(0, 0).UTC()
	clock := testkit.NewManualClock(now)

	var logs []FixtureLogRecord
	var metrics []FixtureMetricRecord
	var spans []FixtureSpanRecord
	var emfBuffer bytes.Buffer
	emfSink := newFixtureEMFMetricSink(f, &emfBuffer, clock)

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP2),
		apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormat(f.Setup.HTTPErrorFormat)),
		apptheory.WithClock(clock),
		apptheory.WithIDGenerator(fixedIDGenerator{id: "req_test_123"}),
		apptheory.WithLimits(apptheory.Limits{
			MaxRequestBytes:  f.Setup.Limits.MaxRequestBytes,
			MaxResponseBytes: f.Setup.Limits.MaxResponseBytes,
		}),
		apptheory.WithCORS(apptheory.CORSConfig{
			AllowedOrigins:   f.Setup.CORS.AllowedOrigins,
			AllowCredentials: f.Setup.CORS.AllowCredentials,
			AllowHeaders:     f.Setup.CORS.AllowHeaders,
		}),
		apptheory.WithAuthHook(func(ctx *apptheory.Context) (string, error) {
			authz := strings.TrimSpace(headerFirstValue(ctx.Request.Headers, "authorization"))
			if authz == "" {
				return "", apptheory.NewAppTheoryError("app.unauthorized", "unauthorized")
			}
			return "authorized", nil
		}),
		apptheory.WithObservability(apptheory.ObservabilityHooks{
			Log: func(r apptheory.LogRecord) {
				logs = append(logs, FixtureLogRecord{
					Level:      r.Level,
					Event:      r.Event,
					RequestID:  r.RequestID,
					TraceID:    r.TraceID,
					TenantID:   r.TenantID,
					Method:     r.Method,
					Path:       r.Path,
					Status:     r.Status,
					ErrorCode:  r.ErrorCode,
					DurationMS: r.DurationMS,
				})
			},
			Metric: func(r apptheory.MetricRecord) {
				metrics = append(metrics, FixtureMetricRecord{
					Name:       r.Name,
					Value:      r.Value,
					DurationMS: r.DurationMS,
					Tags:       r.Tags,
				})
				if emfSink != nil {
					emfSink.RecordMetric(r)
				}
			},
			Span: func(r apptheory.SpanRecord) {
				spans = append(spans, FixtureSpanRecord{
					Name:       r.Name,
					Attributes: r.Attributes,
				})
			},
		}),
		apptheory.WithPolicyHook(fixtureP2PolicyDecision),
	)

	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandlerP2(r.Handler, clock)
		if handler == nil {
			return apptheory.NewAppTheoryError("app.internal", "internal error")
		}
		var opts []apptheory.RouteOption
		if r.AuthRequired {
			opts = append(opts, apptheory.RequireAuth())
		}
		app.Handle(r.Method, r.Path, handler, opts...)
	}

	if f.Input.AWSEvent != nil {
		source := strings.ToLower(strings.TrimSpace(f.Input.AWSEvent.Source))
		if source != "appsync" {
			return fmt.Errorf("unknown aws_event source %q", f.Input.AWSEvent.Source)
		}
		out, err := app.HandleLambda(context.Background(), f.Input.AWSEvent.Event)
		return compareFixtureM1Result(f, out, err)
	}

	if f.Input.Request == nil {
		return apptheory.NewAppTheoryError("app.internal", "internal error")
	}

	bodyBytes, err := decodeFixtureBody(f.Input.Request.Body)
	if err != nil {
		return err
	}

	req := apptheory.Request{
		Method:   f.Input.Request.Method,
		Path:     f.Input.Request.Path,
		Query:    f.Input.Request.Query,
		Headers:  f.Input.Request.Headers,
		Body:     bodyBytes,
		IsBase64: f.Input.Request.IsBase64,
	}

	ctx := context.Background()
	if f.Input.Context.RemainingMS > 0 {
		var cancel func()
		ctx, cancel = context.WithDeadline(ctx, now.Add(time.Duration(f.Input.Context.RemainingMS)*time.Millisecond))
		defer cancel()
	}

	actual := app.Serve(ctx, req)
	return compareFixtureResponse(f, actual, logs, metrics, spans, splitEMFLogLines(emfBuffer.Bytes()))
}

func fixtureP2PolicyDecision(ctx *apptheory.Context) (*apptheory.PolicyDecision, error) {
	headers := ctx.Request.Headers
	switch {
	case strings.TrimSpace(headerFirstValue(headers, "x-force-rate-limit-content-type-lowercase")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.rate_limited",
			Message: "rate limited",
			Headers: map[string][]string{"retry-after": {"1"}, "content-type": {"text/plain; charset=utf-8"}},
		}, nil
	case strings.TrimSpace(headerFirstValue(headers, "x-force-rate-limit-content-type")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.rate_limited",
			Message: "rate limited",
			Headers: map[string][]string{"retry-after": {"1"}, "Content-Type": {"text/plain; charset=utf-8"}},
		}, nil
	case strings.TrimSpace(headerFirstValue(headers, "x-force-rate-limit-multi-window")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.rate_limited",
			Message: "rate limited",
			Headers: map[string][]string{
				"retry-after":           {"30"},
				"x-ratelimit-limit":     {"2"},
				"x-ratelimit-remaining": {"0"},
				"x-ratelimit-reset":     {"60"},
				"x-ratelimit-window":    {"1m"},
			},
		}, nil
	case strings.TrimSpace(headerFirstValue(headers, "x-force-rate-limit-store-failure")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.overloaded",
			Message: "overloaded",
			Headers: map[string][]string{"retry-after": {"1"}, "x-rate-limit-fail-closed": {"true"}},
		}, nil
	case strings.TrimSpace(headerFirstValue(headers, "x-force-rate-limit")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.rate_limited",
			Message: "rate limited",
			Headers: map[string][]string{"retry-after": {"1"}},
		}, nil
	case strings.TrimSpace(headerFirstValue(headers, "x-force-shed")) != "":
		return &apptheory.PolicyDecision{
			Code:    "app.overloaded",
			Message: "overloaded",
			Headers: map[string][]string{"retry-after": {"1"}},
		}, nil
	default:
		return nil, nil
	}
}

func newFixtureEMFMetricSink(
	f Fixture,
	buffer *bytes.Buffer,
	clock *testkit.ManualClock,
) *observability.EMFMetricSink {
	if f.Expect.EMFLogs == nil {
		return nil
	}
	return observability.NewEMFMetricSink(
		observability.WithEMFWriter(buffer),
		observability.WithEMFClock(clock.Now),
	)
}

func builtInAppTheoryHandlerP2(name string, clock *testkit.ManualClock) apptheory.Handler {
	switch strings.TrimSpace(name) {
	case "advance_clock_25ms":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			clock.Advance(25 * time.Millisecond)
			return apptheory.Text(200, "advanced"), nil
		}
	case "advance_clock_13ms_internal":
		return func(_ *apptheory.Context) (*apptheory.Response, error) {
			clock.Advance(13 * time.Millisecond)
			return nil, apptheory.NewAppTheoryError("app.internal", "internal error")
		}
	default:
		return builtInAppTheoryHandler(name)
	}
}

func splitEMFLogLines(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	var lines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func isLoggingProfileContractFixture(f Fixture) bool {
	return len(f.Setup.LoggingProfile) > 0 ||
		len(f.Input.LoggingEvent) > 0 ||
		f.Input.LoggingProfileCatalog ||
		len(f.Expect.ProfileLogs) > 0 ||
		len(f.Expect.ProfileValidationErrors) > 0 ||
		len(f.Expect.LoggingProfileCatalog) > 0
}

func compareLoggingProfileContract(f Fixture) error {
	if len(f.Expect.LoggingProfileCatalog) > 0 {
		if !reflect.DeepEqual(canonicalJSONValue(observability.LoggingProfileCatalog()), canonicalJSONValue(f.Expect.LoggingProfileCatalog)) {
			return fmt.Errorf("logging_profile_catalog mismatch")
		}
		return nil
	}
	if len(f.Expect.ProfileValidationErrors) > 0 {
		actual := decodeLoggingProfileValidationErrors(f.Setup.LoggingProfile)
		if !reflect.DeepEqual(f.Expect.ProfileValidationErrors, actual) {
			return fmt.Errorf("profile_validation_errors mismatch")
		}
		return nil
	}
	if len(f.Expect.ProfileLogs) > 0 {
		config, err := observability.DecodeLoggingProfileJSON(f.Setup.LoggingProfile)
		if err != nil {
			return fmt.Errorf("parse setup.logging_profile: %w", err)
		}
		var event observability.LoggingProfileEvent
		if parseErr := json.Unmarshal(f.Input.LoggingEvent, &event); parseErr != nil {
			return fmt.Errorf("parse input.logging_event: %w", parseErr)
		}
		actual, err := observability.EncodeLoggingProfileEvent(config, f.Setup.Environment, event)
		if err != nil {
			return fmt.Errorf("encode logging profile event: %w", err)
		}
		canonicalActual, ok := canonicalJSONValue(actual).(map[string]any)
		if !ok {
			return fmt.Errorf("profile_logs mismatch")
		}
		actualLogs := []map[string]any{canonicalActual}
		if !reflect.DeepEqual(canonicalJSONValue(f.Expect.ProfileLogs), canonicalJSONValue(actualLogs)) {
			return fmt.Errorf("profile_logs mismatch")
		}
		return nil
	}
	return nil
}

func decodeLoggingProfileValidationErrors(raw json.RawMessage) []string {
	_, err := observability.DecodeLoggingProfileJSON(raw)
	if err == nil {
		return nil
	}
	var profileErr *observability.LoggingProfileValidationError
	if errors.As(err, &profileErr) {
		return profileErr.Errors
	}
	return []string{err.Error()}
}

func canonicalJSONValue(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return value
	}
	return out
}
