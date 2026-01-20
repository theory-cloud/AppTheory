package main

import (
	"context"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/theory-cloud/apptheory"
)

func buildApp() *apptheory.App {
	tier := apptheory.Tier(os.Getenv("APPTHEORY_TIER"))
	name := os.Getenv("APPTHEORY_DEMO_NAME")
	lang := os.Getenv("APPTHEORY_LANG")

	app := apptheory.New(apptheory.WithTier(tier))

	app.Get("/", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"ok":         true,
			"lang":       lang,
			"name":       name,
			"tier":       string(tier),
			"request_id": ctx.RequestID,
			"tenant_id":  ctx.TenantID,
		}), nil
	})

	app.Get("/hello/{name}", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.MustJSON(200, map[string]any{
			"message":    "hello " + ctx.Param("name"),
			"lang":       lang,
			"name":       name,
			"tier":       string(tier),
			"request_id": ctx.RequestID,
			"tenant_id":  ctx.TenantID,
		}), nil
	})

	return app
}

func main() {
	app := buildApp()
	lambda.Start(func(ctx context.Context, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
		return app.ServeAPIGatewayV2(ctx, event), nil
	})
}

