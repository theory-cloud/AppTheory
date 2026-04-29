package apptheory

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestSourceProvenanceFromProviderRequestContext(t *testing.T) {
	got := sourceProvenanceFromProviderRequestContext(sourceProvenanceProviderAPIGatewayV2, " 198.51.100.77 ")
	if got.SourceIP != "198.51.100.77" || got.Provider != "apigw-v2" || got.Source != "provider_request_context" || !got.Valid {
		t.Fatalf("unexpected provenance: %#v", got)
	}

	got = sourceProvenanceFromProviderRequestContext(sourceProvenanceProviderAPIGatewayV2, "not-an-ip")
	if got.SourceIP != "" || got.Provider != "unknown" || got.Source != "unknown" || got.Valid {
		t.Fatalf("malformed source should be unknown: %#v", got)
	}
}

func TestContextSourceProvenanceUnknownForDirectRequests(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Handle("GET", "/source", func(ctx *Context) (*Response, error) {
		return JSON(200, map[string]any{
			"source_ip":         ctx.SourceIP(),
			"source_provenance": ctx.SourceProvenance(),
		})
	})

	resp := app.Serve(context.Background(), Request{Method: "GET", Path: "/source"})
	var body struct {
		SourceIP         string           `json:"source_ip"`
		SourceProvenance SourceProvenance `json:"source_provenance"`
	}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.SourceIP != "" || body.SourceProvenance.Provider != "unknown" || body.SourceProvenance.Source != "unknown" || body.SourceProvenance.Valid {
		t.Fatalf("direct request should be unknown: %#v", body)
	}
}

func TestHTTPAdaptersSetSourceProvenance(t *testing.T) {
	app := New(WithTier(TierP0))
	app.Handle("GET", "/source", func(ctx *Context) (*Response, error) {
		return JSON(200, map[string]any{
			"source_ip":         ctx.SourceIP(),
			"source_provenance": ctx.SourceProvenance(),
		})
	})

	testCases := []struct {
		name      string
		invoke    func() []byte
		provider  string
		sourceIP  string
		wantValid bool
	}{
		{
			name: "apigw v2",
			invoke: func() []byte {
				out := app.ServeAPIGatewayV2(context.Background(), events.APIGatewayV2HTTPRequest{
					RawPath: "/source",
					Headers: map[string]string{"x-forwarded-for": "203.0.113.10"},
					RequestContext: events.APIGatewayV2HTTPRequestContext{
						HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
							Method:   "GET",
							Path:     "/source",
							SourceIP: "198.51.100.77",
						},
					},
				})
				return []byte(out.Body)
			},
			provider:  "apigw-v2",
			sourceIP:  "198.51.100.77",
			wantValid: true,
		},
		{
			name: "lambda url",
			invoke: func() []byte {
				out := app.ServeLambdaFunctionURL(context.Background(), events.LambdaFunctionURLRequest{
					RawPath: "/source",
					Headers: map[string]string{"x-forwarded-for": "203.0.113.10"},
					RequestContext: events.LambdaFunctionURLRequestContext{
						HTTP: events.LambdaFunctionURLRequestContextHTTPDescription{
							Method:   "GET",
							Path:     "/source",
							SourceIP: "198.51.100.88",
						},
					},
				})
				return []byte(out.Body)
			},
			provider:  "lambda-url",
			sourceIP:  "198.51.100.88",
			wantValid: true,
		},
		{
			name: "apigw rest v1",
			invoke: func() []byte {
				out := app.ServeAPIGatewayProxy(context.Background(), events.APIGatewayProxyRequest{
					Path:       "/source",
					HTTPMethod: "GET",
					Headers:    map[string]string{"x-forwarded-for": "203.0.113.10"},
					RequestContext: events.APIGatewayProxyRequestContext{
						Identity: events.APIGatewayRequestIdentity{SourceIP: "198.51.100.99"},
					},
				})
				return []byte(out.Body)
			},
			provider:  "apigw-v1",
			sourceIP:  "198.51.100.99",
			wantValid: true,
		},
		{
			name: "malformed apigw v2",
			invoke: func() []byte {
				out := app.ServeAPIGatewayV2(context.Background(), events.APIGatewayV2HTTPRequest{
					RawPath: "/source",
					RequestContext: events.APIGatewayV2HTTPRequestContext{
						HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
							Method:   "GET",
							Path:     "/source",
							SourceIP: "not-an-ip",
						},
					},
				})
				return []byte(out.Body)
			},
			provider:  "unknown",
			sourceIP:  "",
			wantValid: false,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			var body struct {
				SourceIP         string           `json:"source_ip"`
				SourceProvenance SourceProvenance `json:"source_provenance"`
			}
			if err := json.Unmarshal(tc.invoke(), &body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if body.SourceIP != tc.sourceIP || body.SourceProvenance.SourceIP != tc.sourceIP || body.SourceProvenance.Provider != tc.provider || body.SourceProvenance.Valid != tc.wantValid {
				t.Fatalf("unexpected provenance: %#v", body)
			}
		})
	}
}
