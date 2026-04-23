package main

import (
	"io"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func runFixtureM12(f Fixture) error {
	now := time.Unix(0, 0).UTC()
	app := newAppTheoryFixtureAppP1(now, f.Setup.Limits, f.Setup.CORS, f.Setup.HTTPErrorFormat)
	var metrics []FixtureMetricRecord

	for _, name := range f.Setup.Middlewares {
		mw := builtInM12Middleware(name)
		if mw == nil {
			return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
		}
		app.Use(mw)
	}

	for _, r := range f.Setup.Routes {
		handler := builtInM12Handler(r.Handler, &metrics)
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

	ctx, cancel := fixtureContext(now, f.Input.Context.RemainingMS)
	if cancel != nil {
		defer cancel()
	}

	actual := app.Serve(ctx, req)
	if actual.BodyReader != nil {
		b, err := io.ReadAll(actual.BodyReader)
		if err != nil {
			return err
		}
		actual.Body = append(actual.Body, b...)
		actual.BodyReader = nil
	}

	time.Sleep(30 * time.Millisecond)
	if f.Expect.Metrics != nil && metrics == nil {
		metrics = []FixtureMetricRecord{}
	}

	return compareFixtureResponse(f, actual, nil, metrics, nil)
}

func builtInM12Middleware(name string) apptheory.Middleware {
	switch strings.TrimSpace(name) {
	case "mw_a":
		return func(next apptheory.Handler) apptheory.Handler {
			return func(ctx *apptheory.Context) (*apptheory.Response, error) {
				ctx.Set("mw", "ok")
				ctx.MiddlewareTrace = append(ctx.MiddlewareTrace, "mw_a")

				resp, err := next(ctx)
				if err != nil || resp == nil {
					return resp, err
				}

				if resp.Headers == nil {
					resp.Headers = map[string][]string{}
				}
				resp.Headers["x-middleware"] = []string{"1"}
				return resp, nil
			}
		}
	case "mw_b":
		return func(next apptheory.Handler) apptheory.Handler {
			return func(ctx *apptheory.Context) (*apptheory.Response, error) {
				ctx.MiddlewareTrace = append(ctx.MiddlewareTrace, "mw_b")
				return next(ctx)
			}
		}
	case "timeout_5ms":
		return apptheory.TimeoutMiddleware(apptheory.TimeoutConfig{DefaultTimeout: 5 * time.Millisecond})
	default:
		return nil
	}
}

func builtInM12Handler(name string, metrics *[]FixtureMetricRecord) apptheory.Handler {
	if strings.TrimSpace(name) != "cooperative_cancel_side_effect" {
		return builtInAppTheoryHandler(name)
	}

	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		select {
		case <-ctx.Context().Done():
			return apptheory.Text(200, "canceled"), nil
		case <-time.After(20 * time.Millisecond):
			if metrics != nil {
				*metrics = append(*metrics, FixtureMetricRecord{
					Name:  "timeout.side_effect_committed",
					Value: 1,
					Tags: map[string]string{
						"handler": "cooperative_cancel_side_effect",
					},
				})
			}
			return apptheory.Text(200, "late"), nil
		}
	}
}
