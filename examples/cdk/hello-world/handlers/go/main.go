package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/aws/aws-lambda-go/lambda"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func envOr(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func buildApp() *apptheory.App {
	lang := envOr("APPTHEORY_HELLO_LANG", "go")
	tier := apptheory.Tier(envOr("APPTHEORY_TIER", "p2"))

	app := apptheory.New(apptheory.WithTier(tier))
	app.Get("/", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return helloResponse(ctx, lang, "world"), nil
	})
	app.Get("/hello/{name}", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return helloResponse(ctx, lang, ctx.Param("name")), nil
	})
	return app
}

func helloResponse(ctx *apptheory.Context, lang string, name string) *apptheory.Response {
	return apptheory.MustJSON(200, map[string]any{
		"message":    "hello " + name,
		"runtime":    lang,
		"request_id": ctx.RequestID,
		"tenant_id":  ctx.TenantID,
	})
}

func main() {
	app := buildApp()
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
