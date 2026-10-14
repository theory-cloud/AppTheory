package oauth_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	oauthruntime "github.com/theory-cloud/apptheory/v6/runtime/oauth"
)

// issuerPinConformanceFixture is the shared RFC 9207 issuer-pin table. From
// runtime/oauth/ the repository root is two levels up.
const issuerPinConformanceFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-conformance.v1.json"

// issuerPinGroup names the fixture group this loader executes.
const issuerPinGroup = "issuer_pin"

// redirectMatchGroup names the sibling group the same shared table carries. It
// is executed by runtime/mcpfacade's front-channel tests through the real
// /authorize handler, not here; the set below is a deliberate ledger so a new
// group cannot appear without a loader.
const redirectMatchGroup = "redirect_match"

// formParseGroup is the sibling group holding the /token request-body rule. It
// is executed by runtime/mcpfacade's front-channel tests through the real token
// handler, not here; the ledger below still lists it so a new group cannot
// appear without a loader.
const formParseGroup = "form_parse"

// methodStatusGroup is the sibling group holding the route-model method-mismatch
// contract. It is executed by runtime/mcpfacade's front-channel tests through the
// real mounted app, not here; the ledger below still lists it so a new group
// cannot appear without a loader.
const methodStatusGroup = "method_status"

// dcrGroup is the sibling group holding the RFC 7591 dynamic-client registration
// rule. It is executed by runtime/mcpfacade's registration tests through the real
// mounted POST .../register handler, not here; the ledger below still lists it so
// a new group cannot appear without a loader.
const dcrGroup = "dcr"

// boundRouteGroup is the sibling group holding the registration route-binding
// rule: a client registered through DCR is accepted only at the advertising
// route it registered at. It is executed by runtime/mcpfacade's front-channel
// tests through the real mounted /register, /authorize, and /token handlers, not
// here; the ledger below still lists it so a new group cannot appear without a
// loader.
const boundRouteGroup = "bound_route"

// refreshGroup is the sibling group holding the brokered refresh grant's
// contract: single-flight rotation, the bounded grace replay, reuse revocation,
// the scope and resource bindings of a refresh request, and the typed refusals.
// It is executed by runtime/mcpfacade's refresh tests through the real token
// handler, not here; the ledger below still lists it so a new group cannot
// appear without a loader.
const refreshGroup = "refresh"

// metadataRegistrationGroup is the sibling group holding the advertised
// registration_endpoint contract: the routed RFC 8414 document carries the
// member exactly while the front channel or an explicit register handler mounts
// the /register route. It is executed by runtime/mcpfacade's front-channel tests
// through the real mounted discovery handler, not here; the ledger below still
// lists it so a new group cannot appear without a loader.
const metadataRegistrationGroup = "metadata_registration"

// fixtureGroups is every group the shared table is allowed to carry.
var fixtureGroups = map[string]struct{}{
	issuerPinGroup:            {},
	redirectMatchGroup:        {},
	formParseGroup:            {},
	methodStatusGroup:         {},
	dcrGroup:                  {},
	boundRouteGroup:           {},
	refreshGroup:              {},
	metadataRegistrationGroup: {},
}

// issuerPinCaseCount is the number of issuer_pin rows the shared fixture must
// carry; a change to the table must also be a deliberate edit here.
const issuerPinCaseCount = 27

type issuerPinConformanceDocument struct {
	Cases []issuerPinCase `json:"cases"`
}

type issuerPinCase struct {
	ID         string `json:"id"`
	Group      string `json:"group"`
	Configured string `json:"configured"`
	Claimed    string `json:"claimed"`
	Expect     string `json:"expect"`
}

func loadIssuerPinConformance(t *testing.T, target any) {
	t.Helper()
	path := issuerPinConformanceFixture
	body, err := os.ReadFile(path) // #nosec G304 -- path is a fixed test fixture path built from a constant directory.
	require.NoErrorf(t, err, "read shared fixture %s", path)
	require.NoErrorf(t, json.Unmarshal(body, target), "decode shared fixture %s", path)
}

// TestIssuerPinConformance pins oauth.CanonicalizeIssuerURL to the shared
// cross-runtime table. A row matches exactly when both the configured and the
// claimed value canonicalize and the canonical forms are byte-equal; the Go
// runtime is the reference, so this test also fixes the shape the TypeScript
// and Python loaders must reproduce.
func TestIssuerPinConformance(t *testing.T) {
	var document issuerPinConformanceDocument
	loadIssuerPinConformance(t, &document)

	executed := 0
	for _, fixtureCase := range document.Cases {
		_, knownGroup := fixtureGroups[fixtureCase.Group]
		require.Truef(t, knownGroup, "case %q carries unknown group %q", fixtureCase.ID, fixtureCase.Group)
		if fixtureCase.Group != issuerPinGroup {
			continue
		}
		executed++

		t.Run(fixtureCase.ID, func(t *testing.T) {
			var want bool
			switch fixtureCase.Expect {
			case "match":
				want = true
			case "mismatch":
				want = false
			default:
				t.Fatalf("unknown expect %q", fixtureCase.Expect)
			}

			configured, configuredOK := oauthruntime.CanonicalizeIssuerURL(fixtureCase.Configured)
			claimed, claimedOK := oauthruntime.CanonicalizeIssuerURL(fixtureCase.Claimed)
			matched := configuredOK && claimedOK && configured == claimed

			require.Equalf(
				t,
				want,
				matched,
				"configured %q -> (%v, %q), claimed %q -> (%v, %q)",
				fixtureCase.Configured, configuredOK, configured,
				fixtureCase.Claimed, claimedOK, claimed,
			)
		})
	}

	require.Equalf(t, issuerPinCaseCount, executed, "executed %d %q cases", executed, issuerPinGroup)
}
