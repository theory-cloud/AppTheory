package testkit_test

import (
	"context"
	"testing"

	"github.com/theory-cloud/apptheory"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestInvokeAPIGatewayV2(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	event := testkit.APIGatewayV2Request("GET", "/ping", testkit.HTTPEventOptions{})
	resp := env.InvokeAPIGatewayV2(context.Background(), app, event)

	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Body != "pong" {
		t.Fatalf("expected body pong, got %#v", resp.Body)
	}
}

func TestInvokeLambdaFunctionURL(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	event := testkit.LambdaFunctionURLRequest("GET", "/ping", testkit.HTTPEventOptions{})
	resp := env.InvokeLambdaFunctionURL(context.Background(), app, event)

	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Body != "pong" {
		t.Fatalf("expected body pong, got %#v", resp.Body)
	}
}

