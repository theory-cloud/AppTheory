package oauth_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
)

const originValidationFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-origin-validation.v1.json"

// TestNormalizeRequestOriginEnforcesTheSharedTable pins the request-origin
// validator to the shared accept/reject table. Go is the reference; the
// TypeScript and Python suites load the same rows, so a lexical loopback prefix
// check or a parser that accepts a short/integer IPv4 form is visible.
func TestNormalizeRequestOriginEnforcesTheSharedTable(t *testing.T) {
	raw, err := os.ReadFile(originValidationFixture)
	require.NoError(t, err)
	var document struct {
		Cases []struct {
			ID        string `json:"id"`
			Raw       string `json:"raw"`
			Expect    string `json:"expect"`
			Canonical string `json:"canonical"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &document))
	require.NotEmpty(t, document.Cases)

	for _, testCase := range document.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			canonical, ok := oauth.NormalizeRequestOrigin(testCase.Raw)
			switch testCase.Expect {
			case "accepted":
				require.Truef(t, ok, "origin %q must be accepted", testCase.Raw)
				require.Equalf(t, testCase.Canonical, canonical, "origin %q canonical form", testCase.Raw)
			case "rejected":
				require.Falsef(t, ok, "origin %q must be rejected, got %q", testCase.Raw, canonical)
			default:
				t.Fatalf("case %s states unknown expectation %q", testCase.ID, testCase.Expect)
			}
		})
	}
}
