package mcpfacade

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	oauthstore "github.com/theory-cloud/apptheory/v6/runtime/oauth/store"
)

const familyCapabilityFixture = "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-family-capability.v1.json"

type familyCapabilityCase struct {
	ID      string `json:"id"`
	Variant string `json:"variant"`
	Expect  string `json:"expect"`
	Missing string `json:"missing"`
}

// baseOnlyBroker is a broker store with the five-store SPI and the seeder but
// no family capability at all: the pre-M2 custom-store shape.
type baseOnlyBroker struct {
	oauthstore.RouteRefreshBrokerStore
	oauthstore.RouteRefreshBrokerSeeder
}

// legacyFamilyBroker adds only the old optional enumeration/revocation pair.
type legacyFamilyBroker struct {
	baseOnlyBroker
	family oauthstore.RouteRefreshBrokerFamilyStore
}

func (b *legacyFamilyBroker) ListFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.ListFamily(ctx, familyHash)
}

func (b *legacyFamilyBroker) RevokeFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RevokeFamily(ctx, familyHash)
}

type missingCreateBroker struct {
	legacyFamilyBroker
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore
}

func (b *missingCreateBroker) RotateFamily(ctx context.Context, rotation oauthstore.RouteRefreshFamilyRotation) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RotateFamily(ctx, rotation)
}

type missingRotateBroker struct {
	legacyFamilyBroker
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore
}

func (b *missingRotateBroker) CreateFamily(ctx context.Context, root *oauthstore.RouteRefreshBrokerRecord) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.CreateFamily(ctx, root)
}

type missingListBroker struct {
	baseOnlyBroker
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore
}

func (b *missingListBroker) CreateFamily(ctx context.Context, root *oauthstore.RouteRefreshBrokerRecord) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.CreateFamily(ctx, root)
}

func (b *missingListBroker) RotateFamily(ctx context.Context, rotation oauthstore.RouteRefreshFamilyRotation) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RotateFamily(ctx, rotation)
}

func (b *missingListBroker) RevokeFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RevokeFamily(ctx, familyHash)
}

type missingRevokeBroker struct {
	baseOnlyBroker
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore
}

func (b *missingRevokeBroker) CreateFamily(ctx context.Context, root *oauthstore.RouteRefreshBrokerRecord) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.CreateFamily(ctx, root)
}

func (b *missingRevokeBroker) RotateFamily(ctx context.Context, rotation oauthstore.RouteRefreshFamilyRotation) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RotateFamily(ctx, rotation)
}

func (b *missingRevokeBroker) ListFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.ListFamily(ctx, familyHash)
}

// completeBroker is the five-store SPI plus every transactional family method.
type completeBroker struct {
	baseOnlyBroker
	family oauthstore.RouteRefreshBrokerTransactionalFamilyStore
}

func (b *completeBroker) CreateFamily(ctx context.Context, root *oauthstore.RouteRefreshBrokerRecord) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.CreateFamily(ctx, root)
}

func (b *completeBroker) RotateFamily(ctx context.Context, rotation oauthstore.RouteRefreshFamilyRotation) (*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RotateFamily(ctx, rotation)
}

func (b *completeBroker) ListFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.ListFamily(ctx, familyHash)
}

func (b *completeBroker) RevokeFamily(ctx context.Context, familyHash string) ([]*oauthstore.RouteRefreshBrokerRecord, error) {
	return b.family.RevokeFamily(ctx, familyHash)
}

// capabilityVariant builds the broker variant a fixture row names, wrapping the
// reference broker so the complete variant is the real store.
func capabilityVariant(t *testing.T, variant string, stores oauthstore.Stores) oauthstore.RouteRefreshBrokerStore {
	t.Helper()
	reference := stores.RouteRefreshBroker
	base, ok := reference.(oauthstore.RouteRefreshBrokerStore)
	require.True(t, ok)
	seeder, ok := reference.(oauthstore.RouteRefreshBrokerSeeder)
	require.True(t, ok)
	family, ok := reference.(oauthstore.RouteRefreshBrokerFamilyStore)
	require.True(t, ok)
	transactional, ok := reference.(oauthstore.RouteRefreshBrokerTransactionalFamilyStore)
	require.True(t, ok)
	baseOnly := baseOnlyBroker{RouteRefreshBrokerStore: base, RouteRefreshBrokerSeeder: seeder}
	legacy := legacyFamilyBroker{baseOnlyBroker: baseOnly, family: family}
	switch variant {
	case "base_stores_only":
		return &baseOnly
	case "legacy_family_only":
		return &legacy
	case "missing_create_family":
		return &missingCreateBroker{legacyFamilyBroker: legacy, family: transactional}
	case "missing_rotate_family":
		return &missingRotateBroker{legacyFamilyBroker: legacy, family: transactional}
	case "missing_list_family":
		return &missingListBroker{baseOnlyBroker: baseOnly, family: transactional}
	case "missing_revoke_family":
		return &missingRevokeBroker{baseOnlyBroker: baseOnly, family: transactional}
	case "complete":
		return &completeBroker{baseOnlyBroker: baseOnly, family: transactional}
	default:
		t.Fatalf("unknown capability variant %q", variant)
		return nil
	}
}

// TestFrontChannelRequiresTransactionalFamilyCapability pins registration to the
// shared capability-refusal table. Every variant is constructed from the real
// reference broker, so the accepted row proves the reference store satisfies the
// same contract custom stores must meet.
func TestFrontChannelRequiresTransactionalFamilyCapability(t *testing.T) {
	raw, err := os.ReadFile(familyCapabilityFixture)
	require.NoError(t, err)
	var document struct {
		Cases []familyCapabilityCase `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &document))
	require.Len(t, document.Cases, 7)

	for _, testCase := range document.Cases {
		t.Run(testCase.ID, func(t *testing.T) {
			stores := referenceStores()
			stores.RouteRefreshBroker = capabilityVariant(t, testCase.Variant, stores)
			config := completeFrontChannelConfig()
			config.Stores = stores
			app := apptheory.New()
			inventory, registerErr := RegisterMCPFacade(app, config)
			if testCase.Expect == "accepted" {
				require.NoError(t, registerErr)
				require.NotNil(t, inventory)
				return
			}
			require.Error(t, registerErr)
			require.Nil(t, inventory)
			want := map[string]string{
				"transactional_family": "transactional refresh-family",
				"create_family":        "CreateFamily",
				"rotate_family":        "RotateFamily",
				"list_family":          "ListFamily",
				"revoke_family":        "RevokeFamily",
			}[testCase.Missing]
			require.NotEmpty(t, want)
			require.Contains(t, registerErr.Error(), want)
		})
	}
}
