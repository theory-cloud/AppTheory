package main

import (
	"io"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory"
)

func runFixtureM12(f Fixture) error {
	now := time.Unix(0, 0).UTC()
	app := newAppTheoryFixtureAppP1(now, f.Setup.Limits, f.Setup.CORS)

	for _, name := range f.Setup.Middlewares {
		mw := builtInM12Middleware(name)
		if mw == nil {
			return &apptheory.AppError{Code: "app.internal", Message: "internal error"}
		}
		app.Use(mw)
	}

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

	return compareFixtureResponse(f, actual, nil, nil, nil)
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
	default:
		return nil
	}
}
