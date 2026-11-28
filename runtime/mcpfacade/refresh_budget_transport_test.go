package mcpfacade

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/runtime/oauth"
	oauthstore "github.com/theory-cloud/apptheory/v7/runtime/oauth/store"
)

// fetchBoundProvider is a provider that answers the reporter question and
// records the deadline the facade actually applied to the upstream call, so a
// test can observe the budget that was used rather than the budget that was
// configured.
type fetchBoundProvider struct {
	oauth.Provider
	fetchTimeout time.Duration

	mu          sync.Mutex
	calls       int
	deadline    time.Time
	hasDeadline bool
	// hold keeps the upstream call in flight for a while, so a row can prove the
	// recorded deadline is the one the call was executed under.
	hold time.Duration
}

func (p *fetchBoundProvider) UpstreamFetchTimeout() time.Duration {
	return p.fetchTimeout
}

func (p *fetchBoundProvider) Refresh(ctx context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
	p.mu.Lock()
	p.calls++
	p.deadline, p.hasDeadline = ctx.Deadline()
	hold := p.hold
	p.mu.Unlock()
	if hold > 0 {
		select {
		case <-time.After(hold):
		case <-ctx.Done():
			return nil, oauth.NewProviderError(oauth.ProviderTemporarilyUnavailable, "refresh", "deadline")
		}
	}
	return p.Provider.Refresh(ctx, req)
}

func (p *fetchBoundProvider) observedDeadline() (time.Duration, int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.hasDeadline {
		return 0, p.calls, false
	}
	return time.Until(p.deadline), p.calls, true
}

// TestRouteRefreshBudgetLongerThanTheProviderTransportIsRefused pins the
// config-honesty half of issue #1283: the facade applies RefreshBudget as the
// deadline of the upstream call, so a provider whose own transport gives up
// earlier would silently cut the encoded budget — the soak encoded 12 s and
// every upstream timeout fired at exactly 10.0 s. Registration now refuses that
// combination and names both values instead of accepting a budget the transport
// cannot honor. Every surface that ships the policy refuses it: the facade and
// the exported sweeper.
func TestRouteRefreshBudgetLongerThanTheProviderTransportIsRefused(t *testing.T) {
	config := completeFrontChannelConfig()
	config.Provider = &fetchBoundProvider{Provider: config.Provider, fetchTimeout: DefaultRefreshBudget}
	config.RouteRefreshPolicy.RefreshBudget = 12 * time.Second

	_, err := RegisterMCPFacade(apptheory.New(), config)
	require.Error(t, err)
	require.Contains(t, err.Error(), "12s", "the refusal names the encoded budget")
	require.Contains(t, err.Error(), "10s", "the refusal names the transport bound")
	require.Contains(t, err.Error(), "upstream fetch timeout")
	require.Contains(t, err.Error(), "raise the provider's fetch timeout")

	// The same pair through the exported sweeper, which registers the policy and
	// the provider independently of the facade.
	sweeper, err := NewRefreshSweeper(RefreshSweepConfig{
		Provider: &fetchBoundProvider{Provider: stubProvider{}, fetchTimeout: DefaultRefreshBudget},
		Stores:   referenceStores(),
		Policy: RouteRefreshPolicy{
			HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
			ReuseRateCeiling: MinRefreshReuseRateCeiling,
			RefreshBudget:    12 * time.Second,
		},
	})
	require.Error(t, err)
	require.Nil(t, sweeper)
	require.Contains(t, err.Error(), "12s")
	require.Contains(t, err.Error(), "10s")

	// A budget above the transport bound is refused at every accepted budget, not
	// only at the ceiling; the comparison is against the reported bound.
	config.RouteRefreshPolicy.RefreshBudget = 5 * time.Second
	config.Provider = &fetchBoundProvider{Provider: stubProvider{}, fetchTimeout: 2 * time.Second}
	_, err = RegisterMCPFacade(apptheory.New(), config)
	require.ErrorContains(t, err, "5s")
	require.ErrorContains(t, err, "2s")
}

