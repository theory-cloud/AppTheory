package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-lambda-go/events"

	"github.com/theory-cloud/apptheory"
)

func runFixtureM3(f Fixture) error {
	app := apptheory.New(
		apptheory.WithTier(apptheory.TierP0),
	)

	for _, r := range f.Setup.Routes {
		handler := builtInAppTheoryHandler(r.Handler)
		if handler == nil {
			return fmt.Errorf("unknown handler %q", r.Handler)
		}
		opts := []apptheory.RouteOption{}
		if r.AuthRequired {
			opts = append(opts, apptheory.RequireAuth())
		}
		app.Handle(r.Method, r.Path, handler, opts...)
	}

	if f.Input.AWSEvent == nil {
		return errors.New("fixture missing input.aws_event")
	}

	out, err := app.HandleLambda(context.Background(), f.Input.AWSEvent.Event)
	if err != nil {
		return err
	}

	var actual CanonicalResponse
	switch v := out.(type) {
	case events.APIGatewayProxyResponse:
		actual, err = canonicalizeAPIGatewayProxyResponse(v)
	case *events.APIGatewayProxyResponse:
		if v == nil {
			return errors.New("expected apigw proxy response, got nil pointer")
		}
		actual, err = canonicalizeAPIGatewayProxyResponse(*v)
	case events.APIGatewayProxyStreamingResponse:
		actual, err = canonicalizeAPIGatewayProxyStreamingResponse(&v)
	case *events.APIGatewayProxyStreamingResponse:
		actual, err = canonicalizeAPIGatewayProxyStreamingResponse(v)
	default:
		return fmt.Errorf("expected apigw proxy response, got %T", out)
	}
	if err != nil {
		return err
	}

	actual.Headers = canonicalizeHeaders(actual.Headers)

	if f.Expect.Response == nil {
		return errors.New("fixture missing expect.response")
	}
	expected := *f.Expect.Response

	expectedHeaders := canonicalizeHeaders(expected.Headers)
	if err := compareLegacyResponseMeta(expected, actual, expectedHeaders); err != nil {
		return err
	}
	return compareLegacyResponseBody(expected, actual.Body)
}

func canonicalizeAPIGatewayProxyStreamingResponse(in *events.APIGatewayProxyStreamingResponse) (CanonicalResponse, error) {
	if in == nil {
		return CanonicalResponse{}, errors.New("nil apigw proxy streaming response")
	}

	headers := map[string][]string{}
	for k, vs := range in.MultiValueHeaders {
		headers[k] = append([]string(nil), vs...)
	}
	for k, v := range in.Headers {
		if _, ok := headers[k]; ok {
			continue
		}
		headers[k] = []string{v}
	}
	headers = canonicalizeHeaders(headers)

	cookies := append([]string(nil), in.Cookies...)
	if len(cookies) == 0 {
		cookies = append([]string(nil), headers["set-cookie"]...)
	}
	delete(headers, "set-cookie")

	bodyBytes := []byte{}
	if in.Body != nil {
		b, err := io.ReadAll(in.Body)
		if err != nil {
			return CanonicalResponse{}, fmt.Errorf("read apigw proxy streaming body: %w", err)
		}
		bodyBytes = b
	}

	return CanonicalResponse{
		Status:   in.StatusCode,
		Headers:  headers,
		Cookies:  cookies,
		Body:     bodyBytes,
		IsBase64: false,
	}, nil
}
