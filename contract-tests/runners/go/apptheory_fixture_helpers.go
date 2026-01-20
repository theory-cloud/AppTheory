package main

import (
	"context"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory"
)

func newAppTheoryFixtureAppP1(now time.Time, limits FixtureLimits) *apptheory.App {
	return apptheory.New(
		apptheory.WithTier(apptheory.TierP1),
		apptheory.WithClock(fixedClock{now: now}),
		apptheory.WithIDGenerator(fixedIDGenerator{id: "req_test_123"}),
		apptheory.WithLimits(apptheory.Limits{
			MaxRequestBytes:  limits.MaxRequestBytes,
			MaxResponseBytes: limits.MaxResponseBytes,
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
}

func fixtureContext(now time.Time, remainingMS int) (context.Context, context.CancelFunc) {
	ctx := context.Background()
	if remainingMS <= 0 {
		return ctx, nil
	}
	return context.WithDeadline(ctx, now.Add(time.Duration(remainingMS)*time.Millisecond))
}
