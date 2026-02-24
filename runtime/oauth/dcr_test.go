package oauth

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateDynamicClientRegistrationRequest_ClaudePolicy_AllowsClaudeRedirect(t *testing.T) {
	req := &DynamicClientRegistrationRequest{
		ClientName:              "Claude",
		RedirectURIs:            []string{"https://claude.ai/api/mcp/auth_callback"},
		TokenEndpointAuthMethod: "none",
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		ResponseTypes:           []string{"code"},
	}
	err := ValidateDynamicClientRegistrationRequest(req, ClaudeDynamicClientRegistrationPolicy())
	require.NoError(t, err)
}

func TestValidateDynamicClientRegistrationRequest_ClaudePolicy_RejectsUnknownRedirect(t *testing.T) {
	req := &DynamicClientRegistrationRequest{
		RedirectURIs:            []string{"https://evil.example.com/callback"},
		TokenEndpointAuthMethod: "none",
	}
	err := ValidateDynamicClientRegistrationRequest(req, ClaudeDynamicClientRegistrationPolicy())
	require.Error(t, err)
}

func TestValidateDynamicClientRegistrationRequest_RequiresPublicClient(t *testing.T) {
	req := &DynamicClientRegistrationRequest{
		RedirectURIs:            []string{"https://claude.ai/api/mcp/auth_callback"},
		TokenEndpointAuthMethod: "client_secret_basic",
	}
	err := ValidateDynamicClientRegistrationRequest(req, ClaudeDynamicClientRegistrationPolicy())
	require.Error(t, err)
}
