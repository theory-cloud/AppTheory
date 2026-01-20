package main

import (
	"context"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory"
)

func runFixtureP2(f Fixture) error {
	now := time.Unix(0, 0).UTC()

	var logs []FixtureLogRecord
	var metrics []FixtureMetricRecord
	var spans []FixtureSpanRecord

	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP2),
		apptheory.WithClock(fixedClock{now: now}),
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
				return "", &apptheory.AppError{Code: "app.unauthorized", Message: "unauthorized"}
			}
			return "authorized", nil
		}),
		apptheory.WithObservability(apptheory.ObservabilityHooks{
			Log: func(r apptheory.LogRecord) {
				logs = append(logs, FixtureLogRecord{
					Level:     r.Level,
					Event:     r.Event,
					RequestID: r.RequestID,
					TenantID:  r.TenantID,
					Method:    r.Method,
					Path:      r.Path,
					Status:    r.Status,
					ErrorCode: r.ErrorCode,
				})
			},
			Metric: func(r apptheory.MetricRecord) {
				metrics = append(metrics, FixtureMetricRecord{
					Name:  r.Name,
					Value: r.Value,
					Tags:  r.Tags,
				})
			},
			Span: func(r apptheory.SpanRecord) {
				spans = append(spans, FixtureSpanRecord{
					Name:       r.Name,
					Attributes: r.Attributes,
				})
			},
		}),
		apptheory.WithPolicyHook(func(ctx *apptheory.Context) (*apptheory.PolicyDecision, error) {
			if strings.TrimSpace(headerFirstValue(ctx.Request.Headers, "x-force-rate-limit")) != "" {
				return &apptheory.PolicyDecision{
					Code:    "app.rate_limited",
					Message: "rate limited",
					Headers: map[string][]string{"retry-after": {"1"}},
				}, nil
			}
			if strings.TrimSpace(headerFirstValue(ctx.Request.Headers, "x-force-shed")) != "" {
				return &apptheory.PolicyDecision{
					Code:    "app.overloaded",
					Message: "overloaded",
					Headers: map[string][]string{"retry-after": {"1"}},
				}, nil
			}
			return nil, nil
		}),
	)

	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandler(r.Handler)
		if handler == nil {
			return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
		}
		var opts []apptheory.RouteOption
		if r.AuthRequired {
			opts = append(opts, apptheory.RequireAuth())
		}
		app.Handle(r.Method, r.Path, handler, opts...)
	}

	if f.Input.Request == nil {
		return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
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
	return compareFixtureResponse(f, actual, logs, metrics, spans)
}
