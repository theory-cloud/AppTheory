package main

import (
	"context"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory"
)

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time {
	return c.now
}

type fixedIDGenerator struct {
	id string
}

func (g fixedIDGenerator) NewID() string {
	return g.id
}

func headerFirstValue(headers map[string][]string, key string) string {
	values := headers[strings.ToLower(strings.TrimSpace(key))]
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func runFixtureP1(f Fixture) error {
	now := time.Unix(0, 0).UTC()
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(fixedClock{now: now}),
		apptheory.WithIDGenerator(fixedIDGenerator{id: "req_test_123"}),
		apptheory.WithLimits(apptheory.Limits{
			MaxRequestBytes:  f.Setup.Limits.MaxRequestBytes,
			MaxResponseBytes: f.Setup.Limits.MaxResponseBytes,
		}),
		apptheory.WithAuthHook(func(ctx *apptheory.Context) (string, error) {
			authz := strings.TrimSpace(headerFirstValue(ctx.Request.Headers, "authorization"))
			if authz == "" {
				return "", &apptheory.AppError{Code: "app.unauthorized", Message: "unauthorized"}
			}
			if strings.TrimSpace(headerFirstValue(ctx.Request.Headers, "x-force-forbidden")) != "" {
				return "", &apptheory.AppError{Code: "app.forbidden", Message: "forbidden"}
			}
			return authorizedIdentity, nil
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
	return compareFixtureResponse(f, actual, nil, nil, nil)
}
