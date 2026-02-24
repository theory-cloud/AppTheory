package oauth

import (
	"context"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"

	"github.com/stretchr/testify/require"
)

func TestBearerTokenFromHeaders(t *testing.T) {
	token, err := BearerTokenFromHeaders(map[string][]string{
		"authorization": {"Bearer abc123"},
	})
	require.NoError(t, err)
	require.Equal(t, "abc123", token)
}

func TestBearerTokenFromHeaders_Missing(t *testing.T) {
	_, err := BearerTokenFromHeaders(map[string][]string{})
	require.ErrorIs(t, err, ErrMissingBearerToken)
}

func TestRequireBearerTokenMiddleware_401IncludesResourceMetadata(t *testing.T) {
	t.Setenv("MCP_ENDPOINT", "https://mcp.example.com/mcp")

	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{})
	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"host":              {"mcp.example.com"},
				"x-forwarded-proto": {"https"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 401, resp.Status)
	require.Equal(t, []string{`Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`}, resp.Headers["www-authenticate"])
}

func TestRequireBearerTokenMiddleware_ValidatorRuns(t *testing.T) {
	called := 0
	mw := RequireBearerTokenMiddleware(RequireBearerTokenOptions{
		ResourceMetadataURL: "https://mcp.example.com/.well-known/oauth-protected-resource",
		Validator: func(context.Context, string) error {
			called++
			return nil
		},
	})

	handler := mw(func(*apptheory.Context) (*apptheory.Response, error) {
		return &apptheory.Response{Status: 200}, nil
	})

	resp, err := handler(&apptheory.Context{
		Request: apptheory.Request{
			Headers: map[string][]string{
				"authorization": {"Bearer ok"},
			},
		},
	})
	require.NoError(t, err)
	require.Equal(t, 200, resp.Status)
	require.Equal(t, 1, called)
}