// TestRouteRefreshBudgetIsTheBindingDeadlineWhenTheTransportCanHonorIt pins the
// other half: when the transport bound is at least the budget, the budget stays
// the deadline the upstream call is actually executed under. The 12 s budget the
// soak encoded is honored end to end — normalized, accepted, and applied.
func TestRouteRefreshBudgetIsTheBindingDeadlineWhenTheTransportCanHonorIt(t *testing.T) {
	// The default pair is untouched: a zero budget resolves to the framework's
	// 10 s, which a default-configured adapter's 10 s transport bound honors.
	config := completeFrontChannelConfig()
	config.Provider = &fetchBoundProvider{Provider: config.Provider, fetchTimeout: DefaultRefreshBudget}
	_, err := RegisterMCPFacade(apptheory.New(), config)
	require.NoError(t, err)

	// 12 s is MaxRefreshBudget, the ceiling the lock TTL allows.
	config.RouteRefreshPolicy.RefreshBudget = MaxRefreshBudget
	config.Provider = &fetchBoundProvider{Provider: config.Provider, fetchTimeout: MaxRefreshBudget}
	_, err = RegisterMCPFacade(apptheory.New(), config)
	require.NoError(t, err)

	for _, testCase := range []struct {
		name      string
		budget    time.Duration
		transport time.Duration
	}{
		{name: "equal", budget: 12 * time.Second, transport: 12 * time.Second},
		{name: "transport above budget", budget: 12 * time.Second, transport: 30 * time.Second},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
			handle := mintedRefreshHandle(t, harness)
			familyHash := brokerRecord(t, harness, handle).FamilyHash
			bound := &fetchBoundProvider{
				Provider:     harness.provider.current(),
				fetchTimeout: testCase.transport,
				hold:         50 * time.Millisecond,
			}
			sweeper, err := NewRefreshSweeper(RefreshSweepConfig{
				Provider: bound,
				Stores:   harness.stores,
				Policy: RouteRefreshPolicy{
					HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
					ReuseRateCeiling: MinRefreshReuseRateCeiling,
					RefreshBudget:    testCase.budget,
				},
				Now: harness.clock.Now,
			})
			require.NoError(t, err)

			result, err := sweeper.SweepFamily(context.Background(), familyHash)
			require.NoError(t, err)
			require.Equal(t, RefreshSweepRotated, result.Outcome)

			remaining, calls, ok := bound.observedDeadline()
			require.Equal(t, 1, calls, "the sweep makes exactly one upstream call")
			require.True(t, ok, "the upstream call must carry a deadline")
			require.Greater(t, remaining, testCase.budget-5*time.Second,
				"the encoded budget is the deadline the call ran under")
			require.LessOrEqual(t, remaining, testCase.budget)
		})
	}
}

// TestRouteRefreshBudgetIsUncheckedForAProviderThatStatesNoBound pins that the
// reporter is optional: a provider that states no transport bound is accepted at
// any policy budget, and the budget is still the deadline the call carries.
func TestRouteRefreshBudgetIsUncheckedForAProviderThatStatesNoBound(t *testing.T) {
	harness := newFrontChannelHarnessWith(t, frontChannelHarnessOptions{})
	handle := mintedRefreshHandle(t, harness)
	familyHash := brokerRecord(t, harness, handle).FamilyHash

	var (
		mu          sync.Mutex
		remaining   time.Duration
		hasDeadline bool
	)
	unreported := &refreshOverride{Provider: harness.provider.current(), refresh: func(ctx context.Context, req oauth.RefreshRequest) (*oauth.TokenSet, error) {
		deadline, ok := ctx.Deadline()
		mu.Lock()
		remaining, hasDeadline = time.Until(deadline), ok
		mu.Unlock()
		return harness.provider.current().Refresh(ctx, req)
	}}
	sweeper, err := NewRefreshSweeper(RefreshSweepConfig{
		Provider: unreported,
		Stores:   harness.stores,
		Policy: RouteRefreshPolicy{
			HandleTTL:        oauthstore.DefaultRouteRefreshBrokerTTL,
			ReuseRateCeiling: MinRefreshReuseRateCeiling,
			RefreshBudget:    MaxRefreshBudget,
		},
		Now: harness.clock.Now,
	})
	require.NoError(t, err)

	result, err := sweeper.SweepFamily(context.Background(), familyHash)
	require.NoError(t, err)
	require.Equal(t, RefreshSweepRotated, result.Outcome)

	mu.Lock()
	defer mu.Unlock()
	require.True(t, hasDeadline)
	require.Greater(t, remaining, MaxRefreshBudget-5*time.Second)
	require.LessOrEqual(t, remaining, MaxRefreshBudget)
}
