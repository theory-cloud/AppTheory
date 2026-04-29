package testkit_test

import (
	"context"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestInvokeAPIGatewayV2(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	event := testkit.APIGatewayV2Request("GET", "/ping", testkit.HTTPEventOptions{})
	resp := env.InvokeAPIGatewayV2(context.TODO(), app, event)

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
	resp := env.InvokeLambdaFunctionURL(context.TODO(), app, event)

	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Body != "pong" {
		t.Fatalf("expected body pong, got %#v", resp.Body)
	}
}

func TestHTTPEventBuildersSourceIP(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/source", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, ctx.SourceIP()), nil
	})

	v2Event := testkit.APIGatewayV2Request("GET", "/source", testkit.HTTPEventOptions{
		SourceIP: "2001:DB8::1",
	})
	if v2Event.RequestContext.HTTP.SourceIP != "2001:DB8::1" {
		t.Fatalf("expected API Gateway v2 source IP to be set, got %q", v2Event.RequestContext.HTTP.SourceIP)
	}
	v2Resp := env.InvokeAPIGatewayV2(context.TODO(), app, v2Event)
	if v2Resp.Body != "2001:db8::1" {
		t.Fatalf("expected canonical API Gateway v2 source IP, got %q", v2Resp.Body)
	}

	urlEvent := testkit.LambdaFunctionURLRequest("GET", "/source", testkit.HTTPEventOptions{
		SourceIP: "198.51.100.88",
	})
	if urlEvent.RequestContext.HTTP.SourceIP != "198.51.100.88" {
		t.Fatalf("expected Lambda Function URL source IP to be set, got %q", urlEvent.RequestContext.HTTP.SourceIP)
	}
	urlResp := env.InvokeLambdaFunctionURL(context.TODO(), app, urlEvent)
	if urlResp.Body != "198.51.100.88" {
		t.Fatalf("expected Lambda Function URL source IP, got %q", urlResp.Body)
	}
}

func TestInvokeALB(t *testing.T) {
	env := testkit.New()
	app := env.App()

	app.Get("/ping", func(_ *apptheory.Context) (*apptheory.Response, error) {
		return apptheory.Text(200, "pong"), nil
	})

	event := testkit.ALBTargetGroupRequest("GET", "/ping", testkit.HTTPEventOptions{})
	resp := env.InvokeALB(context.TODO(), app, event)

	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Body != "pong" {
		t.Fatalf("expected body pong, got %#v", resp.Body)
	}
}
